#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api_proxy;
mod connect;
mod lan_discovery;
mod player_embedded;
mod updater;

use tauri::Manager;
use tauri::WebviewUrl;
use tauri::WebviewWindowBuilder;

/// 获取主窗口 HWND
#[tauri::command]
fn get_main_window_hwnd(window: tauri::WebviewWindow) -> Result<isize, String> {
    #[cfg(target_os = "windows")]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        match window.window_handle() {
            Ok(handle) => {
                if let RawWindowHandle::Win32(win32) = handle.as_raw() {
                    return Ok(win32.hwnd.get() as isize);
                }
                Err("无法获取窗口句柄".into())
            }
            Err(e) => Err(format!("获取窗口句柄失败: {e}")),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        Err("仅支持 Windows".into())
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            let start_url = connect::load_server_url().unwrap_or_default();
            let url = if start_url.is_empty() {
                WebviewUrl::App("connect.html".into())
            } else {
                WebviewUrl::App("desktop/index.html".into())
            };

            let inject = format!(
                "window.__MOVIECLAW_SERVER__ = {};",
                serde_json::to_string(&start_url).unwrap()
            );

            WebviewWindowBuilder::new(app, "main", url)
                .title("MovieClaw")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 600.0)
                .center()
                .decorations(false)
                .initialization_script(&inject)
                .build()?;

            // 系统托盘图标
            {
                use tauri::tray::{TrayIconBuilder, TrayIconEvent};
                use tauri::menu::{Menu, MenuItem};

                let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
                let reconnect = MenuItem::with_id(app, "reconnect", "更改服务器", true, None::<&str>)?;
                let check_update = MenuItem::with_id(app, "check_update", "检查更新", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &reconnect, &check_update, &quit])?;

                let _tray = TrayIconBuilder::with_id("main")
                    .icon(app.default_window_icon().unwrap().clone())
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "reconnect" => {
                            let _ = connect::clear_server_url();
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.eval("window.location.href = 'http://tauri.localhost/connect.html'");
                                let _ = w.set_focus();
                            }
                        }
                        "check_update" => {
                            let app_handle = app.clone();
                            std::thread::spawn(move || {
                                match updater::check_for_updates() {
                                    Ok(info) => {
                                        if info.has_update {
                                            // 显示更新提示：弹窗 + 打开下载页
                                            use tauri::Emitter;
                                            let _ = app_handle.emit("update_available", serde_json::json!({
                                                "version": info.latest_version,
                                                "current": info.current_version,
                                                "message": info.message,
                                                "download_url": info.download_url,
                                                "release_notes": info.release_notes
                                            }));
                                            // 在浏览器打开 release 页
                                            let _ = updater::open_release_page();
                                        } else {
                                            use tauri::Emitter;
                                            let _ = app_handle.emit("update_check_result", serde_json::json!({
                                                "has_update": false,
                                                "message": info.message
                                            }));
                                        }
                                    }
                                    Err(e) => {
                                        use tauri::Emitter;
                                        let _ = app_handle.emit("update_check_result", serde_json::json!({
                                            "has_update": false,
                                            "message": format!("检查更新失败: {e}")
                                        }));
                                    }
                                }
                            });
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::DoubleClick { .. } = event {
                            let app = tray.app_handle();
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            }

            // 启动后静默检查更新（延迟 5 秒，不影响启动速度）
            {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    if let Ok(info) = updater::check_for_updates() {
                        if info.has_update {
                            use tauri::Emitter;
                            let _ = app_handle.emit("update_available", serde_json::json!({
                                "version": info.latest_version,
                                "current": info.current_version,
                                "message": info.message,
                                "download_url": info.download_url,
                                "release_notes": info.release_notes
                            }));
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            connect::save_server_url,
            connect::load_server_url,
            connect::clear_server_url,
            connect::get_server_url,
            connect::probe_server,
            updater::check_for_updates,
            updater::open_download_page,
            updater::open_release_page,
            api_proxy::proxy_api,
            get_main_window_hwnd,
            lan_discovery::discover_servers,
            player_embedded::has_embedded_player,
            player_embedded::launch_embedded_player,
            player_embedded::resize_embedded_player,
            player_embedded::set_embedded_player_visible,
            player_embedded::stop_embedded_player,
            player_embedded::send_mpv_command_embedded,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MovieClaw Desktop");
}
