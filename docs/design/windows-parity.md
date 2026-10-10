# Windows 客户端对齐 macOS 功能差距清单（parity gap）

口径：以 `apps/apple/MovieClawMac` 的**可见功能面**为对齐目标（Mac v1 设计范围：
账号切换 / 搜索 / 首页 / 媒体库（详情·人物·合集）/ 播放，见 `docs/design/macos-app.md`）。
Mac 自己也未实装 Discover / Reels / Subscriptions / 设置页 / 活动 / AI / 媒体库管理
（Shared 层代码编译进目标但 MovieClawMac UI 从未引用），**不列入补齐范围**。
Windows 已有的设置页保留（Mac v1 没有设置页，这是 Windows 的超集，不是差距）。

对照基线：macOS 清单（apps/apple/MovieClawMac + Shared + AetherCore）vs
Windows 现状（apps/desktop/ui/desktop + src-tauri），v0.2.110。

---

## 1. 账号 / 登录 / 服务器（Welcome）

| # | macOS | Windows 现状 | 差距 |
|---|---|---|---|
| 1.1 | Welcome 状态机：needsServer / needsSetup / needsLogin / chooseAccount / unreachable（`MacWelcomeView`） | 分散的 login 页 + connect.html，无 unreachable / chooseAccount 阶段 | 整机状态机缺失 |
| 1.2 | 首次初始化 createAdmin（`GET/POST /auth/bootstrap`，确认密码 + 客户端校验） | api.js 已有 `getBootstrapStatus`/`createAdmin`，**无任何 UI** | 首启引导缺失 |
| 1.3 | 扫码登录在欢迎页内（segmented 账号密码/扫码，`MacPairingLogin`：QR + 配对码 + 5 分钟过期 + 换一个码） | QR 配对只在登录后的设置页（3s 轮询 + 60s 自动关） | 登录路径不全 |
| 1.4 | `MacAccountChooser` 一键切到本机任一已存账号 | 设置页账号列表「切换」 | 无独立选择器 |
| 1.5 | 添加账号独立窗口 `MacAddAccountView`（居中于主窗） | 设置页「添加账号」按钮（复用登录逻辑） | 形态差异 |
| 1.6 | `MacAccountButton` 侧边栏底部 popover：当前账号卡 / 切换到列表 / 添加账号 / 关于 / 退出登录 | 全部塞在设置页 | 入口层级差异 |
| 1.7 | `removeAccount` 有 UI（账号面板） | api.js 定义了 `removeAccount`，**无 UI** | 缺 |
| 1.8 | 401 → needsLogin（expiredUsername 预填）+ `captureResume`/`takeResume` 回到原路由 | 未见对等处理 | 缺（需核对） |
| 1.9 | `MacUnreachableCard`：原因 + 重试 / 更换服务器 / 选择账号，app 激活时自动重试 | 无 | 缺 |
| 1.10 | 星空欢迎舞台（CosmosBackdrop + 9s 胶片台词轮播） | 纯表单 | 样式 |
| 1.11 | LAN 发现：Jellyfin 兼容 UDP 7359 逐地址 unicast sweep + health 校验 | 自有协议 `MOVIECLAW_DISCOVER_V1` UDP 18800 广播；responder 是死代码 | 协议不互通 |
| 1.12 | 认证：`POST /auth/device/login` → Bearer device token 存 Keychain（按 server+username） | cookie 会话（`POST /auth/login`，cookie jar 落 `%APPDATA%\cookies.json`） | 认证模型不同；token 应迁 Windows Credential Manager |

## 2. 主框架 / 菜单 / 快捷键

| # | macOS | Windows 现状 | 差距 |
|---|---|---|---|
| 2.1 | 菜单栏「前往」：首页 ⌘1 / 我的收藏 ⌘2 / 媒体库 ⌘3…⌘9 / 返回 ⌘[ / 搜索 ⌘F | 仅 Esc 返回、Ctrl+F 搜索 | 快捷键面缺失（Windows 无全局菜单栏，以快捷键 ± 可选命令面板对等） |
| 2.2 | 菜单栏「账号」：所有已存账号勾选切换 / 添加账号… / 退出登录… | 无 | 缺 |
| 2.3 | 侧边栏：媒体库 kind 图标 + 数量徽章、合集 pinned、底部账号按钮；重选当前 tab pop to root | 首页/我的收藏/媒体库/合集（≤10，过滤 series）/设置，静态 | 徽章与 pop-to-root 缺 |
| 2.4 | 全局通知横幅 `takeNotice`（~3.5s） | 无 | 缺 |
| 2.5 | 退出登录确认 alert | 设置页直接退出 | 缺确认 |
| 2.6 | 每 tab 独立导航栈（`MacRouter`） | 单一 `navStack` | 结构差异（低优先） |
| 2.7 | `libraryList` 60s 轮询（徽章计数） | 无 | 缺 |

## 3. 首页

| # | macOS | Windows 现状 | 差距 |
|---|---|---|---|
| 3.1 | Hero：pager dots（≤12）、hover 边缘箭头、触控板横扫、0.3s hover-switch、邻居图预取、edge-color 渐变 tint、active 卡描边 | 仅 300ms hover-switch | 交互子集 |
| 3.2 | Hero 舞台：0.44×宽高（420–760）、40s 慢推镜、smootherstep 淡入、luma scrim、logo→meta+徽章→剧集行→两行简介、剩余时长 | 有 hero，样式/剩余时长未对齐 | 样式 |
| 3.3 | upNext 横版卡 + 菜单（继续播放/查看详情） | 「接下来继续」货架已有 | 菜单缺 |
| 3.4 | 按类型 genre 卡 → **rowWall**（类型墙） | genre 色块 → **搜索** | 交互错误；且 genres 常为空（`LibraryItemView` 无 genres 字段） |
| 3.5 | 我的媒体库 + 合集卡（`MacLibraryCard`） | 有（per-library 最近添加货架） | 布局差异 |
| 3.6 | 海报货架 + 查看全部（`MacSeeAllCard`，row≥20）+ 点标题进墙 + hover 玻璃翻页按钮 + scrollTo | 有货架滚动箭头 | 查看全部/标题进墙/翻页按钮缺 |
| 3.7 | 卡片 hover：变暗 + 左下播放玻璃键 + 右下「…」菜单；右键菜单（播放/查看详情） | hover 辉光 + 3D 倾斜，无菜单 | 菜单缺 |
| 3.8 | 60s 轮询 + `.playbackStopReported` 后刷新 | 无 | 缺（依赖 6.5 播放回抛） |

## 4. 海报墙

| # | macOS | Windows 现状 | 差距 |
|---|---|---|---|
| 4.1 | 排序菜单：最近添加/最近上映/评分/片名 + 方向 + 只看没看过的，按媒体库持久化 | 6 个排序按钮（客户端排序），无方向/只看没看过/持久化 | 缺 |
| 4.2 | 无限滚动 60/page（`MacWallLoader` 去重 + generation） | 全量分页 100/page 最多 50 页 + 批渲染 | 实现差异（功能等价） |
| 4.3 | rowWall 页面（genre/kind/collection/favorites 源） | 无独立 rowWall | 缺 |
| 4.4 | 墙格右键菜单 播放/查看详情 | 无 | 缺 |
| 4.5 | — | 「网格」视图切换按钮是死代码（只有 grid） | 自债 |

## 5. 详情页

反馈 5 已对齐大头（hero：logo/标题兜底、meta+徽章、三行简介、导演/主演、继续/从头播放、
版本列、信息网格、模糊背景；剧集两态模型：点头图只换头图、悬停播放键起播且舞台环跟上、
季切换只换横排；人物卡可进人物页；系列货架；合集胶囊）。剩余差距：

| # | macOS | Windows 现状 | 差距 |
|---|---|---|---|
| 5.1 | 剧集卡右键菜单 播放 / 标为已看·未看 | 无 | 缺 |
| 5.2 | `PlaybackPreconnect.warm`（详情页出现即预连，实测 cold 105ms → hot 63ms） | ✓ `API.preconnectPlayback()`（详情页触发、20s 合并）+ `api_proxy` 共享 `ureq::Agent`（原先每请求新建 Agent，连接池活不过一次） | **起播性能** |
| 5.3 | `.playbackStopReported` → 重拉 marks/resume（按钮 播放→继续 翻转） | 无播放结束回抛（playUnit 注释明说与 Mac 差异） | 缺 |
| 5.4 | 人物页：removed files 灰显「片源已移除」+ 404 fallback | 待核对 `renderPerson` | 可能缺 |
| 5.5 | 人物卡「本片」徽章 → pop 返回 | 无 | 缺（小） |

## 6. 搜索

| # | macOS | Windows 现状 | 差距 |
|---|---|---|---|
| 6.1 | people chips 行（人物过滤 + 返回搜索结果 banner） | 无 | 缺 |
| 6.2 | 匹配标签（别名/拼音/导演） | 无 | 缺 |
| 6.3 | 最近搜索 per server#user（≤10，清除，点按重搜） | 无 | 缺 |
| 6.4 | 搜索建议 → 侧边栏 search | 无 | 缺 |
| 6.5 | cursor 分页 + 去重 + 请求代数守卫 | 300ms debounce 单次搜索 | 缺 |
| 6.6 | 搜索结果右键菜单 | 无 | 缺 |

## 7. 播放器 UI

| # | macOS | Windows 现状 | 差距 |
|---|---|---|---|
| 7.1 | 玻璃双行控制条（chromeHeight 136）：音量/上一集/-10/播放/+10/下一集/字幕·音轨/画质/全屏 + 已播 + scrubber + 剩余/总长切换 | ✓ 居中玻璃双行面板 100×720 r22 + backdrop-filter、距底 24；上行音量 \| 上一集·-10·播放·+10·下一集 \| 倍速·设置·画中画·全屏（播放键 48×48 恒居中），下行已播 \| scrubber \| 剩余·总长（点按翻转）；上下集按同季已入库集算、缺集跳过 | 轨道/画质入口在右钮区（Mac 是独立字幕·音轨/画质键）|
| 7.2 | scrubber：拖动 scrubFollow 预览 seek、松手精确 seek、trickplay **sprite 切片**预览 | ✓ scrubFollow 按 macOS `ScrubFollow.plan` 落地（cheap 跟手 10Hz 兜底 / 原文件直出停稳 60ms 后沿跟 / 其余松手才跳；跟随不计入 seek、不作废看门狗，mpv 跟随走关键帧 seek，松手才精确落地）；有 trickplay hover（有 URL 时缩略图） | sprite 切片待对齐 |
| 7.3 | 字幕·音轨面板：中文/英语/其他分组 + 「暂时放不了」不可用行；音轨列 | ✓ 字幕按 中文→英语→其他语言 分组（空组不出现，组内保持 `decision.subtitles` 原序）+「暂时放不了」置灰行（缺地址 / 暂不支持格式各给中文原因，0.4 透明、不挂点击）；音轨列仅 ≥2 条时出现，标签拆「语言 · 编码 · 声道」，认不出的编码置灰给原因；行文案走 macOS `displayTitle`/`detail` 两行（原 AI/强制/ASS/PGS 徽章收进小字） | 布局是标签页非 macOS 双列，其余对齐 |
| 7.4 | 画质面板档位命名「原画」+ 提示；guest share 隐藏 | 原画/1080p/720p/480p + 当前画质信息块 | 基本对齐 |
| 7.5 | — | 字幕延迟仅 UI 未应用到渲染 | 自债 |
| 7.6 | 跳过片头/片尾/广告/预告/其他（`MacSkipButton`） | 跳过片头/片尾/segments | 广告/预告 kind 待补 |
| 7.7 | up-next 卡：8s 倒计时条 + dismiss（`nextDismissed`） | autoNextCard 8s（取消/立即播放） | 基本对齐 |
| 7.8 | **画质建议卡**（实测带宽 vs 需求，换/不换） | ✓ `createQualitySuggestion` 阈值照搬（10s 保护期 / 300s 窗 / 单次长等 ≥8s 或 ≥2 次卡顿 / `实测 < 码率×0.9` 才建议 / 1080·720·480 阶梯）；卡片文案、双按钮、20s 自动收起与 mac 一致；「改用 Np」带 `max_height` 重谈且**不报 universal**（decide.py 的 universal 分支故意无视 `max_height`，报了上限整个失效） | QualityMemory 未做（8.5） |
| 7.9 | **软件转码同意对话框**（`MacConsentDialog`，原因/代价/自我放行） | ✓ 标题「这部片需要软件转码才能播放」+ `原因`/`代价` 两行小字（`decision.reason`/`cost_hint`，服务端原样）；能自开（`can_self_enable`）给「取消 · 开启并播放」，存开关期间按钮变「正在开启…」并禁用，存不下去把原因红字留在框里（不静默关）；不能自开只给「知道了」+ 联系管理员提示 | 玻璃 r24/460 宽，其余对齐 |
| 7.10 | 错误对话框 重试/关闭（⏎） | ✓ `MacPlayerDialog` 形状：告警三角（内联 SVG，非 emoji）+ 标题 + 建议 +「关闭(次) · 重试(主)」，次左主右；`decision.reason`/`suggestion` 原样；⏎ 认主、Esc 认次（不落到 Esc 阶梯）；**不再 5 秒自己消失**；「重试」清 `failed_tiers` 重跑同一份（同 macOS `retry()`），起播链的 `Player.close()` 收框 | 形状/键位对齐 |
| 7.11 | 键盘：Space / ←→ ±10s / ⌥←→ / ⌘←→ 上下集 / ↑↓ 音量 / M / F·⌃⌘F / Esc 阶梯（面板→全屏→关闭）/ ⌘. 关闭 | ✓ Space·k / ←→ **±10s**（长按连跳）/ Ctrl·⌘←→ 上下集（只触发一次）/ ↑↓ 音量 / m / f / Esc 阶梯 / Ctrl·⌘. 关闭 | ⌥←→ 逐帧步进缺 |
| 7.12 | 单击只显 chrome 不 toggle；双击全屏；拖动移窗 | 点击播放/暂停 | 交互差异 |
| 7.13 | 字幕上抬避开控制条 | 无 | 样式 |
| 7.14 | 窗口按宽高比 refit（Infuse 式，含最小/最大约束、关闭还原） | 无 | 缺 |
| 7.15 | 显示器休眠抑制（`MacDisplaySleepGuard`） | 无 | 缺 |
| 7.16 | 媒体键/SMTC（`NowPlayingBridge`：播放/暂停/±10s/上下集/scrub） | 无 | 缺 |
| 7.17 | 鼠标隐藏至移动（`NSCursor.setHiddenUntilMouseMoves`） | 无 | 缺（小） |
| 7.18 | — | HTML5 路径有 PiP 按钮（Mac 引擎层有 PiP 但 UI 无按钮） | Windows 反超，保留 |

## 8. 播放引擎 / 性能（核心对等项）

macOS 无 mpv/VLC。双引擎（`PlayerEngine`）：
**NativeEngine（AetherCore/FFmpeg）**：FFmpeg 经 HTTP Range 拉原文件、原地 remux 成
localhost HLS 交给 AVPlayer（「FFmpeg splits, Apple plays」）——DV/Atmos/HDR/PiP/硬解
全由系统提供；VP9/VC-1/MPEG-2/DV-P5 走 FFmpeg 软解 + 系统显示层；支持 ISO/原盘目录。
**AVPlayerEngine**：只跑服务端流（用户限档转码 / native 解不了时）。
Windows 现状：HTML5 `<video>` + hls.js（`ProxyHlsLoader` 走 Rust `/__stream__`）+
外置 mpv 子窗口兜底（`needsNativePlayer`）。

| # | macOS | Windows 现状 | 差距 |
|---|---|---|---|
| 8.1 | **能力上报分级**：native 报 universal 全解码 → 服务器给 tier-0 原文件直出；AVPlayer 只报 VideoToolbox 真值 | 统一报 `client:'web'` + 真实 decode 探测（mediaCapabilities）→ 服务器易给转码流 | **画质/性能关键**：mpv 路径应报 universal 拿原文件 |
| 8.2 | 起播链：点击即建 controller（`playRequestedAt`）+ `@concurrent` 协商 + 协商期预构 AVURLAsset + `PlaybackPreconnect.warm`（HEAD /health 20s 合并） | ✓ 预连 + 起播链去串行（详情页带 `kind`/`files`，删 `getResume` 抢跑）；起播链 API 3–4 次/113–690ms → **1 次/48–123ms**。缺：`playRequestedAt` QoE 计时、P49 `matroska_cues`（服务端已随会话下发，客户端未用） | 起播延迟（前次已做 6.5s→1s 优化，仍有余量） |
| 8.3 | FailurePolicy 阶梯：reconnect / retryNative / retryNativeLowStorage / failNetwork / failSourceMissing / fallbackToServerStream / stepDownTier + 预算（NativeRetryBudget、NetworkRestartBudget、ReconnectBackoff、PrematureEndGuard、SourceProbe） | failed_tiers 降档回路 + `__contentFailed` 去重 + `_playbackSeq` 竞态取消 | 阶梯不全 |
| 8.4 | FrameDropTracker（10s 窗 ≥100 帧 ≥10% → 强制降档）+ StallWatch（解码卡/网络饿/播完归因）+ QualitySuggestion | ✓ 三块 1 Hz 喂样/吐判定（`player.js`），动作由 App 执行：掉帧→`onPlaybackContentFailed` 降档、解码卡→同上、网络死→`onPlaybackNetworkDead` 同档重连、线路慢→画质卡。**一处刻意差异**：macOS 原文件直出不判掉帧（那条路拿不到总帧数做分母），Windows mpv 有 `frame-drop-count` + `time-pos×container-fps`，故档 0 也判；转码档 3/4 仍不判（连转码产物都放不动，再降只会更糟）。「线路慢」明确不算失败（buffer 低但还在收 → `.ok`，2026-09-28《哪吒》），唯一出口是画质卡 | 缺：PrematureEndGuard 播完归因、SourceProbe/NativeRetryBudget/ReconnectBackoff（8.3） |
| 8.5 | QualityMemory（按 item × 网络环境 home/away）+ 音轨/字幕记忆（server marks） | 全局 localStorage（mc_subLang/mc_audioLang），无 per-item 记忆 | 缺 |
| 8.6 | QoE：PlaybackRecord / ReportQueue / StartupTrace → `playbackMetricReport`/`playbackClientLog`（结果、起播分段、卡顿、seek 延迟、投递事实） | 无遥测上报 | 缺 |
| 8.7 | `Server-Timing` 响应头解析（decide/prep/ffmpeg 分段） | 无 | 缺 |
| 8.8 | 双表：LoadingSpeedMeter（2s 窗）+ BandwidthMeter（12s 窗最大值） | 实时速度徽标（2s）+ 诊断 30s 峰值 | 基本对齐 |
| 8.9 | seek 双模式（精确 vs 粗）+ scrubFollow | 拖动 scrubber | 待对齐 |
| 8.10 | 画质切换 = 新会话（tier 阶梯）；限档转码可仍走 native 播（`serverStreamOnNative`） | 画质切换重协商 `max_height`，capability payload 被裁成 `{video:[{max_height}]}`（自债 #8） | 不一致 |
| 8.11 | 外挂字幕 + 字体（`playbackFileFonts`）；PGS 位图字幕；SubtitleOverlay（fontScale 5.2%、底 8%） | JASSUB ASS/SSA + `<track>`；PGS 待核对 | 部分 |
| 8.12 | 音频：E-AC-3 JOC Atmos 直通能力声明、ac3/flac/alac/aac/mp3；native 音轨就地切换 / 流媒体换会话 | HTML5 无法直通；mpv 路径 d3d11va 硬解可直通 | 依赖 8.1/8.13 |
| 8.13 | HDR：`NSScreen` EDR → `hdrPassthrough`；色调映射交系统 | `hdr_passthrough: true` 写死；需 DXGI HDR 查询 | 缺真值探测 |
| 8.14 | 原盘：ISO 字节流 / 原盘目录（`playbackFileDiscList`） | 无 | 缺 |
| 8.15 | — | ~~mpv IPC stub、`resize_embedded_player` 无人调用~~（已清）；mpv 路径仍不设 sessionId | 自债（mpv 路径不回抛进度） |

## 9. macOS-only → Windows 对等实现（平台层）

| macOS | Windows 对等 |
|---|---|
| 菜单栏 Commands | 快捷键 + 可选命令面板 |
| Keychain TokenVault | Windows Credential Manager |
| AVPlayer 系统解码/直通/PiP/色调映射 | mpv（d3d11va/gpu-next）或 FFmpeg+渲染器，自实现直通/色调映射 |
| NSWindow 红绿灯再托管 | Tauri 自绘标题栏（已有） |
| liquid glass（glassEffect 等） | CSS 毛玻璃（视觉近似） |
| MPRemoteCommandCenter | Windows SMTC |
| `hw.model` / NSScreen EDR | 机器 ID / DXGI HDR + 缩放 |
| CIFilter 二维码 | 任意 QR 库（设置页已有 QR 展示） |
| willTerminate 同步上报 | 退出钩子（1.5s 上限） |
| 窗口按宽高比 refit + 拖动移窗 | Tauri window API 近似 |
| NSTrackingArea / NSCursor 隐藏 | 自定义命中测试 / ShowCursor |
| 显示器休眠抑制 | `SetThreadExecutionState(ES_DISPLAY_REQUIRED)` |
| UDP 7359 unicast sweep | 可用同协议或广播；保留 Jellyfin 兼容消息 |

## 10. Windows 自身代码未完成项（自债，非对齐差距）

1. ~~`send_mpv_command_embedded` 空桩（无 seek/音量/暂停控制）~~ → 已清（1c2bce0b，真 JSON IPC）
2. ~~`resize_embedded_player`/`set_embedded_player_visible` 注册未调用~~ → 已清（1c2bce0b，resize/fullscreenchange 已挂）
3. `update_available`/`update_check_result` 事件无监听（更新提示永不出现）
4. 字幕延迟仅 UI 未应用渲染
5. bootstrap 首启 / removeAccount 无 UI
6. 硬件解码开关 `mc_hwDecode` 存而不用（mpv 写死 `--hwdec=d3d11va`）
7. 关于页版本号写死 0.2.108（实际 0.2.110），无运行时版本
8. 画质切换 capability payload 与主路径不一致
9. 「网格」视图切换死按钮
10. 海报墙类型筛选常为空（`LibraryItemView` 无 genres）
11. LAN responder 死代码
12. 播放结束回抛缺失（Mac `.playbackStopReported` 链路）
13. `app.js` 会话后 `start_ms` 归并把显式 0 塌成 null（player.js 已在边界兜底，根因未清）
14. quality-switch HLS 无 ERROR handler；embedded-mpv 成功路径不设 sessionId；updater.rs 字节切片潜在 panic
15. mpv EOF 处理：`--keep-open=no` 到尾卸载文件、`time-pos`/`eof-reached`/`duration` 全变 unavailable，近尾 seek 后 UI 会卡住不动。另：网络 MKV 重定位期间这几个属性短暂 unavailable，UI 靠乐观值 + 轮询纠正（不误报，但 seek 落定前进度条不动）

---

## 分期实施建议

**P0 — 播放性能对等**（用户核心诉求「同等或接近的播放性能」）
1. ✓ 能力上报分级：mpv/原文件路径报 universal → tier-0 原文件直出（8.1）→ 验证：4K DV 片诊断面板 tier=原文件直出 —— 已达成（9c098ead）
2. ✓ mpv IPC 补全 + 窗口跟随（10.1/10.2）→ 验证：mpv 路径可暂停/seek/音量 —— 已达成（1c2bce0b）
3. ✓ 详情页 `PlaybackPreconnect.warm` + 起播链提前建控（8.2）→ 验证：起播耗时基准对比 —— 已达成（未提交）：起播链 API 3–4 次/113–690ms → **1 次/48–123ms**；`--sub-file` 10 条 → **1 条**（内封轨 mpv 自己 demux，冷缓存下 10 条首播 30s+ 不出帧 → 0.42s）
4. ✓ 看门狗闭环：丢帧/卡顿触发降档 + 画质建议卡（8.4、7.8）→ 验证：构造卡顿场景出卡片 —— 已达成（未提交）：600 KB/s 节流代理构造慢线路（只限视频/音频，API 全速），4K HEVC tier-0 出卡「实测约 509 KB/s，这一版需要约 3.1 MB/s…改用 720p」。触发走的是 macOS 两条路径里的 **≥2 次独立卡顿/300s 窗**（另一条是单次连续等待 ≥8s；`PlaybackRouting.swift:269-283` 两条等价，实测该片 5s 一次的卡顿在 8s 阈值之前就凑满两次）。点「改用 720p」→ `max_height=720`、capability **不报 universal**、档 4 transcode、`currentQuality` 记下 720。实测暴露并修掉四个度量 bug：`ProxyHlsLoader` 整片交付使 `_net.bps` 的 2 秒窗「收片瞬间虚高十几倍、其余恒 0」（HTML5 测速源改 1 Hz 累计字节差分）；mpv `cache-speed` 是**字节**/秒，当 bps 用会把带宽报小 8 倍、推荐档掉到 480p；`_everPlayed` 只由 HTML5 `playing` 事件置位，mpv 路径恒 false → 「缓冲」在正常播放时一直成立、8s 假等待会误触发；`selectQuality` 的 mpv 分支提前 return 漏记 `currentQuality`

**P1 — 播放器 UI 对齐**（7.x）
5. ✓ 玻璃双行控制条、上一集/下一集、剩余切换、Esc 阶梯、±10s（7.1/7.11）→ 验证：真机真播双引擎 —— 已达成（未提交）：面板 100×720 r22 + `backdrop-filter: blur(28px) saturate(180%)`，距底 24；上行「音量 | 上一集·-10·播放·+10·下一集 | 倍速·设置·画中画·全屏」（播放键 48×48 居中恒定，两侧等宽块保证不随按钮增减漂移），下行「已播 | 进度条 | 剩余/总长」。**上下集不是服务端字段**：`PlaybackSessionView` 没有 `next_episode`，旧代码判 `sessionData.next_episode` 是死路，改成 macOS 同款客户端算（`PlaybackController.swift:466-498`）——`episodes.filter{owned && episode_number>cur}.min`，**缺集自动跳过**。这一改同时把从来没触发过的自动连播（`onPlaybackEnded`）救活了。剩余↔总长点按翻转（同 QuickTime / `movieclaw.mac.player.showsTotal`），时长未知显 `--:--` 不显 `-0:00`。←/→ ±10s（长按连跳），Ctrl+←/→ 换集（只触发一次），Esc 阶梯「面板 → 退全屏 → 关播放器」，⌘. 直接关。实测暴露并修掉一个真缺口：HTML5 的 `updateProgress` 只挂 `timeupdate`，**`loadedmetadata` 到首次 `timeupdate` 之间片长已知但右侧还挂着 HTML 占位 `0:00`**，起播慢时用户看到的就是假值；mpv 那条链靠轮询首个 `tick()` 补上、HTML5 没有对应动作 → `loadedmetadata` 里补调 `updateProgress()`。mpv 链单独补验（`openEmbeddedPlayer` 不走 `Player.open`，季集号与兄弟表是另加的同步）：mkv 剧集 lib2/550 走 mpv 不静默回落 HTML5，上下集同样正确、点下一集换集后邻居重算
5a. ✓ scrubFollow 精化（7.2 前半）→ 验证：真机三类拖动场景 —— 已达成（未提交）：旧实现**每个 mousemove 都 `engSeekTo`**，等于「拖到哪抽到哪」，还顺手把掉帧/卡顿窗口一路清掉。按 macOS `ScrubFollow.plan`（`PlaybackWatchdogs.swift:134`）重写：`cheap`（落点在当前位置前 1s~已缓冲尾内）跟手但压在 **10Hz 兜底**（`maxWaitMs=100`，后沿落地 `settleMs=60`）；`!cheap` 分两支——原文件直出（档 0，每次 seek 都是一条新 Range 请求）只在**手指停住 60ms** 后跟一次，转码流则 `.skip`、松手才跳。跟随走 `engFollowTo`（**不**作废掉帧/卡顿窗口、mpv 用 `keyframe` seek），松手那一次才算真 seek（精确 + 作废窗口）。进度条滑块改为跟手指（`_scrubPct`），否则 `.skip` 分支下拖动会「画面和滑块都不动」。验收覆盖合同矩阵四格：plan 与 macOS 单测 5 条向量逐条一致；cheap 跟手 6 次/480ms；tier 4 转码拖出缓冲途中 0 次、**停住 200ms 仍 0 次**（这一步才把 `.skip` 和 `.deferred` 分开）；mkv/mpv 原文件扫动途中 0 次、停住后恰好 1 次
5b. ✓ 轨道分组 +「暂时放不了」不可用行（7.3）→ 验证：真机 HTML5/mpv 双链 + 纯函数合同 —— 已达成（未提交）：按 macOS `MacSubtitleGroups.build` / `SubtitleTracks.plan` / `AudioOption.plan` / `MacTrackText.split` 落地。语言标记 23 条向量与 `kind(of:)` 逐条一致（`zh/zh-Hans/zh_CN/chi/zho/chs/cht/cmn/yue/chinese` 及大写 → 中文；`en/en-US/english/English` → 英语，含 `hasPrefix("en")` 会吃进去的 `end`；`jpn/kor/fre/und/空/null` → 其他）。真片爱麻夫人 S1E2（lib2/550，44 条 vtt）分成 中文 2 / 英语 3 / 其他语言 39，行上 `data-sub-index` 记的是 `decision.subtitles` **原位**（中文=[3,4]，英语=[10,11,12]）而不是过滤后的位置——分组只换摆法，`selectSubtitle(index)` 仍按原位走。行文案改成 macOS 两行 `displayTitle`/`detail`（`语言 · 格式 · 内封/外挂 · AI 翻译 · 默认 · 强制`），原徽章信息一条没丢、还补上语言/格式/内封外挂。「暂时放不了」两条理由分得开：`index >= subtitle_urls.length` →「服务端没有给出这条轨的地址」，`kind ∉ [vtt,ass,pgs]` →「暂不支持的字幕格式：xxx」，排在所有语言分组之后、置灰 0.4、不挂点击、点了选中态不动，也不混进语言分组。音轨列只在 ≥2 条时才出现（macOS「没得选的菜单是纯噪音」），爱情没有神话 4 条音轨 4 行、勾在默认那条；认不出的编码（`none`/`unknown`/空）置灰给「Audio Vivid」原因，但整片都认不出时不下结论。没字幕的片（阿凡提 4322）只剩「关闭字幕」+「字幕延迟」+「无可用字幕」；mpv 链（550 裸起 mkv）分组渲染与 HTML5 一致。**验收时暴露、与本次无关不改**：直通播放服务端 `session_id` 是 null（只有转码才分配会话号），`Player.close()` 里的 `sessionStop` 对直通片永远发不出去——就是 `close()` 里「4/4 槽位占满」那条老账的另一半；`selectSubtitle`/`selectAudio` 在 mpv 链仍 inert（`if (!this.video) return`）
5c. ✓ 错误/同意对话框（`MacConsentDialog`，7.9/7.10）→ 验证：真机真决策双向（真 `rejected` + 真 `consent`）—— 已达成（未提交）：按 macOS `MacPlayerDialog` / `MacConsentDialog` / `MacPlayerScreen.dialogs` / `PlaybackController.handleSession`·`fail`·`retry`·`grantConsent` 落地。`api.js` 补 `playbackPolicySet`（`PUT /playback/policy`，只翻 `software_transcode_enabled` 一个字段，未带的字段服务端保持原值；`require_admin`）。`player.js` 加 `showPlayerDialog`/`showConsentDialog`/`hidePlayerDialog`/`_mountDialog`：scrim `rgba(0,0,0,.6)` 压在 `#playerView` 内、玻璃 r24、错误框 420 宽带告警三角（内联 SVG，界面不用 emoji）、同意框 460 宽纯说明文左对齐无图标；按钮**次左主右**（同 SwiftUI `.cancelAction`/`.defaultAction`），服务器来源文案全走 `textContent` 不落 HTML。`close()` 一起收框（否则黑屏上留个框）。键盘：⏎ 认主按钮、Esc 认次按钮并吞掉不落到 Esc 阶梯（焦点在框内按钮上时交给按钮自己触发，不重复触发）；Ctrl·⌘. 仍关播放器。`app.js`：`startPlayback` 开头存 `_retryItem`/`_retryStartMs` 供重试；决策三态分流——`consent` → `showConsentDialog(session.decision)`、`rejected` → `_showPlaybackError(reason, suggestion)`、其余非 `plan` 仍当异常；catch 从「loading 文案 + 5 秒自己消失」换成 `_showPlaybackError` 对话框；`retryPlayback` 重跑同一份（不带 `isRetry` → `_failedTiers` 自动清空，同 macOS `retry()`）；`grantConsent` 写开关后**校验服务端回显** `software_transcode_enabled === true` 才算成功（同 macOS `guard saved.softwareTranscodeEnabled`），不是就把「开关保存后未生效，请重试或查看服务端日志」红字留在框里、按钮复位、框不关。55/55：展示契约（两种形态、字段、按钮顺序、无 emoji）、键盘契约（⏎/Esc/不落阶梯/无框时 Esc 阶梯没弄坏）、存开关失败路径；**真 `rejected`** 用 `failed_tiers=[4]` 顶掉转码档（`decide.py` 降档回路 `tier >= SOFTWARE_TRANSCODE` → `PlaybackRejected`）拿到服务端原话「这部片在当前浏览器上尝试了所有播放方式都失败了。」+ suggestion，6 秒后框仍在，「重试」真起播且决策回到 `plan`；**真 `consent`** 把全局 `software_transcode_enabled` 关掉（这台服务端 `hardware_available: false`，限高 720 的 mkv 必落 `SOFTWARE_TRANSCODE`，`decide.py:465` 就返回 `ConsentRequired`）拿到服务端原样 `reason`/`cost_hint`，「开启并播放」真起播、决策回到 `plan`、开关经独立回读确认回到 `true`。**本次刻意不做**：macOS `infoError` 那个只有「返回」的框（Windows 起播链上没有对应触发点，做了是臆测）；「烧录撞上软件转码同意」自动回退选字幕关（Windows 从不要求服务端烧字幕——会话 body 没有字幕字段，字幕在客户端 JASSUB/`<track>` 渲染）。**与本次无关不改**：直通片 `session_id` 为 null 导致 `Player.close()` 的 `sessionStop` 发不出去；`selectSubtitle`/`selectAudio` 在 mpv 链 inert
6. 窗口宽高比 refit、显示休眠抑制、SMTC

**P2 — 功能链路补齐**
7. Welcome 状态机（bootstrap/chooser/unreachable）+ 扫码上欢迎页 + 账号 popover（1.x）
8. 首页：pager/横扫/箭头、卡片与右键菜单、查看全部 rowWall、类型 → 行墙、60s 轮询（3.x）
9. 墙排序菜单（方向/只看没看过/持久化）+ rowWall（4.x）
10. 搜索：people chips、匹配标签、最近搜索、建议（6.x）
11. 详情剩余：剧集右键标为已看、人物页 removed/404、播放回抛（5.x）

**P3 — 平台层与遥测**
12. Credential Manager、更新事件、运行时版本、QoE 上报、Server-Timing（8.6/8.7、10.3/10.7）
13. 自债清单清扫（10.x）

每项按 AGENTS.md 目标驱动：先写 e2e 断言（真实接口/真实场景），循环验证通过再进下一项。
