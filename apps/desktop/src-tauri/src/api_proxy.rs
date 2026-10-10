use base64::Engine;
use reqwest::{header, Client, Method};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    LazyLock, Mutex,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio_util::sync::CancellationToken;
use url::Url;

// Credentials belong to one complete origin, including its port. Legacy global
// cookies cannot safely be assigned to a server and are deliberately not imported.
type CookieStore = HashMap<String, HashMap<String, SavedCookie>>;
static COOKIES: LazyLock<Mutex<CookieStore>> = LazyLock::new(|| Mutex::new(load_cookies()));
static REQUESTS: LazyLock<Mutex<HashMap<String, CancellationToken>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);
static CLIENT: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("HTTP client configuration")
});

#[derive(Clone, Serialize, Deserialize)]
struct SavedCookie {
    value: String,
    path: String,
    secure: bool,
    expires_at: Option<i64>,
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn cookie_file_path() -> std::path::PathBuf {
    crate::connect::config_dir().join("cookies-v2.json")
}

fn load_cookies() -> CookieStore {
    // Old cookies have no server identity. Retaining them would leave usable
    // unscoped credentials on disk after the migration.
    let _ = std::fs::remove_file(crate::connect::config_dir().join("cookies.json"));
    std::fs::read_to_string(cookie_file_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_cookies(store: &CookieStore) -> Result<(), String> {
    let path = cookie_file_path();
    let json = serde_json::to_vec(store).map_err(|e| e.to_string())?;
    // The temporary file also prevents a terminated write from corrupting the jar.
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, json).map_err(|e| format!("保存登录状态失败: {e}"))?;
    #[cfg(windows)]
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    std::fs::rename(temp, path).map_err(|e| format!("保存登录状态失败: {e}"))
}

fn cookie_header_from(store: &CookieStore, url: &Url) -> Option<String> {
    let jar = store.get(&url.origin().ascii_serialization())?;
    let mut values: Vec<_> = jar
        .iter()
        .filter(|(_, c)| {
            let path_matches = url.path() == c.path
                || (url.path().starts_with(&c.path)
                    && (c.path.ends_with('/')
                        || url.path().as_bytes().get(c.path.len()) == Some(&b'/')));
            path_matches
                && (!c.secure || url.scheme() == "https")
                && c.expires_at.is_none_or(|expiry| expiry > now_seconds())
        })
        .map(|(name, c)| format!("{name}={}", c.value))
        .collect();
    values.sort();
    if values.is_empty() {
        None
    } else {
        Some(values.join("; "))
    }
}

fn cookie_header(url: &Url) -> Option<String> {
    cookie_header_from(&COOKIES.lock().unwrap(), url)
}

fn cookie_domain_matches(host: &str, domain: &str) -> bool {
    let domain = domain.trim_start_matches('.').to_ascii_lowercase();
    let host = host.to_ascii_lowercase();
    !domain.is_empty()
        && (host == domain
            || (host.parse::<std::net::IpAddr>().is_err() && host.ends_with(&format!(".{domain}"))))
}

fn capture_cookies(resp: &reqwest::Response, url: &Url) -> Result<(), String> {
    let mut store = COOKIES.lock().unwrap();
    let mut changed = false;
    for val in resp.headers().get_all(header::SET_COOKIE) {
        let Ok(text) = val.to_str() else { continue };
        let Ok(parsed) = cookie::Cookie::parse(text) else {
            continue;
        };
        // A cookie's Domain may narrow storage but never cross an origin.
        if let Some(domain) = parsed.domain() {
            if !url
                .host_str()
                .is_some_and(|host| cookie_domain_matches(host, domain))
            {
                continue;
            }
        }
        let expires_at = parsed
            .max_age()
            .map(|age| now_seconds() + age.whole_seconds())
            .or_else(|| parsed.expires_datetime().map(|date| date.unix_timestamp()));
        let jar = store.entry(url.origin().ascii_serialization()).or_default();
        if parsed.value().is_empty() || expires_at.is_some_and(|expiry| expiry <= now_seconds()) {
            jar.remove(parsed.name());
        } else {
            jar.insert(
                parsed.name().to_owned(),
                SavedCookie {
                    value: parsed.value().to_owned(),
                    path: parsed.path().unwrap_or("/").to_owned(),
                    secure: parsed.secure().unwrap_or(false),
                    expires_at,
                },
            );
        }
        changed = true;
    }
    if changed {
        save_cookies(&store)?;
    }
    Ok(())
}

struct RequestRegistration(String);
impl Drop for RequestRegistration {
    fn drop(&mut self) {
        REQUESTS.lock().unwrap().remove(&self.0);
    }
}

fn register_request(
    request_id: Option<String>,
) -> Result<(RequestRegistration, CancellationToken), String> {
    let id = request_id
        .unwrap_or_else(|| format!("rust-{}", NEXT_REQUEST.fetch_add(1, Ordering::Relaxed)));
    if id.is_empty() || id.len() > 128 {
        return Err("无效的请求标识".into());
    }
    let token = CancellationToken::new();
    let mut requests = REQUESTS.lock().unwrap();
    if requests.contains_key(&id) {
        return Err("请求标识正在使用".into());
    }
    requests.insert(id.clone(), token.clone());
    Ok((RequestRegistration(id), token))
}

#[tauri::command]
pub fn cancel_proxy_request(request_id: String) -> bool {
    let requests = REQUESTS.lock().unwrap();
    if let Some(token) = requests.get(&request_id) {
        token.cancel();
        true
    } else {
        false
    }
}

pub fn cancel_all_requests() {
    for token in REQUESTS.lock().unwrap().values() {
        token.cancel();
    }
}

#[derive(Serialize)]
pub struct ProxyResponse {
    pub status: u16,
    pub body: String,
    pub headers: HashMap<String, String>,
}

#[derive(Clone, Copy)]
enum ResponseKind {
    Api,
    Image,
    Stream,
}

fn resolve_request(server: &str, path: &str) -> Result<(Url, ResponseKind), String> {
    let (target, kind) = if path.starts_with("/__image__?") || path.starts_with("/__stream__?") {
        let (prefix, query) = path.split_once('?').unwrap();
        let target = url::form_urlencoded::parse(query.as_bytes())
            .find(|(name, _)| name == "url")
            .map(|(_, value)| value.into_owned())
            .ok_or("缺少资源地址")?;
        let full = if target.starts_with("http://") || target.starts_with("https://") {
            target
        } else {
            format!(
                "{}/{}",
                server.trim_end_matches('/'),
                target.trim_start_matches('/')
            )
        };
        (
            full,
            if prefix == "/__image__" {
                ResponseKind::Image
            } else {
                ResponseKind::Stream
            },
        )
    } else {
        if !path.starts_with('/') || path.starts_with("//") {
            return Err("API 路径必须以 / 开头".into());
        }
        (
            format!("{}/api/v1{path}", server.trim_end_matches('/')),
            ResponseKind::Api,
        )
    };
    Ok((crate::connect::validate_http_url(&target)?, kind))
}

#[tauri::command]
pub async fn proxy_api(
    method: String,
    path: String,
    body: Option<String>,
    headers: Option<HashMap<String, String>>,
    request_id: Option<String>,
) -> Result<ProxyResponse, String> {
    let server = crate::connect::load_server_url()?;
    if server.is_empty() {
        return Err("未配置服务器地址".into());
    }
    let origin = crate::connect::validate_http_url(&server)?.origin();
    let (url, kind) = resolve_request(&server, &path)?;
    let (_registration, cancellation) = register_request(request_id)?;
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err("请求已取消".into()),
        result = tokio::time::timeout(
            Duration::from_secs(if matches!(kind, ResponseKind::Api) { 30 } else { 90 }),
            fetch(&CLIENT, url, origin, method, body, headers.unwrap_or_default(), kind)
        ) => result.map_err(|_| "请求超时".to_owned())?,
    }
}

async fn fetch(
    client: &Client,
    mut url: Url,
    credential_origin: url::Origin,
    method: String,
    body: Option<String>,
    headers: HashMap<String, String>,
    kind: ResponseKind,
) -> Result<ProxyResponse, String> {
    let mut method = Method::from_bytes(method.as_bytes()).map_err(|_| "无效的请求方法")?;
    if !matches!(
        method.as_str(),
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
    ) {
        return Err("不支持的请求方法".into());
    }
    let mut body = body;
    let timeout = if matches!(kind, ResponseKind::Api) {
        30
    } else {
        90
    };
    for hop in 0..=5 {
        let mut req = client
            .request(method.clone(), url.clone())
            .timeout(Duration::from_secs(timeout));
        if matches!(kind, ResponseKind::Api) {
            req = req.header(header::ACCEPT, "application/json");
        }
        for (name, value) in &headers {
            // Browser callers cannot inject another account's credentials or alter
            // routing. Range and conditional requests pass through unchanged.
            if !matches!(
                name.to_ascii_lowercase().as_str(),
                "accept"
                    | "content-type"
                    | "range"
                    | "if-range"
                    | "if-none-match"
                    | "if-modified-since"
                    | "cache-control"
            ) {
                return Err(format!("不允许的请求头: {name}"));
            }
            req = req.header(name, value);
        }
        if url.origin() == credential_origin {
            if let Some(value) = cookie_header(&url) {
                req = req.header(header::COOKIE, value);
            }
        }
        if let Some(value) = &body {
            req = req
                .header(header::CONTENT_TYPE, "application/json")
                .body(value.clone());
        }
        let mut response = req.send().await.map_err(|e| format!("请求失败: {e}"))?;
        let status = response.status().as_u16();
        if url.origin() == credential_origin {
            capture_cookies(&response, &url)?;
        }
        if matches!(status, 301 | 302 | 303 | 307 | 308) {
            if let Some(location) = response
                .headers()
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
            {
                if hop == 5 {
                    return Err("重定向次数过多".into());
                }
                let next = url.join(location).map_err(|_| "无效的重定向地址")?;
                crate::connect::validate_http_url(next.as_str())?;
                if url.scheme() == "https" && next.scheme() != "https" {
                    return Err("拒绝 HTTPS 降级重定向".into());
                }
                if status == 303 || ((status == 301 || status == 302) && method == Method::POST) {
                    method = Method::GET;
                    body = None;
                }
                url = next;
                continue;
            }
        }
        let response_headers: HashMap<String, String> = response
            .headers()
            .iter()
            // Credentials remain in Rust, never in webview response metadata.
            .filter(|(name, _)| **name != header::SET_COOKIE)
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|v| (name.as_str().to_owned(), v.to_owned()))
            })
            .collect();
        let content_type = response_headers
            .get("content-type")
            .cloned()
            .unwrap_or_default();
        let limit = if matches!(kind, ResponseKind::Api) {
            16 * 1024 * 1024
        } else {
            64 * 1024 * 1024
        };
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("读取响应失败: {e}"))?
        {
            if bytes.len() + chunk.len() > limit {
                return Err("响应超过大小限制".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let success = (200..300).contains(&status);
        let binary = matches!(kind, ResponseKind::Stream)
            && (content_type.contains("video")
                || content_type.contains("audio")
                || content_type.contains("octet-stream")
                || url.path().ends_with(".m4s")
                || url.path().ends_with(".ts")
                || url.path().ends_with(".mp4"));
        let body = if matches!(kind, ResponseKind::Image) && success {
            format!(
                "data:{};base64,{}",
                content_type
                    .split(';')
                    .next()
                    .filter(|v| !v.is_empty())
                    .unwrap_or("image/jpeg"),
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )
        } else if binary && success {
            base64::engine::general_purpose::STANDARD.encode(bytes)
        } else {
            String::from_utf8_lossy(&bytes).into_owned()
        };
        return Ok(ProxyResponse {
            status,
            body,
            headers: response_headers,
        });
    }
    Err("重定向次数过多".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn local_server(reply: &'static str) -> (Url, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut buffer = [0; 4096];
            let n = socket.read(&mut buffer).unwrap();
            socket.write_all(reply.as_bytes()).unwrap();
            String::from_utf8_lossy(&buffer[..n]).into_owned()
        });
        (url, handle)
    }

    #[test]
    fn cookies_are_scoped_to_origin_path_and_expiration() {
        let a = Url::parse("http://127.0.0.1:3000/api/v1/me").unwrap();
        let b = Url::parse("http://127.0.0.1:3001/api/v1/me").unwrap();
        let mut store = CookieStore::new();
        let jar = store.entry(a.origin().ascii_serialization()).or_default();
        jar.insert(
            "session".into(),
            SavedCookie {
                value: "a-only".into(),
                path: "/api".into(),
                secure: false,
                expires_at: None,
            },
        );
        jar.insert(
            "expired".into(),
            SavedCookie {
                value: "bad".into(),
                path: "/".into(),
                secure: false,
                expires_at: Some(0),
            },
        );
        jar.insert(
            "secure".into(),
            SavedCookie {
                value: "bad".into(),
                path: "/".into(),
                secure: true,
                expires_at: None,
            },
        );
        assert_eq!(
            cookie_header_from(&store, &a).as_deref(),
            Some("session=a-only")
        );
        assert!(cookie_header_from(&store, &b).is_none());
        assert!(cookie_header_from(
            &store,
            &Url::parse("http://127.0.0.1:3000/apiculture").unwrap()
        )
        .is_none());
        assert!(cookie_domain_matches("www.example.com", ".EXAMPLE.com"));
        assert!(!cookie_domain_matches("badexample.com", ".example.com"));
        assert!(!cookie_domain_matches("127.0.0.1", "0.0.1"));
    }

    #[tokio::test]
    async fn multiple_account_cookies_are_captured_together() {
        let (url, handle) = local_server("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nSet-Cookie: mc_accounts_bag=bag-value; Domain=127.0.0.1; Path=/; HttpOnly\r\nSet-Cookie: mc_active_account=active-value; Path=/; HttpOnly\r\nConnection: close\r\n\r\nok");
        let result = fetch(
            &CLIENT,
            url.clone(),
            url.origin(),
            "GET".into(),
            None,
            HashMap::new(),
            ResponseKind::Api,
        )
        .await
        .unwrap();
        assert!(!result.headers.contains_key("set-cookie"));
        let header = cookie_header(&url).unwrap();
        assert!(header.contains("mc_accounts_bag=bag-value"));
        assert!(header.contains("mc_active_account=active-value"));
        COOKIES
            .lock()
            .unwrap()
            .remove(&url.origin().ascii_serialization());
        handle.join().unwrap();
    }

    #[tokio::test]
    async fn range_206_and_server_timing_survive_the_proxy() {
        let (url, handle) = local_server("HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Length: 3\r\nContent-Range: bytes 10-12/100\r\nServer-Timing: prep;dur=3\r\nConnection: close\r\n\r\nabc");
        let result = fetch(
            &CLIENT,
            url.clone(),
            url.origin(),
            "GET".into(),
            None,
            HashMap::from([("Range".into(), "bytes=10-12".into())]),
            ResponseKind::Stream,
        )
        .await
        .unwrap();
        assert_eq!(result.status, 206);
        assert_eq!(result.body, "YWJj");
        assert_eq!(result.headers["content-range"], "bytes 10-12/100");
        assert_eq!(result.headers["server-timing"], "prep;dur=3");
        assert!(handle
            .join()
            .unwrap()
            .to_lowercase()
            .contains("range: bytes=10-12"));
    }

    #[tokio::test]
    async fn credentials_are_not_forwarded_to_an_external_origin_or_redirect() {
        let (external, outside) =
            local_server("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let own = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        COOKIES
            .lock()
            .unwrap()
            .entry(own.origin().ascii_serialization())
            .or_default()
            .insert(
                "session".into(),
                SavedCookie {
                    value: "secret".into(),
                    path: "/".into(),
                    secure: false,
                    expires_at: None,
                },
            );
        let location = external.to_string();
        let redirect = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buf = [0; 4096];
            let n = socket.read(&mut buf).unwrap();
            socket.write_all(format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).unwrap();
            String::from_utf8_lossy(&buf[..n]).into_owned()
        });
        fetch(
            &CLIENT,
            own.clone(),
            own.origin(),
            "GET".into(),
            None,
            HashMap::new(),
            ResponseKind::Api,
        )
        .await
        .unwrap();
        assert!(redirect.join().unwrap().contains("secret"));
        assert!(!outside.join().unwrap().to_lowercase().contains("cookie:"));
        COOKIES
            .lock()
            .unwrap()
            .remove(&own.origin().ascii_serialization());
    }

    #[tokio::test]
    async fn cancellation_drops_an_in_flight_response_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buf = [0; 4096];
            socket.read(&mut buf).unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\na",
                )
                .unwrap();
            started_tx.send(()).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            // Dropping the reqwest future must close the actual connection.
            match socket.read(&mut buf) {
                Ok(0) => true,
                Err(error) => matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::BrokenPipe
                        | std::io::ErrorKind::UnexpectedEof
                ),
                _ => false,
            }
        });
        let (registration, token) = register_request(Some("cancel-test".into())).unwrap();
        let task = tokio::spawn(async move {
            let _registration = registration;
            tokio::select! {
                _ = token.cancelled() => Err("cancelled".to_owned()),
                result = fetch(&CLIENT, url.clone(), url.origin(), "GET".into(), None, HashMap::new(), ResponseKind::Api) => result,
            }
        });
        started_rx.await.unwrap();
        assert!(cancel_proxy_request("cancel-test".into()));
        assert_eq!(task.await.unwrap().err().as_deref(), Some("cancelled"));
        assert!(server.join().unwrap());
        assert!(!cancel_proxy_request("cancel-test".into()));
    }
}
