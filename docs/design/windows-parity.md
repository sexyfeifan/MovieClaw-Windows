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
| 5.2 | `PlaybackPreconnect.warm`（详情页出现即预连，实测 cold 105ms → hot 63ms） | 无 | **起播性能** |
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
| 7.1 | 玻璃双行控制条（chromeHeight 136）：音量/上一集/-10/播放/+10/下一集/字幕·音轨/画质/全屏 + 已播 + scrubber + 剩余/总长切换 | 单行控制条 + 面板；有下一集无上一集 | 布局 + 缺上一集 + 缺剩余切换 |
| 7.2 | scrubber：拖动 scrubFollow 预览 seek、松手精确 seek、trickplay **sprite 切片**预览 | 有 trickplay hover（有 URL 时缩略图） | sprite 切片/scrubFollow 待对齐 |
| 7.3 | 字幕·音轨面板：中文/英语/其他分组 + 「暂时放不了」不可用行；音轨列 | 有轨道列表（AI/强制/ASS/PGS 徽章），无语言分组 | 缺分组 |
| 7.4 | 画质面板档位命名「原画」+ 提示；guest share 隐藏 | 原画/1080p/720p/480p + 当前画质信息块 | 基本对齐 |
| 7.5 | — | 字幕延迟仅 UI 未应用到渲染 | 自债 |
| 7.6 | 跳过片头/片尾/广告/预告/其他（`MacSkipButton`） | 跳过片头/片尾/segments | 广告/预告 kind 待补 |
| 7.7 | up-next 卡：8s 倒计时条 + dismiss（`nextDismissed`） | autoNextCard 8s（取消/立即播放） | 基本对齐 |
| 7.8 | **画质建议卡**（实测带宽 vs 需求，换/不换） | 无 | 缺 |
| 7.9 | **软件转码同意对话框**（`MacConsentDialog`，原因/代价/自我放行） | 无 | 缺 |
| 7.10 | 错误对话框 重试/关闭（⏎） | failed_tiers 降档 + loading 错误文案，无对话框 | 缺 |
| 7.11 | 键盘：Space / ←→ ±10s / ⌥←→ / ⌘←→ 上下集 / ↑↓ 音量 / M / F·⌃⌘F / Esc 阶梯（面板→全屏→关闭）/ ⌘. 关闭 | Space·k / ←→ **±5s** / ↑↓ / m / f / Esc | ±10s、上下集键、Esc 阶梯缺 |
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
| 8.2 | 起播链：点击即建 controller（`playRequestedAt`）+ `@concurrent` 协商 + 协商期预构 AVURLAsset + `PlaybackPreconnect.warm`（HEAD /health 20s 合并） | 45s 会话 POST 超时、35s 卡死看门狗；无预热 | 起播延迟（前次已做 6.5s→1s 优化，仍有余量） |
| 8.3 | FailurePolicy 阶梯：reconnect / retryNative / retryNativeLowStorage / failNetwork / failSourceMissing / fallbackToServerStream / stepDownTier + 预算（NativeRetryBudget、NetworkRestartBudget、ReconnectBackoff、PrematureEndGuard、SourceProbe） | failed_tiers 降档回路 + `__contentFailed` 去重 + `_playbackSeq` 竞态取消 | 阶梯不全 |
| 8.4 | FrameDropTracker（10s 窗 ≥100 帧 ≥10% → 强制降档）+ StallWatch（解码卡/网络饿/播完归因）+ QualitySuggestion | 诊断面板显示丢帧（>2% 告警），不触发降档 | 看门狗闭环缺 |
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
3. 详情页 `PlaybackPreconnect.warm` + 起播链提前建控（8.2）→ 验证：起播耗时基准对比
4. 看门狗闭环：丢帧/卡顿触发降档 + 画质建议卡（8.4、7.8）→ 验证：构造卡顿场景出卡片

**P1 — 播放器 UI 对齐**（7.x）
5. 玻璃双行控制条、上一集、剩余切换、scrubFollow、轨道分组、错误/同意对话框、Esc 阶梯、±10s
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
