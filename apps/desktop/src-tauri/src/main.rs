#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod connect;
mod player;

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
            // 启动时检查是否已有服务器配置，决定加载连接页还是 Web UI
            let start_url = connect::load_server_url().unwrap_or_default();
            let url = if start_url.is_empty() {
                WebviewUrl::App("connect.html".into())
            } else {
                let parsed = start_url.parse::<url::Url>()
                    .or_else(|_| format!("http://{start_url}").parse::<url::Url>())
                    .unwrap_or_else(|_| "about:blank".parse().unwrap());
                WebviewUrl::External(parsed)
            };

            WebviewWindowBuilder::new(app, "main", url)
                .title("MovieClaw")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 600.0)
                .center()
                .initialization_script(INJECT_SCRIPT)
                .build()?;

            // 系统托盘图标
            {
                use tauri::tray::{TrayIconBuilder, TrayIconEvent};
                use tauri::menu::{Menu, MenuItem};

                let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
                let reconnect = MenuItem::with_id(app, "reconnect", "更改服务器", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &reconnect, &quit])?;

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running MovieClaw Desktop");
}
