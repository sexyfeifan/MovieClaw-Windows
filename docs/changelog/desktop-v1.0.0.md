<!-- desktop-release-policy: ci-verified -->

# Windows 1.0.0：清晰的媒体库，自由的播放画幅

首页媒体库封面、深色菜单和详情页完成修复。全屏播放可在“保持原比例”和“填满屏幕”之间切换，也可以进入置顶小窗。

## 浏览与搜索

- 首页媒体库显示封面拼贴，排序和季数菜单采用可读的深色样式；修复按钮图标遮挡及详情页布局。
- 全局搜索排除首页隐藏库、成人库和明确成人分级内容。旧服务端也会过滤返回的媒体条目；未确认搜索范围时不显示人物建议。
- 点击电视剧单集时保留已加载的封面，图片失败时显示占位背景，避免闪出破图。

## 播放

- 全屏画幅菜单支持“保持原比例”和“填满屏幕”；填满会裁切超出屏幕的部分，可随时切回。
- 画中画按钮将播放器变为置顶小窗，按 Esc 或再次点击恢复窗口；结束播放恢复原窗口。
- 原生 mpv 播放、字幕/音轨选择、续播与进度同步、账号隔离和校验更新包沿用已完成的 Windows 实现。

## 安装与服务器

下载 `MovieClaw-Desktop-1.0.0-Setup-x64.exe` 安装，或解压 portable ZIP。安装器在缺少 WebView2 时提供安装；便携包需要系统已有 WebView2。

Windows 扫码登录需要服务端 `/api/v1/auth/bootstrap` 宣告 `windows` 配对能力。旧服务端仍可用密码登录；本仓库提供兼容检查脚本和 [NAS 配置说明](https://github.com/sexyfeifan/MovieClaw-Windows/blob/feat/windows-native/docs/deployment/windows-pairing.md)。Windows 客户端 1.0.0 与服务端版本独立；当前 NAS 为 0.34.0，不能用本分支自报 0.32.0 的整个服务端直接替换，需要兼容升级或审核移植 Windows 配对增量。

## 验证范围与已知限制

本版本按显式选择的 CI 验证流程发布：浏览器端到端、服务端契约、Rust 实际 HTTP/mpv IPC、Windows 打包和安装冒烟检查通过后，使用该提交的原始 CI 安装包发布，并附 SHA-256 与 `release-manifest.json`。

**安装包及应用未进行 Authenticode 签名**，Windows 可能提示未知发布者。此版本不宣称完整的 Mac/Windows 硬件等效验收；多显示器 DPI、全部 HDR/Dolby 输出设备、音频直通和原盘/ISO 实机测试仍需对应设备与资源。没有原盘资源时，原盘验证保留为待验收。

原盘功能目前是主影片取流/服务端降级路径，光盘菜单、多角度、加密光盘和 DVD VobSub 降级尚不支持；播放菜单会如实说明不可用的字幕，不能把模拟主影片测试当作完整光盘支持。

已知成人库名称与明确成人分级会被排除；缺少分级且位于普通库中的内容无法自动可靠判定，需在服务端正确分类。

旧安装包与旧 GitHub Releases 在本版本发布成功后清理；保留 Git 提交历史及源码标签。

完整改动：[上一正式版 → 1.0.0](https://github.com/sexyfeifan/MovieClaw-Windows/compare/desktop-v0.2.111...desktop-v1.0.0)。
