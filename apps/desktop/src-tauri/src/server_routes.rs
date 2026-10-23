//! Transport aliases are learned while authenticated, then proved anonymously before use.
//! Account, cookie and vault namespaces always remain the configured server URL.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{stream::FuturesUnordered, StreamExt};
use reqwest::{Client, Method, RequestBuilder, Response};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};
use url::Url;

#[derive(Clone, Deserialize, Serialize, PartialEq)]
struct Address {
    url: String,
    kind: String,
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
struct Book {
    instance_id: String,
    host_key: String,
    addresses: Vec<Address>,
}
struct Selection {
    book: Book,
    url: Url,
    verified: Instant,
    aliases: Vec<Url>,
}
static BOOKS: LazyLock<Mutex<HashMap<String, Book>>> = LazyLock::new(|| {
    Mutex::new(
        std::fs::read(path())
            .ok()
            .and_then(|v| serde_json::from_slice(&v).ok())
            .unwrap_or_default(),
    )
});
static SELECTED: LazyLock<Mutex<HashMap<String, Selection>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static PROBE_GATES: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static PROBES: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .build()
        .expect("anonymous route probes")
});
fn path() -> std::path::PathBuf {
    crate::connect::config_dir().join("server-addresses-v1.json")
}
fn namespace(base: &Url) -> String {
    crate::connect::server_namespace(base)
}

fn remap(from: &Url, to: &Url, target: &Url) -> Option<Url> {
    if !crate::connect::url_in_server_scope(from, target) {
        return None;
    }
    let suffix = target
        .path()
        .strip_prefix(from.path().trim_end_matches('/'))?;
    let mut url = to.clone();
    url.set_path(&format!("{}{}", to.path().trim_end_matches('/'), suffix));
    url.set_query(target.query());
    url.set_fragment(None);
    Some(url)
}
fn verify(book: &Book, nonce: &str, value: &serde_json::Value) -> bool {
    if value["instance_id"].as_str() != Some(&book.instance_id) {
        return false;
    }
    let Ok(key) = URL_SAFE_NO_PAD.decode(&book.host_key) else {
        return false;
    };
    let Some(proof) = value["proof"].as_str() else {
        return false;
    };
    let Ok(proof) = URL_SAFE_NO_PAD.decode(proof) else {
        return false;
    };
    key.len() == 32
        && ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
            .verify(
                format!("movieclaw-health\n{}\n{nonce}", book.instance_id).as_bytes(),
                &proof,
            )
            .is_ok()
}
async fn prove(book: Book, address: Address) -> Option<Url> {
    let base = crate::connect::validate_http_url(&address.url).ok()?;
    let nonce = crate::credential_vault::random_id().ok()?;
    let mut url = Url::parse(&format!(
        "{}/api/v1/health",
        base.as_str().trim_end_matches('/')
    ))
    .ok()?;
    url.query_pairs_mut().append_pair("nonce", &nonce);
    if address.kind != "lan" {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let response = PROBES
        .get(url)
        .timeout(Duration::from_millis(if address.kind == "lan" {
            1500
        } else {
            5000
        }))
        .send()
        .await
        .ok()?;
    if response.status() != 200 || response.content_length().is_some_and(|v| v > 8192) {
        return None;
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if bytes.len() + chunk.len() > 8192 {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    let value = serde_json::from_slice(&bytes).ok()?;
    verify(&book, &nonce, &value).then_some(base)
}
async fn select(base: &Url, force: bool, failed: Option<&Url>, require_https: bool) -> Option<Url> {
    let name = namespace(base);
    let gate = PROBE_GATES
        .lock()
        .unwrap()
        .entry(name.clone())
        .or_default()
        .clone();
    let _probe = gate.lock().await;
    let book = BOOKS.lock().unwrap().get(&name).cloned()?;
    if !force || failed.is_some() {
        if let Some(v) = SELECTED.lock().unwrap().get(&name).filter(|v| {
            v.book == book
                && v.verified.elapsed() < Duration::from_secs(300)
                && failed != Some(&v.url)
                && (!require_https || v.url.scheme() == "https")
        }) {
            return Some(v.url.clone());
        }
    }
    let mut probes = FuturesUnordered::new();
    for address in book.addresses.iter().take(8).filter(|v| {
        (!require_https || v.url.starts_with("https://"))
            && failed.is_none_or(|failed| {
                failed.as_str().trim_end_matches('/') != v.url.trim_end_matches('/')
            })
    }) {
        probes.push(prove(book.clone(), address.clone()));
    }
    // All probing is anonymous. A failed signature can never release credentials.
    while let Some(result) = probes.next().await {
        if let Some(url) = result {
            if BOOKS.lock().unwrap().get(&name) != Some(&book) {
                return None;
            }
            let mut selected = SELECTED.lock().unwrap();
            // Keep response URLs from in-flight transfers recognizable after a route switch.
            // Reverse mapping never authorizes a transport; send() still proves its destination.
            let mut aliases = selected
                .get(&name)
                .filter(|v| {
                    v.book.instance_id == book.instance_id && v.book.host_key == book.host_key
                })
                .map(|v| v.aliases.clone())
                .unwrap_or_default();
            aliases.retain(|v| v != &url);
            aliases.push(url.clone());
            if aliases.len() > 8 {
                aliases.remove(0);
            }
            selected.insert(
                name,
                Selection {
                    book,
                    url: url.clone(),
                    verified: Instant::now(),
                    aliases,
                },
            );
            return Some(url);
        }
    }
    if let Some(v) = SELECTED.lock().unwrap().get_mut(&name) {
        v.verified = Instant::now() - Duration::from_secs(301);
    }
    None
}
pub(crate) fn canonicalize(base: &Url, target: &Url) -> Url {
    SELECTED
        .lock()
        .unwrap()
        .get(&namespace(base))
        .and_then(|v| {
            v.aliases
                .iter()
                .find_map(|alias| remap(alias, base, target))
        })
        .unwrap_or_else(|| target.clone())
}
pub(crate) async fn send<F>(
    base: &Url,
    logical: &Url,
    method: &Method,
    require_https: bool,
    mut build: F,
) -> Result<Response, String>
where
    F: FnMut(Url) -> Result<RequestBuilder, String>,
{
    let scoped = crate::connect::url_in_server_scope(base, logical);
    let chosen = if scoped {
        select(base, false, None, require_https).await
    } else {
        None
    };
    let wire = chosen
        .as_ref()
        .and_then(|v| remap(base, v, logical))
        .unwrap_or_else(|| logical.clone());
    match build(wire.clone())?.send().await {
        Ok(response) => Ok(response),
        Err(error) => {
            if !scoped || !(error.is_connect() || error.is_timeout()) {
                return Err("服务器连接中断".into());
            }
            let failed = chosen.as_ref().unwrap_or(base);
            let alternative = select(base, true, Some(failed), require_https).await;
            // Never replay a write: the server may already have applied it.
            if !matches!(*method, Method::GET | Method::HEAD) {
                return Err("网络已切换，请重试本次操作".into());
            }
            let alternative = alternative
                .and_then(|v| remap(base, &v, logical))
                .ok_or("服务器暂时无法连接")?;
            build(alternative)?
                .send()
                .await
                .map_err(|_| "服务器暂时无法连接".into())
        }
    }
}
#[tauri::command]
pub async fn refresh_server_routes() -> Result<bool, String> {
    let context = crate::native_auth::load_context()?;
    let response =
        crate::api_proxy::proxy_api("GET".into(), "/server/addresses".into(), None, None, None)
            .await?;
    if response.status != 200 {
        return Ok(false);
    }
    let value: serde_json::Value =
        serde_json::from_str(&response.body).map_err(|_| "服务器地址簿无效")?;
    let book: Book =
        serde_json::from_value(value["data"].clone()).map_err(|_| "服务器地址簿无效")?;
    if book.instance_id.is_empty()
        || URL_SAFE_NO_PAD
            .decode(&book.host_key)
            .map_or(true, |v| v.len() != 32)
    {
        return Ok(false);
    }
    let base = crate::connect::validate_http_url(&context.server)?;
    let mut book = book;
    book.addresses.retain(|v| {
        matches!(v.kind.as_str(), "lan" | "wan")
            && crate::connect::validate_http_url(&v.url).is_ok()
    });
    book.addresses.truncate(8);
    crate::native_auth::with_current(&context, || {
        let mut books = BOOKS.lock().unwrap();
        books.insert(namespace(&base), book);
        let bytes = serde_json::to_vec(&*books).map_err(|_| "地址簿保存失败")?;
        std::fs::write(path(), bytes).map_err(|_| "地址簿保存失败")?;
        Ok(())
    })?;
    let require_https = crate::native_auth::identity(&context.server, None)?.is_none()
        && crate::api_proxy::cookie_snapshot(&base).requires_https(
            &Url::parse(&format!(
                "{}/api/v1/server/addresses",
                base.as_str().trim_end_matches('/')
            ))
            .map_err(|_| "服务器地址无效")?,
        );
    tokio::select! {
        _=context.cancellation.cancelled()=>Err("服务器或账号已更改".into()),
        selected=select(&base,true,None,require_https)=>Ok(selected.is_some()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::KeyPair;
    #[test]
    fn proof_binds_key_instance_and_nonce() {
        let pair = ring::signature::Ed25519KeyPair::from_seed_unchecked(&[7; 32]).unwrap();
        let book = Book {
            instance_id: "fixture-instance".into(),
            host_key: URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()),
            addresses: vec![],
        };
        let proof = pair.sign(b"movieclaw-health\nfixture-instance\nnonce");
        let value = serde_json::json!({"instance_id":"fixture-instance","proof":URL_SAFE_NO_PAD.encode(proof.as_ref())});
        assert!(verify(&book, "nonce", &value));
        assert!(!verify(&book, "replay", &value));
        let mut wrong = book.clone();
        wrong.instance_id = "other".into();
        assert!(!verify(&wrong, "nonce", &value));
        wrong = book.clone();
        wrong.host_key = URL_SAFE_NO_PAD.encode([8; 32]);
        assert!(!verify(&wrong, "nonce", &value));
    }
    #[test]
    fn aliases_preserve_paths_query_and_account_scope() {
        let base = Url::parse("https://example.test/movieclaw").unwrap();
        let lan = Url::parse("http://192.168.0.2:3000").unwrap();
        let resource =
            Url::parse("https://example.test/movieclaw/api/v1/stream?session=opaque").unwrap();
        let wire = remap(&base, &lan, &resource).unwrap();
        assert_eq!(
            wire.as_str(),
            "http://192.168.0.2:3000/api/v1/stream?session=opaque"
        );
        assert_eq!(remap(&lan, &base, &wire), Some(resource));
        assert!(remap(
            &base,
            &lan,
            &Url::parse("https://example.test/movieclaw-other/file").unwrap()
        )
        .is_none());
        assert!(remap(&base, &lan, &Url::parse("https://cdn.test/file").unwrap()).is_none());
    }
    async fn fixture(
        valid: bool,
    ) -> (
        Url,
        Book,
        std::sync::Arc<Mutex<Vec<String>>>,
        tokio::task::JoinHandle<()>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
        let pair = ring::signature::Ed25519KeyPair::from_seed_unchecked(&[11; 32]).unwrap();
        let book = Book {
            instance_id: "test-instance".into(),
            host_key: URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()),
            addresses: vec![Address {
                url: base.to_string(),
                kind: "lan".into(),
            }],
        };
        let records = std::sync::Arc::new(Mutex::new(Vec::new()));
        let captured = records.clone();
        let task = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buffer = vec![0; 16384];
                let n = socket.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..n]).to_string();
                let path = request.split_whitespace().nth(1).unwrap();
                let (status, body, extra) = if path.starts_with("/api/v1/health?") {
                    assert!(!request.to_lowercase().contains("authorization:"));
                    assert!(!request.to_lowercase().contains("cookie:"));
                    let nonce = Url::parse(&format!("http://fixture{path}"))
                        .unwrap()
                        .query_pairs()
                        .find(|(k, _)| k == "nonce")
                        .unwrap()
                        .1
                        .into_owned();
                    let proof =
                        pair.sign(format!("movieclaw-health\ntest-instance\n{nonce}").as_bytes());
                    (200,serde_json::json!({"instance_id":if valid {"test-instance"}else{"impostor"},"proof":URL_SAFE_NO_PAD.encode(proof.as_ref())}).to_string(),"")
                } else {
                    assert!(request
                        .to_lowercase()
                        .contains("authorization: bearer fixture-token"));
                    assert!(request.to_lowercase().contains("range: bytes=2-5"));
                    (206, "2345".into(), "Content-Range: bytes 2-5/8\r\n")
                };
                captured.lock().unwrap().push(request);
                let response=format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}",body.len());
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        (base, book, records, task)
    }
    fn unavailable() -> Url {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        Url::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap()
    }
    #[tokio::test]
    async fn cold_start_proves_alias_before_sending_credentials_and_preserves_range() {
        let (alias, book, records, task) = fixture(true).await;
        let base = unavailable();
        BOOKS.lock().unwrap().insert(namespace(&base), book);
        let target = base.join("/api/v1/media?session=fixture").unwrap();
        let response = send(&base, &target, &Method::GET, false, |wire| {
            Ok(PROBES
                .get(wire)
                .bearer_auth("fixture-token")
                .header("Range", "bytes=2-5"))
        })
        .await
        .unwrap();
        assert_eq!(response.status(), 206);
        assert_eq!(response.headers()["content-range"], "bytes 2-5/8");
        assert_eq!(response.text().await.unwrap(), "2345");
        assert_eq!(
            canonicalize(&base, &alias.join("/api/v1/media").unwrap()),
            base.join("/api/v1/media").unwrap()
        );
        assert_eq!(records.lock().unwrap().len(), 2);
        assert!(records.lock().unwrap()[1].starts_with("GET /api/v1/media?session=fixture "));
        let (next, next_book, _, next_task) = fixture(true).await;
        BOOKS.lock().unwrap().insert(namespace(&base), next_book);
        assert_eq!(select(&base, true, None, false).await, Some(next));
        assert_eq!(
            canonicalize(&base, &alias.join("/api/v1/late-playlist.m3u8").unwrap()),
            base.join("/api/v1/late-playlist.m3u8").unwrap()
        );
        next_task.abort();
        task.abort();
    }
    #[tokio::test]
    async fn impostor_receives_anonymous_probes_only() {
        let (_, book, records, task) = fixture(false).await;
        let base = unavailable();
        BOOKS.lock().unwrap().insert(namespace(&base), book);
        let target = base.join("/api/v1/auth/me").unwrap();
        assert!(send(&base, &target, &Method::GET, false, |wire| Ok(PROBES
            .get(wire)
            .bearer_auth("fixture-token")))
        .await
        .is_err());
        assert!(records
            .lock()
            .unwrap()
            .iter()
            .all(|v| v.starts_with("GET /api/v1/health?")));
        task.abort();
    }
    #[tokio::test]
    async fn simultaneous_requests_share_one_anonymous_probe() {
        let (_, book, records, task) = fixture(true).await;
        let base = unavailable();
        BOOKS.lock().unwrap().insert(namespace(&base), book);
        let (a, b) = tokio::join!(
            select(&base, false, None, false),
            select(&base, false, None, false)
        );
        assert!(a.is_some());
        assert_eq!(a, b);
        assert_eq!(records.lock().unwrap().len(), 1);
        task.abort();
    }
    #[tokio::test]
    async fn secure_cookie_policy_skips_a_previously_verified_http_alias() {
        let (_, book, records, task) = fixture(true).await;
        let mut base = unavailable();
        base.set_scheme("https").unwrap();
        BOOKS.lock().unwrap().insert(namespace(&base), book);
        assert!(select(&base, false, None, false).await.is_some());
        assert!(select(&base, false, None, true).await.is_none());
        assert_eq!(records.lock().unwrap().len(), 1);
        task.abort();
    }
    #[tokio::test]
    async fn a_write_is_not_replayed_after_transport_failure() {
        let (_, book, records, task) = fixture(true).await;
        let base = unavailable();
        let dead = unavailable();
        BOOKS.lock().unwrap().insert(namespace(&base), book.clone());
        SELECTED.lock().unwrap().insert(
            namespace(&base),
            Selection {
                book,
                url: dead,
                verified: Instant::now(),
                aliases: vec![],
            },
        );
        let mut attempts = 0;
        assert!(send(
            &base,
            &base.join("/api/v1/playback/sessions").unwrap(),
            &Method::POST,
            false,
            |wire| {
                attempts += 1;
                Ok(PROBES.post(wire).body("{}"))
            }
        )
        .await
        .is_err());
        assert_eq!(attempts, 1);
        assert_eq!(records.lock().unwrap().len(), 1);
        assert!(records.lock().unwrap()[0].starts_with("GET /api/v1/health?"));
        task.abort();
    }
}
