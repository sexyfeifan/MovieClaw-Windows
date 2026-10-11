# Windows 扫码登录与 NAS 配置

Windows 1.0.0 包含生成二维码、等待手机批准、超时/取消与设备令牌保存流程。令牌保存在当前 Windows 用户的凭据管理器，不写入二维码或普通配置文件。

## 检查现有服务端

在 Windows 仓库目录运行：

```powershell
./apps/desktop/scripts/check-server-compatibility.ps1 -ServerUrl 'http://YOUR-NAS:3000'
```

脚本仅访问公开的登录引导接口，不需要密码。如果 `windowsPairing` 为 false，客户端继续使用密码登录；安装新版客户端本身不能升级 NAS。

## 服务端升级

已有部署应先备份当前 `data/`，保留原来的媒体挂载、容器路径、端口和环境变量。不要用示例 compose 覆盖正在使用的配置。官方服务器镜像是否支持 Windows，以引导接口实际返回为准。

本 Windows 分支服务端源码自报 0.32.0，当前实测 NAS 为 0.34.0。不要以整个较旧服务端替换 NAS。应从现有 NAS 对应版本源码或兼容的新版开始，审核并移植 [Windows 设备配对增量](https://github.com/sexyfeifan/MovieClaw-Windows/commit/101d9ad745e5d9051c5c7d0d5240d971af5ce930)，保持现有数据库兼容性，跑设备配对和媒体库搜索契约测试后构建镜像。

如 NAS 已有 Git、Docker 与构建资源，可在独立源码目录使用该服务器版本的构建脚本；本仓库的 `scripts/build-image.sh` 需要其声明的 TMDB 配置和模型下载条件。随后仅将现有 compose 的 `image` 改为审核后的镜像名，执行 `docker compose up -d`。无 SSH 时，在容器管理界面选择同一镜像，并保持原卷和环境变量。

涉及自部署服务端升级、数据库迁移和密钥的操作需要实际部署入口，不能仅凭客户端截图完成。不要发送密码或私钥到聊天。

## 扫码试用

1. 客户端输入可由手机访问的 NAS 地址，选择扫码登录。
2. 手机扫描二维码；在 NAS 网页以自己的账号登录并批准显示的 Windows 设备。
3. 客户端完成登录后，NAS “我的设备”中会出现 Windows App。取消或超时的配对不能继续安装凭据。

反向代理需转发 `/api/v1/auth/*`，手机和电脑需能访问二维码中的地址。`localhost` 只指当前设备，不能作为跨设备配对地址。HTTPS 部署应保持正确的公开 URL 与代理路径。没有可访问的 NAS 管理入口时，只能完成代码、契约测试和配置准备，实际服务端升级及手机批准仍待执行。
