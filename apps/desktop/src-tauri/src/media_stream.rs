//! Loopback streaming capabilities bind media to one origin/account/generation.
//! Credential headers and upstream signed URLs never appear in the local URL.
use crate::{api_proxy, connect, credential_vault, native_auth};
use reqwest::{header, Client, Method};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Semaphore,
};
use tokio_util::sync::CancellationToken;
use url::Url;

static LEASES: LazyLock<Mutex<HashMap<String, Lease>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static PORT: OnceLock<u16> = OnceLock::new();
static START: Mutex<()> = Mutex::new(());
static CONNECTIONS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(8)));
static CLIENT: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("media HTTP client")
});

#[derive(Clone)]
struct Lease {
    target: Url,
    origin: url::Origin,
    identity: Option<native_auth::Identity>,
    cookie: Option<String>,
    generation: u64,
    expires: Instant,
    cancellation: CancellationToken,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamGrant {
    pub stream_id: String,
    pub url: String,
}

fn start() -> Result<u16, String> {
    let _guard = START.lock().unwrap();
    if let Some(port) = PORT.get() {
        return Ok(*port);
    }
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .map_err(|_| "无法启动本地媒体传输")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "无法配置本地媒体传输")?;
    let port = listener
        .local_addr()
        .map_err(|_| "无法读取本地媒体端口")?
        .port();
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = TcpListener::from_std(listener) else {
            return;
        };
        while let Ok((socket, address)) = listener.accept().await {
            if !address.ip().is_loopback() {
                continue;
            }
            let permit = CONNECTIONS.clone().try_acquire_owned();
            tauri::async_runtime::spawn(async move {
                if let Ok(_permit) = permit {
                    let _ = serve(socket).await;
                } else {
                    let mut socket = socket;
                    let _ = reply(&mut socket, 503, "Media stream concurrency limit").await;
                }
            });
        }
    });
    let _ = PORT.set(port);
    Ok(port)
}

pub fn grant_native(value: &str) -> Result<StreamGrant, String> {
    let captured_generation = native_auth::generation();
    let server = connect::load_server_url()?;
    if server.is_empty() {
        return Err("未配置服务器".into());
    }
    let base = connect::validate_http_url(&server)?;
    let mut target = if value.starts_with("http://") || value.starts_with("https://") {
        connect::validate_http_url(value)?
    } else {
        connect::validate_http_url(&format!(
            "{}/{}",
            server.trim_end_matches('/'),
            value.trim_start_matches('/')
        ))?
    };
    let username = target
        .query_pairs()
        .find(|(name, _)| name == "mc_account")
        .map(|(_, value)| value.into_owned());
    if username.is_some() {
        let remaining: Vec<_> = target
            .query_pairs()
            .filter(|(name, _)| name != "mc_account")
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .collect();
        target.set_query(None);
        target.query_pairs_mut().extend_pairs(remaining);
    }
    let same_origin = target.origin() == base.origin();
    let identity = if same_origin {
        native_auth::identity(&server, username.as_deref())?
    } else {
        None
    };
    let cookie = if same_origin && identity.is_none() {
        api_proxy::cookie_header(&target)
    } else {
        None
    };
    if captured_generation != native_auth::generation() {
        return Err("服务器或账号已更改".into());
    }
    let id = format!(
        "{}{}",
        credential_vault::random_id()?,
        credential_vault::random_id()?
    );
    let port = start()?;
    let mut leases = LEASES.lock().unwrap();
    leases.retain(|_, lease| lease.expires > Instant::now() && !lease.cancellation.is_cancelled());
    if leases.len() >= 128 {
        return Err("媒体传输句柄过多，请关闭旧播放后重试".into());
    }
    leases.insert(
        id.clone(),
        Lease {
            target,
            origin: base.origin(),
            identity,
            cookie,
            generation: captured_generation,
            expires: Instant::now() + Duration::from_secs(4 * 3600),
            cancellation: CancellationToken::new(),
        },
    );
    Ok(StreamGrant {
        url: format!("http://127.0.0.1:{port}/media/{id}"),
        stream_id: id,
    })
}
#[tauri::command]
pub fn grant_media_stream(url: String) -> Result<StreamGrant, String> {
    grant_native(&url)
}
#[tauri::command]
pub fn release_media_stream(stream_id: String) -> bool {
    release(&stream_id)
}
pub fn release(id: &str) -> bool {
    if let Some(lease) = LEASES.lock().unwrap().remove(id) {
        lease.cancellation.cancel();
        true
    } else {
        false
    }
}
fn renew_at(lease: &mut Lease, now: Instant) -> bool {
    if lease.generation != native_auth::generation()
        || lease.cancellation.is_cancelled()
        || lease.expires <= now
    {
        return false;
    }
    lease.expires = now + Duration::from_secs(4 * 3600);
    true
}
pub fn renew(id: &str) -> bool {
    LEASES
        .lock()
        .unwrap()
        .get_mut(id)
        .is_some_and(|lease| renew_at(lease, Instant::now()))
}
#[tauri::command]
pub fn renew_media_stream(stream_id: String) -> bool {
    renew(&stream_id)
}
pub fn revoke_all() {
    for (_, lease) in LEASES.lock().unwrap().drain() {
        lease.cancellation.cancel();
    }
}

fn trusted_origin(origin: &str) -> bool {
    matches!(
        origin,
        "http://tauri.localhost"
            | "https://tauri.localhost"
            | "tauri://localhost"
            | "http://localhost:1420"
    )
}
async fn reply(socket: &mut TcpStream, status: u16, message: &str) -> Result<(), String> {
    socket.write_all(format!("HTTP/1.1 {status} Error\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{message}",message.len()).as_bytes()).await.map_err(|_|"local socket closed".into())
}
async fn serve(mut socket: TcpStream) -> Result<(), String> {
    let mut input = Vec::new();
    let mut buffer = [0; 1024];
    loop {
        let count = tokio::time::timeout(Duration::from_secs(5), socket.read(&mut buffer))
            .await
            .map_err(|_| "request header timeout")?
            .map_err(|_| "local socket closed")?;
        if count == 0 {
            return Ok(());
        }
        input.extend_from_slice(&buffer[..count]);
        if input.len() > 16 * 1024 {
            return reply(&mut socket, 431, "Request header too large").await;
        }
        if input.windows(4).any(|v| v == b"\r\n\r\n") {
            break;
        }
    }
    let text = std::str::from_utf8(&input).map_err(|_| "invalid request")?;
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split_whitespace();
    let method = first.next().unwrap_or_default();
    let path = first.next().unwrap_or_default();
    if !matches!(method, "GET" | "HEAD" | "OPTIONS") {
        return reply(&mut socket, 405, "Method not allowed").await;
    }
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }
    let origin = headers.get("origin");
    if origin.is_some_and(|value| !trusted_origin(value)) {
        return reply(&mut socket, 403, "Origin not allowed").await;
    }
    let Some(id) = path
        .strip_prefix("/media/")
        .filter(|v| !v.is_empty() && v.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'))
    else {
        return reply(&mut socket, 404, "Unknown media capability").await;
    };
    let lease = {
        let mut leases = LEASES.lock().unwrap();
        leases.get_mut(id).and_then(|lease| if renew_at(lease, Instant::now()) {Some(lease.clone())} else {None})
    };
    let Some(lease) = lease.filter(|v| {
        v.generation == native_auth::generation()
            && v.expires > Instant::now()
            && !v.cancellation.is_cancelled()
    }) else {
        return reply(&mut socket, 410, "Media capability expired").await;
    };
    if method == "OPTIONS" {
        let origin = origin
            .map(String::as_str)
            .unwrap_or("http://tauri.localhost");
        return socket.write_all(format!("HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: {origin}\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range, If-Range, If-None-Match, If-Modified-Since, Accept\r\nAccess-Control-Max-Age: 60\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.map_err(|_|"local socket closed".into());
    }
    let transfer = async {
        let response = upstream(&lease, method, &headers).await?;
        pipe_response(
            &mut socket,
            response,
            origin.map(String::as_str),
            method == "HEAD",
        )
        .await
    };
    tokio::select! {biased;_ = lease.cancellation.cancelled()=>Ok(()),result=transfer=>result}
}
async fn upstream(
    lease: &Lease,
    method: &str,
    headers: &HashMap<String, String>,
) -> Result<reqwest::Response, String> {
    let mut url = lease.target.clone();
    for hop in 0..=5 {
        let mut request = CLIENT.request(
            if method == "HEAD" {
                Method::HEAD
            } else {
                Method::GET
            },
            url.clone(),
        );
        for name in [
            "range",
            "if-range",
            "if-none-match",
            "if-modified-since",
            "accept",
        ] {
            if let Some(value) = headers.get(name) {
                request = request.header(name, value);
            }
        }
        if url.origin() == lease.origin {
            if let Some(identity) = &lease.identity {
                request = request.bearer_auth(&identity.token);
            } else if let Some(cookie) = &lease.cookie {
                request = request.header(header::COOKIE, cookie);
            }
        }
        let response = tokio::time::timeout(Duration::from_secs(30), request.send())
            .await
            .map_err(|_| "media response timeout")?
            .map_err(|_| "media upstream failed")?;
        if response.status().as_u16() == 401 {
            if let Some(identity) = &lease.identity {
                native_auth::invalidate(identity);
            }
        }
        if matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            if hop == 5 {
                return Err("media redirect limit".into());
            }
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("invalid media redirect")?;
            let next = url.join(location).map_err(|_| "invalid media redirect")?;
            connect::validate_http_url(next.as_str())?;
            if url.scheme() == "https" && next.scheme() != "https" {
                return Err("media HTTPS downgrade refused".into());
            }
            url = next;
            continue;
        }
        return Ok(response);
    }
    Err("media redirect limit".into())
}
async fn pipe_response(
    socket: &mut TcpStream,
    mut response: reqwest::Response,
    origin: Option<&str>,
    head: bool,
) -> Result<(), String> {
    let status = response.status().as_u16();
    let content_length = response
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    let mut output =
        format!("HTTP/1.1 {status} Media\r\nConnection: close\r\nCache-Control: no-store\r\n");
    for name in [
        "content-type",
        "content-range",
        "accept-ranges",
        "etag",
        "last-modified",
        "server-timing",
    ] {
        if let Some(value) = response.headers().get(name).and_then(|v| v.to_str().ok()) {
            output.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    if let Some(length) = content_length {
        output.push_str(&format!("Content-Length: {length}\r\n"));
    } else if !head {
        output.push_str("Transfer-Encoding: chunked\r\n");
    }
    if let Some(origin) = origin {
        output.push_str(&format!("Access-Control-Allow-Origin: {origin}\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, ETag, Server-Timing\r\nVary: Origin\r\n"));
    }
    output.push_str("\r\n");
    socket
        .write_all(output.as_bytes())
        .await
        .map_err(|_| "local socket closed")?;
    if head {
        return Ok(());
    }
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "media response interrupted")?
    {
        let write = async {
            if content_length.is_none() {
                socket
                    .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                    .await?;
            }
            socket.write_all(&chunk).await?;
            if content_length.is_none() {
                socket.write_all(b"\r\n").await?;
            }
            Ok::<_, std::io::Error>(())
        };
        tokio::time::timeout(Duration::from_secs(15), write)
            .await
            .map_err(|_| "media consumer stalled")?
            .map_err(|_| "local socket closed")?;
    }
    if content_length.is_none() {
        socket
            .write_all(b"0\r\n\r\n")
            .await
            .map_err(|_| "local socket closed")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_desktop_origins_can_read_media_capabilities() {
        assert!(trusted_origin("http://tauri.localhost"));
        assert!(!trusted_origin("https://attacker.test"));
        assert!(!trusted_origin("null"));
    }
    #[tokio::test]
    async fn streaming_range_preserves_partial_content_without_base64() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            use std::io::{Read, Write};
            let (mut socket, _) = listener.accept().unwrap();
            let mut buffer = [0; 8192];
            let count = socket.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..count]);
            assert!(request.to_ascii_lowercase().contains("range: bytes=2-5"));
            assert!(!request.to_ascii_lowercase().contains("cookie:"));
            socket.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 4\r\nContent-Range: bytes 2-5/8\r\nContent-Type: video/mp4\r\n\r\ncdef").unwrap();
        });
        let lease = Lease {
            target: Url::parse(&format!("http://{address}/video")).unwrap(),
            origin: Url::parse("https://configured.test").unwrap().origin(),
            identity: None,
            cookie: Some("must-not-leak".into()),
            generation: generation(),
            expires: Instant::now() + Duration::from_secs(5),
            cancellation: CancellationToken::new(),
        };
        let response = upstream(
            &lease,
            "GET",
            &HashMap::from([("range".into(), "bytes=2-5".into())]),
        )
        .await
        .unwrap();
        assert_eq!(response.status().as_u16(), 206);
        assert_eq!(response.headers()["content-range"], "bytes 2-5/8");
        assert_eq!(response.bytes().await.unwrap(), "cdef");
        server.join().unwrap();
    }
    fn generation() -> u64 {
        native_auth::generation()
    }
    #[test]
    fn active_capability_renews_but_revoked_or_expired_capability_cannot_return() {
        let now = Instant::now();
        let mut lease = Lease {
            target: Url::parse("https://server/media").unwrap(),
            origin: Url::parse("https://server").unwrap().origin(),
            identity: None,
            cookie: None,
            generation: generation(),
            expires: now + Duration::from_secs(1),
            cancellation: CancellationToken::new(),
        };
        assert!(renew_at(&mut lease, now));
        assert!(lease.expires >= now + Duration::from_secs(4 * 3600));
        lease.cancellation.cancel();
        assert!(!renew_at(&mut lease, now));
        lease.cancellation = CancellationToken::new();
        lease.expires = now - Duration::from_secs(1);
        assert!(!renew_at(&mut lease, now));
    }
}
