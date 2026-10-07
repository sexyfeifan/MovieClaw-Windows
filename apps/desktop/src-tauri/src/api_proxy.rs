use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

/// 存储登录后的 Cookie（session）
static COOKIES: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 代理前端 API 请求到 MovieClaw 服务器，自动携带 Cookie
#[tauri::command]
pub async fn proxy_api(
    method: String,
    path: String,
    body: Option<String>,
) -> Result<ProxyResponse, String> {
    let server = crate::connect::load_server_url()
        .map_err(|e| format!("获取服务器地址失败: {e}"))?;

    if server.is_empty() {
        return Err("未配置服务器地址".into());
    }

    let url = format!("{}/api/v1{}", server.trim_end_matches('/'), path);
    eprintln!("[proxy_api] {} {}", method, url);

    let mut req = ureq::request(&method, &url)
        .set("Accept", "application/json");

    // 携带 Cookie
    {
        let cookies = COOKIES.lock().unwrap();
        if !cookies.is_empty() {
            let cookie_str: Vec<String> = cookies.iter().map(|(k, v)| format!("{k}={v}")).collect();
            req = req.set("Cookie", &cookie_str.join("; "));
        }
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
            // 提取 Set-Cookie
            for name in ["set-cookie", "Set-Cookie"] {
                if let Some(cookie_val) = resp.header(name) {
                    store_cookie(cookie_val);
                }
            }
            // ureq 2.x headers_names for all cookies
            for hname in resp.headers_names() {
                if hname.eq_ignore_ascii_case("set-cookie") {
                    if let Some(val) = resp.header(&hname) {
                        store_cookie(val);
                    }
                }
            }
            let text = resp.into_string().unwrap_or_default();
            eprintln!("[proxy_api] Response {}: {}", status, &text[..text.len().min(100)]);
            Ok(ProxyResponse { status, body: text })
        }
        Err(ureq::Error::Status(code, resp)) => {
            // 4xx/5xx 也可能有 Set-Cookie
            for hname in resp.headers_names() {
                if hname.eq_ignore_ascii_case("set-cookie") {
                    if let Some(val) = resp.header(&hname) {
                        store_cookie(val);
                    }
                }
            }
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

fn store_cookie(cookie_val: &str) {
    // 解析 "session=abc123; Path=/; ..." 取 name=value
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

#[derive(serde::Serialize)]
pub struct ProxyResponse {
    pub status: u16,
    pub body: String,
}
