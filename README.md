# MovieClaw Windows

MovieClaw 的 Windows 桌面客户端。连接自己的 MovieClaw 服务器，浏览媒体库、搜索影片、播放电影与剧集。

## 安装

1. 打开 [下载页面](https://github.com/sexyfeifan/MovieClaw-Windows/releases/latest)，下载 `MovieClaw-Desktop-1.0.0-Setup-x64.exe`。
2. 运行安装包，启动 MovieClaw。
3. 输入服务器地址并登录，例如 `http://NAS地址:3000`。

支持 Windows 10/11 x64。安装包包含 mpv 播放器及 WebView2 离线安装组件，无需安装 Python、Node.js、Rust、FFmpeg 或额外解码器。便携版包含播放器，要求系统已有 WebView2。

## 使用

- 侧栏可收起或展开，搜索支持 `Ctrl+F`。
- 全局搜索排除首页隐藏的媒体库及已识别的成人内容。
- 播放支持续播、字幕、音轨、画质、倍速与画中画。
- 双击视频区域或按 `F` 切换全屏；全屏画幅可选“保持原比例”或“填满屏幕”。
- 右上角显示读取速度，点击速度或“播放信息”按钮查看详细信息；`I` 也可打开。
- 在“设置 → 关于”检查更新、查看构建号与开源许可。

扫码登录要求服务端支持 Windows 设备配对，见 [NAS 配置说明](docs/deployment/windows-pairing.md)。库管理与服务器设置使用服务端 Web 管理界面。

## 源码

```text
apps/desktop/      Windows 客户端、测试与打包脚本
apps/apple/        上游 Apple 客户端
apps/web/          服务器 Web 界面
src/movieclaw_api/ 服务器 API
alembic/          数据库迁移
docker/           Docker 配置
docs/             文档
tests/            服务端测试
```

Windows 构建：在 `apps/desktop/` 运行 `npm ci`，再运行 `pwsh -File scripts/package.ps1`。安装包版本独立于服务器版本。

基于 [MovieClaw](https://github.com/movieclaw/MovieClaw)。本仓库保留上游服务器和 Apple 源码，便于兼容性维护。

当前安装包未进行 Authenticode 签名。原盘目前提供主影片取流路径；光盘菜单、多角度、加密光盘及 DVD 位图字幕降级不在支持范围内。GPU 硬解、HDR 输出与音频直通取决于设备能力。
