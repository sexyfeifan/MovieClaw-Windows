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

const Player = {
  video: null,
  hls: null,
  currentTitle: '',
  hideTimer: null,
  isSeeking: false,
  // 进度上报 & 会话保活
  sessionId: null,
  mediaItemId: null,
  seasonNumber: null,
  episodeNumber: null,
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

    // 播放/暂停
    document.getElementById('btnPlayPause')?.addEventListener('click', () => this.togglePlay());
    document.getElementById('playerCenterBtn')?.addEventListener('click', () => this.togglePlay());
    this.video.addEventListener('click', () => this.togglePlay());
    this.video.addEventListener('dblclick', () => this.toggleFullscreen());

    // 进度条
    const seek = document.getElementById('playerSeek');
    if (seek) {
      seek.addEventListener('mousedown', (e) => {
        this.isSeeking = true;
        const rect = seek.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        if (this.video.duration) this.video.currentTime = pct * this.video.duration;
        const onMove = (e2) => {
          const rect2 = seek.getBoundingClientRect();
          const pct2 = Math.max(0, Math.min(1, (e2.clientX - rect2.left) / rect2.width));
          if (this.video.duration) this.video.currentTime = pct2 * this.video.duration;
        };
        const onUp = () => {
          this.isSeeking = false;
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
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
    document.getElementById('btnRew')?.addEventListener('click', () => { this.video.currentTime = Math.max(0, this.video.currentTime - 10); });
    document.getElementById('btnFwd')?.addEventListener('click', () => { this.video.currentTime = Math.min(this.video.duration || 0, this.video.currentTime + 10); });

    // 下一集
    document.getElementById('btnNextEp')?.addEventListener('click', () => {
      if (this.sessionData?.next_episode && typeof App !== 'undefined') {
        const next = this.sessionData.next_episode;
        this.close();
        App.startPlayback({
          media_item_id: next.media_item_id || next.id,
          title: next.title,
          seasonNumber: next.season_number,
          episodeNumber: next.episode_number,
        });
      }
    });

    // 音量
    document.getElementById('btnMute')?.addEventListener('click', () => this.toggleMute());
    const volSlider = document.getElementById('volumeSlider');
    if (volSlider) {
      volSlider.addEventListener('input', () => {
        this.video.volume = parseFloat(volSlider.value);
        this.video.muted = this.video.volume === 0;
        this.updateVolumeIcon();
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
    });
    this.video.addEventListener('progress', () => this.updateBuffer());
    this.video.addEventListener('play', () => {
      this.showIcon('pause');
      this.hideCenterBtn();
      this.autoHideControls();
    });
    this.video.addEventListener('pause', () => {
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
      const loading = document.getElementById('playerLoading');
      if (loading) loading.hidden = false;
    });
    this.video.addEventListener('playing', () => {
      this._everPlayed = true;
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

    // 键盘快捷键
    document.addEventListener('keydown', (e) => {
      if (document.getElementById('playerView')?.hidden) return;
      switch (e.key) {
        case ' ': case 'k': e.preventDefault(); this.togglePlay(); break;
        case 'ArrowLeft': e.preventDefault(); this.video.currentTime = Math.max(0, this.video.currentTime - 5); break;
        case 'ArrowRight': e.preventDefault(); this.video.currentTime = Math.min(this.video.duration || 0, this.video.currentTime + 5); break;
        case 'ArrowUp': e.preventDefault(); this.video.volume = Math.min(1, this.video.volume + 0.1); this.updateVolumeIcon(); break;
        case 'ArrowDown': e.preventDefault(); this.video.volume = Math.max(0, this.video.volume - 0.1); this.updateVolumeIcon(); break;
        case 'm': this.toggleMute(); break;
        case 'f': this.toggleFullscreen(); break;
        case 'Escape': if (!document.fullscreenElement) this.close(); break;
      }
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

  renderSettingsTab(tabName) {
    const content = document.getElementById('playerSettingsContent');
    if (!content) return;

    const session = this.sessionData;
    const decision = session?.decision || {};

    if (tabName === 'subtitles') {
      const subs = decision.subtitles || [];
      const currentOffset = this.subtitleOffset || 0;
      let html = `
        <div class="player-settings-item" data-sub-index="-1" onclick="Player.selectSubtitle(-1)">
          <span class="item-label">关闭字幕</span>
          <svg class="item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 12 11 14 15 10"/></svg>
        </div>
      `;
      html += subs.map((sub, i) => {
        const label = sub.title || sub.language || `字幕 ${i + 1}`;
        const badges = [];
        if (sub.is_ai) badges.push('AI');
        if (sub.is_forced) badges.push('强制');
        if (sub.kind === 'ass') badges.push('ASS');
        else if (sub.kind === 'pgs') badges.push('PGS');
        return `
          <div class="player-settings-item" data-sub-index="${i}" onclick="Player.selectSubtitle(${i})">
            <span class="item-label">${label}</span>
            <span class="item-info">${badges.join(' · ')}</span>
            <svg class="item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 12 11 14 15 10"/></svg>
          </div>
        `;
      }).join('');
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
      if (!subs.length) html = '<div style="padding:20px;text-align:center;color:rgba(255,255,255,0.4);font-size:13px">无可用字幕</div>' + html.substring(html.indexOf('<div class="player-settings-item" style="cursor:default">'));
      content.innerHTML = html;
    }

    else if (tabName === 'audio') {
      const tracks = decision.audio_tracks || [];
      const currentRef = decision.audio?.track_ref;
      let html = tracks.map(t => {
        const label = t.language || `音轨 ${t.ref}`;
        const info = [t.codec, t.channels ? t.channels + 'ch' : ''].filter(Boolean).join(' · ');
        return `
          <div class="player-settings-item ${t.ref === currentRef ? 'active' : ''}" onclick="Player.selectAudio('${t.ref}')">
            <span class="item-label">${label}${t.is_default ? ' (默认)' : ''}</span>
            <span class="item-info">${info}</span>
            <svg class="item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 12 11 14 15 10"/></svg>
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
    document.querySelectorAll('#playerSettingsContent .player-settings-item').forEach(el => {
      el.classList.toggle('active', parseInt(el.dataset.subIndex) === index);
    });
  },

  subtitleOffset: 0, // 字幕延迟（秒）

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

  selectQuality(maxHeight) {
    this.currentQuality = maxHeight;
    // 如果 session data 存在，重新请求播放会话
    if (this.sessionData?.media_item_id && typeof App !== 'undefined') {
      const currentTime = this.video ? this.video.currentTime : 0;
      this.video?.pause();
      const loading = document.getElementById('playerLoading');
      const loadingText = document.getElementById('playerLoadingText');
      if (loading) loading.hidden = false;
      if (loadingText) loadingText.textContent = '正在切换画质...';

      // 重新协商 session (带 max_height)
      const mediaId = this.sessionData.media_item_id;
      API.request('/playback/sessions', {
        method: 'POST',
        body: {
          media_item_id: mediaId,
          capability: {
            universal: true,
            hdr_passthrough: maxHeight === 0,
            containers: ['mp4', 'hls-fmp4'],
            video: maxHeight > 0 ? [{ max_height: maxHeight }] : [],
            audio: [],
            mse: 'managed',
            is_mobile: false,
            native_hls: true,
          },
          client: 'web',
          start_ms: Math.floor(currentTime * 1000),
          attempt_id: Date.now().toString(36) + Math.random().toString(36).slice(2),
        },
      }).then(resp => {
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
      }).catch(e => {
        console.error('Quality switch failed:', e);
        if (loadingText) loadingText.textContent = '切换画质失败: ' + (e.message || e);
        setTimeout(() => { if (loading) loading.hidden = true; }, 2000);
      });
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

    // 显示/隐藏"下一集"按钮
    const nextBtn = document.getElementById('btnNextEp');
    if (nextBtn) {
      nextBtn.style.display = sessionData?.next_episode ? '' : 'none';
    }

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

    // JASSUB: 初始化 ASS 字幕渲染（如果有 ASS 类型字幕）
    this.initJassub(subtitles, sessionData);

    this.showControls();
    this.autoHideControls();
  },

  // 关闭播放器
  close() {
    // 作废仍在途的 startPlayback：否则请求回来晚一步会把新界面覆盖成旧影片
    if (typeof App !== 'undefined') App._playbackSeq = (App._playbackSeq || 0) + 1;
    // 上报最终进度
    this.reportPlaybackStop();
    this.stopProgressReporting();
    this.stopSessionPing();
    clearTimeout(this._stuckTimer);
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

  togglePlay() {
    if (!this.video) return;
    if (this.video.paused) this.video.play().catch(() => {});
    else this.video.pause();
  },

  toggleMute() {
    if (!this.video) return;
    this.video.muted = !this.video.muted;
    this.updateVolumeIcon();
    const slider = document.getElementById('volumeSlider');
    if (slider) slider.value = this.video.muted ? 0 : this.video.volume;
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
    if (this.video && !this.video.paused) {
      this.hideTimer = setTimeout(() => {
        this.hideControls();
        this.hideCenterBtn();
      }, 3000);
    }
  },

  updateProgress() {
    if (!this.video || this.isSeeking) return;
    const cur = this.video.currentTime || 0;
    const dur = this.video.duration || 0;
    const pct = dur ? (cur / dur) * 100 : 0;

    const fill = document.getElementById('playerSeekFill');
    const thumb = document.getElementById('playerSeekThumb');
    if (fill) fill.style.width = pct + '%';
    if (thumb) thumb.style.left = pct + '%';

    const timeEl = document.getElementById('playerTime');
    if (timeEl) timeEl.textContent = this.formatTime(cur) + ' / ' + this.formatTime(dur);
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
    const isMuted = !this.video || this.video.muted || this.video.volume === 0;
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
    if (this.video && this.mediaItemId) {
      const posMs = Math.floor(this.video.currentTime * 1000);
      const durMs = Math.floor((this.video.duration || 0) * 1000);
      API.reportProgress(this.mediaItemId, 'start', posMs, durMs, this.seasonNumber, this.episodeNumber).catch(() => {});
      this.lastProgressReport = Date.now();
    }
    this.progressTimer = setInterval(() => {
      if (!this.video || !this.mediaItemId) return;
      const now = Date.now();
      if (now - this.lastProgressReport < 10000) return;
      this.lastProgressReport = now;
      const posMs = Math.floor(this.video.currentTime * 1000);
      const durMs = Math.floor((this.video.duration || 0) * 1000);
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
    if (!this.video || !this.mediaItemId) return;
    const posMs = Math.floor(this.video.currentTime * 1000);
    const durMs = Math.floor((this.video.duration || 0) * 1000);
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
    if (!this.video || !this.mediaItemId) return;
    const posMs = Math.floor(this.video.currentTime * 1000);
    const durMs = Math.floor((this.video.duration || 0) * 1000);
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
