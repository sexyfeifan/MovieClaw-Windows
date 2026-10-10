// MovieClaw Desktop — 内置 HTML5 播放器（HLS.js + Video）

// ===== 自定义 HLS Loader：走 Rust proxy_api 代理，绕过 CORS + 自动携带 Cookie =====
// HLS.js 自定义 loader 接口：constructor / load / abort / destroy
function ProxyHlsLoader(config) {
  this.config = config || {};
  // stats 必须在构造时创建：hls.js 在调用 load() 之前就执行 frag.stats = loader.stats
  this.stats = {
    aborted: false, loaded: 0, total: 0, retry: 0, chunkCount: 0, bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, end: 0 },
  };
  this.context = null;
  this.callbacks = null;
}

ProxyHlsLoader.prototype.destroy = function () {
  this.callbacks = null;
};

ProxyHlsLoader.prototype.abort = function () {
  if (this.stats) this.stats.aborted = true;
};

ProxyHlsLoader.prototype.load = function (context, config, callbacks) {
  this.context = context;
  this.callbacks = callbacks;
  // 重置字段，绝不换对象 — frag.stats 持有构造时创建的引用
  var stats = this.stats;
  stats.aborted = false; stats.loaded = 0; stats.total = 0; stats.retry = 0;
  stats.chunkCount = 0; stats.bwEstimate = 0;
  stats.loading = { start: performance.now(), first: 0, end: 0 };
  stats.parsing = { start: 0, end: 0 };
  stats.buffering = { start: 0, end: 0 };

  var url = context.url;
  var isBinary = context.responseType === 'arraybuffer' ||
    /\.(ts|m4s|mp4|aac|ec3|webvtt)(\?|#|$)/i.test(url);

  // 通过 Rust 流代理请求（自动携带 Cookie，绕过 CORS）
  // 不管 url 是什么格式，统一用 /__stream__?url= 完整 URL 代理
  var fullUrl;
  if (url.startsWith('http://') || url.startsWith('https://')) {
    fullUrl = url;
  } else {
    var base = (window.__MOVIECLAW_SERVER__ || '').replace(/\/+$/, '');
    fullUrl = base + (url.startsWith('/') ? url : '/' + url);
  }
  var path = '/__stream__?url=' + encodeURIComponent(fullUrl);

  var self = this;
  window.__TAURI__.core.invoke('proxy_api', {
    method: 'GET',
    path: path,
    body: null,
  }).then(function (result) {
    if (self.stats.aborted) return;
    self.stats.loading.first = performance.now();
    self.stats.loading.end = performance.now();

    if (result.status !== 200) {
      callbacks.onError({ code: result.status, text: 'HTTP ' + result.status }, self.stats, context, null);
      return;
    }

    var responseData;
    if (isBinary) {
      // 二进制响应（视频分片）：base64 → ArrayBuffer
      try {
        var binary = atob(result.body);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        responseData = bytes.buffer;
        self.stats.loaded = bytes.length;
        self.stats.total = bytes.length;
      } catch (e) {
        callbacks.onError({ code: 0, text: 'base64 解码失败: ' + e.message }, self.stats, context, null);
        return;
      }
    } else {
      responseData = result.body;
      self.stats.loaded = result.body.length;
      self.stats.total = result.body.length;
    }

    callbacks.onSuccess({ url: url, data: responseData, code: result.status }, self.stats, context, null);
  }).catch(function (err) {
    if (self.stats.aborted) return;
    self.stats.loading.end = performance.now();
    console.error('[ProxyHlsLoader] failed:', url, err);
    callbacks.onError({ code: 0, text: (err && err.message) || '代理请求失败' }, self.stats, context, null);
  });
};

// 挂到 window 确保全局可见
window.ProxyHlsLoader = ProxyHlsLoader;

// ===== 解码能力探测（移植自 web 客户端 lib/player/capability.ts，字段与服务端 ClientCapabilityIn 对应）=====
// 不用 canPlayType（分不清「能解」和「能流畅解」），走 mediaCapabilities.decodingInfo：
// 探测喂 RFC 6381 全串，上报归一到家族名（服务端与 ffprobe 落库的 codec_name 比对）。
// video/audio 报空数组 = 告诉服务端「浏览器什么都不支持」→ 所有影片全量转码，起播慢。
// v2：hdr_passthrough 改为恒 true（Chromium 自行 tone-map），v1 缓存里
// matchMedia 判出的 false 会让服务端拒绝 HDR 影片，必须作废
const CAPABILITY_SCHEMA_VERSION = 2;
const CAPABILITY_CACHE_KEY = 'movieclaw.desktop.capability';
// 4K 一档特意用 Main 10 / 高 profile：真实 4K 片源几乎都是 10bit/高码率，用 1080p 串探出来的结论对不上
const CAPABILITY_VIDEO_MATRIX = {
  h264: (h) => (h >= 2160 ? 'avc1.640033' : 'avc1.640028'),
  hevc: (h) => (h >= 2160 ? 'hvc1.2.4.L153.B0' : 'hvc1.1.6.L120.90'),
  av1: (h) => (h >= 2160 ? 'av01.0.12M.10' : 'av01.0.08M.08'),
  vp9: (h) => (h >= 2160 ? 'vp09.02.51.10' : 'vp09.00.41.08'),
};
// DTS/TrueHD 不探：没有浏览器能解，服务端一律转码
const CAPABILITY_AUDIO_MATRIX = {
  aac: 'mp4a.40.2', ac3: 'ac-3', eac3: 'ec-3', opus: 'opus', flac: 'flac', mp3: 'mp4a.69',
};
const CAPABILITY_HEIGHTS = [2160, 1440, 1080, 720];
const CAPABILITY_CHANNELS = [8, 6, 2];

function capBitrateFor(height) {
  if (height >= 2160) return 25000000;
  if (height >= 1440) return 14000000;
  if (height >= 1080) return 8000000;
  return 4000000;
}

async function capDecodingInfo(mseAvailable, kind, contentType, height, channels) {
  const unsupported = { supported: false, smooth: false, powerEfficient: false };
  const mc = navigator.mediaCapabilities;
  if (!mc || !mc.decodingInfo) return unsupported;
  // 档位都经 MSE 喂分片（media-source）；无 MSE 时才用 file 语义
  const type = mseAvailable ? 'media-source' : 'file';
  try {
    const r = await mc.decodingInfo(kind === 'video'
      ? { type, video: { contentType, width: Math.round(((height || 1080) * 16) / 9), height: height || 1080, bitrate: capBitrateFor(height || 1080), framerate: 24 } }
      : { type, audio: { contentType, channels: String(channels || 2) } });
    return { supported: r.supported, smooth: r.smooth, powerEfficient: r.powerEfficient };
  } catch (_) {
    // 非法 codec 串会抛 TypeError，语义上等同不支持
    return unsupported;
  }
}

let capInflight = null;
async function getCapabilitySnapshot() {
  // UA 哈希：浏览器升级后 codec 支持可能变化，旧缓存自动作废
  const ua = navigator.userAgent;
  let uaHash = 0x811c9dc5;
  for (let i = 0; i < ua.length; i++) { uaHash ^= ua.charCodeAt(i); uaHash = Math.imul(uaHash, 0x01000193) >>> 0; }
  uaHash = uaHash.toString(16);
  try {
    const raw = localStorage.getItem(CAPABILITY_CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached.version === CAPABILITY_SCHEMA_VERSION && cached.uaHash === uaHash) return cached.snapshot;
    }
  } catch (_) { /* 存储不可用则重新探 */ }
  if (capInflight) return capInflight;

  capInflight = (async () => {
    const w = window;
    // ManagedMediaSource 优先（与 hls.js 实际后端一致），没有则 MediaSource
    const mse = w.ManagedMediaSource ? 'managed' : (w.MediaSource ? 'full' : 'none');
    const mseAvailable = mse !== 'none';
    const nativeHls = document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== '';

    const video = [];
    for (const family of Object.keys(CAPABILITY_VIDEO_MATRIX)) {
      let pick = null;
      for (const height of CAPABILITY_HEIGHTS) {
        const p = await capDecodingInfo(mseAvailable, 'video', `video/mp4; codecs="${CAPABILITY_VIDEO_MATRIX[family](height)}"`, height);
        if (p.supported && (!pick || height > pick.max_height)) pick = { max_height: height, smooth: p.smooth, power_efficient: p.powerEfficient };
      }
      // 一个高度都不支持 → 该家族不出现在快照（服务端据此转码）
      if (pick) video.push({ codec: family, ...pick });
    }
    const audio = [];
    for (const family of Object.keys(CAPABILITY_AUDIO_MATRIX)) {
      let maxChannels = null;
      for (const channels of CAPABILITY_CHANNELS) {
        const p = await capDecodingInfo(mseAvailable, 'audio', `audio/mp4; codecs="${CAPABILITY_AUDIO_MATRIX[family]}"`, null, channels);
        if (p.supported && (maxChannels === null || channels > maxChannels)) maxChannels = channels;
      }
      if (maxChannels !== null) audio.push({ codec: family, max_channels: maxChannels });
    }
    // mp4 恒成立；hls-fmp4 要么 MSE（hls.js）要么原生 HLS
    const containers = ['mp4'];
    if (mseAvailable || nativeHls) containers.push('hls-fmp4');
    const snapshot = {
      video, audio, containers,
      // 恒报 true：Chromium 自己会把 HDR tone-map 到 SDR 屏（与 macOS 自研引擎
      // 同策略）。报 false 会让服务端接管 tone-map——服务器无 GPU 时直接拒绝播放
      hdr_passthrough: true,
      mse, is_mobile: false, native_hls: nativeHls,
    };
    try {
      localStorage.setItem(CAPABILITY_CACHE_KEY, JSON.stringify({ version: CAPABILITY_SCHEMA_VERSION, uaHash, probedAt: new Date().toISOString(), snapshot }));
    } catch (_) { /* 写不进只是下次再探 */ }
    return snapshot;
  })();
  try { return await capInflight; } finally { capInflight = null; }
}
window.getCapabilitySnapshot = getCapabilitySnapshot;

// ===== 全解码引擎（嵌入式 mpv）的能力申报（对齐 macOS PlayerCapability.native()）=====
// mpv 直读原文件、硬解不了的编码由它本机软解，申报 universal：服务端直接给档 0
// 原文件直连，不再为一路用不上的换封装/转码起 ffmpeg（NAS 冷启动白花 1.6 秒）。
// 编码/容器清单只在服务端不认 universal 时起作用（老服务端），按 mpv 实际能解的报。
// 音频只报「能原样装进 fMP4 分片」的编码（服务端 FMP4_COPY_AUDIO_CODECS）：报了
// TrueHD，老服务端会计划「换壳成 HLS fMP4 并原样拷 TrueHD」，ffmpeg 的 MP4 封装
// 不支持 TrueHD，转码进程启动即失败（macOS《蜘蛛侠》实测同款教训）。
// 不报 disc_image/disc_folder：嵌入式 mpv 不装载盘内结构，目录清单它吃不下。
function getUniversalCapabilitySnapshot() {
  return {
    video: ['h264', 'hevc', 'av1', 'vp9', 'vp8', 'mpeg2video', 'mpeg4', 'vc1']
      .map(codec => ({ codec, max_height: 2160, smooth: true, power_efficient: codec === 'h264' || codec === 'hevc' })),
    audio: ['aac', 'ac3', 'eac3', 'dts', 'flac', 'alac', 'opus', 'mp3']
      .map(codec => ({ codec, max_channels: 8 })),
    containers: ['mp4', 'hls-fmp4', 'mkv', 'webm', 'ts', 'm2ts', 'avi'],
    hdr_passthrough: true,
    mse: 'full', is_mobile: false, native_hls: false,
    universal: true,
  };
}
window.getUniversalCapabilitySnapshot = getUniversalCapabilitySnapshot;

// ===== 播放看门狗（阈值逐一照搬 Shared/Player/PlaybackWatchdogs.swift + PlaybackRouting.swift）=====
// 三块纯逻辑：喂 1 Hz 样本、吐判定，动作由 App 执行。卡顿归因分三态，其中「线路慢」
// 明确不算失败——带宽不够的唯一出口是画质建议卡（换不换由用户定，2026-09-28 拍板）。
//
// 与 macOS 的一处刻意差异：Apple 的原文件直出故意不判掉帧（NativeEngine.swift
// 「掉帧不是换播放器的理由」），根因是那条路拿不到总帧数做分母。Windows 的 mpv 有
// frame-drop-count，分母用 time-pos × container-fps 估，因此档 0 直出也判——4K 解
// 不动就该降档，这正是 failed_tiers 回路要干的事。转码档（3/4）仍不判：再掉帧说明
// 连转码产物都放不动，继续降档只会更糟。

// 掉帧：10 秒窗（11 个 1 Hz 累计样本的首尾差）内掉帧率 ≥10%，且窗口 ≥100 帧才判
function createFrameDropTracker() {
  const WINDOW = 10, MIN_FRAMES = 100, RATIO = 0.1;
  let history = [];
  return {
    threshold: RATIO,
    // 喂一个累计样本；返回 null = 没到判定条件，否则是窗口掉帧率
    sample(dropped, total) {
      const last = history[history.length - 1];
      // 累计计数变小 = 引擎换了流，旧窗口作废（调用方漏 reset 的兜底）
      if (last && (total < last.total || dropped < last.dropped)) history = [];
      history.push({ dropped, total });
      if (history.length > WINDOW + 1) history.shift();
      if (history.length !== WINDOW + 1) return null;
      const first = history[0];
      const totalDelta = total - first.total;
      if (totalDelta < MIN_FRAMES) return null;
      return (dropped - first.dropped) / totalDelta;
    },
    reset() { history = []; },
  };
}

// 卡顿归因：解码卡 / 线路慢（不算失败）/ 连接断；缓冲够却不动先推 2 把再判死
function createStallWatch() {
  const DECODE_STALL_S = 8, DECODE_MIN_BUFFER = 3.0, SERVER_DEAD_S = 45, DIRECT_DEAD_S = 15;
  const NUDGE_AT = 3, MAX_NUDGES = 2, NUDGE_STEP = 0.1;
  let lastTime = null, stalledFor = 0, silentFor = 0, nudges = 0, sinceNudge = 99, everAdvanced = false;
  return {
    DIRECT_DEAD_S, SERVER_DEAD_S, NUDGE_STEP,
    reset() {
      lastTime = null; stalledFor = 0; silentFor = 0; nudges = 0; sinceNudge = 99; everAdvanced = false;
    },
    // receiving: 这一秒有没有从源收到字节；deadLimit: 缓冲见底后连续多少秒没字节算断线
    sample(time, bufferedAhead, paused, ended, seeking, receiving, deadLimit) {
      const advanced = lastTime != null && time > lastTime;
      // 「真正播起来过」只认小步前进：起播定位、用户拖动是一次大跳，不算
      if (advanced && !seeking && lastTime != null && time - lastTime < 5) everAdvanced = true;
      lastTime = time;
      sinceNudge += 1;
      if (paused || ended || seeking || advanced) {
        stalledFor = 0; silentFor = 0;
        // 只有远离上次推动的真实前进才算恢复——推动自己造成的播放头变化不作数
        if (advanced && sinceNudge > 3) nudges = 0;
        return 'ok';
      }
      stalledFor += 1;
      if (bufferedAhead >= DECODE_MIN_BUFFER) {
        silentFor = 0;
        if (stalledFor >= DECODE_STALL_S) { stalledFor = 0; nudges = 0; return 'decodeStalled'; }
        // 有数据却不动：先推一把（起播预滚阶段不推，否则会把预滚冲掉重来）
        if (everAdvanced && stalledFor >= NUDGE_AT && nudges < MAX_NUDGES) {
          nudges += 1; sinceNudge = 0; stalledFor = 0; return 'nudge';
        }
        return 'ok';
      }
      // 缓冲见底：字节还在进来就是线路慢，不算失败
      silentFor = receiving ? 0 : silentFor + 1;
      if (silentFor >= deadLimit) { stalledFor = 0; silentFor = 0; nudges = 0; return 'dead'; }
      return 'ok';
    },
    reason(verdict, deadLimit) {
      if (verdict === 'decodeStalled') return `播放停滞超过 ${DECODE_STALL_S} 秒，这一档的码流播放器吃不下`;
      return deadLimit < SERVER_DEAD_S
        ? `连续 ${deadLimit} 秒没有收到数据——连接可能中断了`
        : `连续 ${deadLimit} 秒没有收到服务端的数据——转码可能中断了`;
    },
  };
}

// 画质建议：只在等待期测速（缓冲满引擎会停下载，平时读数不可信）
function createQualitySuggestion() {
  const GRACE = 10, WINDOW = 300, MIN_STALLS = 2, LONG_WAIT = 8, LINK_MARGIN = 0.9;
  // 推荐档位阶梯（同 macOS QualityOption）：1080p 约 6、720p 约 3、480p 约 1.5 Mbps
  const LADDER = [[1080, 6e6], [720, 3e6], [480, 1.5e6]];
  let clock = 0, graceUntil = GRACE, stalls = [], stalling = false;
  let waitSeconds = 0, waitSpeeds = [], offered = false;
  function recommendedHeight(bps, currentHeight) {
    const lower = LADDER.filter(([h]) => currentHeight == null || h < currentHeight);
    const fit = lower.find(([, b]) => b <= bps * 0.8);
    return fit ? fit[0] : (lower.length ? lower[lower.length - 1][0] : null);
  }
  return {
    get offered() { return offered; },
    get waitSeconds() { return waitSeconds; },
    // 起播、跳转、从暂停恢复：接下来 10 秒的缓冲不算「卡」
    restartGrace() {
      graceUntil = clock + GRACE; stalling = false;
      waitSeconds = 0; waitSpeeds = [];
    },
    // 每秒一次，只在用户想看时调用。stalled: 正在等（含起播）；seeking: 这段等待是跳转造成的
    tick(stalled, seeking, loadingBps) {
      clock += 1;
      stalls = stalls.filter(s => s.start + s.seconds >= clock - WINDOW);
      const speed = loadingBps > 0 ? loadingBps : null;
      if (stalled) {
        waitSeconds += 1;
        if (speed != null) waitSpeeds.push(speed);
      } else {
        waitSeconds = 0; waitSpeeds = [];
      }
      if (!stalled || seeking || clock <= graceUntil) { stalling = false; return; }
      if (!stalling) { stalls.push({ start: clock, seconds: 0, speeds: [] }); stalling = true; }
      const cur = stalls[stalls.length - 1];
      cur.seconds += 1;
      if (speed != null) cur.speeds.push(speed);
    },
    // 该不该提议；给出一次后本单元不再给
    offer(streamBitrate, currentHeight) {
      if (offered || !(streamBitrate > 0)) return null;
      let measured;
      if (waitSeconds >= LONG_WAIT) {
        // 一次长等取这段里最快的一秒：冷起播分头取流，逐秒读数时有时无，最快那秒
        // 最接近线路能力，它都跟不上码率才算线路问题
        if (!waitSpeeds.length) return null;
        measured = Math.max(...waitSpeeds);
      } else if (stalls.length >= MIN_STALLS) {
        const speeds = stalls.reduce((a, s) => a.concat(s.speeds), []).sort((a, b) => a - b);
        if (!speeds.length) return null;
        measured = speeds[speeds.length >> 1];
      } else return null;
      if (measured >= streamBitrate * LINK_MARGIN) return null;
      const height = recommendedHeight(measured, currentHeight);
      if (height == null) return null;
      offered = true;
      return { measuredBps: measured, requiredBps: streamBitrate, maxHeight: height };
    },
    reset() { offered = false; },
  };
}

function formatBandwidth(bps) {
  if (!(bps > 0) || !isFinite(bps)) return null;
  const mb = bps / 8 / (1024 * 1024);
  if (mb >= 1) return mb.toFixed(1) + ' MB/s';
  const kb = bps / 8 / 1024;
  return kb < 1 ? '0 KB/s' : Math.round(kb) + ' KB/s';
}

// source.resolution 形如 "3840x1632" / "1080p" → 画面高度
function heightOfResolution(r) {
  if (!r) return null;
  const wh = String(r).match(/(\d{3,5})\s*[x×*]\s*(\d{3,5})/i);
  if (wh) return Number(wh[2]);
  const p = String(r).match(/(\d{3,5})\s*[pP]/);
  return p ? Number(p[1]) : null;
}

const Player = {
  video: null,
  hls: null,
  currentTitle: '',
  hideTimer: null,
  isSeeking: false,
  // 拖动跟随（同 macOS scrubFollow）：上次跟随时刻 + 排到一半的跟随任务 + 手指在进度条上的位置
  _lastScrubFollowAt: 0,
  _scrubFollowTask: null,
  _scrubPct: null,
  // 进度上报 & 会话保活
  sessionId: null,
  mediaItemId: null,
  seasonNumber: null,
  episodeNumber: null,
  // 上一集 / 下一集：同季剧集表（详情页 loadBrowse 那一份，只含已入库集）
  episodes: [],
  // 右侧时间显剩余还是总长（点它切换，同 QuickTime）
  showsTotal: false,
  progressTimer: null,
  pingTimer: null,
  lastProgressReport: 0,
  // JASSUB 字幕渲染
  jassub: null,
  jassubTracks: [],

  init() {
    this.video = document.getElementById('playerVideo');
    if (!this.video) return;
    this.initSettings();
    this.initInfoPanel();

    // 播放/暂停
    document.getElementById('btnPlayPause')?.addEventListener('click', () => this.togglePlay());
    document.getElementById('playerCenterBtn')?.addEventListener('click', () => this.togglePlay());
    this.video.addEventListener('click', () => this.togglePlay());
    this.video.addEventListener('dblclick', () => this.toggleFullscreen());

    // 进度条：按下/拖动走 scrubFollow 让画面跟手，松手精确跳到落点
    // （同 macOS MacScrubber 的 DragGesture：onChanged → scrubFollow，onEnded → seek）
    const seek = document.getElementById('playerSeek');
    if (seek) {
      const pctAt = (clientX) => {
        const rect = seek.getBoundingClientRect();
        return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      };
      seek.addEventListener('mousedown', (e) => {
        if (!this.engDuration()) return;
        this.isSeeking = true;
        this._scrubPct = pctAt(e.clientX);
        this.renderScrub();
        this.scrubFollow(this._scrubPct * this.engDuration());
        const onMove = (e2) => {
          if (!this.engDuration()) return;
          this._scrubPct = pctAt(e2.clientX);
          this.renderScrub();
          this.scrubFollow(this._scrubPct * this.engDuration());
        };
        const onUp = (e3) => {
          this.isSeeking = false;
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          // 排到一半的跟随别再落地，松手那一次就到点了
          if (this._scrubFollowTask) { clearTimeout(this._scrubFollowTask); this._scrubFollowTask = null; }
          const pct = pctAt(e3.clientX);
          this._scrubPct = null;
          // 松手这一次才算真 seek（跟随不计入 seek 次数）：精确落地 + 作废掉帧/卡顿窗口
          if (this.engDuration()) this.engSeekTo(pct * this.engDuration());
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      // Trickplay: 悬停显示缩略图预览
      let trickplayPreview = null;
      seek.addEventListener('mousemove', (e) => {
        if (!this.video?.duration) return;
        const rect = seek.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const hoverTime = pct * this.video.duration;

        if (!trickplayPreview) {
          trickplayPreview = document.createElement('div');
          trickplayPreview.className = 'trickplay-preview';
          seek.parentElement.appendChild(trickplayPreview);
        }
        const timeStr = this.formatTime(hoverTime);
        // 尝试获取 trickplay 缩略图
        if (this.sessionData?.trickplay_url) {
          const thumbUrl = this.sessionData.trickplay_url + '?t=' + Math.floor(hoverTime);
          trickplayPreview.innerHTML = `<img src="${thumbUrl}" onerror="this.style.display='none'"><div class="trickplay-time">${timeStr}</div>`;
        } else {
          trickplayPreview.innerHTML = `<div class="trickplay-time">${timeStr}</div>`;
        }
        trickplayPreview.style.display = 'block';
        trickplayPreview.style.left = (pct * 100) + '%';
      });

      seek.addEventListener('mouseleave', () => {
        if (trickplayPreview) trickplayPreview.style.display = 'none';
      });
    }

    // 快进快退
    document.getElementById('btnRew')?.addEventListener('click', () => this.engSeekBy(-10));
    document.getElementById('btnFwd')?.addEventListener('click', () => this.engSeekBy(10));

    // 上一集 / 下一集
    document.getElementById('btnPrevEp')?.addEventListener('click', () => this.playEpisode(this.prevEpisode()));
    document.getElementById('btnNextEp')?.addEventListener('click', () => this.playEpisode(this.nextEpisode()));

    // 右侧时间：剩余 ↔ 总长（同 QuickTime / macOS mac-player-remaining）
    document.getElementById('playerRemaining')?.addEventListener('click', () => {
      this.showsTotal = !this.showsTotal;
      this.updateProgress();
    });

    // 音量
    document.getElementById('btnMute')?.addEventListener('click', () => this.toggleMute());
    const volSlider = document.getElementById('volumeSlider');
    if (volSlider) {
      volSlider.addEventListener('input', () => {
        this.engSetVolume(parseFloat(volSlider.value));
      });
    }

    // 全屏
    document.getElementById('btnFullscreen')?.addEventListener('click', () => this.toggleFullscreen());
    document.getElementById('btnPip')?.addEventListener('click', () => this.togglePip());

    // 返回
    document.getElementById('playerBack')?.addEventListener('click', () => this.close());

    // 视频事件
    this.video.addEventListener('timeupdate', () => {
      this.updateProgress();
      this.checkSegments();
    });
    this.video.addEventListener('loadedmetadata', () => {
      this.renderChapters(this.sessionData?.chapters);
      // 片长在这里才定下来，下行两端要立刻跟上；只等 timeupdate 的话，起播慢时
      // 右侧会一直挂着占位（mpv 那条链靠轮询的首个 tick 补上，HTML5 得在这补）
      this.updateProgress();
    });
    this.video.addEventListener('progress', () => this.updateBuffer());
    this.video.addEventListener('play', () => {
      this.showIcon('pause');
      this.hideCenterBtn();
      this.autoHideControls();
    });
    this.video.addEventListener('pause', () => {
      this._buffering = false;
      this.showIcon('play');
      this.showCenterBtn();
      this.showControls();
    });
    this.video.addEventListener('ended', () => {
      this.showIcon('play');
      this.showCenterBtn();
      this.showControls();
      this.reportPlaybackEnd();
    });
    this.video.addEventListener('waiting', () => {
      this._buffering = true;
      const loading = document.getElementById('playerLoading');
      if (loading) loading.hidden = false;
    });
    this.video.addEventListener('playing', () => {
      this._everPlayed = true;
      this._buffering = false;
      const loading = document.getElementById('playerLoading');
      if (loading) loading.hidden = true;
    });
    this.video.addEventListener('error', () => {
      const text = document.getElementById('playerLoadingText');
      const loading = document.getElementById('playerLoading');
      // 首帧前解不了（浏览器不认该格式/编码）→ 走 failed_tiers 降档回路换转码
      if (!this._everPlayed && typeof App !== 'undefined' && App.onPlaybackContentFailed) {
        App.onPlaybackContentFailed('无法解码该视频格式');
        return;
      }
      if (text) text.textContent = '播放失败: 无法解码该视频格式';
      if (loading) loading.hidden = false;
    });

    // 鼠标移动显示控制栏
    const view = document.getElementById('playerView');
    view?.addEventListener('mousemove', () => {
      this.showControls();
      this.autoHideControls();
    });

    // 键盘快捷键（对齐 macOS MacPlayerScreen.handleKey：⌘ 在 Windows 取 Ctrl）
    document.addEventListener('keydown', (e) => {
      if (document.getElementById('playerView')?.hidden) return;
      // 长按连发：跳转/音量要跟手，换集/开关只认第一次按下（同 macOS phase .down 而非 .repeat）
      const once = !e.repeat;
      const mod = e.ctrlKey || e.metaKey;
      switch (e.key) {
        case ' ': case 'k': e.preventDefault(); if (once) this.togglePlay(); break;
        case 'ArrowLeft':
          e.preventDefault();
          if (mod) { if (once) this.playEpisode(this.prevEpisode()); }
          else this.engSeekBy(-10);
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (mod) { if (once) this.playEpisode(this.nextEpisode()); }
          else this.engSeekBy(10);
          break;
        case 'ArrowUp': e.preventDefault(); this.engSetVolume(this.engVolume() + 0.1); break;
        case 'ArrowDown': e.preventDefault(); this.engSetVolume(this.engVolume() - 0.1); break;
        case 'm': if (once) this.toggleMute(); break;
        case 'f': if (once) this.toggleFullscreen(); break;
        case '.': if (mod && once) { e.preventDefault(); this.close(); } break;
        case 'Enter':
          // 对话框的主按钮（同 SwiftUI .defaultAction）。焦点在框内按钮上时交给按钮自己触发
          if (!once || !this._dialog) break;
          if (e.target && e.target.closest && e.target.closest('#playerDialog button')) break;
          e.preventDefault();
          if (this._dialog.primary) this._dialog.primary();
          break;
        case 'Escape':
          if (!once) break;
          // 对话框在时 Esc 认次按钮（同 SwiftUI .cancelAction），不落到下面的 Esc 阶梯上
          if (this._dialog) {
            e.preventDefault();
            if (this._dialog.secondary) this._dialog.secondary();
            break;
          }
          // Esc 阶梯（同 macOS escape()）：收起面板 → 退出全屏 → 关闭播放器
          if (this.closeAnyPanel()) { e.preventDefault(); break; }
          if (document.fullscreenElement) { e.preventDefault(); this.toggleFullscreen(); break; }
          this.close();
          break;
      }
    });

    // mpv 画面是主窗口的子窗口，缩放/全屏后要手动对齐到视频区域
    window.addEventListener('resize', () => this.syncEmbeddedPlayerRect());
    document.addEventListener('fullscreenchange', () => {
      // 布局要等全屏切换落定才量得准
      requestAnimationFrame(() => this.syncEmbeddedPlayerRect());
    });
  },

  // ===== 设置面板 =====
  sessionData: null,   // 播放会话完整数据

  initSettings() {
    // 设置按钮
    document.getElementById('btnSettings')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSettings();
    });

    // 倍速按钮
    document.getElementById('btnSpeed')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSpeedPanel();
    });

    // 设置标签页切换
    document.querySelectorAll('.player-settings-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.player-settings-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.renderSettingsTab(tab.dataset.tab);
      });
    });

    // 倍速选项
    document.querySelectorAll('.player-speed-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const speed = parseFloat(opt.dataset.speed);
        if (this.video) this.video.playbackRate = speed;
        document.querySelectorAll('.player-speed-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        const label = document.getElementById('speedLabel');
        if (label) label.textContent = speed + 'x';
        this.hideSpeedPanel();
      });
    });

    // 点击外部关闭面板
    document.getElementById('playerView')?.addEventListener('click', (e) => {
      if (!e.target.closest('.player-settings-panel') && !e.target.closest('#btnSettings')) {
        this.hideSettings();
      }
      if (!e.target.closest('.player-speed-panel') && !e.target.closest('#btnSpeed')) {
        this.hideSpeedPanel();
      }
    });

    // 跳过按钮
    document.getElementById('playerSkipBtn')?.addEventListener('click', () => this.skipSegment());
  },

  toggleSettings() {
    const panel = document.getElementById('playerSettingsPanel');
    if (panel.hidden) {
      panel.hidden = false;
      this.hideSpeedPanel();
      // 音轨只在两条以上才有这一栏（没得选的菜单是纯噪音，同 macOS MacTracksPanel）
      const audioTab = document.querySelector('.player-settings-tab[data-tab="audio"]');
      if (audioTab) audioTab.hidden = this.audioTracks().length === 0;
      this.renderSettingsTab('subtitles');
      // 更新激活的标签页
      document.querySelectorAll('.player-settings-tab').forEach(t => t.classList.remove('active'));
      document.querySelector('.player-settings-tab[data-tab="subtitles"]')?.classList.add('active');
    } else {
      panel.hidden = true;
    }
  },

  hideSettings() {
    const panel = document.getElementById('playerSettingsPanel');
    if (panel) panel.hidden = true;
  },

  toggleSpeedPanel() {
    const panel = document.getElementById('playerSpeedPanel');
    if (panel.hidden) {
      panel.hidden = false;
      this.hideSettings();
    } else {
      panel.hidden = true;
    }
  },

  hideSpeedPanel() {
    const panel = document.getElementById('playerSpeedPanel');
    if (panel) panel.hidden = true;
  },

  // Esc 阶梯的第一级：有面板开着就收掉一个，返回是否处理过
  closeAnyPanel() {
    for (const [id, hide] of [
      ['playerInfoPanel', () => this.hideInfoPanel()],
      ['playerSettingsPanel', () => this.hideSettings()],
      ['playerSpeedPanel', () => this.hideSpeedPanel()],
    ]) {
      const panel = document.getElementById(id);
      if (panel && !panel.hidden) { hide(); return true; }
    }
    return false;
  },

  // ===== 实时速度徽标 + 播放诊断面板（右键打开）=====
  // 口径对齐 web 端（lib/player/bandwidth.ts 的 LoadingMeter 与
  // components/player/diagnostics-panel.tsx 的「源 → 处理」层次）

  initInfoPanel() {
    // 播放区域内右键 = 诊断面板；拦截掉 WebView 默认菜单
    document.getElementById('playerView')?.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.toggleInfoPanel();
    });
    document.getElementById('playerInfoClose')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hideInfoPanel();
    });
    document.getElementById('playerSpeedBadge')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleInfoPanel();
    });
  },

  toggleInfoPanel() {
    const panel = document.getElementById('playerInfoPanel');
    if (!panel) return;
    if (panel.hidden) {
      panel.hidden = false;
      this._renderInfoPanel();
      clearInterval(this._infoTimer);
      this._infoTimer = setInterval(() => this._renderInfoPanel(), 500);
    } else {
      this.hideInfoPanel();
    }
  },

  hideInfoPanel() {
    const panel = document.getElementById('playerInfoPanel');
    if (panel) panel.hidden = true;
    clearInterval(this._infoTimer);
    this._infoTimer = null;
  },

  // 分片字节：速度徽标与面板的数据源。ProxyHlsLoader 一次性交付整片，字节在
  // FRAG_LOADED 一步到位；每片另记「实收字节/耗时」作为带宽峰值样本
  attachNetHooks(hls) {
    hls.on(Hls.Events.FRAG_LOADED, (_, data) => {
      const n = this._net;
      const st = data && data.frag && data.frag.stats;
      if (!n || !st || !st.loaded) return;
      n.bytes += st.loaded;
      const dur = st.loading && st.loading.end > st.loading.start ? st.loading.end - st.loading.start : 0;
      if (dur > 0) {
        n.frags.push({ at: performance.now(), bps: (st.loaded * 8 * 1000) / dur });
        if (n.frags.length > 60) n.frags.splice(0, n.frags.length - 60);
      }
    });
  },

  startNetMeter() {
    this.stopNetMeter();
    const badge = document.getElementById('playerSpeedBadge');
    if (badge) { badge.hidden = false; badge.textContent = '↓ —'; }
    this._netTimer = setInterval(() => this._tickNetMeter(), 500);
  },

  stopNetMeter() {
    clearInterval(this._netTimer);
    this._netTimer = null;
    const badge = document.getElementById('playerSpeedBadge');
    if (badge) badge.hidden = true;
  },

  _tickNetMeter() {
    const n = this._net;
    if (!n) return;
    const now = performance.now();
    n.points.push({ at: now, bytes: n.bytes });
    // 窗口起点：至少早 1.75s（2s 窗口留 250ms 给计时器抖动）的最后一个点；
    // 起播不满窗口时用最早的点，但至少隔 900ms——sampleLoadingMeter 同款逻辑，
    // 计数倒退（换了取流对象）时从头量，不许出现负速度
    const last = n.points[n.points.length - 2];
    if (last && n.bytes < last.bytes) n.points = [{ at: now, bytes: n.bytes }];
    const cutoff = now - 1750;
    let ref = -1;
    for (let i = n.points.length - 1; i >= 0; i--) {
      if (n.points[i].at <= cutoff) { ref = i; break; }
    }
    if (ref < 0 && now - n.points[0].at >= 900) ref = 0;
    if (ref >= 0) {
      const base = n.points[ref];
      const dt = now - base.at;
      n.bps = dt > 0 ? ((n.bytes - base.bytes) * 8 * 1000) / dt : null;
      n.points = n.points.slice(ref);
    }
    const badge = document.getElementById('playerSpeedBadge');
    if (badge) {
      badge.hidden = false;
      badge.textContent = '↓ ' + (this.formatNetSpeed(n.bps) || '—');
    }
    if (!document.getElementById('playerInfoPanel')?.hidden) this._renderInfoPanel();
  },

  // bps → 「3.2 MB/s」：1024 进位，MB/s 而非 Mbps（用户对网速的直觉来自下载条，
  // 换 Mbps 会让人以为快了八倍）——同 web bandwidth.ts formatBandwidth
  formatNetSpeed(bps) {
    if (bps == null || !isFinite(bps) || bps < 0) return null;
    const bytesPerSec = bps / 8;
    const mb = bytesPerSec / (1024 * 1024);
    if (mb >= 1) return mb.toFixed(1) + ' MB/s';
    const kb = bytesPerSec / 1024;
    if (kb < 1) return '0 KB/s';
    return Math.round(kb) + ' KB/s';
  },

  _renderInfoPanel() {
    const body = document.getElementById('playerInfoBody');
    if (!body) return;
    const s = this.sessionData || {};
    const d = s.decision || {};
    const src = s.source || {};
    const v = this.video;
    const n = this._net || {};
    const mbps = (bps) => (bps ? (bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1) + ' Mbps' : null);
    const TIER = { 0: '原文件直出', 1: '换壳直通', 2: '换壳 + 转音轨', 3: '硬件转码', 4: '软件转码' };
    const HW = { videotoolbox: 'VideoToolbox', vaapi: 'VAAPI', qsv: 'Intel QSV', nvenc: 'NVENC' };
    const READY = ['无媒体', '元数据', '可播放', '可播放且有数据', '可持续播放'];
    const NETST = ['空闲', '加载中', '已加载', '无资源'];
    const sec = (title, lines) => `<div class="player-info-sec"><div class="sec-title">${title}</div>${lines.filter(Boolean).join('')}</div>`;
    const srcLine = (t) => (t ? `<div class="src">${t}</div>` : '');
    const actLine = (t, alert) => (t ? `<div class="act${alert ? ' alert' : ''}">${t}</div>` : '');

    // —— 流媒体：源容器 → 处理方式 ——
    const container = (src.container || d.container || '未知').toUpperCase();
    const streamTarget = d.tier === 0 ? '原文件直出' : `HLS · fMP4（${TIER[d.tier] ?? '未知档位'}）`;

    // —— 视频：源规格 → 这次怎么处理的 ——
    const fps = src.frame_rate ? `${Number(src.frame_rate.toFixed(3))} fps` : null;
    const videoSrc = [src.resolution, src.video_codec && src.video_codec.toUpperCase(), src.hdr, fps].filter(Boolean).join(' · ');
    let videoAction = null;
    if (d.video) {
      videoAction = d.video.action === 'copy' ? '直通'
        : `转码（${(d.video.codec || 'h264').toUpperCase()}${d.video.height ? ` ${d.video.height}p` : ''} · ${s.hw_backend ? (HW[s.hw_backend] || s.hw_backend) : '软件'}${d.video.tone_map ? ' · HDR 转 SDR' : ''}${d.video.bitrate_cap_bps ? ` · 按线路限 ${mbps(d.video.bitrate_cap_bps)}` : ''}）`;
    }
    // 实测行：输出分辨率 + 掉帧（掉帧率 >2% 标红：能解但解不动，该降档了）
    let perfLine = null;
    let dropAlert = false;
    if (v && v.videoWidth) {
      const bits = [`输出 ${v.videoWidth}×${v.videoHeight}`];
      try {
        const q = v.getVideoPlaybackQuality && v.getVideoPlaybackQuality();
        if (q) {
          // 标准属性名是 droppedVideoFrames（droppedFrames 不存在，会渲染成 undefined）
          bits.push(`掉帧 ${q.droppedVideoFrames ?? 0} / ${q.totalVideoFrames ?? 0}`);
          dropAlert = (q.totalVideoFrames ?? 0) > 0 && (q.droppedVideoFrames ?? 0) / q.totalVideoFrames > 0.02;
        }
      } catch (_) { /* 环境无 playback quality API 时只报分辨率 */ }
      perfLine = bits.join(' · ');
    }

    // —— 音频：这次放的那条轨 → 处理 ——
    const activeTrack = (d.audio_tracks || []).find((t) => t.ref === (d.audio && d.audio.track_ref));
    const audioSrc = activeTrack
      ? [activeTrack.language, activeTrack.codec && activeTrack.codec.toUpperCase(), activeTrack.channels ? `${activeTrack.channels} 声道` : null]
          .filter(Boolean).join(' ') + (activeTrack.is_default ? '（默认）' : '')
      : null;
    let audioAction = null;
    if (d.audio) {
      audioAction = d.audio.action === 'copy' ? '直通'
        : `转码（${(d.audio.codec || 'aac').toUpperCase()}${d.audio.channels ? ` ${d.audio.channels} 声道` : ''}${d.audio.downmix ? ' · 已降混' : ''}）`;
    }

    // —— 传输：此刻的实测读数 ——
    const trans = [];
    let peak = null;
    if (n.frags && n.frags.length) {
      const recent = n.frags.filter((f) => performance.now() - f.at < 30000);
      if (recent.length) peak = Math.max(...recent.map((f) => f.bps));
    }
    trans.push(['↓ ' + (this.formatNetSpeed(n.bps) || '—'), peak ? `带宽峰值 ${this.formatNetSpeed(peak)}` : null].filter(Boolean).join(' · '));
    let ahead = 0;
    if (v) {
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.currentTime >= v.buffered.start(i) - 0.15 && v.currentTime <= v.buffered.end(i)) {
          ahead = v.buffered.end(i) - v.currentTime;
          break;
        }
      }
      trans.push(`缓冲 ${ahead.toFixed(1)} 秒 · 播放头 ${v.currentTime.toFixed(1)} 秒${isFinite(v.duration) && v.duration > 0 ? ` / ${v.duration.toFixed(0)} 秒` : ''}`);
    }
    const hls = this.hls;
    if (hls && hls.levels && hls.currentLevel >= 0 && hls.levels[hls.currentLevel]) {
      const lv = hls.levels[hls.currentLevel];
      // 服务端 fMP4 playlist 不带 RESOLUTION/BANDWIDTH（实测 attrs 为空）：有元数据才报，
      // 单档又没元数据时整行省略——分辨率在「输出」行、处理方式在视频节已经摆了
      const bits = [lv.height ? `${lv.height}p` : null, lv.bitrate ? mbps(lv.bitrate) : null].filter(Boolean);
      if (bits.length || hls.levels.length > 1) {
        trans.push(`档位 ${[...bits, hls.levels.length > 1 ? `${hls.levels.length} 档可选` : null].filter(Boolean).join(' · ')}`);
      }
      if (lv.details) trans.push(`播放列表 ${lv.details.live ? '直播流（边播边给）' : '点播（VOD）'}`);
    }
    if (v) trans.push(`${READY[v.readyState] ?? `readyState ${v.readyState}`} · ${NETST[v.networkState] ?? `networkState ${v.networkState}`} · ${v.paused ? '已暂停' : v.seeking ? '定位中' : '播放中'}`);
    trans.push(`会话 ${s.session_id || '无（直出）'}`);

    body.innerHTML = [
      sec('流媒体', [srcLine([container, mbps(src.bit_rate)].filter(Boolean).join(' · ')), actLine(streamTarget),
        d.degraded_from != null ? actLine('上一档播放失败，自动降档而来', true) : '']),
      sec('视频', [srcLine(videoSrc), actLine(videoAction), perfLine ? `<div class="act${dropAlert ? ' alert' : ''}">${perfLine}</div>` : '']),
      sec('音频', [srcLine(audioSrc), actLine(audioAction)]),
      sec('传输', trans.map((t) => `<div>${t}</div>`)),
    ].join('');

    const reasonEl = document.getElementById('playerInfoReason');
    if (reasonEl) reasonEl.textContent = d.reason || '';
  },

  // ===== 轨道清单与分组（同 macOS PlayerTracks.swift / MacPlayerPanels.swift）=====

  // 语言代码 → 中文名（同 Web lib/language-labels.ts）；und/空没有名字，由调用方兜底
  _langLabel(code) {
    if (!code || code === 'und') return null;
    const names = {
      chs: '简体中文', cht: '繁体中文', chi: '中文', zho: '中文', cmn: '中文',
      yue: '粤语', eng: '英语', jpn: '日语', kor: '韩语', fre: '法语', fra: '法语',
      ger: '德语', deu: '德语', spa: '西班牙语', rus: '俄语', ita: '意大利语',
      por: '葡萄牙语', tha: '泰语', hin: '印地语',
    };
    return names[String(code).toLowerCase()] || code;
  },

  // 轨道标签拆成主标题 + 一行小字（标签是「语言 · 编码 · 声道」）。同 macOS MacTrackText.split
  trackTextSplit(label) {
    const parts = String(label == null ? '' : label).split(' · ');
    const rest = parts.slice(1).join(' · ');
    return { title: parts[0] || label, detail: rest || null };
  },

  // 语言标记 → 分组（各种写法：zh / chi / zho / chs / cht / zh-Hans / cmn / yue……）
  subtitleLangKind(language) {
    const code = String(language == null ? '' : language).toLowerCase();
    if (!code) return 'other';
    if (code.startsWith('zh') || ['chi', 'zho', 'chs', 'cht', 'cmn', 'yue', 'chinese'].includes(code)) return 'chinese';
    if (code.startsWith('en') || code === 'english') return 'english';
    return 'other';
  },

  // 字幕按语言分组：中文 → 英语 → 其他语言，空组不出现。纯函数，同 macOS MacSubtitleGroups.build
  subtitleGroups(options) {
    const buckets = { chinese: [], english: [], other: [] };
    for (const o of options) buckets[this.subtitleLangKind(o.language)].push(o);
    return [
      { id: 'zh', title: '中文', options: buckets.chinese },
      { id: 'en', title: '英语', options: buckets.english },
      { id: 'other', title: '其他语言', options: buckets.other },
    ].filter((g) => g.options.length > 0);
  },

  _embeddedIndex(ref) {
    const n = ref && String(ref).startsWith('embedded:') ? parseInt(String(ref).slice(9), 10) : null;
    return Number.isInteger(n) ? n : null;
  },

  _refLabel(ref) {
    if (ref && String(ref).startsWith('external:')) return String(ref).slice(9);
    const n = this._embeddedIndex(ref);
    return n == null ? '未知语言' : '内封轨 ' + (n + 1);
  },

  subtitleTrackLabel(plan) {
    const title = String(plan.title == null ? '' : plan.title).trim();
    const name = title || this._langLabel(plan.language) || this._refLabel(plan.track_ref);
    return name + ' · ' + ({ vtt: '文本', ass: '特效', pgs: '图形' }[plan.kind] || plan.kind);
  },

  subtitleDisplayTitle(plan) {
    const title = String(plan.title == null ? '' : plan.title).trim();
    if (title) return title;
    const n = this._embeddedIndex(plan.track_ref);
    if (n != null) return '内封轨 ' + (n + 1);
    if (String(plan.track_ref || '').startsWith('external:')) return String(plan.track_ref).slice(9);
    return this.subtitleTrackLabel(plan);
  },

  subtitleDetail(plan) {
    const formats = { vtt: 'WebVTT', ass: 'ASS', pgs: 'PGS 图形', text: '文本' };
    const parts = [this._langLabel(plan.language) || '未知语言', formats[plan.kind] || plan.kind];
    const n = this._embeddedIndex(plan.track_ref);
    const displayTitle = this.subtitleDisplayTitle(plan);
    if (n != null) parts.push(displayTitle === '内封轨 ' + (n + 1) ? '内封' : '内封轨 ' + (n + 1));
    else if (String(plan.track_ref || '').startsWith('external:')) parts.push('外挂');
    if (plan.is_ai) parts.push('AI 翻译');
    if (plan.is_default) parts.push('默认');
    if (plan.is_forced) parts.push('强制');
    return parts.join(' · ');
  },

  // 决策里的字幕计划配上取流地址（与 subtitle_urls 一一对应，少一个就当那条没有地址）；
  // 拿不到的轨置灰给原因，不给一个点了没反应的选项。同 macOS SubtitleTracks.plan。
  // index 是 decision.subtitles 里的原位：selectSubtitle 与 <track> 都按这个下标走
  buildSubtitleTracks() {
    const plans = (this.sessionData && this.sessionData.decision && this.sessionData.decision.subtitles) || [];
    const urls = this.sessionData?.subtitle_urls || [];
    const options = [], unavailable = [];
    plans.forEach((p, index) => {
      const label = this.subtitleTrackLabel(p);
      if (index >= urls.length) {
        unavailable.push({ index, ref: p.track_ref, label, reason: '服务端没有给出这条轨的地址' });
        return;
      }
      if (!['vtt', 'ass', 'pgs'].includes(p.kind)) {
        unavailable.push({ index, ref: p.track_ref, label, reason: '暂不支持的字幕格式：' + p.kind });
        return;
      }
      options.push({
        index, ref: p.track_ref, kind: p.kind, language: p.language || null,
        displayTitle: this.subtitleDisplayTitle(p), detail: this.subtitleDetail(p),
      });
    });
    return { options, unavailable };
  },

  // 可选音轨（同 macOS AudioOption.plan）：只有一条时返回空——没得选的菜单是纯噪音
  audioTracks() {
    const tracks = (this.sessionData && this.sessionData.decision && this.sessionData.decision.audio_tracks) || [];
    if (tracks.length < 2) return [];
    const unrec = (c) => { const s = String(c == null ? '' : c).toLowerCase(); return !s || s === 'none' || s === 'unknown'; };
    const anyRecognized = tracks.some((t) => !unrec(t.codec));
    return tracks.map((t) => ({
      ref: t.ref,
      label: this.audioLabel(t),
      is_default: !!t.is_default,
      unavailableReason: anyRecognized && unrec(t.codec)
        ? '音频编码无法识别（常见于菁彩声 Audio Vivid），没有可用的解码器' : null,
    }));
  },

  audioLabel(t) {
    const name = this._langLabel(t.language)
      || (String(t.ref || '').startsWith('embedded:') ? '音轨 ' + String(t.ref).slice(9) : '未知音轨');
    const rest = [];
    if (t.codec) rest.push(String(t.codec).toUpperCase());
    if (t.channels > 0) rest.push({ 1: '单声道', 2: '立体声', 6: '5.1', 8: '7.1' }[t.channels] || (t.channels + ' 声道'));
    return rest.length ? [name].concat(rest).join(' · ') : name;
  },

  renderSettingsTab(tabName) {
    const content = document.getElementById('playerSettingsContent');
    if (!content) return;

    const session = this.sessionData;
    const decision = session?.decision || {};
    const check = '<svg class="item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 12 11 14 15 10"/></svg>';

    if (tabName === 'subtitles') {
      // 关闭 → 中文 → 英语 → 其他语言 → 暂时放不了（同 macOS MacTracksPanel.subtitleRows）
      const { options, unavailable } = this.buildSubtitleTracks();
      const currentOffset = this.subtitleOffset || 0;
      const sel = this.selectedSubtitle;
      let html = `
        <div class="player-settings-item ${sel === null ? 'active' : ''}" data-sub-index="-1" onclick="Player.selectSubtitle(-1)">
          <span class="item-label">关闭字幕</span>
          ${check}
        </div>
      `;
      for (const g of this.subtitleGroups(options)) {
        html += `<div class="player-settings-group">${g.title}</div>`;
        html += g.options.map((o) => `
          <div class="player-settings-item stacked ${sel === o.index ? 'active' : ''}" data-sub-index="${o.index}" onclick="Player.selectSubtitle(${o.index})">
            <div class="item-text">
              <span class="item-label">${o.displayTitle}</span>
              <span class="item-info">${o.detail}</span>
            </div>
            ${check}
          </div>
        `).join('');
      }
      if (unavailable.length) {
        html += '<div class="player-settings-group">暂时放不了</div>';
        html += unavailable.map((u) => `
          <div class="player-settings-item stacked disabled" data-sub-index="${u.index}">
            <div class="item-text">
              <span class="item-label">${u.label}</span>
              <span class="item-info">${u.reason}</span>
            </div>
            ${check}
          </div>
        `).join('');
      }
      if (!options.length && !unavailable.length) {
        html += '<div style="padding:20px;text-align:center;color:rgba(255,255,255,0.4);font-size:13px">无可用字幕</div>';
      }
      // 字幕延迟调整
      html += `
        <div class="player-settings-item" style="cursor:default">
          <span class="item-label">字幕延迟</span>
          <div class="subtitle-offset-controls">
            <button class="offset-btn" onclick="Player.adjustSubtitleOffset(-0.5)">-0.5s</button>
            <span class="offset-value" id="subOffsetValue">${currentOffset > 0 ? '+' : ''}${currentOffset.toFixed(1)}s</span>
            <button class="offset-btn" onclick="Player.adjustSubtitleOffset(0.5)">+0.5s</button>
          </div>
        </div>
      `;
      content.innerHTML = html;
    }

    else if (tabName === 'audio') {
      const tracks = this.audioTracks();
      const currentRef = decision.audio?.track_ref ?? null;
      let html = tracks.map(t => {
        const parts = this.trackTextSplit(t.label);
        const detail = [parts.detail, t.is_default ? '默认' : null, t.unavailableReason].filter(Boolean).join(' · ');
        const active = t.ref === currentRef || (currentRef == null && t.is_default);
        return `
          <div class="player-settings-item stacked ${active ? 'active' : ''}${t.unavailableReason ? ' disabled' : ''}"${t.unavailableReason ? '' : ` onclick="Player.selectAudio('${t.ref}')"`}>
            <div class="item-text">
              <span class="item-label">${parts.title}</span>
              ${detail ? `<span class="item-info">${detail}</span>` : ''}
            </div>
            ${check}
          </div>
        `;
      }).join('');
      if (!tracks.length) html = '<div style="padding:20px;text-align:center;color:rgba(255,255,255,0.4);font-size:13px">无可用音轨</div>';
      content.innerHTML = html;
    }

    else if (tabName === 'quality') {
      const source = session?.source || {};
      const video = decision.video || {};
      const tier = decision.tier;
      const currentQuality = this.currentQuality || 0; // 0=原画
      const html = `
        <div class="player-settings-item ${currentQuality === 0 ? 'active' : ''}" onclick="Player.selectQuality(0)">
          <span class="item-label">原画</span>
          <span class="item-info">不压缩</span>
          <svg class="item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 12 11 14 15 10"/></svg>
        </div>
        <div class="player-settings-item ${currentQuality === 1080 ? 'active' : ''}" onclick="Player.selectQuality(1080)">
          <span class="item-label">1080p</span>
          <span class="item-info">~6 Mbps</span>
          <svg class="item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 12 11 14 15 10"/></svg>
        </div>
        <div class="player-settings-item ${currentQuality === 720 ? 'active' : ''}" onclick="Player.selectQuality(720)">
          <span class="item-label">720p</span>
          <span class="item-info">~3 Mbps</span>
          <svg class="item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 12 11 14 15 10"/></svg>
        </div>
        <div class="player-settings-item ${currentQuality === 480 ? 'active' : ''}" onclick="Player.selectQuality(480)">
          <span class="item-label">480p</span>
          <span class="item-info">~1.5 Mbps</span>
          <svg class="item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 12 11 14 15 10"/></svg>
        </div>
        <div style="padding:12px 16px;border-top:1px solid rgba(255,255,255,0.06)">
          <div style="font-size:11px;color:rgba(255,255,255,0.35);margin-bottom:8px">当前画质信息</div>
          ${source.resolution ? `<div style="font-size:12px;color:rgba(255,255,255,0.6);margin-bottom:4px">源：${source.resolution} · ${source.video_codec || ''} · ${source.hdr || ''}</div>` : ''}
          ${video.height ? `<div style="font-size:12px;color:rgba(255,255,255,0.6);margin-bottom:4px">输出：${video.height}p${video.action === 'copy' ? ' (直通)' : ' (转码)'}</div>` : ''}
          ${tier != null ? `<div style="font-size:12px;color:rgba(255,255,255,0.6)">档位：${tier}</div>` : ''}
          ${source.bit_rate ? `<div style="font-size:12px;color:rgba(255,255,255,0.6);margin-top:4px">码率：${(source.bit_rate / 1000000).toFixed(1)} Mbps</div>` : ''}
        </div>
      `;
      content.innerHTML = html;
    }

    else if (tabName === 'speed') {
      const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
      const current = this.video?.playbackRate || 1;
      content.innerHTML = speeds.map(s => `
        <div class="player-settings-item ${s === current ? 'active' : ''}" onclick="Player.setSpeed(${s})">
          <span class="item-label">${s}x${s === 1 ? ' (正常)' : ''}</span>
          <svg class="item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 12 11 14 15 10"/></svg>
        </div>
      `).join('');
    }
  },

  selectSubtitle(index) {
    if (!this.video) return;
    // 禁用所有 HTML5 字幕轨
    for (let i = 0; i < this.video.textTracks.length; i++) {
      this.video.textTracks[i].mode = 'disabled';
    }

    // 如果有 JASSUB，用它处理 ASS 字幕
    if (this.jassub) {
      if (index < 0) {
        // 关闭字幕
        this.jassub.setTrack?.(null);
        this.jassub.freeTrack?.();
      } else {
        // 判断选中的是否是 ASS 字幕
        const decision = this.sessionData?.decision || {};
        const subs = decision.subtitles || [];
        const sub = subs[index];
        if (sub && (sub.kind === 'ass' || sub.kind === 'ssa')) {
          const assIdx = this.jassubTracks.findIndex((_, i) => {
            const s = subs.filter((s2, j) => s2 && (s2.kind === 'ass' || s2.kind === 'ssa'))[i];
            return true;
          });
          // 直接加载对应的 ASS URL
          const assUrls = (this.sessionData?.subtitle_urls || []).filter((_, i) => {
            const s = subs[i];
            return s && (s.kind === 'ass' || s.kind === 'ssa');
          });
          const assSubIdx = subs.slice(0, index + 1).filter(s => s && (s.kind === 'ass' || s.kind === 'ssa')).length - 1;
          if (assSubIdx >= 0 && assUrls[assSubIdx]) {
            this.jassub.setTrack?.(assUrls[assSubIdx]);
          }
        } else {
          // 非 ASS 字幕：关闭 JASSUB，用 HTML5 textTracks
          this.jassub.freeTrack?.();
          if (index < this.video.textTracks.length) {
            this.video.textTracks[index].mode = 'showing';
          }
        }
      }
    } else {
      // 无 JASSUB：纯 HTML5 textTracks
      if (index >= 0 && index < this.video.textTracks.length) {
        this.video.textTracks[index].mode = 'showing';
      }
    }

    // 更新选中态
    this.selectedSubtitle = index < 0 ? null : index;
    document.querySelectorAll('#playerSettingsContent .player-settings-item').forEach(el => {
      el.classList.toggle('active', parseInt(el.dataset.subIndex) === index);
    });
  },

  subtitleOffset: 0, // 字幕延迟（秒）
  // 当前字幕：null=关，数字=decision.subtitles 下标，undefined=还没定（mpv 那条链不跟选中态）
  selectedSubtitle: undefined,

  adjustSubtitleOffset(delta) {
    this.subtitleOffset = Math.max(-30, Math.min(30, this.subtitleOffset + delta));
    const el = document.getElementById('subOffsetValue');
    if (el) el.textContent = (this.subtitleOffset > 0 ? '+' : '') + this.subtitleOffset.toFixed(1) + 's';
    // 应用字幕偏移（通过 track.cues 调整在 Chromium 中不直接支持，使用 CSS transform 或 video.currentTime 的替代方案）
    // Chromium WebView2 中可用 textTracks 的 mode 切换 + track offset hack
    // 这里先记录 offset 值，实际渲染偏移需要在 CSS 或 cue 调整中应用
  },

  selectAudio(ref) {
    // HLS.js 音轨切换
    if (this.hls && this.hls.audioTracks) {
      const idx = this.hls.audioTracks.findIndex(t => t.id === ref || t.name === ref);
      if (idx >= 0) this.hls.audioTrack = idx;
    }
    // 更新选中态
    document.querySelectorAll('#playerSettingsContent .player-settings-item').forEach(el => {
      el.classList.toggle('active', el.getAttribute('onclick')?.includes(`'${ref}'`));
    });
    this.hideSettings();
  },

  setSpeed(rate) {
    if (this.video) this.video.playbackRate = rate;
    const label = document.getElementById('speedLabel');
    if (label) label.textContent = rate + 'x';
    document.querySelectorAll('.player-speed-option').forEach(o => {
      o.classList.toggle('active', parseFloat(o.dataset.speed) === rate);
    });
    this.hideSettings();
    this.hideSpeedPanel();
  },

  currentQuality: 0, // 0=原画, 否则 maxHeight

  async selectQuality(maxHeight) {
    // mpv 会话不走下面那条 HTML5 重协商链：带着 max_height 重开起播链，由它按
    // 「限了画质就别报 universal」重谈会话（decide.py 的 universal 分支不受 max_height
    // 影响，报了还是原文件直出，上限整个失效）。这一开是新协商，failed_tiers 一并清掉
    // （对齐 macOS switchQuality）
    if (window.__MOVIECLAW_MPV_ACTIVE) {
      this.hideSettings();
      // 上限记下来：画质菜单要亮对档，下一张建议卡的 currentHeight 也按它夹
      this.currentQuality = maxHeight;
      const sd = this.sessionData;
      if (sd && typeof App !== 'undefined') {
        App.startPlayback({
          media_item_id: sd.media_item_id,
          title: this.currentTitle,
          library_id: sd.library_id,
          seasonNumber: sd.season_number,
          episodeNumber: sd.episode_number,
          startMs: Math.floor(this.engPos() * 1000),
          __maxHeight: maxHeight,
        });
      }
      return;
    }
    this.currentQuality = maxHeight;
    // 如果 session data 存在，重新请求播放会话
    if (this.sessionData?.media_item_id && typeof App !== 'undefined') {
      const currentTime = this.video ? this.video.currentTime : 0;
      this.video?.pause();
      const loading = document.getElementById('playerLoading');
      const loadingText = document.getElementById('playerLoadingText');
      if (loading) loading.hidden = false;
      if (loadingText) loadingText.textContent = '正在切换画质...';

      // 重新协商 session：能力按当前引擎如实申报，画质上限放请求顶层 max_height。
      // 原来把 universal:true 和 video:[{max_height}] 塞进 capability 是两处错位：
      // universal 分支直接给档 0 原文件（上限整个失效），video[] 里的 max_height
      // 服务端也不读（读的是请求顶层，decide.py 的 max_height 参数）
      const mediaId = this.sessionData.media_item_id;
      try {
        const capability = await getCapabilitySnapshot();
        const body = {
          media_item_id: mediaId,
          capability,
          client: 'web',
          start_ms: Math.floor(currentTime * 1000),
          attempt_id: Date.now().toString(36) + Math.random().toString(36).slice(2),
        };
        if (maxHeight > 0) body.max_height = maxHeight;
        const resp = await API.request('/playback/sessions', { method: 'POST', body });
        const session = resp?.data || resp;
        if (!session?.stream_url) throw new Error('切换画质失败');
        const origin = API.baseUrl;
        const streamUrl = session.stream_url.startsWith('http')
          ? session.stream_url
          : origin + (session.stream_url.startsWith('/api/') ? session.stream_url : '/api/v1' + (session.stream_url.startsWith('/') ? session.stream_url : '/' + session.stream_url));
        this.sessionData = session;
        if (!session.media_item_id) session.media_item_id = mediaId;

        // 重新加载流
        if (this.hls) { this.hls.destroy(); this.hls = null; }
        const isHls = streamUrl.includes('.m3u8') || streamUrl.includes('/hls');
        if (isHls && window.Hls && Hls.isSupported()) {
          this.hls = new Hls({
            maxBufferLength: 60,
            maxMaxBufferLength: 60,
            // 与主路径一致：TTFB 盖过服务端 ensure_segment 30s 等待
            fragLoadPolicy: {
              default: {
                maxTimeToFirstByteMs: 45000,
                maxLoadTimeMs: 120000,
                timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
                errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
              },
            },
            loader: window.__TAURI__ ? ProxyHlsLoader : undefined,
          });
          this.hls.loadSource(streamUrl);
          this.hls.attachMedia(this.video);
          this.attachNetHooks(this.hls);
          this.startNetMeter();
          this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
            this.video.currentTime = currentTime;
            this.video.play().catch(() => {});
            if (loading) loading.hidden = true;
          });
        } else {
          this.video.src = streamUrl;
          this.video.addEventListener('loadedmetadata', () => {
            this.video.currentTime = currentTime;
            this.video.play().catch(() => {});
            if (loading) loading.hidden = true;
          }, { once: true });
        }
      } catch (e) {
        console.error('Quality switch failed:', e);
        if (loadingText) loadingText.textContent = '切换画质失败: ' + (e.message || e);
        setTimeout(() => { if (loading) loading.hidden = true; }, 2000);
      }
    }
    // 更新 UI
    document.querySelectorAll('#playerSettingsContent .player-settings-item').forEach(el => {
      el.classList.remove('active');
    });
    this.hideSettings();
  },

  // ===== 跳过片头/片尾 =====
  currentSegments: [],
  currentSkipIndex: -1,

  initSegments(segments) {
    this.currentSegments = segments || [];
    this.currentSkipIndex = -1;
    const btn = document.getElementById('playerSkipBtn');
    if (btn) btn.hidden = true;
  },

  checkSegments() {
    if (!this.video || !this.currentSegments.length) return;
    const curMs = this.video.currentTime * 1000;
    const btn = document.getElementById('playerSkipBtn');
    if (!btn) return;

    let showBtn = false;
    for (let i = 0; i < this.currentSegments.length; i++) {
      const seg = this.currentSegments[i];
      if (curMs >= seg.start_ms && curMs < seg.end_ms) {
        showBtn = true;
        this.currentSkipIndex = i;
        btn.textContent = seg.type === 'intro' ? '跳过片头' : seg.type === 'outro' ? '跳过片尾' : '跳过此段';
        break;
      }
    }
    btn.hidden = !showBtn;
  },

  skipSegment() {
    if (this.currentSkipIndex < 0 || !this.video) return;
    const seg = this.currentSegments[this.currentSkipIndex];
    if (seg) {
      this.video.currentTime = seg.end_ms / 1000 + 0.5;
    }
    const btn = document.getElementById('playerSkipBtn');
    if (btn) btn.hidden = true;
    this.currentSkipIndex = -1;
  },

  // ===== 章节标记 =====
  renderChapters(chapters) {
    const seek = document.getElementById('playerSeek');
    if (!seek || !chapters?.length) return;
    // 清除旧的章节标记
    seek.querySelectorAll('.player-chapter-mark').forEach(el => el.remove());
    const dur = this.video?.duration;
    if (!dur) return;
    chapters.forEach(ch => {
      const pct = (ch.start_ms / 1000 / dur) * 100;
      if (pct < 0 || pct > 100) return;
      const mark = document.createElement('div');
      mark.className = 'player-chapter-mark';
      mark.style.left = pct + '%';
      mark.title = ch.title || '';
      seek.appendChild(mark);
    });
  },

  // ---- 上一集 / 下一集 ----
  // 同 macOS PlaybackController.nextEpisode/previousEpisode：只在**本季已入库**的
  // 集里找，缺集跳过。服务端的 PlaybackSessionView 不带 next_episode 字段（旧代码读
  // 它，按钮永远不亮），所以这份兄弟表由详情页 loadBrowse 那一份随起播传进来
  prevEpisode() {
    if (this.seasonNumber == null || this.episodeNumber == null) return null;
    return this.episodes
      .filter((e) => e && e.owned && e.episode_number < this.episodeNumber)
      .sort((a, b) => b.episode_number - a.episode_number)[0] || null;
  },

  nextEpisode() {
    if (this.seasonNumber == null || this.episodeNumber == null) return null;
    return this.episodes
      .filter((e) => e && e.owned && e.episode_number > this.episodeNumber)
      .sort((a, b) => a.episode_number - b.episode_number)[0] || null;
  },

  // 换集：关掉当前这一集，按同一部剧的下一单元重开。episodes 随身带走——
  // 降档/重连回路也会重新进 startPlayback，兄弟表不能在那几条路上丢
  playEpisode(ep) {
    if (!ep || typeof App === 'undefined') return;
    const mediaId = this.sessionData?.media_item_id ?? this.mediaItemId;
    if (!mediaId) return;
    const seriesTitle = String(this.currentTitle || '').replace(/\s+S\d+E\d+$/i, '');
    const season = this.seasonNumber;
    const title = season == null
      ? ep.name || seriesTitle
      : `${seriesTitle} S${season}E${ep.episode_number}`;
    this.episodes = this.episodes.slice();
    this.close();
    App.startPlayback({
      media_item_id: mediaId,
      title,
      library_id: this.sessionData?.library_id,
      seasonNumber: season,
      episodeNumber: ep.episode_number,
      episodes: this.episodes,
    });
  },

  // 剧集才出上下集按钮；到头的那一侧禁用（不隐藏，免得控制条宽度跳）
  syncEpisodeNav() {
    const isEpisode = this.seasonNumber != null && this.episodeNumber != null
      && !(Number(this.seasonNumber) === 0 && Number(this.episodeNumber) === 0);
    for (const [id, ep] of [['btnPrevEp', this.prevEpisode()], ['btnNextEp', this.nextEpisode()]]) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      btn.hidden = !isEpisode;
      btn.disabled = !ep;
    }
  },

  // 打开播放器并加载流
  open(title, streamUrl, subtitles, startMs, sessionData) {
    const view = document.getElementById('playerView');
    const titleEl = document.getElementById('playerTitle');
    const loading = document.getElementById('playerLoading');
    const loadingText = document.getElementById('playerLoadingText');

    this.currentTitle = title || 'MovieClaw';
    if (titleEl) titleEl.textContent = this.currentTitle;
    if (loading) loading.hidden = false;
    if (loadingText) loadingText.textContent = '正在加载...';

    view.hidden = false;
    this.sessionData = sessionData || null;
    this.sessionId = sessionData?.session_id || sessionData?.id || null;
    this.mediaItemId = sessionData?.media_item_id || sessionData?.mediaItemId || null;
    this.seasonNumber = sessionData?.season_number ?? null;
    this.episodeNumber = sessionData?.episode_number ?? null;
    this.lastProgressReport = 0;

    // 上一集 / 下一集：只在剧集里出现，缺集那一侧禁用（同 macOS MacPlayerTransport）
    this.syncEpisodeNav();

    // 启动进度上报定时器
    this.startProgressReporting();
    this.startSessionPing();

    // 初始化片段/章节
    this.initSegments(sessionData?.segments);
    // 渲染字幕轨信息到 settings（更新可用状态）

    // 清理旧的 HLS 实例
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    clearTimeout(this._stuckTimer);
    this._everPlayed = false;

    // 复用的 <video> 会把上一次的播放位置当成「默认起播位置」带进新源
    // （readyState=0 时 currentTime 读到的就是它，removeAttribute/load 也清不掉），
    // 「从头播放」(startMs=0/null) 必须在这里显式归位，否则从旧位置接着放
    if (this.video) this.video.currentTime = (startMs || 0) / 1000;

    // 实时速度：累计字节 + 2 秒滑动窗口（口径对齐 web bandwidth.ts 的 LoadingMeter）
    this._net = { bytes: 0, points: [], bps: null, frags: [] };
    this.hideInfoPanel();
    this.stopNetMeter(); // 原生直链没有分片钩子，徽标保持隐藏，由 hls 分支的 startNetMeter 点亮
    this.startWatchdogs();

    const isHls = streamUrl.includes('.m3u8') || streamUrl.includes('/hls');

    if (isHls && window.Hls && Hls.isSupported()) {
      this.hls = new Hls({
        // 对齐 web 引擎（apps/web/lib/player/engine.ts）的起播配置
        maxBufferLength: 60,
        maxMaxBufferLength: 60,
        // 必须显式给起播位置，不能留默认(-1)：EVENT playlist（转码/重封装会话）
        // 没有 ENDLIST，hls.js 当直播从「直播边缘」起播——续播时服务端已 burst
        // 出几十秒就会从错误位置开播。会话相对制传 0（续播由服务端 -ss 决定，
        // 流头即续播点）；非会话流传文件内续播秒数。
        startPosition: startMs ? startMs / 1000 : 0,
        // 分片超时要盖过服务端 ensure_segment 按需等待（最长 30s）：默认 20s
        // TTFB 会在服务端即将给出分片前掐掉重发，慢转码场景反复空转
        fragLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 45000,
            maxLoadTimeMs: 120000,
            timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
            errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
          },
        },
        loader: window.__TAURI__ ? ProxyHlsLoader : undefined,
      });
      this.hls.loadSource(streamUrl);
      this.hls.attachMedia(this.video);
      this.attachNetHooks(this.hls);
      this.startNetMeter();
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (startMs) this.video.currentTime = startMs / 1000;
        this.video.play().catch(() => {});
      });
      this.hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) {
          const details = String(data.details || '');
          // 首帧前的 buffer* 错误 = 视频初始化数据本身解不了（如直通重封装的
          // hvcC 缺参数集）→ 交给 App 走 failed_tiers 降档回路换转码重来
          if (!this._everPlayed && details.startsWith('buffer') &&
              typeof App !== 'undefined' && App.onPlaybackContentFailed) {
            setTimeout(() => App.onPlaybackContentFailed(details), 0);
            return;
          }
          if (loadingText) loadingText.textContent = '播放失败: ' + (details || 'HLS 流加载错误');
          if (loading) loading.hidden = false;
        }
      });
    } else {
      // MP4 / WebM 等原生格式
      this.video.src = streamUrl;
      this.video.addEventListener('loadedmetadata', () => {
        if (startMs) this.video.currentTime = startMs / 1000;
        this.video.play().catch(() => {});
      }, { once: true });
    }

    // 卡死兜底：服务端转码产出不出数据（如 ffmpeg 中途崩了）时首帧永远不来，
    // 35 秒后明确报错/降档，而不是无限停在「正在加载...」。
    // readyState>=2 = 数据其实到了（如自动播放被浏览器拦下），不算内容失败
    this._stuckTimer = setTimeout(() => {
      if (this._everPlayed || (this.video && this.video.readyState >= 2)) return;
      const lt = loadingText ? loadingText.textContent : '';
      if (lt && lt.startsWith('播放失败')) return; // 已有明确错误，不覆盖
      if (typeof App !== 'undefined' && App.onPlaybackContentFailed) {
        App.onPlaybackContentFailed('视频数据加载超时');
      } else if (loadingText) {
        loadingText.textContent = '播放失败: 视频数据加载超时，请稍后重试';
        if (loading) loading.hidden = false;
      }
    }, 35000);

    // 字幕
    if (subtitles && subtitles.length) {
      subtitles.forEach((sub, i) => {
        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.src = sub;
        track.srclang = 'zh';
        track.label = '字幕 ' + (i + 1);
        if (i === 0) track.default = true;
        this.video.appendChild(track);
      });
    }
    // 菜单里的勾要指对：上面把第 0 条设成了 default，起播就算它在放
    this.selectedSubtitle = (subtitles && subtitles.length) ? 0 : null;

    // JASSUB: 初始化 ASS 字幕渲染（如果有 ASS 类型字幕）
    this.initJassub(subtitles, sessionData);

    this.showControls();
    this.autoHideControls();
  },

  // 关闭播放器
  close() {
    // 作废仍在途的 startPlayback：否则请求回来晚一步会把新界面覆盖成旧影片
    if (typeof App !== 'undefined') App._playbackSeq = (App._playbackSeq || 0) + 1;
    // mpv 会话结束（含切回 HTML5 的场景）：标志不清会让 selectQuality 一直拒接画质切换；
    // 顺手收掉 mpv，否则 startPlayback 开新片时旧 mpv 还压在画面上
    if (window.__MOVIECLAW_MPV_ACTIVE) {
      window.__MOVIECLAW_MPV_ACTIVE = false;
      this.stopMpvPoll();
      if (window.__TAURI__?.core?.invoke) {
        window.__TAURI__.core.invoke('set_embedded_player_visible', { visible: false }).catch(() => {});
        window.__TAURI__.core.invoke('stop_embedded_player').catch(() => {});
      }
    }
    // 上报最终进度
    this.reportPlaybackStop();
    this.stopProgressReporting();
    this.stopSessionPing();
    clearTimeout(this._stuckTimer);
    // 拖动跟随排到一半的那次别在关播后落地
    if (this._scrubFollowTask) { clearTimeout(this._scrubFollowTask); this._scrubFollowTask = null; }
    this._scrubPct = null;
    this.stopNetMeter();
    this.stopWatchdogs();
    this.hideInfoPanel();
    // 错误/同意对话框压在播放器上：关播放器就得一起走，否则黑屏上留个框
    this.hidePlayerDialog();
    // 通知服务端结束会话，立即释放直通/转码槽位（否则要等 180s 空闲回收，
    // 连播几部就把 4/4 槽位占满 → 后续播放全 503）
    if (this.sessionId) {
      API.sessionStop(this.sessionId).catch(() => {});
      this.sessionId = null;
    }
    this.destroyJassub();

    const view = document.getElementById('playerView');
    if (view) view.hidden = true;
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.innerHTML = '';
      this.video.load();
    }
    if (document.fullscreenElement) document.exitFullscreen();
    clearTimeout(this.hideTimer);
  },

  // ===== 播放引擎读写 =====
  // HTML5 会话直接读写 <video>；mpv 会话没有 media element，属性靠 IPC 轮询缓存到
  // this.mpvState，控制命令发出即返回。调用点一律走 eng*，不用关心底下是哪个引擎。
  mpvState: null,
  mpvPollTimer: null,

  isMpv() {
    return !!window.__MOVIECLAW_MPV_ACTIVE;
  },

  // 发一条 mpv JSON IPC 命令。失败只记日志：mpv 退了由 stop 收尾，不该把 UI 打断
  mpvCmd(command) {
    if (!window.__TAURI__?.core?.invoke) return Promise.resolve(null);
    return window.__TAURI__.core.invoke('send_mpv_command_embedded', { command })
      .catch(e => { console.warn('[mpv]', command && command[0], (e && e.message) || e); return null; });
  },

  engPos() {
    return this.isMpv() ? (this.mpvState ? this.mpvState.time : 0) : (this.video ? this.video.currentTime : 0);
  },

  engDuration() {
    return this.isMpv() ? (this.mpvState ? this.mpvState.duration : 0) : (this.video ? this.video.duration || 0 : 0);
  },

  engPaused() {
    if (this.isMpv()) return this.mpvState ? this.mpvState.paused : true;
    return !this.video || this.video.paused;
  },

  engVolume() {
    return this.isMpv() ? (this.mpvState ? this.mpvState.volume : 1) : (this.video ? this.video.volume : 1);
  },

  engMuted() {
    return this.isMpv() ? !!(this.mpvState && this.mpvState.muted) : !!this.video?.muted;
  },

  // 统一收口夹取：两个引擎都只认 [0, duration]
  engSeekTo(sec) {
    // 用户 seek 作废掉帧/卡顿窗口（同 macOS seek 时 reset + restartGrace）。
    // 只在用户入口清：StallWatch 的 nudge 自己也 seek，跟着清掉「最多推 2 把」就失效了
    this._stallWatch?.reset();
    this._frameDrops?.reset();
    this._qualitySuggestion?.restartGrace();
    const dur = this.engDuration();
    const t = Math.max(0, dur ? Math.min(dur, sec) : sec);
    if (this.isMpv()) {
      if (this.mpvState) this.mpvState.time = t;
      this.mpvCmd(['seek', t, 'absolute']);
    } else if (this.video) {
      this.video.currentTime = t;
    }
  },

  engSeekBy(delta) {
    this.engSeekTo(this.engPos() + delta);
  },

  // 拖动途中画面跟着手指走的那次跳转：**不**作废掉帧/卡顿窗口（跟随不计入 seek
  // 次数，松手那次才算，同 macOS scrubFollow），mpv 用关键帧 seek——扫动途中要的是快
  engFollowTo(sec) {
    const dur = this.engDuration();
    const t = Math.max(0, dur ? Math.min(dur, sec) : sec);
    if (this.isMpv()) {
      if (this.mpvState) this.mpvState.time = t;
      this.mpvCmd(['seek', t, 'absolute', 'keyframe']);
    } else if (this.video) {
      this.video.currentTime = t;
    }
  },

  // 落点是不是在已缓冲里。缓冲未知按 0 算（macOS bufferedEndMs ?? 0）
  engBufferedEndSec() {
    if (this.isMpv()) {
      const t = this.mpvState ? this.mpvState.time : 0;
      return t + (this.mpvState && this.mpvState.bufferedAhead ? this.mpvState.bufferedAhead : 0);
    }
    const v = this.video;
    if (!v || !v.buffered || !v.buffered.length) return 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime && v.currentTime <= v.buffered.end(i)) return v.buffered.end(i);
    }
    return v.buffered.end(v.buffered.length - 1);
  },

  // 原文件直出（档 0）= 每次 seek 都是一条新的 Range 请求，扫动途中跟只会一路抽
  // （同 macOS playsOriginalFile，PlaybackController.swift:764）
  get playsOriginalFile() {
    return this.sessionData?.decision?.tier === 0;
  },

  // 拖动跟随的节奏（同 macOS ScrubFollow.plan，PlaybackWatchdogs.swift:134）：
  // 后沿落地 + 连续扫动 10Hz 兜底。跳转便宜（落点在缓冲里）时途中跟手；
  // 原文件直出拖出缓冲只在手指停住 settleMs 后跟一次；其余情况松手才跳。
  scrubFollowPlan(nowMs, lastFollowMs, cheap, reachable, settleOnly) {
    const settleMs = 60, maxWaitMs = 100;
    if (!reachable) return { kind: 'skip' };
    if (!cheap) return settleOnly ? { kind: 'deferred', ms: settleMs } : { kind: 'skip' };
    const waited = nowMs - lastFollowMs;
    if (waited >= maxWaitMs) return { kind: 'follow' };
    return { kind: 'deferred', ms: Math.max(0, Math.min(settleMs, maxWaitMs - waited)) };
  },

  scrubFollow(targetSec) {
    if (!this.engDuration()) return;
    const plan = this.scrubFollowPlan(
      Date.now(), this._lastScrubFollowAt,
      // cheap：落点在当前位置前 1 秒~已缓冲尾之间（同 macOS）
      targetSec >= this.engPos() - 1 && targetSec <= this.engBufferedEndSec(),
      targetSec >= 0,          // reachable：文件时间轴上 originMs=0
      this.playsOriginalFile,  // settleOnly
    );
    if (this._scrubFollowTask) { clearTimeout(this._scrubFollowTask); this._scrubFollowTask = null; }
    if (plan.kind === 'skip') return;
    if (plan.kind === 'follow') {
      this._lastScrubFollowAt = Date.now();
      this.engFollowTo(targetSec);
      return;
    }
    // 后沿落地：中途再来一次拖动就把这次取消重排，手指停住 plan.ms 后才跟
    this._scrubFollowTask = setTimeout(() => {
      this._scrubFollowTask = null;
      this._lastScrubFollowAt = Date.now();
      this.engFollowTo(targetSec);
    }, plan.ms);
  },

  engSetVolume(v) {
    const vol = Math.max(0, Math.min(1, v));
    if (this.isMpv()) {
      if (this.mpvState) this.mpvState.volume = vol;
      this.mpvCmd(['set_property', 'volume', Math.round(vol * 100)]);
    } else if (this.video) {
      this.video.volume = vol;
      this.video.muted = vol === 0;
    }
    this.updateVolumeIcon();
  },

  engSetMuted(muted) {
    if (this.isMpv()) {
      if (this.mpvState) this.mpvState.muted = !!muted;
      this.mpvCmd(['set_property', 'mute', !!muted]);
    } else if (this.video) {
      this.video.muted = !!muted;
    }
    this.updateVolumeIcon();
  },

  // mpv 不推属性事件，进度条/时间/暂停态靠轮询喂成和 HTML5 一样
  startMpvPoll() {
    this.stopMpvPoll();
    this.mpvState = { time: 0, duration: 0, paused: true, volume: 1, muted: false };
    this._mpvRectSig = null;
    // 浮层（加载层/面板）显隐会改变挖洞范围，跟着它们重算
    this.mpvRectTimer = setInterval(() => this.syncEmbeddedPlayerRect(), 200);
    const tick = async () => {
      if (!this.isMpv() || !this.mpvState) return;
      const [t, d, p, c] = await Promise.all([
        this.mpvCmd(['get_property', 'time-pos']),
        this.mpvCmd(['get_property', 'duration']),
        this.mpvCmd(['get_property', 'pause']),
        // 前向缓存秒数：拖动跟随判「落点在不在缓冲里」用（engBufferedEndSec）
        this.mpvCmd(['get_property', 'demuxer-cache-duration']),
      ]);
      if (!this.isMpv() || !this.mpvState) return;
      if (t && typeof t.data === 'number') this.mpvState.time = t.data;
      if (d && typeof d.data === 'number') this.mpvState.duration = d.data;
      this.mpvState.bufferedAhead = (c && typeof c.data === 'number') ? c.data : 0;
      if (p && typeof p.data === 'boolean') {
        this.mpvState.paused = p.data;
        // HTML5 的 play/pause 事件在这里不会来，图标随轮询走
        this.showIcon(p.data ? 'play' : 'pause');
      }
      this.updateProgress();
    };
    tick();
    this.mpvPollTimer = setInterval(tick, 500);
    this.startWatchdogs();
  },

  stopMpvPoll() {
    if (this.mpvPollTimer) { clearInterval(this.mpvPollTimer); this.mpvPollTimer = null; }
    if (this.mpvRectTimer) { clearInterval(this.mpvRectTimer); this.mpvRectTimer = null; }
    this.stopWatchdogs();
    this.mpvState = null;
  },

  // ===== 播放看门狗：1 Hz 采样喂三个 tracker，判定交 App 执行 =====
  startWatchdogs() {
    this.stopWatchdogs();
    this._frameDrops = createFrameDropTracker();
    this._stallWatch = createStallWatch();
    this._qualitySuggestion = createQualitySuggestion();
    this._watchedSeconds = 0;
    this._lastWatchTime = null;
    this._lastNetBytes = null;
    this._watchdogTick = setInterval(() => this._tickWatchdogs(), 1000);
  },

  stopWatchdogs() {
    if (this._watchdogTick) { clearInterval(this._watchdogTick); this._watchdogTick = null; }
    this._frameDrops = this._stallWatch = this._qualitySuggestion = null;
    this.hideQualityOffer();
  },

  // 采一帧当前引擎的真实状态。mpv 那边要走 IPC，所以只在 1 Hz 采（UI 轮询 500ms 不掺这个）
  async _sampleEngine() {
    if (this.isMpv()) {
      const props = ['time-pos', 'pause', 'eof-reached', 'seeking', 'paused-for-cache',
        'demuxer-cache-duration', 'cache-speed', 'frame-drop-count', 'decoder-frame-drop-count', 'container-fps'];
      const res = await Promise.all(props.map(p => this.mpvCmd(['get_property', p])));
      if (!this.isMpv() || !this.mpvState) return null;
      const v = {};
      res.forEach((r, i) => { v[props[i]] = r && r.data !== undefined ? r.data : null; });
      const time = typeof v['time-pos'] === 'number' ? v['time-pos'] : this.mpvState.time;
      // mpv 这条链没有 <video> 的 playing 事件：time-pos 走起来过就等于出过帧
      // （起播前是 0/null）。不置位的话下面 !this._everPlayed 恒真，「缓冲」会在
      // 正常播放时一直成立，画质卡的「连续等待 ≥8s」被 8 秒普通播放误触发
      if (time > 0) this._everPlayed = true;
      return {
        time,
        paused: !!v.pause,
        ended: !!v['eof-reached'],
        seeking: !!v.seeking,
        // mpv 的前向缓存秒数；没有 demuxer 属性时按 0 算（缓冲见底）
        bufferedAhead: typeof v['demuxer-cache-duration'] === 'number' ? v['demuxer-cache-duration'] : 0,
        // cache-speed = 正在填的缓存读速；缓存满时为 0，正好符合「只在等待期测速」的口径。
        // mpv 给的是**字节**/秒，这里统一成比特/秒（formatBandwidth 与码率阈值都按 bps 算）
        loadingBps: typeof v['cache-speed'] === 'number' ? v['cache-speed'] * 8 : 0,
        dropped: (Number(v['frame-drop-count']) || 0) + (Number(v['decoder-frame-drop-count']) || 0),
        fps: typeof v['container-fps'] === 'number' ? v['container-fps'] : 0,
        // 没数据要攒 / 还没出过帧 = 正在等（对应 macOS phase == .buffering）
        buffering: !!v['paused-for-cache'] || !this._everPlayed,
      };
    }
    const v = this.video;
    if (!v) return null;
    let bufferedAhead = 0;
    try {
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= v.currentTime && v.currentTime <= v.buffered.end(i)) {
          bufferedAhead = v.buffered.end(i) - v.currentTime;
          break;
        }
      }
    } catch (_) {}
    let dropped = 0, total = 0;
    try {
      const q = v.getVideoPlaybackQuality && v.getVideoPlaybackQuality();
      if (q) { dropped = q.droppedVideoFrames || 0; total = q.totalVideoFrames || 0; }
    } catch (_) {}
    // 等待期测速源：ProxyHlsLoader 一次性交付整片，字节只在片尾跳一次，
    // _net.bps 那个 2 秒窗口量出来「收片瞬间虚高十几倍、其余时间恒为 0」——
    // 两个都不像线路能力，看门狗拿它判「跟不跟得上」只会把所有样本都否掉。
    // 改成对累计收片字节做 1 Hz 差分：等待期里每秒都在收，差分就是那一秒的真实
    // 下行速率（同 macOS 在等待期逐秒读引擎字节计数，取最快那秒）
    let loadingBps = 0;
    if (this._net) {
      const bytes = this._net.bytes || 0;
      if (this._lastNetBytes != null && bytes >= this._lastNetBytes) {
        loadingBps = (bytes - this._lastNetBytes) * 8; // 每秒一字节 = 8 bps
      }
      this._lastNetBytes = bytes;
    }
    return {
      time: v.currentTime,
      paused: !!v.paused,
      ended: !!v.ended,
      seeking: !!v.seeking,
      bufferedAhead,
      loadingBps,
      dropped, total, fps: 0,
      buffering: !!this._buffering,
    };
  },

  async _tickWatchdogs() {
    if (!this._frameDrops || !this.sessionData) return;
    const view = document.getElementById('playerView');
    if (view && view.hidden) return;
    const s = await this._sampleEngine();
    if (!s || !this._frameDrops || !this.sessionData) return;
    // 真播起来了就清网络重开预算（同 macOS reachedPlaying()）
    if (!s.buffering && !s.paused && !s.ended && s.time > 0 && typeof App !== 'undefined' && App.onPlaybackRecovered) {
      App.onPlaybackRecovered();
    }

    const sd = this.sessionData;
    const decision = sd.decision || {};
    const tier = typeof decision.tier === 'number' ? decision.tier : null;
    // 只在视频直通档判掉帧：转码档（3/4）再掉帧说明连转码产物都放不动，降档只会更糟
    const isCopy = decision.video ? decision.video.action === 'copy' : tier === 0;
    const playsOriginalFile = tier === 0;

    if (isCopy && tier != null && tier < 3 && !s.paused && !s.ended && !s.seeking) {
      if (this.isMpv()) {
        // mpv 不给已播帧数，用累计观看时长 × 帧率估（同 macOS EngineStats）；
        // 只认小步前进，起播定位/用户拖动的大跳不算
        const d = this._lastWatchTime == null ? 0 : s.time - this._lastWatchTime;
        if (d > 0 && d < 5) this._watchedSeconds += d;
        this._lastWatchTime = s.time;
        s.total = Math.floor(this._watchedSeconds * (s.fps || 24));
      }
      const ratio = this._frameDrops.sample(s.dropped, s.total);
      if (ratio != null && ratio >= this._frameDrops.threshold) {
        this._frameDrops.reset();
        const pct = Math.round(ratio * 100);
        if (typeof App !== 'undefined' && App.onPlaybackContentFailed) {
          App.onPlaybackContentFailed(`直通播放持续掉帧（${pct}%），正在换转码重试`);
        }
        return;
      }
    }

    const deadLimit = playsOriginalFile ? this._stallWatch.DIRECT_DEAD_S : this._stallWatch.SERVER_DEAD_S;
    const verdict = this._stallWatch.sample(
      s.time, s.bufferedAhead, s.paused, s.ended, s.seeking, s.loadingBps > 0, deadLimit,
    );
    if (verdict === 'nudge') {
      // 有数据却不动：推一把踢活解码管线（起播预滚阶段 tracker 不会推）。
      // 故意不走 engSeekTo —— 那条路会清 StallWatch，把「最多推 2 把」清成无限推
      const t = s.time + this._stallWatch.NUDGE_STEP;
      if (this.isMpv()) {
        if (this.mpvState) this.mpvState.time = t;
        this.mpvCmd(['seek', t, 'absolute']);
        this.mpvCmd(['set_property', 'pause', false]);
      } else if (this.video) {
        this.video.currentTime = t;
        this.video.play().catch(() => {});
      }
    } else if (verdict === 'decodeStalled') {
      if (typeof App !== 'undefined' && App.onPlaybackContentFailed) {
        App.onPlaybackContentFailed(this._stallWatch.reason(verdict, deadLimit));
      }
      return;
    } else if (verdict === 'dead') {
      if (typeof App !== 'undefined' && App.onPlaybackNetworkDead) {
        App.onPlaybackNetworkDead(this._stallWatch.reason(verdict, deadLimit));
      }
      return;
    }

    // ---- 画质建议（与掉帧互不触发：那是解码吃不下，这是线路跟不上）----
    if (!this._qualitySuggestion) return;
    this._qualitySuggestion.tick(s.buffering || s.seeking, s.seeking, s.loadingBps);
    if (this._qualityOffer || this._qualitySuggestion.offered) return;
    const bitrate = (sd.source && sd.source.bit_rate) || 0;
    const sourceHeight = heightOfResolution(sd.source && sd.source.resolution)
      ?? (decision.video && decision.video.height) ?? null;
    const currentHeight = this.currentQuality > 0
      ? (sourceHeight != null ? Math.min(sourceHeight, this.currentQuality) : this.currentQuality)
      : sourceHeight;
    const offer = this._qualitySuggestion.offer(bitrate, currentHeight);
    if (offer) this.showQualityOffer(offer);
  },

  // 画质建议卡（macOS QualitySuggestion）：一次性、20 秒没理会自动收起、换不换由用户定
  showQualityOffer(offer) {
    this._qualityOffer = offer;
    const meas = formatBandwidth(offer.measuredBps) || '—';
    const req = formatBandwidth(offer.requiredBps) || '—';
    let card = document.getElementById('qualityOfferCard');
    if (!card) {
      card = document.createElement('div');
      card.id = 'qualityOfferCard';
      card.className = 'quality-offer-card';
      document.getElementById('playerView')?.appendChild(card);
    }
    card.innerHTML = `
      <div class="quality-offer-title">网速跟不上当前画质</div>
      <div class="quality-offer-body">实测约 ${meas}，这一版需要约 ${req}。可以暂停攒一会缓冲再看，或改用 ${offer.maxHeight}p（服务端转码，画质会降低）。</div>
      <div class="quality-offer-actions">
        <button class="btn-secondary" id="btnKeepQuality">继续当前画质</button>
        <button class="btn-play" id="btnAcceptQuality">改用 ${offer.maxHeight}p</button>
      </div>
    `;
    document.getElementById('btnAcceptQuality')?.addEventListener('click', () => this.acceptQualityOffer());
    document.getElementById('btnKeepQuality')?.addEventListener('click', () => this.hideQualityOffer());
    clearTimeout(this._qualityOfferTimer);
    this._qualityOfferTimer = setTimeout(() => this.hideQualityOffer(), 20000);
  },

  acceptQualityOffer() {
    const offer = this._qualityOffer;
    if (!offer) return;
    this.hideQualityOffer();
    this.selectQuality(offer.maxHeight);
  },

  hideQualityOffer() {
    clearTimeout(this._qualityOfferTimer);
    this._qualityOfferTimer = null;
    this._qualityOffer = null;
    document.getElementById('qualityOfferCard')?.remove();
  },

  // ===== 对话框（同 macOS MacPlayerDialog / MacConsentDialog）=====
  // 会话决策的两个终态：要用户同意才能软件转码、或彻底放不了。模态压在播放器上，
  // 键盘 ⏎ 认主按钮、Esc 认次按钮（同 SwiftUI .defaultAction / .cancelAction）
  hidePlayerDialog() {
    this._dialog = null;
    document.getElementById('playerDialog')?.remove();
  },

  _dialogButton(label, prominent, onClick) {
    const b = document.createElement('button');
    b.className = prominent ? 'btn-play' : 'btn-secondary';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  },

  // 错误对话框：标题 + 一行建议 +「重试 / 关闭」（macOS MacPlayerDialog 的 .error 用法）
  showPlayerDialog({ title, message, primary, secondary }) {
    this.hidePlayerDialog();
    const card = document.createElement('div');
    card.className = 'player-dialog';
    // SF Symbol 的感叹号三角，Windows 用同形状的内联 SVG（界面不用 emoji）
    card.innerHTML = `
      <svg class="player-dialog-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 2.5 1.2 21.5h21.6L12 2.5zm0 6.2a.9.9 0 0 1 .9.9v5a.9.9 0 1 1-1.8 0v-5a.9.9 0 0 1 .9-.9zm0 9.1a1.15 1.15 0 1 1 0 2.3 1.15 1.15 0 0 1 0-2.3z"/>
      </svg>
    `;
    const t = document.createElement('div');
    t.className = 'player-dialog-title';
    t.textContent = title;
    card.appendChild(t);
    if (message) {
      const m = document.createElement('div');
      m.className = 'player-dialog-message';
      m.textContent = message;
      card.appendChild(m);
    }
    const actions = document.createElement('div');
    actions.className = 'player-dialog-actions';
    // 主次顺序同 macOS：次按钮在左、主按钮在右
    if (secondary) actions.appendChild(this._dialogButton(secondary[0], false, secondary[1]));
    actions.appendChild(this._dialogButton(primary[0], true, primary[1]));
    card.appendChild(actions);
    this._mountDialog(card, primary[1], secondary ? secondary[1] : null);
  },

  // 软件转码同意：说清原因与代价，能自开的给「开启并播放」（macOS MacConsentDialog）
  showConsentDialog(decision) {
    this.hidePlayerDialog();
    const card = document.createElement('div');
    card.className = 'player-dialog consent';
    const t = document.createElement('div');
    t.className = 'player-dialog-title';
    t.textContent = '这部片需要软件转码才能播放';
    card.appendChild(t);

    const field = (label, text) => {
      const wrap = document.createElement('div');
      const l = document.createElement('div');
      l.className = 'player-dialog-field-label';
      l.textContent = label;
      const v = document.createElement('div');
      v.className = 'player-dialog-field-value';
      v.textContent = text;
      wrap.append(l, v);
      return wrap;
    };
    card.appendChild(field('原因', decision.reason || ''));
    if (decision.cost_hint) card.appendChild(field('代价', decision.cost_hint));

    // 开关存不下去时把原因留在框里（macOS 的 error 状态）
    const errEl = document.createElement('div');
    errEl.className = 'player-dialog-error';
    errEl.hidden = true;
    card.appendChild(errEl);

    if (decision.can_self_enable !== true) {
      const hint = document.createElement('div');
      hint.className = 'player-dialog-hint';
      hint.textContent = '当前未开启软件转码。请联系管理员开启（管理员播放此类影片时会收到开启询问）。';
      card.appendChild(hint);
    }

    const actions = document.createElement('div');
    actions.className = 'player-dialog-actions';
    if (decision.can_self_enable !== true) {
      // 非超管改不了开关：只有「知道了」，等于退出
      actions.appendChild(this._dialogButton('知道了', true, () => this.close()));
      card.appendChild(actions);
      this._mountDialog(card, () => this.close(), null);
      return;
    }
    let saving = false;
    const grant = async () => {
      if (saving) return;
      saving = true;
      errEl.hidden = true;
      primaryBtn.disabled = true;
      primaryBtn.textContent = '正在开启…';
      try {
        await App.grantConsent();
        // 成功会重新起播，起播链里的 Player.close() 自己把对话框收掉
      } catch (e) {
        errEl.textContent = (e && e.message) || String(e);
        errEl.hidden = false;
        saving = false;
        primaryBtn.disabled = false;
        primaryBtn.textContent = '开启并播放';
      }
    };
    actions.appendChild(this._dialogButton('取消', false, () => this.close()));
    const primaryBtn = this._dialogButton('开启并播放', true, grant);
    actions.appendChild(primaryBtn);
    card.appendChild(actions);
    this._mountDialog(card, grant, () => this.close());
  },

  _mountDialog(card, primary, secondary) {
    const scrim = document.createElement('div');
    scrim.id = 'playerDialog';
    scrim.className = 'player-dialog-scrim';
    scrim.appendChild(card);
    document.getElementById('playerView')?.appendChild(scrim);
    // 键盘 ⏘/Esc 要找得到按钮对应的动作
    this._dialog = { primary, secondary };
  },

  // mpv 画面是主窗口的子窗口，不跟 HTML5 布局走：视频区域一变（缩放窗口/进全屏）得手动挪它。
  // 同时网页层要在这块区域上挖洞透出画面——但顶栏/进度条/浮层压在视频上，
  // 洞必须把它们刨出去，否则 SetWindowRgn 会把控件一起剪没
  syncEmbeddedPlayerRect() {
    if (!this.isMpv() || !window.__TAURI__?.core?.invoke) return;
    const wrap = document.querySelector('.player-video-wrap');
    const topbar = document.getElementById('playerTopbar');
    const controls = document.getElementById('playerControls');
    if (!wrap || !topbar || !controls) return;
    const wr = wrap.getBoundingClientRect();
    const tr = topbar.getBoundingClientRect();
    const cr = controls.getBoundingClientRect();
    // 控件条自动隐藏走 opacity，矩形一直在，视频带因此是稳的，不会跟着控件进出跳动
    const top = Math.max(wr.top, tr.bottom);
    const bottom = Math.min(wr.bottom, cr.top);
    const scale = window.devicePixelRatio || 1;
    const box = (r) => [r.left, r.top, r.width, r.height].map((v) => Math.round(v * scale));
    // 带内可见的浮层（加载层/面板）留在网页层里画，挖洞时刨掉它们。
    // 中央按钮故意不刨：它是 border-radius:50% 的圆，刨出的矩形会在四角露出
    // .player-view 的纯黑底，比少一个按钮更难看。播放/暂停由底栏负责
    const keepRects = ['playerLoading', 'playerInfoPanel', 'playerSettingsPanel', 'playerSpeedPanel']
      .map((id) => document.getElementById(id))
      .filter((el) => el && !el.hidden)
      .map((el) => box(el.getBoundingClientRect()));
    const args = {
      x: Math.round(wr.left * scale),
      y: Math.round(top * scale),
      width: Math.round(wr.width * scale),
      height: Math.round((bottom - top) * scale),
      keepRects,
    };
    // 浮层显隐没有统一入口，靠轮询兜着；签名没变就不重设区域，免得每 200ms 触发一次重绘
    const sig = JSON.stringify(args);
    if (sig === this._mpvRectSig) return;
    this._mpvRectSig = sig;
    window.__TAURI__.core.invoke('resize_embedded_player', args).catch(() => {});
    window.__TAURI__.core.invoke('set_embedded_player_visible', { visible: true }).catch(() => {});
  },

  togglePlay() {
    const wasPaused = this.engPaused();
    if (this.isMpv()) {
      if (this.mpvState) this.mpvState.paused = !wasPaused;
      this.mpvCmd(['set_property', 'pause', !wasPaused]);
      // HTML5 的 play/pause 事件在 mpv 会话里不会来，图标/控制条这里补上
      this.showIcon(wasPaused ? 'pause' : 'play');
      if (wasPaused) { this.hideCenterBtn(); this.autoHideControls(); }
      else { this.showCenterBtn(); this.showControls(); }
    } else if (this.video) {
      if (this.video.paused) this.video.play().catch(() => {});
      else this.video.pause();
    }
  },

  toggleMute() {
    const next = !this.engMuted();
    this.engSetMuted(next);
    const slider = document.getElementById('volumeSlider');
    if (slider) slider.value = next ? 0 : this.engVolume();
  },

  toggleFullscreen() {
    const view = document.getElementById('playerView');
    if (!view) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else view.requestFullscreen().catch(() => {});
  },

  togglePip() {
    if (!this.video) return;
    if (document.pictureInPictureElement) document.exitPictureInPicture();
    else this.video.requestPictureInPicture().catch(() => {});
  },

  showIcon(name) {
    const play = document.getElementById('iconPlay');
    const pause = document.getElementById('iconPause');
    if (play) play.style.display = name === 'play' ? '' : 'none';
    if (pause) pause.style.display = name === 'pause' ? '' : 'none';
    const centerBtn = document.getElementById('playerCenterBtn');
    if (centerBtn) {
      centerBtn.innerHTML = name === 'play'
        ? '<svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
        : '<svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    }
  },

  showCenterBtn() {
    const btn = document.getElementById('playerCenterBtn');
    if (btn) btn.hidden = false;
  },

  hideCenterBtn() {
    const btn = document.getElementById('playerCenterBtn');
    if (btn) btn.hidden = true;
  },

  showControls() {
    const topbar = document.getElementById('playerTopbar');
    const controls = document.getElementById('playerControls');
    if (topbar) topbar.style.opacity = '1';
    if (controls) controls.style.opacity = '1';
  },

  hideControls() {
    const topbar = document.getElementById('playerTopbar');
    const controls = document.getElementById('playerControls');
    if (topbar) topbar.style.opacity = '0';
    if (controls) controls.style.opacity = '0';
  },

  autoHideControls() {
    clearTimeout(this.hideTimer);
    if (!this.engPaused()) {
      this.hideTimer = setTimeout(() => {
        this.hideControls();
        this.hideCenterBtn();
      }, 3000);
    }
  },

  // 进度条上的已播条与滑块：拖动中跟手指（_scrubPct），否则跟播放头
  renderScrub() {
    const dur = this.engDuration();
    const frac = this._scrubPct != null
      ? this._scrubPct
      : (dur ? this.engPos() / dur : 0);
    const pct = Math.max(0, Math.min(1, frac)) * 100;
    const fill = document.getElementById('playerSeekFill');
    const thumb = document.getElementById('playerSeekThumb');
    if (fill) fill.style.width = pct + '%';
    if (thumb) thumb.style.left = pct + '%';
  },

  updateProgress() {
    if (this.isSeeking) return;
    if (!this.isMpv() && !this.video) return;
    const cur = this.engPos();
    const dur = this.engDuration();

    this.renderScrub();

    // 下行两端：左「已播」，右「剩余」或「总长」（点它切换，同 QuickTime）。
    // 片长还没起（起播中）时右侧显示占位，不显示「-0:00」（同 macOS）
    const timeEl = document.getElementById('playerTime');
    if (timeEl) timeEl.textContent = this.formatTime(cur);
    const remEl = document.getElementById('playerRemaining');
    if (remEl) {
      remEl.textContent = dur > 0
        ? (this.showsTotal ? this.formatTime(dur) : '-' + this.formatTime(Math.max(0, dur - cur)))
        : '--:--';
      remEl.title = this.showsTotal ? '显示剩余时间' : '显示总时长';
    }
  },

  updateBuffer() {
    if (!this.video || !this.video.buffered.length) return;
    const dur = this.video.duration || 0;
    const buf = this.video.buffered.end(this.video.buffered.length - 1);
    const pct = dur ? (buf / dur) * 100 : 0;
    const bufEl = document.getElementById('playerSeekBuffer');
    if (bufEl) bufEl.style.width = pct + '%';
  },

  updateVolumeIcon() {
    const vol = document.getElementById('iconVol');
    const mute = document.getElementById('iconMute');
    const isMuted = this.isMpv()
      ? (this.engMuted() || this.engVolume() === 0)
      : (!this.video || this.video.muted || this.video.volume === 0);
    if (vol) vol.style.display = isMuted ? 'none' : '';
    if (mute) mute.style.display = isMuted ? '' : 'none';
  },

  // ===== JASSUB ASS 字幕渲染 =====
  initJassub(subtitles, sessionData) {
    // 清理旧的 JASSUB 实例
    this.destroyJassub();

    if (!subtitles || !subtitles.length) return;
    if (typeof JASSUB === 'undefined') {
      console.warn('[JASSUB] Library not loaded');
      return;
    }

    // 查找 ASS/SSA 字幕轨
    const decision = sessionData?.decision || {};
    const assSubs = decision.subtitles || [];
    const assUrls = subtitles.filter((_, i) => {
      const sub = assSubs[i];
      return sub && (sub.kind === 'ass' || sub.kind === 'ssa' || sub.format === 'ass' || sub.format === 'ssa');
    });

    if (!assUrls.length) return;

    try {
      // 创建 JASSUB 渲染器
      this.jassub = new JASSUB({
        video: this.video,
        subContent: null, // 从 URL 加载
        subUrl: assUrls[0],
        availableFonts: { 'default': 'jassub-default.woff2' },
        workerUrl: 'jassub-worker.js',
        wasmUrl: 'jassub-worker.wasm',
        fallbackFont: 'jassub-default.woff2',
        debug: false,
      });
      this.jassubTracks = assUrls;
      console.log('[JASSUB] Initialized with', assUrls.length, 'ASS track(s)');
    } catch (e) {
      console.warn('[JASSUB] Init failed:', e);
    }
  },

  destroyJassub() {
    if (this.jassub) {
      try { this.jassub.destroy(); } catch (_) {}
      this.jassub = null;
    }
    this.jassubTracks = [];
  },

  // ===== 进度上报 & 会话保活 =====
  startProgressReporting() {
    this.stopProgressReporting();
    // 发送初始 start 事件
    if (this.mediaItemId) {
      const posMs = Math.floor(this.engPos() * 1000);
      const durMs = Math.floor(this.engDuration() * 1000);
      API.reportProgress(this.mediaItemId, 'start', posMs, durMs, this.seasonNumber, this.episodeNumber).catch(() => {});
      this.lastProgressReport = Date.now();
    }
    this.progressTimer = setInterval(() => {
      if (!this.mediaItemId) return;
      const now = Date.now();
      if (now - this.lastProgressReport < 10000) return;
      this.lastProgressReport = now;
      const posMs = Math.floor(this.engPos() * 1000);
      const durMs = Math.floor(this.engDuration() * 1000);
      API.reportProgress(this.mediaItemId, 'progress', posMs, durMs, this.seasonNumber, this.episodeNumber).catch(() => {});
    }, 5000);
  },

  stopProgressReporting() {
    if (this.progressTimer) { clearInterval(this.progressTimer); this.progressTimer = null; }
  },

  startSessionPing() {
    this.stopSessionPing();
    if (!this.sessionId) return;
    this.pingTimer = setInterval(() => {
      if (!this.sessionId) return;
      API.sessionPing(this.sessionId).catch(() => {});
    }, 30000);
  },

  stopSessionPing() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  },

  reportPlaybackEnd() {
    if (!this.mediaItemId) return;
    const posMs = Math.floor(this.engPos() * 1000);
    const durMs = Math.floor(this.engDuration() * 1000);
    API.reportProgress(this.mediaItemId, 'stop', posMs, durMs, this.seasonNumber, this.episodeNumber).catch(() => {});
    this.stopProgressReporting();
    this.stopSessionPing();
    if (this.sessionId) {
      API.sessionStop(this.sessionId).catch(() => {});
      this.sessionId = null;
    }
    if (durMs > 0 && posMs / durMs >= 0.9) {
      if (typeof App !== 'undefined' && App.onPlaybackEnded) {
        App.onPlaybackEnded(this.sessionData);
      }
    }
  },

  reportPlaybackStop() {
    if (!this.mediaItemId) return;
    const posMs = Math.floor(this.engPos() * 1000);
    const durMs = Math.floor(this.engDuration() * 1000);
    API.reportProgress(this.mediaItemId, 'stop', posMs, durMs, this.seasonNumber, this.episodeNumber).catch(() => {});
  },

  formatTime(secs) {
    if (!secs || isNaN(secs)) return '0:00';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  },
};

// DOM 加载后初始化
document.addEventListener('DOMContentLoaded', () => Player.init());
