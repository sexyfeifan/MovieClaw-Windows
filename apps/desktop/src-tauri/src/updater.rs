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

/// 解析版本号字符串为 (major, minor, patch) 比较元组
/// 支持格式: "0.2.100", "v0.2.100", "desktop-v0.2.100", "desktop-0.2.100"
fn parse_version(v: &str) -> (u64, u64, u64) {
    // 移除所有前缀: "desktop-v", "desktop-", "v"
    let cleaned = v
        .trim()
        .trim_start_matches("desktop-v")
        .trim_start_matches("desktop-")
        .trim_start_matches('v');
    let parts: Vec<&str> = cleaned.split('.').collect();
    let major = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
    let minor = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let patch = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    (major, minor, patch)
}

/// 检查 GitHub Releases 是否有新版本
#[tauri::command]
pub fn check_for_updates() -> Result<UpdateInfo, String> {
    // 获取所有 releases，找最新的桌面版 release
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases?per_page=10");
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .build();

    let resp = agent
        .get(&url)
        .set("User-Agent", "MovieClaw-Desktop")
        .set("Accept", "application/vnd.github.v3+json")
        .call()
        .map_err(|e| format!("请求 GitHub API 失败: {e}"))?;

    let releases: serde_json::Value = resp
        .into_json()
        .map_err(|e| format!("解析响应失败: {e}"))?;

    let current_ver = parse_version(CURRENT_VERSION);

    // 找最新的包含 Setup exe 的桌面 release
    let mut best_release: Option<&serde_json::Value> = None;
    let mut best_ver = current_ver;
    let mut has_update = false;

    if let Some(arr) = releases.as_array() {
        for release in arr {
            let tag = release.get("tag_name").and_then(|t| t.as_str()).unwrap_or("");
            // 只关注桌面版 release（tag 含 "desktop" 或有 Setup asset）
            let has_setup = release
                .get("assets")
                .and_then(|a| a.as_array())
                .map(|assets| {
                    assets.iter().any(|a| {
                        let name = a.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        name.contains("Setup") && name.ends_with(".exe")
                    })
                })
                .unwrap_or(false);

            if !has_setup && !tag.contains("desktop") {
                continue;
            }

            let ver = parse_version(tag);
            if ver > best_ver {
                best_ver = ver;
                best_release = Some(release);
                has_update = true;
            }
        }
    }

    let (latest_tag, download_url, release_notes) = if let Some(release) = best_release {
        let tag = release
            .get("tag_name")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();

        // 找 Windows 安装包下载链接（优先 Setup exe）
        let mut url = String::new();
        if let Some(assets) = release.get("assets").and_then(|a| a.as_array()) {
            // 先找 Setup exe
            for asset in assets {
                let name = asset.get("name").and_then(|n| n.as_str()).unwrap_or("");
                if name.contains("Setup") && name.ends_with(".exe") {
                    url = asset
                        .get("browser_download_url")
                        .and_then(|u| u.as_str())
                        .unwrap_or("")
                        .to_string();
                    break;
                }
            }
            // 没有 Setup 就找任意 exe 或 zip
            if url.is_empty() {
                for asset in assets {
                    let name = asset.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    if name.ends_with(".exe") || name.ends_with(".zip") {
                        url = asset
                            .get("browser_download_url")
                            .and_then(|u| u.as_str())
                            .unwrap_or("")
                            .to_string();
                        break;
                    }
                }
            }
        }

        let notes = release
            .get("body")
            .and_then(|b| b.as_str())
            .unwrap_or("")
            .to_string();

        (tag, url, notes)
    } else {
        (String::new(), String::new(), String::new())
    };

    let release_notes = if release_notes.len() > 500 {
        release_notes[..500].to_string()
    } else {
        release_notes
    };

    Ok(UpdateInfo {
        has_update,
        current_version: CURRENT_VERSION.to_string(),
        latest_version: latest_tag.clone(),
        download_url,
        release_notes,
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
