# MovieClaw Desktop (Windows)

MovieClaw 桌面客户端 — WebView2 浏览库 + mpv 原生播放。

## 架构

```
┌─ Tauri 2 ──────────────────────────────────┐
│  主窗口 = WebView2                           │
│  ├─ 首启：connect.html（输入服务器地址）      │
│  └─ 之后：加载服务器 Web UI                   │
│                                              │
│  注入桥 (inject.js)                          │
│  └─ 拦截 /play/ 路由 → POST /playback/sessions│
│     → invoke("launch_player") → mpv          │
│                                              │
│  Rust 宿主                                   │
│  ├─ connect.rs — 服务器配置、健康探活          │
│  ├─ player.rs  — mpv 进程管理 + IPC 观测      │
│  └─ playback.rs — 进度/心跳/结束上报           │
└──────────────────────────────────────────────┘
```

## 开发

### 前置工具链（一次性安装）

- **Rust GNU 工具链**：`rustup toolchain install stable-x86_64-pc-windows-gnu`
- **llvm-mingw**：下载 [llvm-mingw-20260922-ucrt-x86_64.zip](https://github.com/mstorsjo/llvm-mingw/releases)
  解压到 `C:\Users\<user>\toolchains\llvm-mingw-20260922-ucrt-x86_64\`
- **stub libgcc**：在 `x86_64-w64-mingw32\lib\` 创建空的 `libgcc.a`，
  将 `libunwind.a` 复制为 `libgcc_eh.a`

无需安装 Visual Studio Build Tools。

### 构建 & 运行

```powershell
.\scripts\dev.ps1          # 编译 + 运行
.\scripts\dev.ps1 build    # 只编译
.\scripts\dev.ps1 run      # 只运行
```

### 环境变量

| 变量 | 说明 |
|---|---|
| `MOVIECLAW_MPV` | mpv.exe 路径（缺省从 PATH / 同目录 mpv/ 查找） |

## 播放流程

1. 用户在 Web UI 海报墙点击影片 → Next.js 路由 `/play/127/s01e03?t=5`
2. `inject.js` 拦截 `pushState`（不跳转，留在海报墙）
3. webview 侧 `POST /api/v1/playback/sessions`（universal 直通能力，恒为档 0 直通）
4. Rust `launch_player` 拉起 mpv：`--start=N --sub-file=... --input-ipc-server=\\.\pipe\...`
5. mpv IPC 观测 `time-pos/pause/eof` → 进度上报

## 打包

```powershell
.\scripts\build.ps1 release
```

产出 `target\release\movieclaw-desktop.exe`。后续用 Inno Setup 打安装包。
