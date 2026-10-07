use serde::Deserialize;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Emitter;

#[derive(Debug, Deserialize)]
pub struct PlayerLaunch {
    pub stream_url: String,
    pub subtitle_urls: Option<Vec<String>>,
    pub start_ms: Option<u64>,
    pub title: Option<String>,
}

static MPV_CHILD: Mutex<Option<Child>> = Mutex::new(None);
static MPV_WRITER: Mutex<Option<std::fs::File>> = Mutex::new(None);
static PIPE_COUNTER: AtomicU32 = AtomicU32::new(0);

fn find_mpv() -> Option<String> {
    if let Ok(p) = std::env::var("MOVIECLAW_MPV") {
        return Some(p);
    }
    // 尝试 PATH 中的 mpv
    let candidates = ["mpv.exe", "mpv"];
    for c in &candidates {
        if which(c).is_some() {
            return Some(c.to_string());
        }
    }
    // 便携目录
    if let Ok(exe_dir) = std::env::current_exe() {
        if let Some(dir) = exe_dir.parent() {
            let local = dir.join("mpv").join("mpv.exe");
            if local.exists() {
                return Some(local.to_string_lossy().to_string());
            }
        }
    }
    None
}

#[cfg(windows)]
fn which(cmd: &str) -> Option<String> {
    let out = Command::new("where").arg(cmd).output().ok()?;
    if out.status.success() {
        let path = String::from_utf8_lossy(&out.stdout).lines().next()?.to_string();
        if path.is_empty() { None } else { Some(path) }
    } else {
        None
    }
}

#[cfg(not(windows))]
fn which(cmd: &str) -> Option<String> {
    let out = Command::new("which").arg(cmd).output().ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

/// 启动 IPC 读取线程：连接 mpv 命名管道，订阅属性变化，通过 Tauri 事件通知前端。
/// 管道关闭（mpv 退出）时发出 player_exited。
fn spawn_ipc_listener(app: tauri::AppHandle, pipe_name: String, mpv_pid: u32) {
    std::thread::spawn(move || {
        // 等待 mpv 创建命名管道（最多 5 秒）
        let pipe = {
            let mut attempts = 0;
            loop {
                match std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&pipe_name)
                {
                    Ok(f) => break Some(f),
                    Err(_) if attempts < 50 => {
                        attempts += 1;
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    Err(_) => break None,
                }
            }
        };

        let pipe = match pipe {
            Some(p) => p,
            None => {
                let _ = app.emit("player_exited", serde_json::json!({
                    "pid": mpv_pid,
                    "final_time_pos": 0.0,
                    "error": "ipc_connect_failed"
                }));
                return;
            }
        };

        let mut writer = match pipe.try_clone() {
            Ok(p) => p,
            Err(e) => {
                let _ = app.emit("player_exited", serde_json::json!({
                    "pid": mpv_pid,
                    "final_time_pos": 0.0,
                    "error": format!("ipc_clone_failed: {e}")
                }));
                return;
            }
        };
        // 克隆一份 writer 存全局，供 send_mpv_command 使用
        if let Ok(global_writer) = writer.try_clone() {
            *MPV_WRITER.lock().unwrap() = Some(global_writer);
        }
        let reader = BufReader::new(pipe);

        // 订阅 mpv 属性
        let _ = writeln!(writer, r#"{{"command":["observe_property",1,"time-pos"]}}"#);
        let _ = writeln!(writer, r#"{{"command":["observe_property",2,"duration"]}}"#);
        let _ = writeln!(writer, r#"{{"command":["observe_property",3,"pause"]}}"#);
        let _ = writeln!(writer, r#"{{"command":["observe_property",4,"volume"]}}"#);
        let _ = writeln!(writer, r#"{{"command":["observe_property",5,"mute"]}}"#);
        let _ = writer.flush();

        // 读取事件，每秒最多发一次 player_state
        let mut last_time_pos = 0.0_f64;
        let mut last_duration = 0.0_f64;
        let mut last_paused = false;
        let mut last_volume = 100.0_f64;
        let mut last_mute = false;
        let mut last_emit = Instant::now();

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if line.trim().is_empty() {
                continue;
            }
            let msg: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let event = msg.get("event").and_then(|e| e.as_str()).unwrap_or("");
            match event {
                "property-change" => {
                    let id = msg.get("id").and_then(|i| i.as_i64()).unwrap_or(0);
                    let data = msg.get("data");
                    match id {
                        1 => {
                            if let Some(t) = data.and_then(|d| d.as_f64()) {
                                last_time_pos = t;
                            }
                        }
                        2 => {
                            if let Some(d) = data.and_then(|d| d.as_f64()) {
                                last_duration = d;
                            }
                        }
                        3 => {
                            if let Some(p) = data.and_then(|d| d.as_bool()) {
                                last_paused = p;
                            }
                        }
                        4 => {
                            if let Some(v) = data.and_then(|d| d.as_f64()) {
                                last_volume = v;
                            }
                        }
                        5 => {
                            if let Some(m) = data.and_then(|d| d.as_bool()) {
                                last_mute = m;
                            }
                        }
                        _ => {}
                    }
                    if last_emit.elapsed() >= Duration::from_secs(1) {
                        last_emit = Instant::now();
                        let _ = app.emit("player_state", serde_json::json!({
                            "time_pos": last_time_pos,
                            "duration": last_duration,
                            "paused": last_paused,
                            "volume": last_volume,
                            "mute": last_mute
                        }));
                    }
                }
                "end-file" => break,
                _ => {}
            }
        }

        // 清除全局 writer
        *MPV_WRITER.lock().unwrap() = None;

        // 管道关闭 = 播放器退出
        let _ = app.emit("player_state", serde_json::json!({
            "time_pos": last_time_pos,
            "duration": last_duration,
            "paused": last_paused,
            "volume": last_volume,
            "mute": last_mute
        }));
        let _ = app.emit("player_exited", serde_json::json!({
            "pid": mpv_pid,
            "final_time_pos": last_time_pos
        }));
    });
}

#[tauri::command]
pub fn launch_player(app: tauri::AppHandle, params: PlayerLaunch) -> Result<serde_json::Value, String> {
    let mpv = find_mpv().ok_or("未找到 mpv，请设置 MOVIECLAW_MPV 环境变量或安装 mpv")?;

    // 先停掉已有实例
    stop_player().ok();

    let start_secs = params.start_ms.map(|ms| ms as f64 / 1000.0);
    let title = params.title.unwrap_or_else(|| "MovieClaw".into());

    let mut cmd = Command::new(&mpv);
    cmd.arg(&params.stream_url)
        .arg(format!("--title={title}"))
        .arg("--force-window=immediate")
        .arg("--hwdec=auto-safe")
        .arg("--keep-open=no")
        .arg("--osd-level=1");

    if let Some(s) = start_secs {
        cmd.arg(format!("--start={}", s));
    }

    let pipe_id = PIPE_COUNTER.fetch_add(1, Ordering::SeqCst);
    let pipe_name = format!("\\\\.\\pipe\\movieclaw-mpv-{}-{}", std::process::id(), pipe_id);
    cmd.arg(format!("--input-ipc-server={pipe_name}"));

    if let Some(subs) = &params.subtitle_urls {
        for sub in subs {
            cmd.arg(format!("--sub-file={sub}"));
        }
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("启动 mpv 失败: {e}"))?;

    let pid = child.id();
    *MPV_CHILD.lock().unwrap() = Some(child);

    // 启动 IPC 监听线程
    spawn_ipc_listener(app, pipe_name.clone(), pid);

    Ok(serde_json::json!({ "ok": true, "pid": pid, "pipe": pipe_name }))
}

#[tauri::command]
pub fn stop_player() -> Result<bool, String> {
    *MPV_WRITER.lock().unwrap() = None;
    let mut guard = MPV_CHILD.lock().unwrap();
    if let Some(child) = guard.as_mut() {
        let _ = child.kill();
        *guard = None;
        Ok(true)
    } else {
        Ok(false)
    }
}

/// 发送 JSON 命令到 mpv IPC 管道
#[tauri::command]
pub fn send_mpv_command(command: Vec<serde_json::Value>) -> Result<bool, String> {
    let mut guard = MPV_WRITER.lock().unwrap();
    let writer = guard.as_mut().ok_or("播放器未运行")?;
    let msg = serde_json::json!({ "command": command });
    writeln!(writer, "{msg}").map_err(|e| format!("写入 IPC 失败: {e}"))?;
    writer.flush().map_err(|e| format!("刷新 IPC 失败: {e}"))?;
    Ok(true)
}
