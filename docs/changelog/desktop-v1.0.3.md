<!-- desktop-release-policy: ci-verified -->

# MovieClaw Windows 1.0.3(61.1)

连接自己的 MovieClaw 服务器，在 Windows 上浏览媒体库、播放电影与剧集。

- 安装：下载标有构建号的安装版 ZIP，解压后运行 `MovieClaw-Desktop-1.0.3(61.1)-Setup-x64.exe`，安装后输入服务器地址并登录。
- 软件内更新使用兼容 EXE，与带构建号的安装程序内容一致。
- 正在观看：从主界面侧栏或播放器左上角查看自己的设备与已授权好友，查看影片、进度及最近观看历史，选择从头播放或跟上进度。同账号当前播放按设备区分，历史按影片或单集合并。
- 隐私：好友入口和观看共享默认关闭。各成员可选择允许共享的媒体库；未选或新建的库默认保密。
- 自己的设备无需开启公开共享即可由自己查看。Web / Mac / 手机用户可在同一服务器登录后打开 `/api/v1/plugins/watch-presence/settings` 授权共享。
- 插件：在服务器 Web 设置 → 插件上传 `MovieClaw-Watch-Presence-1.0.0.mcplugin`，核对并批准主进程运行。兼容基线为 MovieClaw 0.36.0，无额外运行程序或容器。详见附带的 `Watch-Presence-Guide.md`。
- Windows 10/11 x64。安装版包含 mpv 播放器与 WebView2 离线组件；便携版要求系统已有 WebView2。

[使用说明](https://github.com/sexyfeifan/MovieClaw-Windows#readme)

附 `SHA256SUMS.txt` 和 `release-manifest.json`。客户端及插件自动化测试通过，本机安装和启动已验证；NAS 多设备实测及完整 Windows/macOS 物理硬件对等验收尚未完成。安装包未签名，HDR、音频直通与原盘功能以设备能力及支持范围为准。
