# MovieClaw Windows

MovieClaw 的 Windows 桌面客户端。连接自己的 MovieClaw 服务器，浏览媒体库、搜索影片、播放电影与剧集。

## 安装

1. 打开 [下载页面](https://github.com/sexyfeifan/MovieClaw-Windows/releases/latest)，下载 `MovieClaw-Desktop-1.0.3-Setup-x64.exe`。
2. 运行安装包，启动 MovieClaw。
3. 输入服务器地址并登录，例如 `http://NAS地址:3000`。

支持 Windows 10/11 x64。安装包包含 mpv 播放器及 WebView2 离线安装组件，无需安装 Python、Node.js、Rust、FFmpeg 或额外解码器。便携版包含播放器，要求系统已有 WebView2。

## 使用

- 设置中可分别开启“我的订阅”和“发现”，两个入口默认关闭。发现支持浏览和订阅作品；我的订阅可查看下载、入库进度与追踪日程。
- 侧栏可收起或展开，搜索支持 `Ctrl+F`。
- 全局搜索排除首页隐藏的媒体库及已识别的成人内容。
- 播放支持续播、字幕、音轨、画质、倍速与画中画。
- 详情页可先选择播放版本、音轨和字幕；管理员可生成单语或双语 AI 字幕，并查看、取消或重试任务。
- 左右方向键前进或后退，上下方向键调整音量，控制器显示当前音量。
- 双击视频区域或按 `F` 切换全屏；全屏画幅可选“保持原比例”或“填满屏幕”。
- 右上角显示读取速度，点击速度或“播放信息”按钮查看详细信息；`I` 也可打开。
- 在“设置 → 关于”检查更新、查看构建号与开源许可。
- 安装可选的[服务器观看动态插件](plugins/watch-presence/README.md)，开启“显示服务器好友列表”后，从主界面侧栏或播放器左上角的“正在观看”查看自己的设备与好友、最近历史，并从头播放或跟上进度。入口和公开共享默认关闭；查看自己的设备无需公开，好友共享范围由各成员自行选择。

扫码登录入口暂时隐藏。AI 字幕使用服务器上的参考字幕和已配置的 AI 模型；PGS 图片字幕需要服务器支持 OCR。无参考字幕的语音转写暂不支持。库管理与服务器设置使用服务端 Web 管理界面。

## 源码

```text
apps/desktop/      Windows 客户端、测试与打包脚本
apps/apple/        上游 Apple 客户端
apps/web/          服务器 Web 界面
plugins/           可选服务端插件
src/movieclaw_api/ 服务器 API
alembic/          数据库迁移
docker/           Docker 配置
docs/             文档
tests/            服务端测试
```

Windows 构建：在 `apps/desktop/` 运行 `npm ci`，再运行 `pwsh -File scripts/package.ps1`。安装包版本独立于服务器版本。

基于 [MovieClaw](https://github.com/movieclaw/MovieClaw)。本仓库保留上游服务器和 Apple 源码，便于兼容性维护。

当前安装包未进行 Authenticode 签名。原盘目前提供主影片取流路径；光盘菜单、多角度、加密光盘及 DVD 位图字幕降级不在支持范围内。GPU 硬解、HDR 输出与音频直通取决于设备能力。
