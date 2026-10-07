// MovieClaw Desktop — 自定义原生 UI 应用
(function () {
  'use strict';

  // ===== Tauri 桥 =====
  function invoke(cmd, args) {
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
      return window.__TAURI__.core.invoke(cmd, args);
    }
    return Promise.reject(new Error('Tauri API not available'));
  }

  // ===== 状态管理 =====
  const state = {
    serverUrl: '',
    auth: { token: '', username: '' },
    player: { active: false, timePos: 0, duration: 0, paused: false, volume: 100, mute: false },
    session: null,
    currentPage: 'library',
    history: []
  };

  // ===== 工具函数 =====
  function fmtTime(sec) {
    if (!sec || isNaN(sec)) return '00:00';
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  function $(id) { return document.getElementById(id); }

  function log(...args) { console.log('[MovieClaw]', ...args); }

  // ===== API 调用层 =====
  async function api(path, options = {}) {
    const base = state.serverUrl || '';
    const url = base + path;
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (state.auth.token) {
      headers['Authorization'] = `Bearer ${state.auth.token}`;
    }

    const resp = await fetch(url, {
      credentials: 'include',
      ...options,
      headers
    });

    if (resp.status === 401) {
      // token 过期，跳回登录
      state.auth.token = '';
      showLogin();
      throw new Error('未登录');
    }

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.message || `HTTP ${resp.status}`);
    return data.data || data;
  }

  // ===== 认证 =====
  async function login(username, password) {
    try {
      const data = await api('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      state.auth.token = data.token || data.access_token || '';
      state.auth.username = username;
      updateServerStatus(true);
      navigate('library');
      return true;
    } catch (e) {
      log('登录失败:', e);
      return false;
    }
  }

  function showLogin() {
    // 在设置页或弹窗中显示登录表单
    navigate('settings');
  }

  // ===== 媒体库加载 =====
  async function loadLibrary() {
    try {
      const data = await api('/api/v1/media?sort=recent&limit=20');
      renderMediaGrid('gridRecent', data.items || data.results || []);
    } catch (e) {
      log('加载媒体库失败:', e);
    }

    try {
      const data = await api('/api/v1/media?sort=continue&limit=20');
      renderMediaGrid('gridContinue', data.items || data.results || []);
    } catch (e) {
      log('加载继续观看失败:', e);
    }
  }

  async function loadMovies(filter) {
    try {
      const sort = filter === 'recent' ? 'recent' : filter === 'popular' ? 'popular' : 'all';
      const data = await api(`/api/v1/media?type=movie&sort=${sort}&limit=50`);
      renderMediaGrid('gridMovies', data.items || data.results || []);
    } catch (e) {
      log('加载电影失败:', e);
    }
  }

  async function loadSeries() {
    try {
      const data = await api('/api/v1/media?type=series&limit=50');
      renderMediaGrid('gridSeries', data.items || data.results || []);
    } catch (e) {
      log('加载剧集失败:', e);
    }
  }

  function renderMediaGrid(gridId, items) {
    const grid = $(gridId);
    if (!grid) return;

    if (!items || items.length === 0) {
      grid.innerHTML = '<div class="empty-grid">暂无内容</div>';
      return;
    }

    grid.innerHTML = items.map(item => {
      const poster = item.poster_url || item.poster || item.image || '';
      const title = item.title || item.name || '未知';
      const year = item.year || item.release_date || '';
      const type = item.media_type || item.type || '';
      const id = item.id || item.media_item_id;

      return `
        <div class="media-card" onclick="openDetail(${id})">
          <img class="media-poster" src="${poster}" alt="${title}"
               onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 200 300%22><rect fill=%22%231c1f2e%22 width=%22200%22 height=%22300%22/><text x=%22100%22 y=%22150%22 text-anchor=%22middle%22 fill=%22%235a5e72%22 font-size=%2240%22>🎬</text></svg>'">
          <div class="media-info">
            <div class="media-title">${title}</div>
            <div class="media-meta">${year} ${type ? '· ' + type : ''}</div>
          </div>
        </div>`;
    }).join('');
  }

  // ===== 详情页 =====
  async function openDetail(id) {
    try {
      const data = await api(`/api/v1/media/${id}`);
      renderDetail(data);
      navigate('detail');
    } catch (e) {
      log('加载详情失败:', e);
    }
  }

  function renderDetail(item) {
    const container = $('detailContainer');
    const poster = item.poster_url || item.poster || '';
    const title = item.title || item.name || '未知';
    const desc = item.description || item.overview || item.synopsis || '';
    const year = item.year || '';
    const rating = item.rating || item.vote_average || '';
    const runtime = item.runtime || item.duration || '';

    let episodesHtml = '';
    if (item.episodes && item.episodes.length > 0) {
      episodesHtml = `
        <div class="episode-list">
          <div class="section-title">剧集</div>
          ${item.episodes.map(ep => `
            <div class="episode-item" onclick="playMedia(${item.id}, ${ep.season_number || 1}, ${ep.episode_number})">
              <div class="episode-num">${ep.episode_number}</div>
              <div class="episode-info">
                <div class="episode-title">${ep.title || `第 ${ep.episode_number} 集`}</div>
                <div class="episode-desc">${ep.description || ''}</div>
              </div>
              <div class="episode-play">▶</div>
            </div>
          `).join('')}
        </div>`;
    }

    container.innerHTML = `
      <div class="detail-hero">
        <img class="detail-poster" src="${poster}" alt="${title}"
             onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 240 360%22><rect fill=%22%231c1f2e%22 width=%22240%22 height=%22360%22/></svg>'">
        <div class="detail-info">
          <div class="detail-title">${title}</div>
          <div class="detail-meta">
            ${year ? `<span>${year}</span>` : ''}
            ${rating ? `<span>⭐ ${rating}</span>` : ''}
            ${runtime ? `<span>${runtime} 分钟</span>` : ''}
          </div>
          <div class="detail-desc">${desc}</div>
          <div class="detail-actions">
            <button class="btn-primary" onclick="playMedia(${item.id}, 0, 0)">▶ 播放</button>
            <button class="btn-secondary" onclick="goBack()">← 返回</button>
          </div>
        </div>
      </div>
      ${episodesHtml}`;
  }

  // ===== 搜索 =====
  async function doSearch() {
    const q = $('searchInput').value.trim();
    if (!q) return;

    navigate('search');
    $('searchResults').innerHTML = '<div class="loading"><div class="spinner"></div></div>';

    try {
      const data = await api(`/api/v1/search?q=${encodeURIComponent(q)}`);
      const items = data.items || data.results || data || [];
      if (items.length === 0) {
        $('searchResults').innerHTML = '<div class="empty-state">没有找到相关内容</div>';
      } else {
        renderMediaGrid('searchResults', items);
      }
    } catch (e) {
      log('搜索失败:', e);
      $('searchResults').innerHTML = '<div class="empty-state">搜索失败，请稍后重试</div>';
    }
  }

  // ===== 播放 =====
  async function playMedia(mediaId, seasonNum, episodeNum) {
    try {
      log('请求播放:', mediaId, seasonNum, episodeNum);

      const body = {
        media_item_id: mediaId,
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
        client: 'desktop',
        attempt_id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now())
      };
      if (seasonNum) body.season_number = seasonNum;
      if (episodeNum) body.episode_number = episodeNum;

      const session = await api('/api/v1/playback/sessions', {
        method: 'POST',
        body: JSON.stringify(body)
      });

      if (session.decision && session.decision.outcome !== 'plan') {
        alert('播放不可用: ' + (session.decision.reason || session.decision.outcome));
        return;
      }

      const streamUrl = session.stream_url && session.stream_url.startsWith('http')
        ? session.stream_url
        : state.serverUrl + session.stream_url;

      const subtitleUrls = (session.subtitle_urls || []).map(s =>
        s.startsWith('http') ? s : state.serverUrl + s
      );

      // 启动 mpv
      const result = await invoke('launch_player', {
        params: {
          stream_url: streamUrl,
          subtitle_urls: subtitleUrls.length ? subtitleUrls : null,
          start_ms: session.start_ms > 0 ? session.start_ms : null,
          title: `S${seasonNum || 1}E${episodeNum || 1}`
        }
      });

      log('mpv 启动:', result);

      state.session = {
        sessionId: session.session_id,
        mediaItemId: mediaId,
        seasonNumber: seasonNum,
        episodeNumber: episodeNum,
        fileId: session.decision ? session.decision.file_id : null,
        startMs: session.start_ms || 0,
        timeline: session.timeline || 'session',
        mpvPid: result.pid
      };

      // 显示播放器浮层
      showPlayer(`S${seasonNum || 1}E${episodeNum || 1} - ${mediaId}`);

      // 打开控制面板
      invoke('open_controls_window').catch(() => {});

      // 启动进度上报
      startProgressLoop();

    } catch (e) {
      log('播放失败:', e);
      alert('播放失败: ' + e.message);
    }
  }

  // ===== 播放器浮层 =====
  function showPlayer(title) {
    $('playerTitle').textContent = title || '正在播放';
    $('playerOverlay').style.display = 'flex';
    state.player.active = true;
  }

  function closePlayer() {
    invoke('stop_player').catch(() => {});
    invoke('close_controls_window').catch(() => {});
    $('playerOverlay').style.display = 'none';
    state.player.active = false;
    stopProgressLoop();
  }

  function playerTogglePause() {
    invoke('send_mpv_command', { command: ['cycle', 'pause'] }).catch(() => {});
    state.player.paused = !state.player.paused;
    $('playerBtnPause').textContent = state.player.paused ? '▶' : '⏸';
    $('playerStatus').textContent = state.player.paused ? '已暂停' : '播放中...';
  }

  function playerSeekRel(secs) {
    invoke('send_mpv_command', { command: ['seek', secs, 'relative'] }).catch(() => {});
    state.player.timePos = Math.max(0, Math.min(state.player.duration, state.player.timePos + secs));
    updatePlayerUI();
  }

  function playerSeek(e) {
    const bar = e.currentTarget;
    const rect = bar.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const target = pct * state.player.duration;
    invoke('send_mpv_command', { command: ['seek', target, 'absolute'] }).catch(() => {});
    state.player.timePos = target;
    updatePlayerUI();
  }

  function playerSetVolume(val) {
    val = parseInt(val, 10);
    state.player.volume = val;
    $('playerVolPct').textContent = val + '%';
    invoke('send_mpv_command', { command: ['set_property', 'volume', val] }).catch(() => {});
  }

  function playerToggleMute() {
    invoke('send_mpv_command', { command: ['cycle', 'mute'] }).catch(() => {});
    state.player.mute = !state.player.mute;
    $('playerVolIcon').textContent = state.player.mute ? '🔇' : '🔊';
  }

  function updatePlayerUI() {
    const pct = state.player.duration > 0 ? (state.player.timePos / state.player.duration * 100) : 0;
    $('playerProgressFill').style.width = pct + '%';
    $('playerCurTime').textContent = fmtTime(state.player.timePos);
    $('playerTotalTime').textContent = fmtTime(state.player.duration);
  }

  // ===== 进度上报 =====
  let progressTimer = null;
  let pingTimer = null;

  function startProgressLoop() {
    stopProgressLoop();
    reportProgress('start');
    progressTimer = setInterval(() => reportProgress('progress'), 10000);
    pingTimer = setInterval(pingSession, 30000);
  }

  function stopProgressLoop() {
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  }

  async function reportProgress(event) {
    if (!state.session) return;
    try {
      await api('/api/v1/playback/progress', {
        method: 'POST',
        body: JSON.stringify({
          media_item_id: state.session.mediaItemId,
          season_number: state.session.seasonNumber || 0,
          episode_number: state.session.episodeNumber || 0,
          event: event,
          position_ms: Math.floor(state.player.timePos * 1000),
          paused: state.player.paused,
          file_id: state.session.fileId || undefined,
          device_id: 'desktop-' + (window.__MOVIECLAW_DEVICE_ID || 'default')
        })
      });
    } catch (e) {
      log('进度上报失败:', e);
    }
  }

  async function pingSession() {
    if (!state.session || !state.session.sessionId) return;
    try {
      await api(`/api/v1/playback/sessions/${state.session.sessionId}/ping`, { method: 'POST' });
    } catch (e) { /* ignore */ }
  }

  async function endSession() {
    if (!state.session || !state.session.sessionId) return;
    try {
      await api(`/api/v1/playback/sessions/${state.session.sessionId}`, { method: 'DELETE' });
    } catch (e) { /* ignore */ }
  }

  // ===== 导航 =====
  function navigate(page) {
    if (state.currentPage !== page) {
      state.history.push(state.currentPage);
    }
    state.currentPage = page;

    // 切换页面
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const pageEl = $(`page-${page}`);
    if (pageEl) pageEl.classList.add('active');

    // 高亮导航
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const navEl = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (navEl) navEl.classList.add('active');

    // 标题
    const titles = {
      library: '媒体库', movies: '电影', series: '剧集',
      search: '搜索', detail: '详情', settings: '设置'
    };
    $('pageTitle').textContent = titles[page] || page;

    // 返回按钮
    $('btnBack').style.display = page === 'detail' ? 'flex' : 'none';

    // 加载数据
    if (page === 'library') loadLibrary();
    if (page === 'movies') loadMovies('all');
    if (page === 'series') loadSeries();
  }

  function goBack() {
    const prev = state.history.pop() || 'library';
    state.currentPage = prev;
    navigate(prev);
  }

  // ===== 设置 =====
  async function loadSettings() {
    try {
      const url = await invoke('load_server_url');
      if (url) {
        state.serverUrl = url;
        $('settingServerUrl').value = url;
      }
    } catch (e) { /* ignore */ }
  }

  async function saveServerUrl() {
    const url = $('settingServerUrl').value.trim();
    if (!url) return;
    try {
      await invoke('save_server_url', { url });
      state.serverUrl = url;
      updateServerStatus(true);
    } catch (e) {
      log('保存失败:', e);
    }
  }

  async function testConnection() {
    const url = $('settingServerUrl').value.trim();
    $('settingConnStatus').textContent = '测试中...';
    try {
      const result = await invoke('probe_server', { url });
      $('settingConnStatus').textContent = result.message;
    } catch (e) {
      $('settingConnStatus').textContent = '连接失败';
    }
  }

  function updateServerStatus(connected) {
    const dot = document.querySelector('.status-dot');
    const text = document.querySelector('.status-text');
    if (connected) {
      dot.className = 'status-dot connected';
      text.textContent = '已连接';
    } else {
      dot.className = 'status-dot disconnected';
      text.textContent = '未连接';
    }
  }

  function filterMovies(filter, btn) {
    document.querySelectorAll('#page-movies .filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    loadMovies(filter);
  }

  function checkUpdate() {
    invoke('check_for_updates').then(info => {
      if (info.has_update) {
        showUpdateBanner(info);
      } else {
        alert(info.message);
      }
    }).catch(() => {});
  }

  function showUpdateBanner(info) {
    $('updateVersion').textContent = info.latest_version || '';
    $('updateMessage').textContent = info.message || '';
    $('updateBanner').style.display = 'block';
    $('updateBanner').dataset.downloadUrl = info.download_url || '';
  }

  function dismissUpdate() {
    $('updateBanner').style.display = 'none';
  }

  function openDownload() {
    invoke('open_download_page').catch(() => {});
    dismissUpdate();
  }

  // ===== Tauri 事件 =====
  function setupTauriEvents() {
    if (!window.__TAURI__ || !window.__TAURI__.event) return;

    window.__TAURI__.event.listen('player_state', (e) => {
      const p = e.payload;
      if (p.time_pos !== undefined) state.player.timePos = p.time_pos;
      if (p.duration !== undefined) state.player.duration = p.duration;
      if (p.paused !== undefined) state.player.paused = !!p.paused;
      if (p.volume !== undefined) state.player.volume = p.volume;
      if (p.mute !== undefined) state.player.mute = !!p.mute;
      updatePlayerUI();
      if (p.volume !== undefined) $('playerVolSlider').value = Math.round(p.volume);
      if (p.volume !== undefined) $('playerVolPct').textContent = Math.round(p.volume) + '%';
    });

    window.__TAURI__.event.listen('player_exited', () => {
      reportProgress('stop');
      endSession();
      stopProgressLoop();
      $('playerOverlay').style.display = 'none';
      state.player.active = false;
      state.session = null;
    });

    window.__TAURI__.event.listen('update_available', (e) => {
      showUpdateBanner(e.payload);
    });
  }

  // ===== 键盘快捷键 =====
  document.addEventListener('keydown', (e) => {
    if (!state.player.active) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    switch (e.key) {
      case ' ': e.preventDefault(); playerTogglePause(); break;
      case 'ArrowUp': e.preventDefault();
        state.player.volume = Math.min(130, state.player.volume + 5);
        playerSetVolume(state.player.volume); break;
      case 'ArrowDown': e.preventDefault();
        state.player.volume = Math.max(0, state.player.volume - 5);
        playerSetVolume(state.player.volume); break;
      case 'ArrowRight': e.preventDefault(); playerSeekRel(5); break;
      case 'ArrowLeft': e.preventDefault(); playerSeekRel(-5); break;
      case 'm': case 'M': e.preventDefault(); playerToggleMute(); break;
      case 'Escape': closePlayer(); break;
    }
  });

  // ===== 初始化 =====
  async function init() {
    log('MovieClaw Desktop UI 启动');

    // 生成设备 ID
    if (!window.__MOVIECLAW_DEVICE_ID) {
      window.__MOVIECLAW_DEVICE_ID = 'desktop-' + Date.now().toString(36) + '-' +
        Math.random().toString(36).slice(2, 8);
    }

    // 加载设置
    await loadSettings();

    // 尝试连接
    if (state.serverUrl) {
      try {
        await invoke('probe_server', { url: state.serverUrl });
        updateServerStatus(true);
      } catch (e) {
        updateServerStatus(false);
      }
    }

    // 设置 Tauri 事件
    setupTauriEvents();

    // 加载媒体库
    navigate('library');
  }

  // 暴露全局函数
  window.navigate = navigate;
  window.goBack = goBack;
  window.doSearch = doSearch;
  window.openDetail = openDetail;
  window.playMedia = playMedia;
  window.closePlayer = closePlayer;
  window.playerTogglePause = playerTogglePause;
  window.playerSeekRel = playerSeekRel;
  window.playerSeek = playerSeek;
  window.playerSetVolume = playerSetVolume;
  window.playerToggleMute = playerToggleMute;
  window.saveServerUrl = saveServerUrl;
  window.testConnection = testConnection;
  window.filterMovies = filterMovies;
  window.checkUpdate = checkUpdate;
  window.dismissUpdate = dismissUpdate;
  window.openDownload = openDownload;

  // 启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
