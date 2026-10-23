//! Isolated plugin browser. Credentials stay in Rust; every window has its own loopback origin.
use crate::{api_proxy, connect, native_auth};
use bytes::Bytes;
use futures_util::stream;
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full, Limited, StreamBody};
use hyper::{
    body::{Frame, Incoming},
    service::service_fn,
    Request, Response,
};
use hyper_util::rt::TokioIo;
use reqwest::{header, Client};
use serde_json::Value;
use std::{
    convert::Infallible,
    sync::{Arc, LazyLock},
    time::Duration,
};
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use url::Url;

type Body = UnsyncBoxBody<Bytes, std::io::Error>;
static CLIENT: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .build()
        .expect("plugin HTTP client")
});
struct Session {
    context: native_auth::Context,
    identity: Option<native_auth::Identity>,
    cookies: api_proxy::CookieSnapshot,
    base: Url,
    origin: String,
    secret: String,
    cookie: String,
    target: String,
    closed: CancellationToken,
}
fn reply(status: u16, message: impl Into<Bytes>) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("cache-control", "no-store")
        .body(
            Full::new(message.into())
                .map_err(|e: Infallible| match e {})
                .boxed_unsync(),
        )
        .unwrap()
}
fn location(base: &Url, value: &str) -> Result<Url, String> {
    let target = Url::parse(&format!("{}{}", base.as_str().trim_end_matches('/'), value))
        .map_err(|_| "插件地址无效")?;
    if !connect::url_in_server_scope(base, &target) || value.starts_with("//") {
        return Err("插件地址超出服务器范围".into());
    }
    Ok(target)
}
fn entry_target(
    server: &Url,
    apps: &Value,
    id: &str,
    index: usize,
) -> Result<(String, String), String> {
    let app = apps
        .as_array()
        .and_then(|v| v.iter().find(|v| v["id"] == id && v["nav"] == true))
        .ok_or("插件已移除、未加入导航或没有权限")?;
    let entry = app["entries"]
        .as_array()
        .and_then(|v| v.get(index))
        .ok_or("插件入口不存在")?;
    if id.is_empty()
        || !id
            .bytes()
            .all(|v| v.is_ascii_lowercase() || v.is_ascii_digit() || v == b'-')
    {
        return Err("插件标识无效".into());
    }
    let prefix = format!("/api/v1/plugins/{id}/web/");
    if app["base"].as_str() != Some(&prefix) {
        return Err("插件页面根地址无效".into());
    }
    let root = location(server, &prefix)?;
    let target = root
        .join(entry["path"].as_str().unwrap_or(""))
        .map_err(|_| "插件入口无效")?;
    if target.origin() != root.origin()
        || !target.path().starts_with(root.path())
        || target.fragment().is_some()
    {
        return Err("插件入口超出页面目录".into());
    }
    let relative = target
        .as_str()
        .strip_prefix(server.as_str().trim_end_matches('/'))
        .ok_or("插件入口无效")?;
    Ok((
        relative.into(),
        entry["label"]
            .as_str()
            .unwrap_or("MovieClaw 插件")
            .chars()
            .take(80)
            .collect(),
    ))
}
fn host_link(url: &Url) -> bool {
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    let id = |value: &str| {
        value
            .parse::<u64>()
            .is_ok_and(|v| v > 0 && v <= 9_007_199_254_740_991)
    };
    match parts.as_slice() {
        ["play", item] => id(item),
        ["library", library, "item", item] => id(library) && id(item),
        ["media", kind, item] => matches!(*kind, "movie" | "tv") && id(item),
        ["search"] => url.query().is_some_and(|q| q.len() <= 2048),
        _ => false,
    }
}
async fn handle(
    request: Request<Incoming>,
    session: Arc<Session>,
) -> Result<Response<Body>, Infallible> {
    let s = &session;
    if s.context.cancellation.is_cancelled()
        || s.closed.is_cancelled()
        || s.context.generation != native_auth::generation()
    {
        return Ok(reply(410, "账号已切换，请重新打开插件"));
    }
    let authority = s.origin.strip_prefix("http://").unwrap();
    if request.headers().get("host").and_then(|v| v.to_str().ok()) != Some(authority) {
        return Ok(reply(403, "无效的本地来源"));
    }
    if let Some(origin) = request.headers().get("origin") {
        if origin.to_str().ok() != Some(&s.origin) {
            return Ok(reply(403, "来源不匹配"));
        }
    }
    if request
        .headers()
        .get("sec-fetch-site")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| !matches!(v, "same-origin" | "none"))
    {
        return Ok(reply(403, "来源不匹配"));
    }
    if request.method() == "GET" && request.uri().path() == format!("/__launch/{}", s.secret) {
        let mut response = reply(303, "");
        response
            .headers_mut()
            .insert(header::LOCATION, s.target.parse().unwrap());
        response.headers_mut().insert(
            header::SET_COOKIE,
            format!(
                "{}={}; HttpOnly; SameSite=Strict; Path=/",
                s.cookie, s.secret
            )
            .parse()
            .unwrap(),
        );
        return Ok(response);
    }
    let authorized = request
        .headers()
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';')
                .any(|v| v.trim() == format!("{}={}", s.cookie, s.secret))
        });
    if !authorized {
        return Ok(reply(401, "请从 MovieClaw 打开插件"));
    }
    let path = request
        .uri()
        .path_and_query()
        .map(|v| v.as_str())
        .unwrap_or("/");
    // Plugins may use account domain APIs, but may not replace the native account's credentials.
    if path.starts_with("/api/v1/auth/")
        && !(request.method() == "GET" && path == "/api/v1/auth/me")
    {
        return Ok(reply(403, "请在 MovieClaw 账号面板管理登录"));
    }
    let target = match location(&s.base, path) {
        Ok(v) => v,
        Err(_) => return Ok(reply(403, "插件地址无效")),
    };
    let (parts, incoming) = request.into_parts();
    if !matches!(
        parts.method.as_str(),
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"
    ) {
        return Ok(reply(405, "不支持的请求方法"));
    }
    let body = tokio::select! {
        _ = s.context.cancellation.cancelled() => return Ok(reply(410,"账号已切换")),
        _ = s.closed.cancelled() => return Ok(reply(410,"插件已关闭")),
        result = tokio::time::timeout(Duration::from_secs(30),Limited::new(incoming,8*1024*1024).collect()) => match result {
            Ok(Ok(v)) => v.to_bytes(), _ => return Ok(reply(413,"插件请求过大或超时")),
        }
    };
    let require_https = s.identity.is_none() && s.cookies.requires_https(&target);
    let operation =
        crate::server_routes::send(&s.base, &target, &parts.method, require_https, |wire| {
            let mut outbound = CLIENT
                .request(parts.method.clone(), wire.clone())
                .body(body.clone())
                .header(
                    header::USER_AGENT,
                    concat!("MovieClaw-Windows/", env!("CARGO_PKG_VERSION")),
                );
            for name in [
                "accept",
                "content-type",
                "range",
                "if-range",
                "if-none-match",
                "if-modified-since",
                "last-event-id",
            ] {
                if let Some(value) = parts.headers.get(name) {
                    outbound = outbound.header(name, value);
                }
            }
            // Plugin CSRF/custom headers must survive, while proxy routing headers never do.
            for (name, value) in &parts.headers {
                let key = name.as_str();
                if key.starts_with("x-")
                    && !key.starts_with("x-forwarded-")
                    && !matches!(key, "x-real-ip" | "x-original-url" | "x-rewrite-url")
                {
                    outbound = outbound.header(name, value);
                }
            }
            if let Some(identity) = &s.identity {
                outbound = outbound.bearer_auth(&identity.token);
            } else if let Some(cookie) = s.cookies.header_for_transport(&target, &wire) {
                outbound = outbound.header(header::COOKIE, cookie);
            }
            Ok(outbound)
        });
    let response = tokio::select! {
        _=s.context.cancellation.cancelled()=>return Ok(reply(410,"账号已切换")),
        _=s.closed.cancelled()=>return Ok(reply(410,"插件已关闭")),
        result=tokio::time::timeout(Duration::from_secs(30),operation)=>match result {
            Ok(Ok(v))=>v, _=>return Ok(reply(502,"插件暂时无法连接服务器")),
        }
    };
    if response.status().as_u16() == 401 {
        if let Some(identity) = &s.identity {
            native_auth::invalidate(identity);
        }
    }
    let mut builder = Response::builder().status(response.status());
    for name in [
        "content-type",
        "content-range",
        "accept-ranges",
        "etag",
        "last-modified",
        "cache-control",
        "content-security-policy",
        "x-frame-options",
    ] {
        if let Some(value) = response.headers().get(name) {
            builder = builder.header(name, value);
        }
    }
    if response.status().is_redirection() {
        let next = response
            .headers()
            .get(header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| response.url().join(v).ok())
            .map(|v| crate::server_routes::canonicalize(&s.base, &v));
        let Some(next) = next.filter(|v| connect::url_in_server_scope(&s.base, v)) else {
            return Ok(reply(403, "插件重定向超出服务器范围"));
        };
        let relative = next
            .as_str()
            .strip_prefix(s.base.as_str().trim_end_matches('/'))
            .unwrap_or("/");
        builder = builder.header(header::LOCATION, relative);
    }
    let closed = s.closed.clone();
    let cancelled = s.context.cancellation.clone();
    let frames = stream::unfold(
        (response, closed, cancelled),
        |(mut response, closed, cancelled)| async move {
            let chunk = tokio::select! {
                _=closed.cancelled()=>return None,
                _=cancelled.cancelled()=>return None,
                result=response.chunk()=>result,
            };
            match chunk {
                Ok(Some(bytes)) => Some((Ok(Frame::data(bytes)), (response, closed, cancelled))),
                Ok(None) => None,
                Err(_) => Some((
                    Err(std::io::Error::other("插件响应中断")),
                    (response, closed, cancelled),
                )),
            }
        },
    );
    Ok(builder
        .body(StreamBody::new(frames).boxed_unsync())
        .unwrap())
}

#[tauri::command]
pub async fn open_plugin_page(
    app: tauri::AppHandle,
    entry_id: String,
    index: usize,
    client_epoch: u64,
) -> Result<(), String> {
    let context = native_auth::load_context()?;
    let metadata = api_proxy::proxy_api("GET".into(), "/ui/apps".into(), None, None, None).await?;
    if metadata.status != 200 {
        return Err("无法读取插件列表，请重新登录后重试".into());
    }
    let value: Value = serde_json::from_str(&metadata.body).map_err(|_| "插件列表无效")?;
    let base = connect::validate_http_url(&context.server)?;
    let (target, title) = entry_target(&base, &value["data"], &entry_id, index)?;
    let identity = native_auth::identity(&context.server, None)?;
    let cookies = api_proxy::cookie_snapshot(&base);
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| "无法打开插件窗口")?;
    let origin = format!(
        "http://127.0.0.1:{}",
        listener
            .local_addr()
            .map_err(|_| "无法读取插件端口")?
            .port()
    );
    let secret = crate::credential_vault::random_id()?;
    let closed = CancellationToken::new();
    let s = native_auth::with_current(&context, || {
        Ok(Arc::new(Session {
            context: context.clone(),
            identity,
            cookies,
            base,
            origin: origin.clone(),
            secret: secret.clone(),
            cookie: format!("mc_plugin_{secret}"),
            target,
            closed: closed.clone(),
        }))
    })?;
    let endpoint =
        Url::parse(&format!("{origin}/__launch/{secret}")).map_err(|_| "插件地址无效")?;
    let (ready, receive) = tokio::sync::oneshot::channel();
    let window_app = app.clone();
    let window_closed = closed.clone();
    let cancelled = context.cancellation.clone();
    app.run_on_main_thread(move || {
        if cancelled.is_cancelled() {
            let _ = ready.send(Err("账号已切换，请重新打开插件".into()));
            return;
        }
        let allowed = origin.clone();
        let navigation_app = window_app.clone();
        let navigation_cancel = cancelled.clone();
        let navigation_generation = context.generation;
        let result = WebviewWindowBuilder::new(
            &window_app,
            format!("plugin-{secret}"),
            WebviewUrl::External(endpoint),
        )
        .title(title)
        .inner_size(1100.0, 800.0)
        .min_inner_size(700.0, 500.0)
        .incognito(true)
        .on_navigation(move |url| {
            if navigation_cancel.is_cancelled()
                || navigation_generation != native_auth::generation()
                || url.origin().ascii_serialization() != allowed
            {
                return false;
            }
            if !host_link(url) {
                return true;
            }
            let target_app = navigation_app.clone();
            let payload =
                serde_json::json!({"path":url.path(),"query":url.query(),"epoch":client_epoch});
            let _ = navigation_app.run_on_main_thread(move || {
                use tauri::{Emitter, Manager};
                let _ = target_app.emit_to("main", "movieclaw:plugin-route", payload);
                if let Some(window) = target_app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            });
            false
        })
        .build()
        .map_err(|_| "无法创建插件窗口".to_owned());
        if let Ok(window) = &result {
            let cancel = window_closed.clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    cancel.cancel();
                }
            });
            let window = window.clone();
            tauri::async_runtime::spawn(async move {
                tokio::select! {_=cancelled.cancelled()=>{},_=window_closed.cancelled()=>{}}
                let _ = window.close();
            });
        }
        let _ = ready.send(result.map(|_| ()));
    })
    .map_err(|_| "无法安排插件窗口")?;
    receive.await.map_err(|_| "插件窗口未就绪")??;
    tauri::async_runtime::spawn(async move {
        let limits = Arc::new(tokio::sync::Semaphore::new(32));
        loop {
            let accepted = tokio::select! {_=s.closed.cancelled()=>break,_=s.context.cancellation.cancelled()=>break,r=listener.accept()=>r};
            let Ok((socket, _)) = accepted else { break };
            let Ok(permit) = limits.clone().try_acquire_owned() else {
                continue;
            };
            let session = s.clone();
            tauri::async_runtime::spawn(async move {
                let _permit = permit;
                let service_session = session.clone();
                let service = service_fn(move |request| handle(request, service_session.clone()));
                let mut builder = hyper::server::conn::http1::Builder::new();
                builder.max_buf_size(32 * 1024);
                tokio::select! {_=session.closed.cancelled()=>{},_=session.context.cancellation.cancelled()=>{},_=builder.serve_connection(TokioIo::new(socket),service)=>{}}
            });
        }
    });
    Ok(())
}

/// The packaged Windows smoke runs a real remote WebView2 page and attempts native IPC.
/// Only the explicit diagnostic environment enables this credential-free probe.
pub fn diagnostic_probe(app: tauri::AppHandle) {
    if std::env::var("MOVIECLAW_PLATFORM_SMOKE").as_deref() != Ok("1") {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let result=async {
            let listener=TcpListener::bind("127.0.0.1:0").await.map_err(|_|"bind")?;
            let origin=format!("http://{}",listener.local_addr().map_err(|_|"port")?);
            let label=format!("plugin-smoke-{}",crate::credential_vault::random_id().map_err(|_|"random")?);
            let (report,mut received)=tokio::sync::mpsc::channel(1);
            let service_task=tauri::async_runtime::spawn(async move {
                while let Ok((socket,_))=listener.accept().await {
                    let report=report.clone();
                    tauri::async_runtime::spawn(async move {
                        let service=service_fn(move |request:Request<Incoming>| {
                            let report=report.clone();async move {
                                if request.method()=="POST" && request.uri().path()=="/result" {
                                    if let Ok(bytes)=Limited::new(request.into_body(),1024).collect().await {
                                        if let Ok(value)=serde_json::from_slice::<Value>(&bytes.to_bytes()) {let _=report.try_send(value);}
                                    }
                                    return Ok::<_,Infallible>(reply(200,"ok"));
                                }
                                let mut page=reply(200,r#"<!doctype html><meta charset="utf-8"><title>Plugin isolation probe</title><script>
                                (async()=>{const invoke=window.__TAURI__?.core?.invoke||window.__TAURI_INTERNALS__?.invoke;const blocked=[];
                                for(const command of ['get_app_version','get_server_url','proxy_api']){
                                  if(!invoke){blocked.push(true);continue;}
                                  try{await invoke(command,{method:'GET',path:'/auth/me'});blocked.push(false);}catch(_){blocked.push(true);}
                                }
                                await fetch('/result',{method:'POST',body:JSON.stringify({passed:blocked.length===3&&blocked.every(Boolean),commands:blocked.length,bridgePresent:!!invoke})});})();
                                </script>"#);
                                page.headers_mut().insert(header::CONTENT_TYPE,"text/html; charset=utf-8".parse().unwrap());Ok(page)
                            }
                        });
                        let _=hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(socket),service).await;
                    });
                }
            });
            let endpoint=Url::parse(&origin).map_err(|_|"url")?;
            let (created,ready)=tokio::sync::oneshot::channel();let window_app=app.clone();let window_label=label.clone();
            app.run_on_main_thread(move || {
                let result=WebviewWindowBuilder::new(&window_app,window_label,WebviewUrl::External(endpoint))
                    .title("MovieClaw plugin isolation probe").visible(false).incognito(true)
                    .on_navigation(move |url|url.origin().ascii_serialization()==origin).build().map(|_|()).map_err(|_|"window");
                let _=created.send(result);
            }).map_err(|_|"dispatch")?;
            let outcome=async {ready.await.map_err(|_|"ready")??;
                tokio::time::timeout(Duration::from_secs(10),received.recv()).await.map_err(|_|"timeout")?.ok_or("closed")}.await;
            service_task.abort();
            use tauri::Manager;
            if let Some(window)=app.get_webview_window(&label) {let _=window.close();}
            outcome
        }.await;
        let value =
            result.unwrap_or_else(|reason| serde_json::json!({"passed":false,"reason":reason}));
        let _ = std::fs::write(
            crate::connect::config_dir().join("plugin-smoke.json"),
            value.to_string(),
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plugin_links_only_enter_known_movieclaw_routes() {
        for path in [
            "/play/12",
            "/library/1/item/3",
            "/media/tv/4",
            "/search?q=movie&private=1",
        ] {
            assert!(host_link(
                &Url::parse(&format!("http://127.0.0.1:4179{path}")).unwrap()
            ));
        }
        for path in [
            "/play/0",
            "/play/9999999999999999999999999",
            "/api/v1/auth/me",
            "/settings",
            "/media/unknown/1",
            "/search",
        ] {
            assert!(!host_link(
                &Url::parse(&format!("http://127.0.0.1:4179{path}")).unwrap()
            ));
        }
    }
    #[test]
    fn only_server_advertised_visible_entries_can_open() {
        let base = Url::parse("https://nas.test/movieclaw").unwrap();
        let mut apps = serde_json::json!([{"id":"watch-friends","nav":true,"base":"/api/v1/plugins/watch-friends/web/","entries":[{"label":"映迹","path":""}]}]);
        assert_eq!(
            entry_target(&base, &apps, "watch-friends", 0).unwrap().0,
            "/api/v1/plugins/watch-friends/web/"
        );
        assert!(entry_target(&base, &apps, "missing", 0).is_err());
        apps[0]["entries"][0]["path"] = "history?tab=friends".into();
        assert_eq!(
            entry_target(&base, &apps, "watch-friends", 0).unwrap().0,
            "/api/v1/plugins/watch-friends/web/history?tab=friends"
        );
        assert!(entry_target(&base, &apps, "watch-friends", 1).is_err());
        apps[0]["nav"] = false.into();
        assert!(entry_target(&base, &apps, "watch-friends", 0).is_err());
        apps[0]["nav"] = true.into();
        for path in [
            "https://evil.test/",
            "../../auth/me",
            "//evil.test/",
            "%2e%2e/secret",
        ] {
            apps[0]["entries"][0]["path"] = path.into();
            assert!(entry_target(&base, &apps, "watch-friends", 0).is_err());
        }
    }
    #[test]
    fn loopback_window_forwards_session_privately_and_rejects_foreign_origins_and_retired_accounts()
    {
        native_auth::with_context_read(|| {
            use std::io::{Read, Write};
            let upstream = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let base = Url::parse(&format!("http://{}", upstream.local_addr().unwrap())).unwrap();
            let remote = std::thread::spawn(move || {
                for index in 0..2 {
                    let (mut socket, _) = upstream.accept().unwrap();
                    socket
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut buf = [0; 8192];
                    let n = socket.read(&mut buf).unwrap();
                    let request = String::from_utf8_lossy(&buf[..n]);
                    if index == 0 {
                        assert!(request.starts_with("GET /api/v1/plugins/watch-friends/web/ "));
                    } else {
                        assert!(
                            request.starts_with("POST /api/v1/plugins/watch-friends/preferences ")
                        );
                        assert!(request.to_lowercase().contains("x-friends-request: 1"));
                        assert!(!request.to_lowercase().contains("x-forwarded-for:"));
                        assert!(!request.to_lowercase().contains("origin:"));
                    }
                    assert!(request.contains("session=private-fixture"));
                    assert!(!request.contains("window-secret"));
                    socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nSet-Cookie: session=never-visible\r\nContent-Length: 7\r\nConnection: close\r\n\r\nfixture").unwrap();
                }
            });
            tokio::runtime::Runtime::new().unwrap().block_on(async {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let origin = format!("http://{}", listener.local_addr().unwrap());
                let session = Arc::new(Session {
                    context: native_auth::test_context(base.to_string()),
                    identity: None,
                    cookies: api_proxy::CookieSnapshot::test_cookie(
                        &base,
                        "session",
                        "private-fixture",
                        "/",
                    ),
                    base,
                    origin: origin.clone(),
                    secret: "window-secret".into(),
                    cookie: "window-cookie".into(),
                    target: "/api/v1/plugins/watch-friends/web/".into(),
                    closed: CancellationToken::new(),
                });
                let s = session.clone();
                let task = tokio::spawn(async move {
                    while let Ok((socket, _)) = listener.accept().await {
                        let s = s.clone();
                        tokio::spawn(async move {
                            let service = service_fn(move |r| handle(r, s.clone()));
                            let _ = hyper::server::conn::http1::Builder::new()
                                .serve_connection(TokioIo::new(socket), service)
                                .await;
                        });
                    }
                });
                let client = Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .unwrap();
                assert_eq!(
                    client
                        .get(format!("{origin}/api/v1/auth/me"))
                        .send()
                        .await
                        .unwrap()
                        .status(),
                    401
                );
                let launched = client
                    .get(format!("{origin}/__launch/window-secret"))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(launched.status(), 303);
                assert!(launched.headers()[header::SET_COOKIE]
                    .to_str()
                    .unwrap()
                    .contains("HttpOnly; SameSite=Strict"));
                let cookie = "window-cookie=window-secret";
                let content = client
                    .get(format!("{origin}/api/v1/plugins/watch-friends/web/"))
                    .header(header::COOKIE, cookie)
                    .send()
                    .await
                    .unwrap();
                assert!(!content.headers().contains_key(header::SET_COOKIE));
                assert_eq!(content.text().await.unwrap(), "fixture");
                let mutation = client
                    .post(format!("{origin}/api/v1/plugins/watch-friends/preferences"))
                    .header(header::COOKIE, cookie)
                    .header("X-Friends-Request", "1")
                    .header(header::ORIGIN, &origin)
                    .header("X-Forwarded-For", "evil")
                    .body("{}")
                    .send()
                    .await
                    .unwrap();
                assert_eq!(mutation.status(), 200);
                assert_eq!(mutation.text().await.unwrap(), "fixture");
                assert_eq!(
                    client
                        .post(format!("{origin}/api/v1/auth/device/login"))
                        .header(header::COOKIE, cookie)
                        .send()
                        .await
                        .unwrap()
                        .status(),
                    403
                );
                assert_eq!(
                    client
                        .get(format!("{origin}/api/v1/auth/me"))
                        .header(header::COOKIE, cookie)
                        .header(header::ORIGIN, "http://evil.test")
                        .send()
                        .await
                        .unwrap()
                        .status(),
                    403
                );
                session.context.cancellation.cancel();
                assert_eq!(
                    client
                        .get(format!("{origin}/api/v1/auth/me"))
                        .header(header::COOKIE, cookie)
                        .send()
                        .await
                        .unwrap()
                        .status(),
                    410
                );
                task.abort();
            });
            remote.join().unwrap();
        });
    }
}
