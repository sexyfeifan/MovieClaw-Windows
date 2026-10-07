use serde::{Deserialize, Serialize};

const GITHUB_REPO: &str = "sexyfeifan/MovieClaw-Windows";
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub has_update: bool,
    pub current_version: String,
    pub latest_version: String,
    pub download_url: String,
    pub release_notes: String,
    pub message: String,
}

/// 解析 semver 字符串为 (major, minor, patch) 比较元组
fn parse_version(v: &str) -> (u64, u64, u64) {
    let cleaned = v.trim_start_matches('v');
    let parts: Vec<&str> = cleaned.split('.').collect();
    let major = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
    let minor = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let patch = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    (major, minor, patch)
}

/// 检查 GitHub Releases 是否有新版本
#[tauri::command]
pub fn check_for_updates() -> Result<UpdateInfo, String> {
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases/latest");
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .build();

    let resp = agent
        .get(&url)
        .set("User-Agent", "MovieClaw-Desktop")
        .set("Accept", "application/vnd.github.v3+json")
        .call()
        .map_err(|e| format!("请求 GitHub API 失败: {e}"))?;

    let body: serde_json::Value = resp
        .into_json()
        .map_err(|e| format!("解析响应失败: {e}"))?;

    let latest_tag = body
        .get("tag_name")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    let latest_clean = latest_tag.trim_start_matches('v');
    let current_clean = CURRENT_VERSION.trim_start_matches('v');

    // 找 Windows 安装包下载链接
    let mut download_url = String::new();
    if let Some(assets) = body.get("assets").and_then(|a| a.as_array()) {
        for asset in assets {
            let name = asset.get("name").and_then(|n| n.as_str()).unwrap_or("");
            if name.contains("Setup") && name.ends_with(".exe") {
                download_url = asset
                    .get("browser_download_url")
                    .and_then(|u| u.as_str())
                    .unwrap_or("")
                    .to_string();
                break;
            }
        }
    }

    let release_notes = body
        .get("body")
        .and_then(|b| b.as_str())
        .unwrap_or("")
        .to_string();

    let current_ver = parse_version(current_clean);
    let latest_ver = parse_version(latest_clean);
    let has_update = latest_ver > current_ver;

    Ok(UpdateInfo {
        has_update,
        current_version: CURRENT_VERSION.to_string(),
        latest_version: latest_tag.clone(),
        download_url,
        release_notes: if release_notes.len() > 500 {
            release_notes[..500].to_string()
        } else {
            release_notes
        },
        message: if has_update {
            format!("发现新版本 {latest_tag}（当前 {CURRENT_VERSION}）")
        } else {
            format!("已是最新版本 ({CURRENT_VERSION})")
        },
    })
}

/// 在浏览器中打开下载页面
#[tauri::command]
pub fn open_download_page() -> Result<bool, String> {
    let url = format!("https://github.com/{GITHUB_REPO}/releases/latest");
    open::that(&url).map_err(|e| format!("打开浏览器失败: {e}"))?;
    Ok(true)
}

/// 打开指定版本的 release 页面
#[tauri::command]
pub fn open_release_page() -> Result<bool, String> {
    let url = format!("https://github.com/{GITHUB_REPO}/releases");
    open::that(&url).map_err(|e| format!("打开浏览器失败: {e}"))?;
    Ok(true)
}
