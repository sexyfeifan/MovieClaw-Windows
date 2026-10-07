use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize)]
pub struct ConnectResult {
    pub ok: bool,
    pub message: String,
}

fn config_path() -> PathBuf {
    let dir = dirs_next_config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("movieclaw-desktop");
    fs::create_dir_all(&dir).ok();
    dir.join("server.json")
}

#[cfg(windows)]
fn dirs_next_config_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(PathBuf::from)
}

#[cfg(not(windows))]
fn dirs_next_config_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config"))
}

#[tauri::command]
pub fn save_server_url(url: String) -> Result<ConnectResult, String> {
    let trimmed = url.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        return Ok(ConnectResult {
            ok: false,
            message: "URL 不能为空".into(),
        });
    }
    let normalized = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed
    } else {
        format!("http://{trimmed}")
    };
    fs::write(config_path(), &normalized).map_err(|e| format!("写入配置失败: {e}"))?;
    Ok(ConnectResult {
        ok: true,
        message: normalized,
    })
}

/// 供前端获取当前配置的服务器地址
#[tauri::command]
pub fn get_server_url() -> Result<String, String> {
    load_server_url()
}

#[tauri::command]
pub fn load_server_url() -> Result<String, String> {
    fs::read_to_string(config_path())
        .map(|s| s.trim_start_matches('\u{FEFF}').trim().to_string())
        .or_else(|_| Ok(String::new()))
}

#[tauri::command]
pub fn clear_server_url() -> Result<ConnectResult, String> {
    let path = config_path();
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除配置失败: {e}"))?;
    }
    Ok(ConnectResult {
        ok: true,
        message: "已断开服务器".into(),
    })
}

#[tauri::command]
pub fn probe_server(url: String) -> Result<ConnectResult, String> {
    let trimmed = url.trim().trim_end_matches('/').to_string();
    let health = format!("{trimmed}/api/v1/health");
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(5))
        .build();
    match agent.get(&health).call() {
        Ok(resp) => {
            let status = resp.status();
            Ok(ConnectResult {
                ok: true,
                message: format!("连接成功 ({status})"),
            })
        }
        Err(ureq::Error::Status(code, _)) => Ok(ConnectResult {
            ok: false,
            message: format!("服务返回 {code}"),
        }),
        Err(e) => Ok(ConnectResult {
            ok: false,
            message: format!("无法连接: {e}"),
        }),
    }
}
