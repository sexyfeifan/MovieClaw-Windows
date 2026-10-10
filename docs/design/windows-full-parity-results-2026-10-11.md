# Windows 全阶段修复、证据和真机验收

本次执行范围已从阶段 0–2 扩展至原计划阶段 0–7。用户确认暂时没有 Windows 真机或自托管 runner，因此本次交付范围是可实现的代码、GitHub 托管 CI、可复跑的测试与性能采集，以及明确的硬件验收清单。硬件解码、最终 HDR/音频输出和 Windows/macOS 同条件性能结论必须等待真机，不能用托管虚拟机或 Chromium fixture 代替。

固定 Windows 起点为 `desktop-v0.2.111` / `30cd3642daba58f2cc3e614b269c335c108beb59`；macOS 实际可见界面和行为基线为 `9139a638a391ed91bcb2d48940b6e8d595de5a56`。原始问题、范围和验收门槛见 [完整计划](windows-parity-plan-2026-10-11.md)。分支继续使用 `codex/windows-stages-0-2`，名字不代表本次只做三个阶段。

## 交付与证据状态

基础集成提交 `c6c90e312c44d0fd1e24c5998dc856c5fcc903eb` 已通过 [Windows 托管 CI](https://github.com/sexyfeifan/MovieClaw-Windows/actions/runs/38077233682)：MSVC Release 构建、实际 mpv 解码/IPC、WebView2 原生就绪、关闭、NSIS 安装/启动/卸载与便携包全部通过。便携包界面就绪 6.805 秒、关闭 0.062 秒；安装版就绪 1.680 秒、关闭 0.036 秒。这里计的是界面 bridge 就绪，而不是仅找到原生窗口句柄。

本地最终回归已通过 JavaScript 单测90条、真实浏览器DOM/HTTP测试40条、后端381条和Web28条；后端2条字体测试因Mac缺少Linux测试字体跳过，托管流程明确安装字体并重跑。全仓ruff和正式desktop cargo check --tests通过。

全仓[PR CI](https://github.com/sexyfeifan/MovieClaw-Windows/actions/runs/38080732966)已通过：Python三分片合计5352 passed/37 skipped/3 xfailed/1 xpassed，Web lint/typecheck、Go CLI六平台构建、macOS Worker构建/单测全部成功。

Windows首轮已完成原生编译和真实凭证/网络合同；真实mpv的关闭轨道属性返回JSON false，已修正测试合同并改用可seek文件验证前进/回退，避免EOF假阳性。更新器改用原始stdout管道写UTF8 JSON，保留真实Authenticode和无控制台回归；其最终Windows结果仍待下轮实证。

本文在最后一轮集成验证期间持续更新；新增平台、更新、原盘与性能门禁的最终提交、运行、产物哈希和测试数量会在 CI 收尾后登记。没有创建稳定 Release。

最终提交 `c377212821e96fce9f52cdae80ba2914dc790c96` 的服务端合同已在 [push CI](https://github.com/sexyfeifan/MovieClaw-Windows/actions/runs/38080717852) 与 [PR CI](https://github.com/sexyfeifan/MovieClaw-Windows/actions/runs/38080732879) 双绿：383条真实API/媒体测试、28条Web设备展示与审批测试全部通过，没有跳过；Ubuntu实际FFmpeg/ffprobe为6.1.1。包含DVD重排音轨跨VOB续播、碎片ISO主标题取流、PGS字幕和会话DELETE缓存清理。

| 阶段 | 代码与自动化交付 | 尚需外部证据 |
| --- | --- | --- |
| 0 固定基线与构建 | 锁定 MSVC、Cargo/npm 依赖、mpv 与 Vulkan loader 来源/哈希/许可；安装器与便携包共用组装；原生就绪、关闭、安装/卸载门禁与环境报告 | 用户 Windows 10/11、干净非管理员系统、缺 WebView2 的安装引导 |
| 1 API 与浏览 | 修正搜索/账号/人物/up-next 合同；服务端分页/排序/过滤；路由取消与上下文隔离；可操作的未登录窗口与安全文本 | 实际 Windows 字体、系统缩放和长期使用体验 |
| 2 播放生命周期 | 双引擎共享文件时间、观看 attempt、首帧后上报、最终快照、会话保活/回收、换画质与换集、EOF 与有界关闭 | 用测试账号在真实 NAS 检查最终进度；不可达或断电不保证最终投递 |
| 3 播放控制 | 持久 mpv IPC 与属性订阅、真实轨 ID 映射、字幕/音轨/速度、预览与 skip/章节、字幕语言与记忆、失败恢复预算、鼠标/快捷键输入桥 | 视频区域真实鼠标输入、ASS 字体/PGS、同步、输出设备效果 |
| 4 账户与平台 | 第一方 Windows device kind、Credential Manager、设备配对与旧服务器兼容；上下文原子切换、撤销与迟到 token 守卫；离线移除有界并保留加密待撤销作业；UDP7359；受控二进制 Range 传输；SMTC、播放防休眠、置顶/比例贴合/还原、DPI；流式下载/hash/签名验证与安装 | LAN 网卡/防火墙、真实 Credential Manager、媒体键、休眠与跨屏行为 |
| 5 页面与交互 | 按实际 Mac 对齐 HomeRows、UpNext Hero、pinned 合集、墙、搜索、人物、详情与长季；每 tab 导航/滚动恢复；焦点、减少动效与三尺寸截图 | 相同真实数据在 Windows 上逐页对照；字体和原生按钮按平台处理 |
| 6 媒体与性能 | 有界且默认关闭的脱敏诊断；30 样本页面基准、滚动原始帧间隔、20 次真实 HTML5 起播/释放；大库缓存与 DOM 限额；原生进程树采集与合成软件解码；BDMV/DVD/ISO 主标题的服务端 HLS 降级、真实 FFmpeg 和 API 生命周期回归 | 真实 GPU/显示器/音响；30 次起播/seek、30 分钟/2 小时播放，同条件 Mac 对照 |
| 7 发布与维护 | 从同一通过 CI 的提交取产物，校验哈希/许可/签名状态，保留明确硬件门禁、回滚；以固定 Mac SHA 比较官方完整源码树并生成差异报告 | 本次不覆盖已有 0.2.111 Release；稳定发布取决于完整门禁 |

## F01–F24 修复追踪

“自动化”指真实 HTTP/DOM、Rust TCP/命名管道或包烟测；使用原生 bridge fixture 的页面测试只验证桥合同，不代表 mpv 图像输出已经通过。

| 问题 | 最终行为与主要回归 |
| --- | --- |
| F01 搜索空结果 | 展开 `hit.item`，保留库/命中说明、人物过滤与 cursor；真实 DOM 搜索进入正确详情 |
| F02 账号错配 | 按 `username/active` 切换；鉴权变更串行等待，旧界面/请求先失效；慢登录失败、取消、重新登录和账号切换回归 |
| F03 扫码无效 | 原生 authorize/token 协商，浏览器只见公开二维码与不透明 pairing ID；批准、拒绝、过期、取消与重试回归 |
| F04 人物无作品 | 直接使用 `PersonView.credits`，带本片/角色、缺源状态并可返回详情 |
| F05 墙截断/全量加载 | 60 项服务端分页，不设 200/5100 总量上限；只保留 12 页完整对象与可见行 DOM，返程按原 cursor/offset 重新取页 |
| F06 迟到请求覆盖 | 页面/账号/服务器代数与读取取消；A→B 搜索和导航、迟到原生 status 回归 |
| F07 续播季错误 | 解析 `up-next.data.items` 与新版 `resume_episode`；第三季、季 0、缺集、49/50/51 和 1050→1051 边界回归 |
| F08 原生不上报 | mpv 首帧后 start/progress，有会话才 ping；与 HTML5 共用进度队列 |
| F09 关闭归零/EOF | 停引擎之前保存有效快照；stop 与 DELETE 有序且限时；EOF 单次、提前退出不当作看完 |
| F10 时间轴混用 | `timeline=session` 只加一次 origin；file 直接用引擎时间；显式 0、300 秒续播和关闭 321 秒回归 |
| F11 换画质失控 | 保留季集/文件/轨选择/attempt，回收旧会话与迟到新会话，统一 HLS error/close |
| F12 可见轨道控件无效 | mpv `track-list` 的 ff-index/类型序号映射到真实 ID，`aid/sid/speed/sub-delay/sub-scale` 经 IPC；不操作隐藏 video 假装生效 |
| F13 关闭后自动重播 | 换集共用动作且携带库/季集；关闭/换片/换账号清倒计时和监听 |
| F14 两个服务器混用 | 原生配置和所有请求使用同一 captured context；切换作废请求、媒体 capability 和页面缓存 |
| F15 凭证边界 | device token 保存在原生凭证层；兼容 Cookie 按完整服务端 base URL 与 path/secure/expiry 隔离，跨源取图/取流不附带；旧无归属 Cookie 不自动迁移 |
| F16 发现协议不通 | UDP7359 Jellyfin 兼容请求及返回结构，发现结果进行健康检查；手填、重试和更换地址保留 |
| F17 打包不可重复 | 删除 inject.js 与 mpv 占位入口，固定下载/哈希/运行依赖/许可；实际 MSVC 构建与安装烟测后才上传包 |
| F18 更新不可见/中文 panic | 启动和手动检查有 UI 状态，排除预发布与旧版本，中文按字符截断；固定仓库/正式 tag/x64 资源、HTTPS 重定向白名单、流式下载和取消；SHA256SUMS/资源摘要一致，安装前重新校验 hash 与 Authenticode；未签名须二次明确确认，无效签名拒绝，便携包手动替换 |
| F19 未登录窗口失效 | 窗口按钮在欢迎和登录时也绑定，连接页有外部 JS 窗口栏 |
| F20 大二进制/取消 | loopback 不透明媒体 capability，流式传输、Range206/响应头、下游断连和 revoke 真正终止；HLS progressive 与普通 buffer 路径分别处理 |
| F21 偏好/skip/预览失效 | 服务端观看记忆优先、再读语言设置；独立 trickplay 索引与 sprite；所有 skip kind 和章节使用文件时间 |
| F22 重试丢意图 | 重连保留画质/文件/轨道与观看身份；兄弟分集按库/媒体/季重建；质量记忆按账号/服务器/线路隔离 |
| F23 管道/线程积累 | 单个异步命名管道 actor、限额队列、request ID、事件订阅、3 秒命令 deadline 和 stop/cancel；Windows 真管道测试覆盖并发与分片事件 |
| F24 HTML 注入 | 文本/属性/URL 按上下文转义、连接发现用 textContent；播放器移除可执行 inline 属性，CSP 禁止 inline 事件与远程脚本；恶意媒体/查询/轨道元数据回归 |

## 实际 Mac 和局域网对照

已从固定 Mac SHA 构建独立 Debug 应用，隔离 bundle ID、Keychain 与测试登录，通过用户提供的同一服务端实际检查首页、库、电影详情和人物。侧边栏宽度、Hero 比例、静态背景、横版继续卡、人物圆头像、详情演职员/文件信息等依据真实页面校正。测试已退出登录并撤销该测试设备；未动用户现有 Mac 应用或凭证。

服务端 0.34.0 的真实 bootstrap、账号、8 个库、合集、60 项墙、嵌套搜索、人物、详情、up-next 与收藏合同已核对；鉴权海报、背景和 Logo 实际加载。原文件协商 tier 0 / `session_id=null`，Range 请求实际得到 206。未写收藏、已看或观看进度；本次真实观看状态回归仍留给专用测试账号和 Windows 验收。

NAS 账号密码、Cookie、Token、取流签名、生产媒体截图与原始 Mac trace 不进入仓库或 GitHub 产物。CI 只使用合成媒体和临时账号/本地 HTTP 服务。实际 Mac Debug 启动数据不作 Release 性能基线。

## 性能结果的解释

`apps/desktop/playwright.perf.config.cjs` 和 `tests/perf/browser-bench.spec.cjs` 固定 30 次冷/暖页面样本、239 个 rAF 间隔、20 次真实 H264 浏览器起播/释放，并报告 OS/CPU/Node/提交与 UI 源文件 SHA256。`browser-performance.json` 明确标记 `nativeWindowsMeasured=false`、`macHardwareComparable=false`。

大库测试在 10,000 项 fixture 中逐页推进到 2,460 项：完整 payload 最多 720 项，实际 DOM 45 张卡，其余为轻量 ID 索引。返回详情后能恢复同一可见卡片。索引项数量、完整对象数量和 DOM 数量分别报告，避免把轻量索引误写成完整缓存。

具体 P50/P95 以最终 CI 产物为准。Chromium 页面的 rAF 间隔不能证明 Windows 输入到显示延迟、WebView2 合成、mpv GPU 首帧或 Mac 等性能。服务器无 GPU 时也不能以未验证 HDR 透传能力换取播放“成功”；源解码、色调映射、实际目标颜色空间和最终显示必须分别记录。

## Windows 真机验收清单

SMTC 与电源请求运行在主 UI 线程，结束、迟到 begin、窗口退出都清理；退出前退役认证上下文，并有界取消下载、终止和回收签名验证子进程；托管探针验证窗口/置顶还原与电源请求释放，并单独报告该虚拟机是否能创建 SMTC。物理媒体键、实际睡眠和跨屏输出依然需要下表验证。固定 Mac 基线没有开放画中画入口，本次不把仅 HTML5 可用的浏览器画中画写成 mpv 对等功能。

| 场景 | 操作与通过条件 | 记录 |
| --- | --- | --- |
| 干净安装/升级/卸载 | Win10/11 x64、非管理员、中文/空格路径、无开发工具与 PATH mpv；缺 WebView2 时安装引导；便携和安装器；旧版升级后完整打开/退出/卸载 | OS、版本/SHA、路径、Runtime 与遗留进程 |
| 原生嵌入与输入 | 视频区域鼠标移动唤醒控制条、单击/双击、隐藏光标、拖动/键盘；最大化/最小化/恢复/退出；视频和控制层始终贴合 | 录像、窗口和 mpv 实际状态 |
| DPI/多屏 | 100%/150%/200%、不同 DPI 显示器互拖、全屏/恢复、字幕/seek 坐标，比例贴合/置顶/结束还原 | 显示器、分辨率/刷新率/缩放、截图 |
| 账号与发现 | 两账号和 A→B→A；配对批准/拒绝/过期/取消、设备撤销/密码失效、断网后登录；多网卡/防火墙/IPv4 LAN发现 | 设备列表、Credential Manager、请求归属 |
| 真实观看状态 | mpv 与 HLS 各在321秒停止并由另一客户端复查；300秒 session 起播、显式从头、第三季换质/换集、EOF | 源文件时间、服务端最终进度、会话数量 |
| 媒体键/休眠 | 前台和后台系统媒体键，暂停/继续/结束后系统状态正确；播放不自动睡眠，暂停/结束恢复 | SMTC 实际事件、系统电源行为 |
| 轨道和字幕 | 非连续音轨/字幕 ID、多语言、多声道、外挂 ASS/字体、内封 PGS、字幕关/延迟/大小；seek/换质后同步 | 实际音频/画面、aid/sid、字幕偏移 |
| 解码矩阵 | 1080p H264、4K HEVC Main10 24/60fps、AV1/VP9、高码率；软/硬解开关、硬解不支持降级；缺源/损坏文件 | hwdec-current、输出规格、掉帧、A/V同步 |
| HDR/DV/音频输出 | HDR显示器/SDR色调映射、Windows HDR 开关/跨屏；DV具体profile；TrueHD/DTS/EAC3/Atmos具体输出设备 | 实际目标 primaries/gamma、显示器/接收器状态，不能只记标签 |
| 原盘 | ISO/BDMV/DVD按最终支持矩阵：正确主标题、取流/seek/轨道，客户端不支持时走服务端可用降级或明确提示 | 盘类型、播放路径、降级成本/失败码 |
| 网络与故障 | 600KB/s、延迟/丢包、短断网/服务端重启/mpv crash，重试有界，最后有效进度未清零 | QoE脱敏结果、重试次数、残留资源 |
| 性能与长稳 | 同 NAS/文件/网络/输出、冷暖分组，各30次起播/seek；30分钟媒体矩阵、2小时连续播放、20轮换质/换集/退出；60秒空闲进程树CPU/内存/GPU | 原始样本、P50/P95/失败数、完整进程树，与同条件 Mac 比较 |
| 更新与回滚 | 包哈希匹配；签名按实际证书状态；取消/坏哈希/旧版本被拒绝；升级后能播放，保留上一已验证版本回滚 | 下载来源、SHA256、Authenticode、前后版本 |

## 服务端兼容与发布边界

Windows 原生设备登录需要服务端 bootstrap 的 `native_device_kinds` 包含 `windows`，并接纳第一方设备的密码登录、配对、撤销和失效合同。本仓已经一起修正后端；用户当前 0.34.0 NAS 未部署这些变更时会继续使用明确标注的 Cookie 兼容登录，QR 会显示升级说明。本次没有自行部署或改动该 NAS 服务。

原盘降级也需要部署本次服务端改动。它解析未加密 BDMV 的 MPLS 和 DVD 的 IFO 主标题，通过 FFmpeg `subfile/concat` 原地读取 ISO extent/VOB cell 后提供 HLS，不解压整盘，不新增客户端挂载要求。普通 UDF/ISO9660 DVD、碎片 UDF BDMV ISO、BDMV 目录与 ISO 主标题中的 PGS 字幕已加入真实 FFmpeg/API 回归；时长/轨道/编码来自逻辑主标题探测。覆盖范围以合成盘回归和最终支持矩阵为准。

**当前代码限制**：不提供光盘菜单、解密或多角度/交织导航；此降级路径不能呈现 DVD VobSub，字幕菜单会给出禁用原因并提示可用外挂文本字幕。这些不能写成“仅等待真机即全部支持”。普通主标题视频/音轨已有可用降级，最终输出效果另需真机。旧服务端给出的 raw ISO/虚拟 manifest 若无法直接播放，会明确提示，不能把它作为普通视频吞掉错误。

无法安全判断归属的旧全局 Cookie 不迁移，需要重新登录。兼容 Cookie 和原生 device token 有独立安全边界。强制杀进程/断电/服务端不可达不能保证最终进度到达；已发出但响应丢失的会话创建只能由服务端超时回收。

本次没有生成或冒充签名证书，没有覆盖既有 0.2.111 发布资源。测试包沿用 Cargo 中的 0.2.111，并以 CI 提交 SHA 标识，正式升级版本需要单独增加版本号。未通过真实硬件媒体/性能门禁之前，不将“代码通过/托管 CI 通过”改写为“与 Mac 界面、功能、性能全部相同”。

## 上游维护验证

`upstream-baseline.json`固定官方仓库`movieclaw/MovieClaw`及Mac基线；旧`yipengfei329/movieclaw`地址仍重定向至该仓库。新版Upstream Watch比较两个完整Git树，覆盖Mac界面/Shared/AetherCore/API/Apple构建，包含删除文件，不再依赖没有files字段的提交列表或最近七天窗口。[GitHub上游检查](https://github.com/sexyfeifan/MovieClaw-Windows/actions/runs/38080717926)及本地真实抓取官方main `56afe35ca6c672b888a8249b23898f14a76cb69c`后，所跟踪路径相对固定基线无变化；不同提交并不代表这些目录变化。差异报告作为待人工审查证据，不自动更新基线、导入代码或开Issue。
