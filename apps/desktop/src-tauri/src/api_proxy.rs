use std::collections::HashMap;
use std::io::Read;
use std::sync::{LazyLock, Mutex};

/// 存储登录后的 Cookie（session）
static COOKIES: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 代理前端 API 请求到 MovieClaw 服务器，自动携带 Cookie。
/// 特殊路径 `/__image__?url=...` 返回图片 base64 data URI（解决 <img> 无 Cookie 401）。
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

    let server = crate::connect::load_server_url()
        .map_err(|e| format!("获取服务器地址失败: {e}"))?;

    if server.is_empty() {
        return Err("未配置服务器地址".into());
    }

    let url = format!("{}/api/v1{}", server.trim_end_matches('/'), path);
    eprintln!("[proxy_api] {} {}", method, url);

    let mut req = ureq::request(&method, &url).set("Accept", "application/json");

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
            eprintln!("[proxy_api] Response {}: {}", status, &text[..text.len().min(100)]);
            Ok(ProxyResponse { status, body: text })
        }
        Err(ureq::Error::Status(code, resp)) => {
            capture_cookies_from_headers(&resp);
            let text = resp.into_string().unwrap_or_default();
            eprintln!("[proxy_api] Error {}: {}", code, &text[..text.len().min(100)]);
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
    let mut req = ureq::get(&url).set("Accept", "image/*");
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
