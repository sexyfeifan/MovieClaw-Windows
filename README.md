<p align="center">
  <img src="docs/images/banner.en.jpg" width="900" alt="MovieClaw Windows Desktop">
</p>

<p align="center">
  <b>MovieClaw Windows Desktop</b> — 基于 <a href="https://github.com/movieclaw/MovieClaw">MovieClaw</a> 的 Windows 桌面客户端<br>
  Tauri + WebView2 + mpv 混合架构 · 本地硬解 · 进度同步 · 自动更新
</p>

<p align="center">
  <a href="#quick-start">快速开始</a> ·
  <a href="#directory-structure">目录结构</a> ·
  <a href="#desktop-client">桌面客户端</a> ·
  <a href="#deployment">部署</a> ·
  <a href="#ci--cd">CI/CD</a>
</p>

---

## Quick Start

### 桌面客户端（Windows x64）

1. 从 [1.0.0 Release](https://github.com/sexyfeifan/MovieClaw-Windows/releases/tag/desktop-v1.0.0) 下载 `MovieClaw-Desktop-1.0.0-Setup-x64.exe`
2. 运行安装包，启动后输入 MovieClaw 服务器地址
3. 浏览海报墙 → 点击播放 → mpv 本地硬解播放

**系统要求**: Windows 10/11 x64，WebView2 Runtime。安装包已包含 mpv；缺少 WebView2 时安装器会提供安装。

本版包含媒体库封面、深色菜单、隐藏库/成人内容搜索过滤、单集封面修复、全屏画幅选择和置顶小窗。包未进行 Authenticode 签名；验证范围见 [1.0.0 更新说明](docs/changelog/desktop-v1.0.0.md)。扫码登录的 NAS 条件见 [配置说明](docs/deployment/windows-pairing.md)。

### 服务端部署

```bash
# Docker 一键部署（推荐）
docker-compose up -d

# 或使用 CLI
python -m movieclaw_api.main
```

---

## Directory Structure

```
MovieClaw-Windows/
├── src/movieclaw_api/          # 🖥️ 服务端 — Python FastAPI 后端
├── apps/
│   ├── web/                    # 🌐 服务端 — Next.js Web UI
│   ├── desktop/                # 🪟 客户端 — Windows 桌面应用（本仓库核心）
│   │   ├── src-tauri/          #   Rust/Tauri 壳 + mpv 控制
│   │   ├── ui/desktop/         #   内嵌媒体库页面与播放器控件
│   │   ├── tests/              #   单元测试与端到端测试
│   │   ├── release/            #   硬件验收模板
│   │   └── scripts/            #   构建、NSIS 打包、验收与兼容检查
│   ├── apple/                  # 📱 客户端 — iOS/macOS（上游）
│   └── extension/              # 🧩 浏览器扩展（上游）
├── docker/                     # 🐳 Docker 部署配置
├── alembic/                    # 🗄️ 数据库迁移
├── tests/                      # ✅ 测试套件
├── .github/workflows/          # 🤖 CI/CD + 上游监控
└── docs/                       # 📖 文档
```

### 服务端 vs 客户端

| 组件 | 位置 | 技术栈 | 用途 |
|---|---|---|---|
| **API 后端** | `src/movieclaw_api/` | Python FastAPI | 媒体库管理、播放会话、转码决策 |
| **Web UI** | `apps/web/` | Next.js + React | 浏览器端海报墙、详情页 |
| **Windows 桌面** | `apps/desktop/` | Tauri 2 + WebView2 + mpv | 原生桌面体验，mpv 本地硬解 |
| **iOS** | `apps/apple/` | Swift | iPhone/iPad 客户端 |

> **客户端只需 `apps/desktop/`**，但运行需要服务端提供 API。两者通过 HTTP REST API 通信。

---

## Desktop Client

### 架构

```
┌──────────────────────────────────────┐
│  Tauri Shell (Rust)                  │
│  ├── WebView2 (内嵌桌面 UI)         │
│  │   └── desktop/ (页面与播放控件)   │
│  ├── mpv sidecar (本地硬解播放)      │
│  │   └── JSON IPC named pipe         │
│  └── System Tray                     │
└──────────────────────────────────────┘
         ↕ HTTP REST API
┌──────────────────────────────────────┐
│  MovieClaw Server                    │
│  ├── /api/v1/playback/sessions       │
│  ├── /api/v1/playback/progress       │
│  └── /api/v1/...                     │
└──────────────────────────────────────┘
```

### 核心功能

- **播放桥**: 内嵌桌面页面 → 创建播放会话 → 启动 mpv，字幕和进度由原生桥同步
- **本地硬解**: `universal: true` → tier 0 直连播放 → mpv `--hwdec=auto-safe`
- **进度同步**: 每 10s 上报 `/playback/progress`，支持 start/progress/stop 事件
- **音量控制**: 浮动控件 + 快捷键 (↑↓ / M)，通过 mpv IPC 控制
- **自动更新**: 启动时静默检查 GitHub Releases，托盘菜单手动检查
- **单实例**: `tauri-plugin-single-instance` 防止重复启动
- **系统托盘**: 显示主窗口 / 更改服务器 / 检查更新 / 退出

### 解码策略

| 场景 | 行为 |
|---|---|
| 视频编码/容器兼容 | **tier 0 直连播放** — mpv 本地硬解 |
| 视频编码/容器不兼容 | **服务器转码** — mpv 解码转码流 |

---

## Deployment

### 开发环境

```bash
# 1. 启动服务端
cd /path/to/MovieClaw-Windows
docker-compose up -d

# 2. 启动桌面客户端（开发模式）
cd apps/desktop
pnpm tauri dev
```

### 构建安装包

```bash
cd apps/desktop
powershell -File scripts/package.ps1
```

产物输出到 `apps/desktop/dist/`:
- `MovieClaw-Desktop-*-Setup-x64.exe` — NSIS 安装包
- `MovieClaw-Desktop-portable-x64.zip` — 便携版

---

## CI / CD

| Workflow | 触发 | 功能 |
|---|---|---|
| `desktop-ci.yml` | push/PR | 编译 + 打包 + 上传 Artifacts |
| `desktop-release.yml` | tag `v*` | 构建 Release + 安装包 + 上传 GitHub Releases |
| `upstream-watch.yml` | 每周 | 监控上游 MovieClaw API 变更 |

---

## Upstream

本仓库 fork 自 [movieclaw/MovieClaw](https://github.com/movieclaw/MovieClaw)，保留全量代码以便：

1. **上游 API 变更监控** — `upstream-watch.yml` 自动 diff 上游
2. **完整部署能力** — 客户端 + 服务端一站式
3. **快速同步** — `git remote add upstream` + `git merge upstream/main`

```bash
# 同步上游更新
git fetch upstream
git merge upstream/main
```

---

<p align="center">
  <sub>Based on <a href="https://github.com/movieclaw/MovieClaw">MovieClaw</a> · Licensed under the same terms</sub>
</p>
