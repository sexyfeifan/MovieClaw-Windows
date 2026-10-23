## Windows 0.1.2: Server plugins and playback preferences

The Windows client uses the existing server for plugin pages, playback preferences and verified server addresses. No login patch, extra container or additional service is required.

- Plugin navigation follows the current account's server-provided list. Missing plugins and revoked permissions remove their entries; browsing and playback work without optional plugins.
- Yingji pages use their existing server interface. Supported media links return to the Windows detail view or player with a fresh permission check.
- Automatic skipping follows account preferences for ads, previews and learned intros, with undo and manual controls.
- Server address selection verifies the instance signature before sending credentials. Read-only requests can retry after a network change; writes are not replayed.
- Password login and account switching use existing server endpoints. Unsupported Windows pairing stays hidden.

This community test package follows the official Windows 0.1.1 version with 0.1.2. Users of earlier private 1.x builds must install it manually once. The updater follows `windows-v` releases and ignores old private `desktop-v1.x` tags.

---

## 简体中文

## Windows 0.1.2：服务器插件与播放偏好

本版直接使用原服务端的插件页面、播放偏好和服务器地址能力。不需要登录补丁、额外 Docker 容器或其他服务。

- 插件导航来自当前账号的服务器清单；未安装、卸载或收回权限后隐藏入口。没有可选插件也能正常浏览和播放。
- 映迹沿用已有服务端页面；支持的影片链接回到 Windows 详情页或播放器，并重新核对权限。
- 自动跳过遵循账号的广告、预告和已学习片头偏好，支持撤回和手动开关。
- 自动选择服务器地址前验证实例签名；网络变化后只读请求可重试，写入不重复提交。
- 密码登录和账号切换使用已有接口，不支持的 Windows 扫码配对入口隐藏。

本社区测试包接续官方 Windows 0.1.1，版本为 0.1.2。此前私有 1.x 版须手动安装一次；新版更新器跟随 `windows-v` 发布，忽略旧私有 `desktop-v1.x` 标签。
