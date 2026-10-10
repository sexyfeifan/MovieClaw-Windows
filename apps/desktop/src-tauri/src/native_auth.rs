//! Native device authentication. JavaScript receives identity metadata, never credentials.
use crate::{api_proxy, connect, credential_vault as vault};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        LazyLock, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;

static GENERATION: AtomicU64 = AtomicU64::new(1);
static CONTEXT_CANCEL: LazyLock<Mutex<CancellationToken>> =
    LazyLock::new(|| Mutex::new(CancellationToken::new()));
static MUTATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static STORE: LazyLock<Mutex<HashMap<String, SavedOrigin>>> =
    LazyLock::new(|| Mutex::new(load_store()));
static PAIRS: LazyLock<Mutex<HashMap<String, Pairing>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static CLIENT: LazyLock<Client> = LazyLock::new(|| {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .expect("native auth client")
});

#[derive(Clone, Default, Serialize, Deserialize)]
struct SavedOrigin {
    active: Option<String>,
    accounts: Vec<Value>,
}
#[derive(Clone)]
struct Context {
    server: String,
    origin: String,
    generation: u64,
    cancellation: CancellationToken,
}
#[derive(Clone)]
struct Pairing {
    context: Context,
    device_code: String,
    cancellation: CancellationToken,
    expires_at: u64,
    interval: u64,
    next_poll: u64,
}
#[derive(Clone)]
pub(crate) struct Identity {
    pub origin: String,
    pub username: String,
    pub token: String,
    pub generation: u64,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn fail(status: u16, code: &str, message: &str) -> String {
    json!({"status":status,"code":code,"message":message}).to_string()
}
fn load_context() -> Result<Context, String> {
    let server = connect::load_server_url()?;
    if server.is_empty() {
        return Err(fail(400, "NO_SERVER", "请先选择服务器"));
    }
    Ok(Context {
        origin: connect::validate_http_url(&server)?
            .origin()
            .ascii_serialization(),
        server,
        generation: generation(),
        cancellation: CONTEXT_CANCEL.lock().unwrap().clone(),
    })
}
fn ensure_current(context: &Context) -> Result<(), String> {
    if context.generation != generation() || context.cancellation.is_cancelled() {
        return Err(fail(409, "CONTEXT_CHANGED", "服务器或账号已更改，请重试"));
    }
    Ok(())
}
pub(crate) fn generation() -> u64 {
    GENERATION.load(Ordering::SeqCst)
}
pub(crate) fn change_context() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    let mut token = CONTEXT_CANCEL.lock().unwrap();
    token.cancel();
    *token = CancellationToken::new();
    for (_, pair) in PAIRS.lock().unwrap().drain() {
        pair.cancellation.cancel();
    }
    api_proxy::cancel_all_requests();
    crate::media_stream::revoke_all();
}
fn load_store() -> HashMap<String, SavedOrigin> {
    std::fs::read(connect::config_dir().join("accounts.json"))
        .ok()
        .and_then(|v| serde_json::from_slice(&v).ok())
        .unwrap_or_default()
}
fn persist(store: &HashMap<String, SavedOrigin>) -> Result<(), String> {
    let path = connect::config_dir().join("accounts.json");
    let temp = path.with_extension("tmp");
    std::fs::write(
        &temp,
        serde_json::to_vec(store).map_err(|_| fail(500, "LOCAL_STORAGE", "账号信息无法保存"))?,
    )
    .map_err(|_| fail(500, "LOCAL_STORAGE", "账号信息无法保存"))?;
    #[cfg(windows)]
    if path.exists() {
        std::fs::remove_file(&path).map_err(|_| fail(500, "LOCAL_STORAGE", "账号信息无法保存"))?;
    }
    std::fs::rename(temp, path).map_err(|_| fail(500, "LOCAL_STORAGE", "账号信息无法保存"))
}
fn account(session: &Value, active: bool, authenticated: bool) -> Value {
    json!({"username":session["username"],"nickname":session["nickname"],"avatar_url":session["avatar_url"],"role":session.get("role").cloned().unwrap_or(json!("admin")),"active":active,"authenticated":authenticated})
}
fn accounts(origin: &str) -> Result<Vec<Value>, String> {
    let record = STORE
        .lock()
        .unwrap()
        .get(origin)
        .cloned()
        .unwrap_or_default();
    record
        .accounts
        .iter()
        .map(|v| {
            let username = v["username"].as_str().unwrap_or_default();
            Ok(account(
                v,
                record.active.as_deref() == Some(username),
                vault::read(&vault::token_key(origin, username))?.is_some(),
            ))
        })
        .collect()
}
pub(crate) fn identity(server: &str, username: Option<&str>) -> Result<Option<Identity>, String> {
    let captured_generation = generation();
    let origin = connect::validate_http_url(server)?
        .origin()
        .ascii_serialization();
    let selected = username.map(str::to_owned).or_else(|| {
        STORE
            .lock()
            .unwrap()
            .get(&origin)
            .and_then(|v| v.active.clone())
    });
    let Some(username) = selected else {
        return Ok(None);
    };
    let token = vault::read(&vault::token_key(&origin, &username))?;
    if captured_generation != generation() {
        return Err(fail(409, "CONTEXT_CHANGED", "服务器或账号已更改，请重试"));
    }
    Ok(token.map(|token| Identity {
        origin,
        username,
        token,
        generation: captured_generation,
    }))
}
pub(crate) fn invalidate(identity: &Identity) {
    let key = vault::token_key(&identity.origin, &identity.username);
    if vault::read(&key).ok().flatten().as_deref() == Some(identity.token.as_str()) {
        let _ = vault::delete(&key);
    }
}
async fn request(
    context: &Context,
    method: Method,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
    cancellation: Option<&CancellationToken>,
) -> Result<(u16, Value), String> {
    ensure_current(context)?;
    let mut req = CLIENT
        .request(method, format!("{}/api/v1{path}", context.server))
        .header("Accept", "application/json");
    if let Some(token) = token {
        req = req.bearer_auth(token);
    }
    if let Some(body) = body {
        req = req.json(&body);
    }
    let operation = async {
        let mut response = req
            .send()
            .await
            .map_err(|_| fail(0, "NETWORK", "服务器暂时无法连接，请重试"))?;
        let status = response.status().as_u16();
        if (300..400).contains(&status) {
            return Err(fail(
                status,
                "REDIRECT",
                "认证接口不能重定向，请检查服务器地址",
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| fail(0, "NETWORK", "服务器响应中断"))?
        {
            if bytes.len() + chunk.len() > 256 * 1024 {
                return Err(fail(502, "INVALID_RESPONSE", "认证响应过大"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let data: Value = serde_json::from_slice(&bytes)
            .map_err(|_| fail(status, "INVALID_RESPONSE", "服务器返回的认证数据无效"))?;
        Ok((status, data))
    };
    let pair_token = cancellation.cloned().unwrap_or_else(CancellationToken::new);
    tokio::select! { biased;
        _ = context.cancellation.cancelled() => Err(fail(409,"CONTEXT_CHANGED","服务器或账号已更改，请重试")),
        _ = pair_token.cancelled() => Err(fail(409,"PAIR_CANCELLED","配对已取消")),
        result = operation => { ensure_current(context)?; result }
    }
}
fn data(status: u16, value: Value) -> Result<Value, String> {
    if !(200..300).contains(&status) {
        return Err(fail(
            status,
            value["code"].as_str().unwrap_or("AUTH_FAILED"),
            value["message"].as_str().unwrap_or("认证请求失败"),
        ));
    }
    Ok(value.get("data").cloned().unwrap_or(Value::Null))
}
async fn cookie_request(
    context: &Context,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    ensure_current(context)?;
    let response = api_proxy::cookie_api(
        &context.server,
        &context.cancellation,
        method,
        path,
        body.map(|v| v.to_string()),
    )
    .await?;
    ensure_current(context)?;
    data(
        response.status,
        serde_json::from_str(&response.body)
            .map_err(|_| fail(502, "INVALID_RESPONSE", "服务器返回的数据无效"))?,
    )
}
async fn capabilities(context: &Context) -> Result<(bool, bool), String> {
    let (status, value) =
        request(context, Method::GET, "/auth/bootstrap", None, None, None).await?;
    let info = data(status, value)?;
    let initialized = info["initialized"]
        .as_bool()
        .ok_or_else(|| fail(502, "INVALID_RESPONSE", "该地址不是有效的 MovieClaw 服务器"))?;
    let supports = info["native_device_kinds"]
        .as_array()
        .is_some_and(|v| v.iter().any(|kind| kind.as_str() == Some("windows")));
    Ok((initialized, supports))
}
async fn session(context: &Context, token: &str) -> Result<Value, String> {
    let (status, value) =
        request(context, Method::GET, "/auth/me", None, Some(token), None).await?;
    data(status, value)
}
fn activate(context: &Context, session: &Value, token: &str) -> Result<(), String> {
    ensure_current(context)?;
    let username = session["username"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| fail(502, "INVALID_RESPONSE", "服务器未返回账号身份"))?;
    vault::write(&vault::token_key(&context.origin, username), token)?;
    let mut store = STORE.lock().unwrap();
    let entry = store.entry(context.origin.clone()).or_default();
    entry
        .accounts
        .retain(|v| v["username"].as_str() != Some(username));
    entry.accounts.push(account(session, true, true));
    entry.active = Some(username.to_owned());
    persist(&store)?;
    drop(store);
    change_context();
    Ok(())
}
async fn status(context: &Context, initialized: bool, supports: bool) -> Result<Value, String> {
    if !supports {
        let me = match cookie_request(&context, "GET", "/auth/me", None).await {
            Ok(v) => Some(v),
            Err(e) if error_status(&e) == 401 => None,
            Err(e) => return Err(e),
        };
        let list = if me.is_some() {
            cookie_request(&context, "GET", "/auth/accounts", None).await?
        } else {
            json!([])
        };
        return Ok(
            json!({"mode":"cookie","initialized":initialized,"session":me,"accounts":list,"pairing_supported":false,"compatibility_reason":"服务器尚未支持 Windows 设备登录，当前使用兼容登录；升级服务器后可使用设备配对。","context_generation":generation()}),
        );
    }
    let me = if let Some(identity) = identity(&context.server, None)? {
        match session(context, &identity.token).await {
            Ok(v) => Some(v),
            Err(e) if error_status(&e) == 401 => {
                invalidate(&identity);
                None
            }
            Err(e) => return Err(e),
        }
    } else {
        None
    };
    Ok(
        json!({"mode":"device","initialized":initialized,"session":me,"accounts":accounts(&context.origin)?,"pairing_supported":true,"compatibility_reason":null,"context_generation":generation()}),
    )
}
fn error_status(error: &str) -> u16 {
    serde_json::from_str::<Value>(error)
        .ok()
        .and_then(|v| v["status"].as_u64())
        .unwrap_or_default() as u16
}
fn client() -> Result<Value, String> {
    Ok(
        json!({"kind":"windows","installation_id":vault::installation_id()?,"name":std::env::var("COMPUTERNAME").unwrap_or_else(|_|"Windows PC".into()).chars().take(64).collect::<String>(),"platform":format!("Windows · {}",std::env::consts::ARCH),"client_version":env!("CARGO_PKG_VERSION")}),
    )
}

#[tauri::command]
pub async fn native_auth_status() -> Result<Value, String> {
    let context = load_context()?;
    let (initialized, supports) = capabilities(&context).await?;
    status(&context, initialized, supports).await
}
#[tauri::command]
pub async fn native_password_login(username: String, password: String) -> Result<Value, String> {
    let _guard = MUTATION.lock().await;
    let context = load_context()?;
    let (initialized, supports) = capabilities(&context).await?;
    if !initialized {
        return Err(fail(409, "NEEDS_SETUP", "服务器尚未完成初始化"));
    }
    if supports {
        let (code, value) = request(
            &context,
            Method::POST,
            "/auth/device/login",
            Some(json!({"username":username,"password":password,"client":client()?})),
            None,
            None,
        )
        .await?;
        let login = data(code, value)?;
        let token = login["token"]
            .as_str()
            .ok_or_else(|| fail(502, "INVALID_RESPONSE", "服务器未返回设备凭证"))?;
        activate(&context, &login["session"], token)?;
    } else {
        cookie_request(
            &context,
            "POST",
            "/auth/login",
            Some(json!({"username":username,"password":password,"remember":true})),
        )
        .await?;
        change_context();
    }
    let current = load_context()?;
    if current.origin != context.origin {
        return Err(fail(409, "CONTEXT_CHANGED", "服务器已更改"));
    }
    status(&current, initialized, supports).await
}
#[tauri::command]
pub async fn native_select_account(username: String) -> Result<Value, String> {
    let _guard = MUTATION.lock().await;
    let context = load_context()?;
    let (initialized, supports) = capabilities(&context).await?;
    if supports {
        let selected = identity(&context.server, Some(&username))?
            .ok_or_else(|| fail(401, "NEEDS_PASSWORD", "这个账号需要重新登录"))?;
        let me = match session(&context, &selected.token).await {
            Ok(v) => v,
            Err(e) => {
                if error_status(&e) == 401 {
                    invalidate(&selected);
                }
                return Err(e);
            }
        };
        activate(&context, &me, &selected.token)?;
    } else {
        cookie_request(
            &context,
            "POST",
            "/auth/accounts/switch",
            Some(json!({"username":username})),
        )
        .await?;
        change_context();
    }
    let current = load_context()?;
    if current.origin != context.origin {
        return Err(fail(409, "CONTEXT_CHANGED", "服务器已更改"));
    }
    status(&current, initialized, supports).await
}
async fn remove(context: &Context, username: &str) -> Result<(), String> {
    if let Some(identity) = identity(&context.server, Some(username))? {
        // Forget locally even when the server is offline; revoke has a bounded wait.
        let _ = tokio::time::timeout(
            Duration::from_secs(5),
            request(
                context,
                Method::DELETE,
                "/auth/devices/current",
                None,
                Some(&identity.token),
                None,
            ),
        )
        .await;
    }
    ensure_current(context)?;
    vault::delete(&vault::token_key(&context.origin, username))?;
    let mut store = STORE.lock().unwrap();
    if let Some(entry) = store.get_mut(&context.origin) {
        entry
            .accounts
            .retain(|v| v["username"].as_str() != Some(username));
        if entry.active.as_deref() == Some(username) {
            entry.active = None;
        }
    }
    persist(&store)
}
async fn activate_remaining(context: &Context) -> Result<(), String> {
    if identity(&context.server, None)?.is_some() {
        return Ok(());
    }
    for candidate in accounts(&context.origin)? {
        let Some(username) = candidate["username"].as_str() else {
            continue;
        };
        if let Some(identity) = identity(&context.server, Some(username))? {
            match session(context, &identity.token).await {
                Ok(me) => {
                    activate(context, &me, &identity.token)?;
                    return Ok(());
                }
                Err(e) if error_status(&e) == 401 => invalidate(&identity),
                Err(_) => {}
            }
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn native_remove_account(username: String) -> Result<Value, String> {
    let _guard = MUTATION.lock().await;
    let context = load_context()?;
    let (initialized, supports) = capabilities(&context).await?;
    if supports {
        remove(&context, &username).await?;
        activate_remaining(&context).await?;
        change_context();
    } else {
        cookie_request(
            &context,
            "DELETE",
            &format!(
                "/auth/accounts/{}",
                url::form_urlencoded::byte_serialize(username.as_bytes()).collect::<String>()
            ),
            None,
        )
        .await?;
        change_context();
    }
    let current = load_context()?;
    if current.origin != context.origin {
        return Err(fail(409, "CONTEXT_CHANGED", "服务器已更改"));
    }
    status(&current, initialized, supports).await
}
#[tauri::command]
pub async fn native_logout(all: Option<bool>) -> Result<Value, String> {
    let _guard = MUTATION.lock().await;
    let context = load_context()?;
    let (initialized, supports) = capabilities(&context).await?;
    if supports {
        let names = if all.unwrap_or(false) {
            accounts(&context.origin)?
                .iter()
                .filter_map(|v| v["username"].as_str().map(str::to_owned))
                .collect()
        } else {
            identity(&context.server, None)?
                .map(|v| vec![v.username])
                .unwrap_or_default()
        };
        for username in names {
            ensure_current(&context)?;
            remove(&context, &username).await?;
        }
        if !all.unwrap_or(false) {
            activate_remaining(&context).await?;
        }
        change_context();
    } else {
        cookie_request(
            &context,
            "POST",
            "/auth/logout",
            Some(json!({"all":all.unwrap_or(false)})),
        )
        .await?;
        change_context();
    }
    let current = load_context()?;
    if current.origin != context.origin {
        return Err(fail(409, "CONTEXT_CHANGED", "服务器已更改"));
    }
    status(&current, initialized, supports).await
}
#[tauri::command]
pub async fn native_pair_begin() -> Result<Value, String> {
    let context = load_context()?;
    let (initialized, supports) = capabilities(&context).await?;
    if !initialized || !supports {
        return Err(fail(
            422,
            "WINDOWS_DEVICE_UNSUPPORTED",
            "请升级并初始化服务器后使用 Windows 配对登录",
        ));
    }
    let client = client()?;
    let (status,value)=request(&context,Method::POST,"/auth/device/authorize",Some(json!({"client_type":"windows","client_name":client["name"],"installation_id":client["installation_id"],"platform":client["platform"],"client_version":client["client_version"]})),None,None).await?;
    let info = data(status, value)?;
    let device_code = info["device_code"]
        .as_str()
        .ok_or_else(|| fail(502, "INVALID_RESPONSE", "服务器未返回配对凭据"))?
        .to_owned();
    let interval = info["interval"].as_u64().unwrap_or(5).clamp(1, 60);
    let expires_at = now() + info["expires_in"].as_u64().unwrap_or(300).min(900);
    let id = vault::random_id()?;
    let uri = info["verification_uri_complete"]
        .as_str()
        .ok_or_else(|| fail(502, "INVALID_RESPONSE", "服务器未返回配对地址"))?;
    connect::validate_http_url(uri)?;
    let mut pairs = PAIRS.lock().unwrap();
    for (_, pair) in pairs.drain() {
        pair.cancellation.cancel();
    }
    pairs.insert(
        id.clone(),
        Pairing {
            context,
            device_code,
            cancellation: CancellationToken::new(),
            expires_at,
            interval,
            next_poll: now(),
        },
    );
    Ok(
        json!({"pairing_id":id,"user_code":info["user_code"],"verification_uri":info["verification_uri"],"verification_uri_complete":uri,"expires_at":expires_at,"interval":interval}),
    )
}
#[tauri::command]
pub async fn native_pair_cancel(pairing_id: String) -> bool {
    let cancelled = if let Some(pair) = PAIRS.lock().unwrap().remove(&pairing_id) {
        pair.cancellation.cancel();
        true
    } else {
        false
    };
    // Return only after an in-flight poll has settled, including a commit that
    // won the race before cancellation. The UI can then restore current status.
    let _guard = MUTATION.lock().await;
    cancelled
}
#[tauri::command]
pub async fn native_pair_poll(pairing_id: String) -> Result<Value, String> {
    let _guard = MUTATION.lock().await;
    let pair = {
        let mut pairs = PAIRS.lock().unwrap();
        let Some(pair) = pairs.get_mut(&pairing_id) else {
            return Ok(json!({"status":"cancelled"}));
        };
        if pair.expires_at <= now() {
            pairs.remove(&pairing_id);
            return Ok(json!({"status":"expired"}));
        }
        if pair.next_poll > now() {
            return Ok(json!({"status":"pending","interval":pair.next_poll-now()}));
        }
        pair.next_poll = now() + pair.interval;
        pair.clone()
    };
    let response = request(
        &pair.context,
        Method::POST,
        "/auth/device/token",
        Some(json!({"device_code":pair.device_code})),
        None,
        Some(&pair.cancellation),
    )
    .await;
    if pair.cancellation.is_cancelled() {
        return Ok(json!({"status":"cancelled"}));
    }
    let (status, value) = response?;
    if status == 202 || status == 429 {
        return Ok(
            json!({"status":"pending","interval":if status==429 {pair.interval+5} else {pair.interval}}),
        );
    }
    if status == 400 {
        PAIRS.lock().unwrap().remove(&pairing_id);
        return Ok(
            json!({"status":if value["message"].as_str().unwrap_or_default().contains("拒绝") {"denied"} else {"expired"}}),
        );
    }
    let login = data(status, value)?;
    let token = login["token"]
        .as_str()
        .ok_or_else(|| fail(502, "INVALID_RESPONSE", "服务器未返回设备凭证"))?;
    let verified = request(
        &pair.context,
        Method::GET,
        "/auth/me",
        None,
        Some(token),
        Some(&pair.cancellation),
    )
    .await;
    if pair.cancellation.is_cancelled() {
        return Ok(json!({"status":"cancelled"}));
    }
    let (code, value) = verified?;
    let me = data(code, value)?;
    // Cancellation and installation share the same lock: a successful cancel cannot
    // race a late poll into installing a credential or switching the active account.
    let mut pairs = PAIRS.lock().unwrap();
    if pair.cancellation.is_cancelled() || !pairs.contains_key(&pairing_id) {
        return Ok(json!({"status":"cancelled"}));
    }
    pairs.remove(&pairing_id);
    drop(pairs);
    activate(&pair.context, &me, token)?;
    Ok(json!({"status":"approved","session":me,"interval":pair.interval}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn account_metadata_contains_no_secret() {
        let v = account(
            &json!({"username":"member","nickname":"成员","role":"member","token":"secret"}),
            true,
            true,
        );
        assert_eq!(v["username"], "member");
        assert!(v.get("token").is_none());
        assert_eq!(v["active"], true);
    }
    #[tokio::test]
    async fn native_login_contract_does_not_send_cookie_or_return_token_metadata() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let handler = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let n = socket.read(&mut buffer).unwrap();
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]);
                    let length = header
                        .lines()
                        .find_map(|v| {
                            v.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|v| v.parse::<usize>().ok())
                        })
                        .unwrap_or_default();
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let request = String::from_utf8(bytes).unwrap();
            assert!(request.starts_with("POST /api/v1/auth/device/login "));
            assert!(!request.to_ascii_lowercase().contains("cookie:"));
            assert!(request.contains("\"kind\":\"windows\""));
            let body = r#"{"data":{"token":"private-device-token","session":{"username":"member","nickname":"成员","role":"member"}}}"#;
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .unwrap();
        });
        let context = Context {
            origin: server.clone(),
            server,
            generation: generation(),
            cancellation: CancellationToken::new(),
        };
        let (code, value) = request(
            &context,
            Method::POST,
            "/auth/device/login",
            Some(json!({"username":"member","password":"test","client":{"kind":"windows"}})),
            None,
            None,
        )
        .await
        .unwrap();
        let login = data(code, value).unwrap();
        assert_eq!(login["token"], "private-device-token");
        assert!(account(&login["session"], true, true)
            .get("token")
            .is_none());
        handler.join().unwrap();
    }
}
