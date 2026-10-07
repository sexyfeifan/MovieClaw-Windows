use tauri::Manager;
use tauri::WebviewUrl;
use tauri::WebviewWindowBuilder;

/// 显示音量覆盖窗口（原生透明置顶小窗口）
#[tauri::command]
pub fn show_volume_window(app: tauri::AppHandle) -> Result<bool, String> {
    // 如果已存在则聚焦
    if let Some(w) = app.get_webview_window("volume-overlay") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(true);
    }

    // 获取主窗口位置，将音量窗口放在右下角
    let (x, y, w, h) = app
        .get_webview_window("main")
        .map(|mw| {
            let pos = mw.outer_position().unwrap_or_default();
            let size = mw.outer_size().unwrap_or_default();
            (pos.x, pos.y, size.width, size.height)
        })
        .unwrap_or((100, 100, 1280, 800));

    // 音量窗口位置：主窗口右下角内侧
    let win_x = x + (w as i32) - 320;
    let win_y = y + (h as i32) - 120;

    WebviewWindowBuilder::new(&app, "volume-overlay", WebviewUrl::App("volume-overlay.html".into()))
        .title("音量控制")
        .inner_size(280.0, 56.0)
        .position(win_x as f64, win_y as f64)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .build()
        .map_err(|e| format!("创建音量窗口失败: {e}"))?;

    Ok(true)
}

/// 隐藏音量覆盖窗口
#[tauri::command]
pub fn hide_volume_window(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(w) = app.get_webview_window("volume-overlay") {
        let _ = w.hide();
        Ok(true)
    } else {
        Ok(false)
    }
}

/// 切换音量覆盖窗口显示/隐藏
#[tauri::command]
pub fn toggle_volume_window(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(w) = app.get_webview_window("volume-overlay") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
        }
        Ok(true)
    } else {
        show_volume_window(app)
    }
}
