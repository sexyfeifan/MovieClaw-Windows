#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod connect;
mod player;
mod updater;
mod volume_overlay;

use tauri::Manager;
use tauri::WebviewUrl;
use tauri::WebviewWindowBuilder;

const INJECT_SCRIPT: &str = include_str!("../../ui/inject.js");

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 已有实例运行时，聚焦主窗口
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .on_window_event(|_, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let _ = player::stop_player();
            }
        })
        .setup(|app| {
            // 启动时检查是否已有服务器配置，决定加载连接页还是桌面 UI
            let start_url = connect::load_server_url().unwrap_or_default();
            let url = if start_url.is_empty() {
                WebviewUrl::App("connect.html".into())
            } else {
                WebviewUrl::App("desktop/index.html".into())
            };

            // 注入服务器地址到 JS 上下文
            let inject = if start_url.is_empty() {
                INJECT_SCRIPT.to_string()
            } else {
                format!("window.__MOVIECLAW_SERVER__ = {};\n{}", serde_json::to_string(&start_url).unwrap(), INJECT_SCRIPT)
            };

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
                            // 清除服务器配置，回到连接页
                            let _ = connect::clear_server_url();
                            let _ = player::stop_player();
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                // 用 Tauri 内部协议加载 connect.html
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
                            let _ = player::stop_player();
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
            connect::probe_server,
            player::launch_player,
            player::stop_player,
            player::send_mpv_command,
            updater::check_for_updates,
            updater::open_download_page,
            updater::open_release_page,
            volume_overlay::show_volume_window,
            volume_overlay::hide_volume_window,
            volume_overlay::toggle_volume_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MovieClaw Desktop");
}
