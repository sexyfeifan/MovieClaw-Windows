// MovieClaw Desktop — 注入桥（initialization_script）
// 拦截 Next.js App Router 的 pushState 跳转到 /play/ 的导航，
// 通过 Tauri IPC 启动 mpv 播放器，并在 webview 侧做进度上报。
(function () {
  'use strict';

  // connect.html 不需要播放桥
  if (window.location.protocol === 'tauri:' || document.title.indexOf('连接') !== -1) {
    return;
  }

  var LOG = '[MovieClaw-Desktop]';

  function log() {
    var args = Array.prototype.slice.call(arguments);
    console.log.apply(console, [LOG].concat(args));
  }

  // Tauri invoke
  function invoke(cmd, args) {
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
      return window.__TAURI__.core.invoke(cmd, args);
    }
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
      return window.__TAURI_INTERNALS__.invoke(cmd, args);
    }
    return Promise.reject(new Error('Tauri API not available'));
  }

  // ---- 路由拦截 ----

  function isPlayPath(pathname) {
    return /^\/play\/[^/]+/.test(pathname);
  }

  function parsePlayUrl(urlStr) {
    try {
      var u = new URL(urlStr, window.location.origin);
      if (!isPlayPath(u.pathname)) return null;
      var parts = u.pathname.split('/').filter(Boolean);
      // parts: ['play', '127', 's01e03']
      var mediaItemId = parts[1];
      var unit = parts[2] || null;
      var tParam = u.searchParams.get('t');
      var startMs = tParam ? parseInt(tParam, 10) * 1000 : null;

      var seasonNumber = null, episodeNumber = null;
      if (unit) {
        var m = unit.match(/^s(\d+)e(\d+)$/i);
        if (m) {
          seasonNumber = parseInt(m[1], 10);
          episodeNumber = parseInt(m[2], 10);
        }
      }

      return { mediaItemId: parseInt(mediaItemId, 10), seasonNumber: seasonNumber, episodeNumber: episodeNumber, startMs: startMs, unit: unit };
    } catch (e) {
      return null;
    }
  }

  // 拦截 pushState（Next.js <Link> 走这里）
  var origPushState = history.pushState;
  history.pushState = function (state, title, url) {
    if (url) {
      var path = typeof url === 'string' ? url : url.toString();
      var parsed = parsePlayUrl(path);
      if (parsed) {
        log('拦截 pushState:', path, parsed);
        handlePlayRequest(parsed);
        return; // 吞掉跳转，用户留在当前页
      }
    }
    return origPushState.apply(this, arguments);
  };

  // 拦截 replaceState
  var origReplaceState = history.replaceState;
  history.replaceState = function (state, title, url) {
    if (url) {
      var path = typeof url === 'string' ? url : url.toString();
      var parsed = parsePlayUrl(path);
      if (parsed) {
        log('拦截 replaceState:', path, parsed);
        handlePlayRequest(parsed);
        return;
      }
    }
    return origReplaceState.apply(this, arguments);
  };

  // popstate（浏览器后退到播放页）
  window.addEventListener('popstate', function () {
    var parsed = parsePlayUrl(window.location.pathname + window.location.search);
    if (parsed) {
      log('拦截 popstate:', parsed);
      handlePlayRequest(parsed);
    }
  });

  // 拦截 <a> 标签点击（某些入口直接用 <a href="/play/...">）
  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== document) {
      if (el.tagName === 'A' && el.getAttribute('href')) {
        var parsed = parsePlayUrl(el.getAttribute('href'));
        if (parsed) {
          e.preventDefault();
          e.stopPropagation();
          log('拦截 <a> 点击:', el.getAttribute('href'), parsed);
          handlePlayRequest(parsed);
          return;
        }
      }
      el = el.parentElement;
    }
  }, true);

  // ---- 播放请求处理 ----

  function uuid() {
    return (crypto.randomUUID) ? crypto.randomUUID() :
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
  }

  // ---- 设备标识 ----

  function getDeviceId() {
    var id = localStorage.getItem('movieclaw_device_id');
    if (!id) {
      id = 'desktop-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem('movieclaw_device_id', id);
    }
    return id;
  }

  // ---- 播放器状态（由 Rust 侧 player_state 事件更新）----

  var playerState = { timePos: 0, duration: 0, paused: false, volume: 100, mute: false };
  window.__MOVIECLAW_PLAYER_STATE__ = playerState; // 调试用
  var listenersSetup = false;

  function getPositionMs() {
    var s = window.__MOVIECLAW_SESSION__;
    if (!s) return Math.floor(playerState.timePos * 1000);
    // session 时间轴（旧式 HLS 转码）：time-pos 是会话内偏移，需加 start_ms
    if (s.sessionId && s.timeline === 'session') {
      return (s.startMs || 0) + Math.floor(playerState.timePos * 1000);
    }
    // 直接播放 / 文件时间轴：time-pos 即文件时间
    return Math.floor(playerState.timePos * 1000);
  }

  // ---- 进度上报 ----

  var progressTimer = null;
  var pingTimer = null;

  function reportProgress(event) {
    var s = window.__MOVIECLAW_SESSION__;
    if (!s) return Promise.resolve();

    return fetch('/api/v1/playback/progress', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_item_id: s.mediaItemId,
        season_number: s.seasonNumber || 0,
        episode_number: s.episodeNumber || 0,
        event: event,
        position_ms: getPositionMs(),
        paused: playerState.paused,
        file_id: s.fileId || undefined,
        device_id: s.deviceId
      })
    }).then(function (resp) { return resp.json(); }).then(function (result) {
      var data = result.data || result;
      if (data && data.ended_by_admin) {
        log('管理员已结束播放');
        invoke('stop_player').catch(function () {});
      }
    }).catch(function (err) {
      log('进度上报失败:', err);
    });
  }

  function pingSession() {
    var s = window.__MOVIECLAW_SESSION__;
    if (!s || !s.sessionId) return;
    fetch('/api/v1/playback/sessions/' + s.sessionId + '/ping', {
      method: 'POST',
      credentials: 'include'
    }).catch(function () {});
  }

  function endTranscodeSession() {
    var s = window.__MOVIECLAW_SESSION__;
    if (!s || !s.sessionId) return;
    fetch('/api/v1/playback/sessions/' + s.sessionId, {
      method: 'DELETE',
      credentials: 'include'
    }).catch(function () {});
  }

  // ---- 播放器事件监听（Tauri event）----

  function setupPlayerListeners() {
    if (listenersSetup) return;
    if (!window.__TAURI__ || !window.__TAURI__.event) return;
    listenersSetup = true;

    window.__TAURI__.event.listen('player_state', function (e) {
      playerState.timePos = e.payload.time_pos || 0;
      playerState.duration = e.payload.duration || 0;
      playerState.paused = !!e.payload.paused;
      if (e.payload.volume !== undefined) playerState.volume = e.payload.volume;
      if (e.payload.mute !== undefined) playerState.mute = !!e.payload.mute;
      updateVolumeUI();
    });

    window.__TAURI__.event.listen('player_exited', function (e) {
      var s = window.__MOVIECLAW_SESSION__;
      if (!s || e.payload.pid !== s.mpvPid) return;
      playerState.timePos = e.payload.final_time_pos || playerState.timePos;
      reportProgress('stop');
      endTranscodeSession();
      stopProgressLoop();
      hideVolumeWidget();
      window.__MOVIECLAW_SESSION__ = null;
      log('播放结束, 最终位置:', playerState.timePos);
    });
  }

  function startProgressLoop() {
    stopProgressLoop();
    // 立即上报 start
    reportProgress('start');
    // 每 10s 上报 progress
    progressTimer = setInterval(function () { reportProgress('progress'); }, 10000);
    // 每 30s ping 会话（仅转码会话）
    pingTimer = setInterval(pingSession, 30000);
  }

  function stopProgressLoop() {
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  // ---- 音量控制 UI（Shadow DOM 隔离，不被网页遮挡）----

  var volumeHost = null;
  var volumeShadow = null;

  function ensureVolumeWidget() {
    if (volumeHost && volumeHost.isConnected) return;

    // 宿主元素：固定在视口最上层
    volumeHost = document.createElement('div');
    volumeHost.id = '__mc_vol_host__';
    volumeHost.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(volumeHost);

    // Shadow DOM 完全隔离页面 CSS
    volumeShadow = volumeHost.attachShadow({ mode: 'open' });

    volumeShadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .widget {
          pointer-events: auto;
          display: flex;
          align-items: center;
          gap: 6px;
          background: rgba(15, 17, 23, 0.88);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 12px;
          padding: 10px 14px;
          font-family: 'Segoe UI', system-ui, sans-serif;
          color: #e8e8e8;
          user-select: none;
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          box-shadow: 0 4px 24px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05);
          transition: opacity 0.3s, transform 0.3s;
        }
        .widget.hidden {
          opacity: 0;
          transform: translateY(8px);
          pointer-events: none;
        }
        .btn {
          width: 34px; height: 34px;
          border: none; border-radius: 8px;
          cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          font-size: 15px;
          background: rgba(255,255,255,0.08);
          color: #e8e8e8;
          transition: background 0.15s, transform 0.1s;
        }
        .btn:hover { background: rgba(255,255,255,0.18); }
        .btn:active { transform: scale(0.92); }
        .btn.active { background: rgba(248,113,113,0.5); }
        .slider {
          -webkit-appearance: none;
          width: 100px; height: 4px;
          border-radius: 2px;
          background: rgba(255,255,255,0.15);
          outline: none;
          cursor: pointer;
        }
        .slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 14px; height: 14px;
          border-radius: 50%;
          background: #fff;
          cursor: pointer;
          box-shadow: 0 1px 6px rgba(0,0,0,0.4);
        }
        .pct {
          font-size: 12px;
          min-width: 36px;
          text-align: center;
          opacity: 0.8;
          font-weight: 600;
          letter-spacing: 0.3px;
        }
      </style>
      <div class="widget hidden" id="w">
        <button class="btn mute" title="静音 (M)">🔊</button>
        <button class="btn down" title="音量减 (↓)">−</button>
        <input type="range" class="slider" min="0" max="130" value="100" step="1">
        <button class="btn up" title="音量加 (↑)">+</button>
        <span class="pct">100%</span>
      </div>`;

    // 绑定事件
    var w = volumeShadow.getElementById('w');
    volumeShadow.querySelector('.mute').addEventListener('click', toggleMute);
    volumeShadow.querySelector('.down').addEventListener('click', function () { adjustVolume(-5); });
    volumeShadow.querySelector('.up').addEventListener('click', function () { adjustVolume(5); });
    volumeShadow.querySelector('.slider').addEventListener('input', function () {
      setVolume(parseInt(this.value, 10));
    });
  }

  function showVolumeWidget() {
    ensureVolumeWidget();
    var w = volumeShadow.getElementById('w');
    if (w) w.classList.remove('hidden');
  }

  function hideVolumeWidget() {
    if (!volumeShadow) return;
    var w = volumeShadow.getElementById('w');
    if (w) w.classList.add('hidden');
  }

  function updateVolumeUI() {
    if (!volumeShadow) return;
    var mute = volumeShadow.querySelector('.mute');
    var slider = volumeShadow.querySelector('.slider');
    var pct = volumeShadow.querySelector('.pct');
    var vol = Math.round(playerState.volume);
    if (slider) slider.value = vol;
    if (pct) pct.textContent = vol + '%';
    if (mute) {
      mute.textContent = playerState.mute ? '🔇' : '🔊';
      mute.classList.toggle('active', playerState.mute);
    }
  }

  function setVolume(level) {
    level = Math.max(0, Math.min(130, level));
    invoke('send_mpv_command', { command: ['set_property', 'volume', level] }).catch(function () {});
  }

  function adjustVolume(delta) {
    setVolume(Math.round(playerState.volume) + delta);
  }

  function toggleMute() {
    invoke('send_mpv_command', { command: ['cycle', 'mute'] }).catch(function () {});
  }

  // 快捷键（播放时在 webview 中按 M / ↑↓ 控制音量）
  document.addEventListener('keydown', function (e) {
    if (!window.__MOVIECLAW_SESSION__) return;
    // 不拦截输入框
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        adjustVolume(5);
        break;
      case 'ArrowDown':
        e.preventDefault();
        adjustVolume(-5);
        break;
      case 'm': case 'M':
        e.preventDefault();
        toggleMute();
        break;
    }
  });

  // ---- 软件更新提示 ----

  function showUpdateBanner(info) {
    // 移除已有提示
    var old = document.getElementById('__mc_update_host__');
    if (old) old.remove();

    // Shadow DOM 宿主
    var host = document.createElement('div');
    host.id = '__mc_update_host__';
    host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(host);

    var shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .banner {
          pointer-events: auto;
          background: linear-gradient(135deg, #1a6b3c, #2d8f56);
          color: #fff;
          padding: 18px 22px;
          border-radius: 12px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.4);
          max-width: 360px;
          font-family: 'Segoe UI', system-ui, sans-serif;
          animation: slide-in 0.4s ease;
        }
        @keyframes slide-in {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        .title { font-size: 15px; font-weight: 600; margin-bottom: 8px; }
        .msg { font-size: 13px; opacity: 0.9; margin-bottom: 14px; line-height: 1.4; }
        .actions { display: flex; gap: 8px; }
        .btn-primary {
          flex: 1; padding: 8px 16px; border: none;
          border-radius: 8px;
          background: rgba(255,255,255,0.95);
          color: #1a6b3c;
          font-weight: 600; cursor: pointer; font-size: 13px;
        }
        .btn-ghost {
          padding: 8px 16px; border: none;
          border-radius: 8px;
          background: rgba(255,255,255,0.2);
          color: #fff;
          cursor: pointer; font-size: 13px;
        }
        .btn-ghost:hover { background: rgba(255,255,255,0.3); }
      </style>
      <div class="banner">
        <div class="title">🔄 发现新版本 ${info.version || ''}</div>
        <div class="msg">${info.message || ''}</div>
        <div class="actions">
          <button class="btn-primary" id="dl">立即更新</button>
          <button class="btn-ghost" id="dismiss">稍后</button>
        </div>
      </div>`;

    shadow.getElementById('dl').addEventListener('click', function () {
      invoke('open_download_page').catch(function () {});
      host.remove();
    });
    shadow.getElementById('dismiss').addEventListener('click', function () {
      host.remove();
    });

    // 10 秒后自动消失
    setTimeout(function () {
      if (host.parentNode) host.remove();
    }, 10000);
  }

  // 监听 Rust 侧更新事件
  function setupUpdateListeners() {
    if (!window.__TAURI__ || !window.__TAURI__.event) return;
    window.__TAURI__.event.listen('update_available', function (e) {
      log('发现新版本:', e.payload);
      showUpdateBanner(e.payload);
    });
    window.__TAURI__.event.listen('update_check_result', function (e) {
      log('更新检查:', e.payload.message);
      if (!e.payload.has_update) {
        // 轻量 toast 提示
        var toast = document.createElement('div');
        toast.textContent = e.payload.message;
        toast.style.cssText = 'position:fixed;bottom:80px;right:16px;z-index:99999;background:rgba(0,0,0,0.75);color:#fff;padding:10px 18px;border-radius:8px;font-family:system-ui;font-size:13px;backdrop-filter:blur(8px);';
        document.body.appendChild(toast);
        setTimeout(function () { toast.remove(); }, 3000);
      }
    });
  }
  setupUpdateListeners();

  // ---- 播放请求处理 ----

  var _lastPlayTs = 0;
  async function handlePlayRequest(parsed) {
    // 防止 pushState + replaceState 双重触发
    var now = Date.now();
    if (now - _lastPlayTs < 2000) {
      log('跳过重复播放请求');
      return;
    }
    _lastPlayTs = now;

    try {
      log('请求播放:', parsed);

      // 重置播放器状态
      playerState.timePos = 0;
      playerState.duration = 0;
      playerState.paused = false;

      // 清理上一次播放
      if (window.__MOVIECLAW_SESSION__) {
        reportProgress('stop');
        endTranscodeSession();
        stopProgressLoop();
        hideVolumeWidget();
        window.__MOVIECLAW_SESSION__ = null;
      }
      invoke('stop_player').catch(function () {});

      // 在 webview 侧 fetch（HttpOnly Cookie 自动带上）
      var body = {
        media_item_id: parsed.mediaItemId,
        capability: {
          universal: true,
          hdr_passthrough: true,
          containers: ['mp4', 'hls-fmp4'],
          video: [],
          audio: [],
          mse: 'none',
          is_mobile: false,
          native_hls: false
        },
        client: 'web',
        attempt_id: uuid()
      };
      if (parsed.seasonNumber != null) body.season_number = parsed.seasonNumber;
      if (parsed.episodeNumber != null) body.episode_number = parsed.episodeNumber;
      if (parsed.startMs != null) body.start_ms = parsed.startMs;

      var resp = await fetch('/api/v1/playback/sessions', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!resp.ok) {
        log('会话创建失败:', resp.status);
        return;
      }

      var result = await resp.json();
      var session = result.data || result;
      log('播放会话:', session);

      // 检查决策结果
      if (session.decision && session.decision.outcome !== 'plan') {
        log('播放不可用:', session.decision.outcome, session.decision.reason || '');
        return;
      }

      if (!session.stream_url) {
        log('无流地址');
        return;
      }

      // stream_url 是服务器根相对路径
      var streamUrl = session.stream_url.indexOf('http') === 0
        ? session.stream_url
        : window.location.origin + session.stream_url;

      var subtitleUrls = (session.subtitle_urls || []).map(function (s) {
        return s.indexOf('http') === 0 ? s : window.location.origin + s;
      });

      // 确定 mpv 起播位置
      // session 时间轴的 --start 应为 0（会话已从正确位置开始编码）
      // 直接播放 / 文件时间轴：--start = start_ms / 1000
      var isSessionTimeline = session.session_id && session.timeline === 'session';
      var mpvStartMs = isSessionTimeline ? null : (session.start_ms > 0 ? session.start_ms : null);

      // 设置事件监听（只需一次）
      setupPlayerListeners();

      // 启动 mpv
      var launchResult = await invoke('launch_player', {
        params: {
          stream_url: streamUrl,
          subtitle_urls: subtitleUrls.length ? subtitleUrls : null,
          start_ms: mpvStartMs,
          title: parsed.unit || String(parsed.mediaItemId || 'MovieClaw')
        }
      });
      log('mpv 启动:', launchResult);

      // 保存会话上下文供进度上报
      window.__MOVIECLAW_SESSION__ = {
        sessionId: session.session_id,
        mediaItemId: parsed.mediaItemId,
        seasonNumber: parsed.seasonNumber,
        episodeNumber: parsed.episodeNumber,
        fileId: session.decision ? session.decision.file_id : null,
        startMs: session.start_ms || 0,
        timeline: session.timeline || 'session',
        deviceId: getDeviceId(),
        mpvPid: launchResult.pid
      };

      // 启动进度上报循环
      startProgressLoop();

      // 显示音量控件
      showVolumeWidget();

    } catch (err) {
      log('播放异常:', err);
    }
  }

  log('注入桥已加载 — MovieClaw Desktop');
})();
