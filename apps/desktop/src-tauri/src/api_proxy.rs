use std::collections::HashMap;
use std::io::Read;
use std::sync::{LazyLock, Mutex};

/// 存储登录后的 Cookie（session）
static COOKIES: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(load_cookies_from_disk()));

/// 全局共享的 ureq Agent。
///
/// `ureq::request()` / `ureq::get()` 每次都 `AgentBuilder::new().build()` 新建一个 Agent，
/// 连接池随之一起丢弃——于是每个 API 调用都是冷握手，一次也复用不上。共享一个 Agent
/// 才能让 `ConnectionPool` 活过单次请求（HTTPS 反代场景实测 cold 105ms → hot 63ms）。
static AGENT: LazyLock<ureq::Agent> = LazyLock::new(ureq::Agent::new);

/// Cookie 持久化路径
fn cookie_file_path() -> std::path::PathBuf {
    let base = std::env::var("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    base.join("movieclaw-desktop").join("cookies.json")
}

/// 从磁盘加载已保存的 cookies
fn load_cookies_from_disk() -> HashMap<String, String> {
    let path = cookie_file_path();
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(map) = serde_json::from_str::<HashMap<String, String>>(&text) {
            eprintln!("[cookies] Loaded {} cookies from disk", map.len());
            return map;
        }
    }
    HashMap::new()
}

/// 保存 cookies 到磁盘
fn save_cookies_to_disk(cookies: &HashMap<String, String>) {
    let path = cookie_file_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(cookies) {
        let _ = std::fs::write(&path, json);
    }
}

/// 代理前端 API 请求到 MovieClaw 服务器，自动携带 Cookie。
/// 特殊路径 `/__image__?url=...` 返回图片 base64 data URI（解决 <img> 无 Cookie 401）。
/// 特殊路径 `/__stream__?url=...` 代理 HLS 流请求（m3u8 清单 + 视频分片），自动携带 Cookie。
#[tauri::command]
pub async fn proxy_api(
    method: String,
    path: String,
    body: Option<String>,
) -> Result<ProxyResponse, String> {
    // 图片代理分支
    if let Some(stripped) = path.strip_prefix("/__image__") {
        let raw = stripped.trim_start_matches('?');
        let img_path = raw.strip_prefix("url=").unwrap_or(raw);
        let decoded = urlencoding_decode(img_path);
        return fetch_image_as_data_uri(&decoded).await;
    }

    // 流代理分支（HLS m3u8/ts 分片）
    if let Some(stripped) = path.strip_prefix("/__stream__") {
        let raw = stripped.trim_start_matches('?');
        let stream_url = raw.strip_prefix("url=").unwrap_or(raw);
        let decoded = urlencoding_decode(stream_url);
        return fetch_stream_proxy(&decoded).await;
    }

    let server = crate::connect::load_server_url()
        .map_err(|e| format!("获取服务器地址失败: {e}"))?;

    if server.is_empty() {
        return Err("未配置服务器地址".into());
    }

    let url = format!("{}/api/v1{}", server.trim_end_matches('/'), path);
    eprintln!("[proxy_api] {} {}", method, url);

    let mut req = AGENT.request(&method, &url).set("Accept", "application/json");

    // 携带 Cookie
    if let Some(ck) = cookie_header() {
        req = req.set("Cookie", &ck);
    }

    if body.is_some() {
        req = req.set("Content-Type", "application/json");
    }

    let result = match (&body, method.to_uppercase().as_str()) {
        (Some(b), "POST") | (Some(b), "PUT") | (Some(b), "PATCH") => req.send_string(b),
        _ => req.call(),
    };

    match result {
        Ok(resp) => {
            let status = resp.status();
            capture_cookies_from_headers(&resp);
            let text = resp.into_string().unwrap_or_default();
            // 日志截断必须按字符：按字节切会在中文错误体中间劈开 UTF-8，
            // panic 后 Tauri invoke 永不返回 → 前端 45s 超时（2026-10-09 真机事故）
            let snippet: String = text.chars().take(60).collect();
            eprintln!("[proxy_api] Response {}: {}", status, snippet);
            Ok(ProxyResponse { status, body: text })
        }
        Err(ureq::Error::Status(code, resp)) => {
            capture_cookies_from_headers(&resp);
            let text = resp.into_string().unwrap_or_default();
            let snippet: String = text.chars().take(60).collect();
            eprintln!("[proxy_api] Error {}: {}", code, snippet);
            Ok(ProxyResponse { status: code, body: text })
        }
        Err(e) => {
            eprintln!("[proxy_api] Network error: {}", e);
            Err(format!("请求失败: {e}"))
        }
    }
}

/// 抓取图片并返回 base64 data URI（通过 proxy_api 的 /__image__ 路径调用）
async fn fetch_image_as_data_uri(path_or_url: &str) -> Result<ProxyResponse, String> {
    let url = if path_or_url.starts_with("http://") || path_or_url.starts_with("https://") {
        path_or_url.to_string()
    } else {
        let server = crate::connect::load_server_url()
            .map_err(|e| format!("获取服务器地址失败: {e}"))?;
        if server.is_empty() {
            return Err("未配置服务器地址".into());
        }
        let base = server.trim_end_matches('/');
        if path_or_url.starts_with('/') {
            format!("{base}{path_or_url}")
        } else {
            format!("{base}/{path_or_url}")
        }
    };

    eprintln!("[proxy_image] GET {}", url);
    let mut req = AGENT.get(&url).set("Accept", "image/*");
    if let Some(ck) = cookie_header() {
        req = req.set("Cookie", &ck);
    }

    match req.call() {
        Ok(resp) => {
            let content_type = resp
                .content_type()
                .split(';')
                .next()
                .unwrap_or("image/jpeg")
                .to_string();
            let bytes = resp
                .into_reader()
                .bytes()
                .collect::<Result<Vec<u8>, _>>()
                .map_err(|e| format!("读取图片数据失败: {e}"))?;
            let b64 = base64_encode(&bytes);
            Ok(ProxyResponse {
                status: 200,
                body: format!("data:{content_type};base64,{b64}"),
            })
        }
        Err(ureq::Error::Status(code, _)) => {
            eprintln!("[proxy_image] HTTP {code} for {url}");
            Ok(ProxyResponse {
                status: code,
                body: format!("图片请求失败: HTTP {code}"),
            })
        }
        Err(e) => {
            eprintln!("[proxy_image] Error: {e}");
            Err(format!("图片请求失败: {e}"))
        }
    }
}

/// 代理 HLS 流请求（m3u8 清单 + ts 分片），自动携带 Cookie，绕过 CORS
async fn fetch_stream_proxy(url: &str) -> Result<ProxyResponse, String> {
    let full_url = if url.starts_with("http://") || url.starts_with("https://") {
        url.to_string()
    } else {
        let server = crate::connect::load_server_url()
            .map_err(|e| format!("获取服务器地址失败: {e}"))?;
        if server.is_empty() {
            return Err("未配置服务器地址".into());
        }
        let base = server.trim_end_matches('/');
        if url.starts_with('/') {
            format!("{base}{url}")
        } else {
            format!("{base}/{url}")
        }
    };

    eprintln!("[proxy_stream] GET {}", full_url);
    let mut req = AGENT.get(&full_url);
    if let Some(ck) = cookie_header() {
        req = req.set("Cookie", &ck);
    }

    match req.call() {
        Ok(resp) => {
            let status = resp.status();
            let content_type = resp.content_type().to_string();
            capture_cookies_from_headers(&resp);

            // 二进制内容（ts/m4s/mp4 分片）→ base64
            if content_type.contains("video")
                || content_type.contains("audio")
                || content_type.contains("octet-stream")
                || content_type.contains("mp2t")
                || content_type.contains("mp4")
            {
                let bytes = resp
                    .into_reader()
                    .bytes()
                    .collect::<Result<Vec<u8>, _>>()
                    .map_err(|e| format!("读取流数据失败: {e}"))?;
                let b64 = base64_encode(&bytes);
                Ok(ProxyResponse { status, body: b64 })
            } else {
                // 文本内容（m3u8 清单）→ 直接返回文本
                let text = resp.into_string().unwrap_or_default();
                Ok(ProxyResponse { status, body: text })
            }
        }
        Err(ureq::Error::Status(code, resp)) => {
            capture_cookies_from_headers(&resp);
            let text = resp.into_string().unwrap_or_default();
            eprintln!("[proxy_stream] HTTP {code} for {full_url}");
            Ok(ProxyResponse { status: code, body: text })
        }
        Err(e) => {
            eprintln!("[proxy_stream] Error: {e}");
            Err(format!("流请求失败: {e}"))
        }
    }
}

/// 获取 Cookie 字符串
fn cookie_header() -> Option<String> {
    let cookies = COOKIES.lock().unwrap();
    if cookies.is_empty() {
        None
    } else {
        let s: Vec<String> = cookies.iter().map(|(k, v)| format!("{k}={v}")).collect();
        Some(s.join("; "))
    }
}

/// 从响应头中提取并保存 Set-Cookie
fn capture_cookies_from_headers(resp: &ureq::Response) {
    for hname in resp.headers_names() {
        if hname.eq_ignore_ascii_case("set-cookie") {
            if let Some(val) = resp.header(&hname) {
                store_cookie(val);
            }
        }
    }
}

fn store_cookie(cookie_val: &str) {
    if let Some(first_part) = cookie_val.split(';').next() {
        if let Some(eq_pos) = first_part.find('=') {
            let name = first_part[..eq_pos].trim().to_string();
            let value = first_part[eq_pos + 1..].trim().to_string();
            if !name.is_empty() {
                eprintln!("[proxy_api] Stored cookie: {}", name);
                let mut cookies = COOKIES.lock().unwrap();
                if value.is_empty() || value == "deleted" {
                    cookies.remove(&name);
                } else {
                    cookies.insert(name, value);
                }
                save_cookies_to_disk(&cookies);
            }
        }
    }
}

fn urlencoding_decode(s: &str) -> String {
    let mut result = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                result.push(byte);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            result.push(b' ');
        } else {
            result.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&result).to_string()
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        result.push(CHARS[(n >> 18) as usize & 0x3F] as char);
        result.push(CHARS[(n >> 12) as usize & 0x3F] as char);
        result.push(if chunk.len() > 1 { CHARS[(n >> 6) as usize & 0x3F] as char } else { '=' });
        result.push(if chunk.len() > 2 { CHARS[n as usize & 0x3F] as char } else { '=' });
    }
    result
}

#[derive(serde::Serialize)]
pub struct ProxyResponse {
    pub status: u16,
    pub body: String,
}
