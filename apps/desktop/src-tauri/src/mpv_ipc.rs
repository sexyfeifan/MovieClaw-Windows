//! One cancellable named-pipe connection per mpv instance. Properties and commands
//! share the actor; a timed-out read never leaves an OS thread or pipe behind.
use serde_json::{json, Map, Value};
#[cfg(windows)]
use std::collections::HashMap;
#[cfg(windows)]
use std::io;
use std::sync::{Arc, Mutex};
use std::time::Duration;
#[cfg(windows)]
use tauri::Emitter;
#[cfg(windows)]
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use tokio::sync::{mpsc, oneshot};
#[cfg(windows)]
use tokio::time::timeout;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

const PROPERTIES: &[&str] = &[
    "time-pos",
    "duration",
    "pause",
    "volume",
    "mute",
    "speed",
    "aid",
    "sid",
    "sub-delay",
    "track-list",
    "chapter-list",
    "demuxer-cache-duration",
    "cache-speed",
    "paused-for-cache",
    "eof-reached",
    "seeking",
    "video-out-params",
    "video-params",
    "hwdec-current",
    "hwdec",
    "video-codec",
    "frame-drop-count",
    "decoder-frame-drop-count",
    "container-fps",
    "sub-pos",
    "sub-scale",
];
const COMMAND_TIMEOUT: Duration = Duration::from_secs(3);
type Reply = oneshot::Sender<Result<Value, String>>;
#[cfg_attr(not(windows), allow(dead_code))]
struct Command {
    value: Vec<Value>,
    deadline: Instant,
    reply: Reply,
}

#[derive(Clone)]
pub struct Session {
    tx: mpsc::Sender<Command>,
    cancel: CancellationToken,
    state: Arc<Mutex<Map<String, Value>>>,
}

impl Session {
    pub fn start(pipe: String, instance: u64, app: Option<tauri::AppHandle>) -> Self {
        let (tx, rx) = mpsc::channel(64);
        let cancel = CancellationToken::new();
        let state = Arc::new(Mutex::new(Map::from_iter([
            ("ipc_connected".into(), json!(false)),
            ("ipc_connections".into(), json!(0)),
        ])));
        let session = Self {
            tx,
            cancel: cancel.clone(),
            state: state.clone(),
        };
        #[cfg(windows)]
        tauri::async_runtime::spawn(async move {
            let result = run(pipe, instance, app, rx, cancel, state.clone()).await;
            let mut data = state.lock().unwrap();
            data.insert("ipc_connected".into(), json!(false));
            if let Err(error) = result {
                data.insert("ipc_error".into(), json!(error));
            }
        });
        #[cfg(not(windows))]
        {
            let _ = (pipe, instance, app, rx);
            state.lock().unwrap().insert(
                "ipc_error".into(),
                json!("mpv named-pipe IPC requires Windows"),
            );
        }
        session
    }

    pub fn snapshot(&self) -> Value {
        Value::Object(self.state.lock().unwrap().clone())
    }
    pub fn stop(&self) {
        self.cancel.cancel();
    }

    pub async fn command(&self, value: Vec<Value>) -> Result<Value, String> {
        if value.is_empty()
            || value.len() > 16
            || serde_json::to_vec(&value).map_err(|e| e.to_string())?.len() > 65536
        {
            return Err("无效的 mpv 命令".into());
        }
        let operation = value[0].as_str().unwrap_or_default();
        let property = value.get(1).and_then(Value::as_str).unwrap_or_default();
        let allowed = match operation {
            "get_property" => value.len() == 2 && PROPERTIES.contains(&property),
            "set_property" => {
                value.len() == 3
                    && [
                        "pause",
                        "volume",
                        "mute",
                        "speed",
                        "aid",
                        "sid",
                        "sub-delay",
                        "sub-pos",
                        "sub-scale",
                    ]
                    .contains(&property)
            }
            "seek" => (3..=4).contains(&value.len()) && value[1].is_number(),
            _ => false,
        };
        if !allowed {
            return Err("播放器命令不在允许范围内".into());
        }
        let (reply, response) = oneshot::channel();
        let deadline = Instant::now() + COMMAND_TIMEOUT;
        self.tx
            .try_send(Command {
                value,
                deadline,
                reply,
            })
            .map_err(|_| "mpv 命令队列已满或已关闭")?;
        tokio::select! {
            _ = self.cancel.cancelled() => Err("播放请求已取消".into()),
            result = tokio::time::timeout_at(deadline, response) =>
                result.map_err(|_| "mpv IPC 超时".to_string())?.map_err(|_| "mpv IPC 已关闭".to_string())?,
        }
    }
}

#[cfg(windows)]
async fn write(
    pipe: &NamedPipeClient,
    value: Value,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    let operation = async {
        let mut offset = 0;
        while offset < bytes.len() {
            pipe.writable().await.map_err(|e| e.to_string())?;
            match pipe.try_write(&bytes[offset..]) {
                Ok(0) => return Err("mpv IPC 写入已关闭".into()),
                Ok(n) => offset += n,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                Err(error) => return Err(format!("写 mpv IPC 失败: {error}")),
            }
        }
        Ok(())
    };
    tokio::select! {
        _ = cancel.cancelled() => Err("播放请求已取消".into()),
        result = timeout(COMMAND_TIMEOUT, operation) => result.map_err(|_| "mpv IPC 写入超时".to_string())?,
    }
}

#[cfg(windows)]
async fn run(
    name: String,
    instance: u64,
    app: Option<tauri::AppHandle>,
    mut rx: mpsc::Receiver<Command>,
    cancel: CancellationToken,
    state: Arc<Mutex<Map<String, Value>>>,
) -> Result<(), String> {
    let connect = async {
        loop {
            match ClientOptions::new().open(&name) {
                Ok(pipe) => return Ok(pipe),
                Err(error) if matches!(error.raw_os_error(), Some(2 | 231)) => {
                    tokio::time::sleep(Duration::from_millis(25)).await
                }
                Err(error) => return Err(format!("连接 mpv IPC 失败: {error}")),
            }
        }
    };
    let pipe = tokio::select! {
        _ = cancel.cancelled() => return Ok(()),
        result = timeout(Duration::from_secs(10), connect) => result.map_err(|_| "mpv IPC 连接超时")??,
    };
    {
        let mut data = state.lock().unwrap();
        data.insert("ipc_connected".into(), json!(true));
        data.insert("ipc_connections".into(), json!(1));
    }
    for (id, property) in PROPERTIES.iter().enumerate() {
        write(
            &pipe,
            json!({ "command": ["observe_property", id + 1, property] }),
            &cancel,
        )
        .await?;
    }
    let mut next_id = 100u64;
    let mut pending: HashMap<u64, (Instant, Reply)> = HashMap::new();
    let mut incoming = Vec::new();
    let mut expiry = tokio::time::interval(Duration::from_millis(50));
    loop {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => break,
            _ = expiry.tick() => {
                let now = Instant::now();
                let expired: Vec<_> = pending.iter().filter(|(_, (deadline, reply))| reply.is_closed() || *deadline <= now).map(|(id, _)| *id).collect();
                for id in expired {
                    if let Some((_, reply)) = pending.remove(&id) { let _ = reply.send(Err("mpv IPC 超时".into())); }
                }
            }
            command = rx.recv(), if pending.len() < 64 => {
                let Some(command) = command else { break };
                if command.reply.is_closed() || command.deadline <= Instant::now() { continue; }
                next_id += 1;
                write(&pipe, json!({ "command": command.value, "request_id": next_id }), &cancel).await?;
                pending.insert(next_id, (command.deadline, command.reply));
            }
            ready = pipe.readable() => {
                ready.map_err(|e| e.to_string())?;
                let mut bytes = [0u8; 16384];
                match pipe.try_read(&mut bytes) {
                    Ok(0) => return Err("mpv IPC 已关闭".into()),
                    Ok(n) => incoming.extend_from_slice(&bytes[..n]),
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                    Err(error) => return Err(format!("读 mpv IPC 失败: {error}")),
                }
                if incoming.len() > 1024 * 1024 { return Err("mpv IPC 响应超过大小限制".into()); }
                while let Some(end) = incoming.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<_> = incoming.drain(..=end).collect();
                    let Ok(value) = serde_json::from_slice::<Value>(&line) else { continue };
                    if let Some(id) = value["request_id"].as_u64() {
                        if let Some((_, reply)) = pending.remove(&id) {
                            let result = if value["error"].as_str().is_some_and(|e| e != "success") {
                                Err(format!("mpv 命令失败: {}", value["error"]))
                            } else { Ok(value) };
                            let _ = reply.send(result);
                        }
                        continue;
                    }
                    if value["event"] == "property-change" {
                        if let Some(name) = value["name"].as_str() {
                            state.lock().unwrap().insert(name.into(), value["data"].clone());
                        }
                    } else if value["event"] == "end-file" {
                        state.lock().unwrap().insert("end_file".into(), value);
                    } else if value["event"] == "client-message" && value["args"][0] == "movieclaw-input" {
                        if let Some(app) = &app {
                            let _ = app.emit("movieclaw:player-input", json!({ "instanceId": instance, "args": value["args"] }));
                        }
                    }
                }
            }
        }
    }
    // Dropping NamedPipeClient cancels the registered overlapped I/O and closes the
    // only pipe handle. Pending oneshots fail; no read thread outlives the session.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn stopped_session_cancels_connect_and_rejects_commands() {
        let session = Session::start(
            format!(r"\\.\pipe\movieclaw-missing-{}", std::process::id()),
            1,
            None,
        );
        session.stop();
        assert!(session
            .command(vec![json!("get_property"), json!("pause")])
            .await
            .is_err());
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(session.snapshot()["ipc_connections"], 0);
    }
    #[tokio::test]
    async fn rejects_process_and_file_access_commands() {
        let session = Session::start(
            format!(r"\\.\pipe\movieclaw-denied-{}", std::process::id()),
            2,
            None,
        );
        for command in [
            vec![json!("run"), json!("powershell")],
            vec![json!("loadfile"), json!("http://example.invalid")],
            vec![
                json!("set_property"),
                json!("input-ipc-server"),
                json!("bad"),
            ],
        ] {
            assert!(session
                .command(command)
                .await
                .unwrap_err()
                .contains("允许范围"));
        }
        session.stop();
    }

    #[cfg(windows)]
    fn test_pipe() -> String {
        use std::sync::atomic::{AtomicU32, Ordering};
        static ID: AtomicU32 = AtomicU32::new(0);
        format!(
            r"\\.\pipe\movieclaw-actor-test-{}-{}",
            std::process::id(),
            ID.fetch_add(1, Ordering::SeqCst)
        )
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn persistent_connection_demultiplexes_properties_commands_and_cancels_handle() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::windows::named_pipe::ServerOptions;
        let name = test_pipe();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&name)
            .unwrap();
        let server_task = tokio::spawn(async move {
            server.connect().await.unwrap();
            let mut stream = BufReader::new(server);
            let mut line = String::new();
            let mut commands = 0;
            loop {
                line.clear();
                if stream.read_line(&mut line).await.unwrap() == 0 {
                    break;
                }
                let value: Value = serde_json::from_str(&line).unwrap();
                if let Some(id) = value["request_id"].as_u64() {
                    commands += 1;
                    // Events and command replies interleave and cross read boundaries.
                    let output = format!("{{\"event\":\"property-change\",\"name\":\"pause\",\"data\":false}}\n{{\"request_id\":{id},\"error\":\"success\",\"data\":true}}\n");
                    let middle = output.len() / 2;
                    stream
                        .get_mut()
                        .write_all(&output.as_bytes()[..middle])
                        .await
                        .unwrap();
                    stream
                        .get_mut()
                        .write_all(&output.as_bytes()[middle..])
                        .await
                        .unwrap();
                }
            }
            commands
        });
        let session = Session::start(name, 3, None);
        let mut jobs = Vec::new();
        for _ in 0..8 {
            let clone = session.clone();
            jobs.push(tokio::spawn(async move {
                clone
                    .command(vec![json!("get_property"), json!("pause")])
                    .await
            }));
        }
        for job in jobs {
            assert_eq!(job.await.unwrap().unwrap()["data"], true);
        }
        assert_eq!(session.snapshot()["ipc_connections"], 1);
        assert_eq!(session.snapshot()["pause"], false);
        session.stop();
        assert_eq!(
            timeout(Duration::from_secs(2), server_task)
                .await
                .unwrap()
                .unwrap(),
            8
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn deadline_does_not_spawn_an_orphan_read_and_stop_closes_the_connection() {
        use tokio::io::{AsyncBufReadExt, BufReader};
        use tokio::net::windows::named_pipe::ServerOptions;
        let name = test_pipe();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&name)
            .unwrap();
        let server_task = tokio::spawn(async move {
            server.connect().await.unwrap();
            let mut stream = BufReader::new(server);
            let mut line = String::new();
            loop {
                line.clear();
                if stream.read_line(&mut line).await.unwrap() == 0 {
                    break;
                }
            }
        });
        let session = Session::start(name, 4, None);
        let error = session
            .command(vec![json!("get_property"), json!("pause")])
            .await
            .unwrap_err();
        assert!(error.contains("超时"));
        assert_eq!(session.snapshot()["ipc_connections"], 1);
        assert_eq!(session.snapshot()["ipc_connected"], true);
        session.stop();
        timeout(Duration::from_secs(2), server_task)
            .await
            .unwrap()
            .unwrap();
    }
}
