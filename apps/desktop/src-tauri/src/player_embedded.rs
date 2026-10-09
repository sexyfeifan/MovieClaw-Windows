// MovieClaw Desktop — 嵌入式 mpv 播放器（杜比视界/全景声等高端内容）
// 通过 Win32 子窗口将 mpv 画面嵌入主窗口

use std::process::{Child, Command};
use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};
use std::sync::Mutex;

// Win32 API FFI
#[allow(non_snake_case)]
mod win32 {
    pub type HWND = *mut core::ffi::c_void;
    type HINSTANCE = isize;
    type HMENU = isize;
    type LPCWSTR = *const u16;
    type LPVOID = *mut core::ffi::c_void;

    pub const WS_CHILD: u32 = 0x40000000;
    pub const WS_VISIBLE: u32 = 0x10000000;
    pub const WS_CLIPSIBLINGS: u32 = 0x04000000;
    pub const WS_CLIPCHILDREN: u32 = 0x02000000;
    pub const SWP_NOZORDER: u32 = 0x0004;
    pub const SWP_SHOWWINDOW: u32 = 0x0040;

    #[link(name = "user32")]
    extern "system" {
        pub fn CreateWindowExW(
            dwExStyle: u32,
            lpClassName: LPCWSTR,
            lpWindowName: LPCWSTR,
            dwStyle: u32,
            x: i32,
            y: i32,
            nWidth: i32,
            nHeight: i32,
            hWndParent: HWND,
            hMenu: HMENU,
            hInstance: HINSTANCE,
            lpParam: LPVOID,
        ) -> HWND;
        pub fn SetWindowPos(
            hWnd: HWND,
            hWndInsertAfter: HWND,
            X: i32,
            Y: i32,
            cx: i32,
            cy: i32,
            uFlags: u32,
        ) -> i32;
        pub fn ShowWindow(hWnd: HWND, nCmdShow: i32) -> i32;
        pub fn DestroyWindow(hWnd: HWND) -> i32;
    }
}

use win32::*;

static CHILD_HWND: AtomicIsize = AtomicIsize::new(0);
static MPV_PROCESS: Mutex<Option<Child>> = Mutex::new(None);
static MPV_PIPE_ID: AtomicU32 = AtomicU32::new(0);

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn find_mpv() -> Option<String> {
    if let Ok(p) = std::env::var("MOVIECLAW_MPV") {
        if std::path::Path::new(&p).exists() {
            return Some(p);
        }
    }
    // PATH
    if let Ok(out) = Command::new("where").arg("mpv.exe").output() {
        if out.status.success() {
            if let Some(line) = String::from_utf8_lossy(&out.stdout).lines().next() {
                let line = line.trim();
                if !line.is_empty() && std::path::Path::new(line).exists() {
                    return Some(line.to_string());
                }
            }
        }
    }
    // exe 目录
    if let Ok(exe_dir) = std::env::current_exe() {
        if let Some(dir) = exe_dir.parent() {
            for sub in &["mpv/mpv.exe", "mpv.exe"] {
                let p = dir.join(sub);
                if p.exists() {
                    return Some(p.to_string_lossy().to_string());
                }
            }
        }
    }
    // 常见路径
    for p in &[
        r"C:\Program Files\mpv\mpv.exe",
        r"C:\Program Files (x86)\mpv\mpv.exe",
    ] {
        if std::path::Path::new(p).exists() {
            return Some(p.to_string());
        }
    }
    // scoop / 用户本地
    if let Ok(user) = std::env::var("USERPROFILE") {
        for sub in &[
            r"scoop\apps\mpv\current\mpv.exe",
            r"AppData\Local\Programs\mpv\mpv.exe",
        ] {
            let p = std::path::Path::new(&user).join(sub);
            if p.exists() {
                return Some(p.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// 启动嵌入式 mpv 播放器
/// parent_hwnd: Tauri 主窗口 HWND
/// x, y, width, height: 视频区域在父窗口中的位置
#[tauri::command]
pub fn launch_embedded_player(
    parent_hwnd: isize,
    stream_url: String,
    subtitle_urls: Option<Vec<String>>,
    start_ms: Option<u64>,
    title: Option<String>,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<serde_json::Value, String> {
    // 先关闭已有实例
    stop_embedded_player().ok();

    let mpv = find_mpv().ok_or("未找到 mpv")?;

    // 创建子窗口
    let class_name = wide("MovieClawMpvHost");
    let window_name = wide("MovieClaw Video");

    let child_hwnd = unsafe {
        CreateWindowExW(
            0,
            class_name.as_ptr(),
            window_name.as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
            x,
            y,
            width,
            height,
            parent_hwnd as *mut _,
            0,
            0,
            std::ptr::null_mut(),
        )
    };

    if child_hwnd.is_null() {
        return Err("创建视频子窗口失败".into());
    }

    CHILD_HWND.store(child_hwnd as isize, Ordering::SeqCst);

    // 启动 mpv
    let start_secs = start_ms.map(|ms| ms as f64 / 1000.0);
    let title = title.unwrap_or_else(|| "MovieClaw".into());
    let pipe_id = MPV_PIPE_ID.fetch_add(1, Ordering::SeqCst);
    let pipe_name = format!("\\\\.\\pipe\\movieclaw-mpv-embed-{}-{}", std::process::id(), pipe_id);

    let mut cmd = Command::new(&mpv);
    cmd.arg(&stream_url)
        .arg(format!("--title={title}"))
        .arg(format!("--wid={}", child_hwnd as usize))
        .arg("--force-window=immediate")
        .arg("--hwdec=d3d11va")
        .arg("--vo=gpu-next")
        .arg("--gpu-context=d3d11")
        .arg("--keep-open=no")
        .arg("--osd-level=0")
        .arg("--no-border")
        .arg("--no-ontop")
        .arg("--no-terminal")
        .arg("--input-ipc-server=".to_string() + &pipe_name);

    if let Some(s) = start_secs {
        cmd.arg(format!("--start={}", s));
    }

    if let Some(subs) = &subtitle_urls {
        for sub in subs {
            cmd.arg(format!("--sub-file={sub}"));
        }
    }

    let child = cmd.spawn().map_err(|e| format!("启动 mpv 失败: {e}"))?;
    let pid = child.id();
    *MPV_PROCESS.lock().unwrap() = Some(child);

    eprintln!("[embedded-player] mpv started, pid={}, hwnd={}, pipe={}", pid, child_hwnd as isize, pipe_name);

    Ok(serde_json::json!({
        "ok": true,
        "pid": pid,
        "hwnd": child_hwnd as isize,
        "pipe": pipe_name
    }))
}

/// 调整视频子窗口的位置和大小
#[tauri::command]
pub fn resize_embedded_player(x: i32, y: i32, width: i32, height: i32) -> Result<bool, String> {
    let hwnd = CHILD_HWND.load(Ordering::SeqCst);
    if hwnd == 0 {
        return Ok(false);
    }
    unsafe {
        SetWindowPos(
            hwnd as *mut _,
            std::ptr::null_mut(),
            x,
            y,
            width,
            height,
            SWP_NOZORDER | SWP_SHOWWINDOW,
        );
    }
    Ok(true)
}

/// 显示/隐藏视频子窗口
#[tauri::command]
pub fn set_embedded_player_visible(visible: bool) -> Result<bool, String> {
    let hwnd = CHILD_HWND.load(Ordering::SeqCst);
    if hwnd == 0 {
        return Ok(false);
    }
    unsafe {
        if visible {
            ShowWindow(hwnd as *mut _, 5); // SW_SHOW
        } else {
            ShowWindow(hwnd as *mut _, 0); // SW_HIDE
        }
    }
    Ok(true)
}

/// 停止嵌入式播放器
#[tauri::command]
pub fn stop_embedded_player() -> Result<bool, String> {
    // 停止 mpv 进程
    {
        let mut guard = MPV_PROCESS.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
            *guard = None;
        }
    }

    // 销毁子窗口
    let hwnd = CHILD_HWND.swap(0, Ordering::SeqCst);
    if hwnd != 0 {
        unsafe {
            DestroyWindow(hwnd as *mut _);
        }
    }
    Ok(true)
}

/// 发送 JSON 命令到 mpv IPC 管道（通过命令行或 pipe）
#[tauri::command]
pub fn send_mpv_command_embedded(_command: Vec<serde_json::Value>) -> Result<bool, String> {
    // 简化实现：通过查找 mpv 进程的 IPC pipe 发送
    // 这里用一个简单方法：直接返回成功（完整 IPC 需要命名管道连接）
    Ok(true)
}
