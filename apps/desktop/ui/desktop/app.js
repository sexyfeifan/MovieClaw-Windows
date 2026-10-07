// MovieClaw Desktop — Main application

const App = {
  currentPage: 'home',
  libraries: [],
  collections: [],

  async init() {
    await API.init();

    // 检查登录状态
    try {
      const session = await API.getSession();
      console.log('Session:', session);
      // 已登录
    } catch (e) {
      console.log('Not logged in:', e);
      this.renderLogin();
      return;
    }

    this.bindEvents();
    await this.loadSidebarData();
    this.navigate('home');
  },

  // ===== 登录 =====
  renderLogin() {
    const content = document.getElementById('content');
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.style.display = 'none';

    content.innerHTML = `
      <div class="login-page">
        <div class="login-card">
          <div class="login-logo">MovieClaw</div>
          <div class="login-subtitle">登录到服务器</div>
          <form id="loginForm">
            <div class="login-field">
              <label for="loginUser">用户名</label>
              <input type="text" id="loginUser" placeholder="输入用户名" autocomplete="username" required>
            </div>
            <div class="login-field">
              <label for="loginPass">密码</label>
              <input type="password" id="loginPass" placeholder="输入密码" autocomplete="current-password" required>
            </div>
            <button type="submit" class="login-btn" id="loginBtn">登录</button>
            <div class="login-error" id="loginError"></div>
          </form>
        </div>
      </div>
    `;

    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('loginBtn');
      const err = document.getElementById('loginError');
      btn.disabled = true;
      btn.textContent = '正在登录...';
      err.textContent = '';

      try {
        const user = document.getElementById('loginUser').value.trim();
        const pass = document.getElementById('loginPass').value;
        await API.login(user, pass);
        // 登录成功，重新加载
        sidebar.style.display = '';
        this.bindEvents();
        await this.loadSidebarData();
        this.navigate('home');
      } catch (ex) {
        err.textContent = ex.message || '登录失败';
        btn.disabled = false;
        btn.textContent = '登录';
      }
    });
  },

  bindEvents() {
    // 侧栏导航
    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const page = item.dataset.page;
        this.navigate(page);
      });
    });

    // 搜索
    const searchInput = document.getElementById('searchInput');
    let searchTimer;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        const q = searchInput.value.trim();
        if (q) this.navigate('search', { query: q });
        else if (this.currentPage === 'search') this.navigate('home');
      }, 300);
    });

    // 窗口控制
    document.getElementById('btnMinimize')?.addEventListener('click', () => {
      if (window.__TAURI__) window.__TAURI__.window.getCurrentWindow().minimize();
    });
    document.getElementById('btnMaximize')?.addEventListener('click', () => {
      if (window.__TAURI__) window.__TAURI__.window.getCurrentWindow().toggleMaximize();
    });
    document.getElementById('btnClose')?.addEventListener('click', () => {
      if (window.__TAURI__) window.__TAURI__.window.getCurrentWindow().close();
    });
  },

  async loadSidebarData() {
    try {
      const [libs, colls] = await Promise.all([
        API.listLibraries().catch(e => { console.error('Load libraries failed:', e); return []; }),
        API.listCollections().catch(e => { console.error('Load collections failed:', e); return []; }),
      ]);
      // API 可能返回 { data: [...] } 包装
      this.libraries = libs?.data || libs || [];
      this.collections = colls?.data || colls || [];
      console.log('Libraries:', this.libraries.length, 'Collections:', this.collections.length);
      this.renderSidebar();
    } catch (e) {
      console.error('Failed to load sidebar:', e);
    }
  },

  renderSidebar() {
    const libNav = document.getElementById('libraryNav');
    libNav.innerHTML = this.libraries.map(lib => `
      <a class="nav-item" data-library-id="${lib.id}" href="#">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          ${lib.kind === 'tv' ? '<rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/>' : '<rect x="2" y="2" width="20" height="20" rx="2"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/>'}
        </svg>
        <span>${lib.name}</span>
        ${lib.itemCount ? `<span class="badge">${lib.itemCount}</span>` : ''}
      </a>
    `).join('');

    libNav.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const id = parseInt(item.dataset.libraryId);
        this.navigate('library', { libraryId: id });
      });
    });

    const colNav = document.getElementById('collectionNav');
    colNav.innerHTML = this.collections.slice(0, 10).map(col => `
      <a class="nav-item" data-collection-id="${col.id}" href="#">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
        <span>${col.name}</span>
      </a>
    `).join('');

    colNav.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const id = parseInt(item.dataset.collectionId);
        this.navigate('collection', { collectionId: id });
      });
    });
  },

  setActiveNav(page, libraryId) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    if (libraryId) {
      document.querySelector(`[data-library-id="${libraryId}"]`)?.classList.add('active');
    } else if (page === 'collection') {
      // collection items handled separately
    } else {
      document.querySelector(`[data-page="${page}"]`)?.classList.add('active');
    }
  },

  async navigate(page, params = {}) {
    this.currentPage = page;
    this.setActiveNav(page, params.libraryId);
    const content = document.getElementById('content');

    switch (page) {
      case 'home':
        await this.renderHome(content);
        break;
      case 'library':
        await this.renderLibrary(content, params.libraryId);
        break;
      case 'collection':
        await this.renderCollection(content, params.collectionId);
        break;
      case 'favorites':
        await this.renderFavorites(content);
        break;
      case 'search':
        await this.renderSearch(content, params.query);
        break;
      case 'settings':
        this.renderSettings(content);
        break;
      case 'detail':
        await this.renderDetail(content, params);
        break;
    }
  },

  // ===== 首页 =====
  async renderHome(container) {
    container.innerHTML = '<div class="page-loading"><div class="spinner"></div></div>';
    try {
      if (!this.libraries.length) {
        container.innerHTML = '<div class="page-loading"><div style="color:var(--text-secondary)">暂无媒体库，请先在服务器添加</div></div>';
        return;
      }

      // 并行加载多个横排数据
      const shelves = await Promise.all([
        API.listLibraryItems(this.libraries[0]?.id, { limit: 12, sort: 'added_at', order: 'desc' }).catch(e => { console.error(e); return []; }),
        API.listLibraryItems(this.libraries[0]?.id, { limit: 12, sort: 'rating', order: 'desc' }).catch(e => { console.error(e); return []; }),
        API.listLibraryItems(this.libraries[0]?.id, { limit: 12, sort: 'release_date', order: 'desc' }).catch(e => { console.error(e); return []; }),
      ]);

      const unwrap = (r) => r?.data || r?.items || r || [];

      const shelfData = [
        { title: '最近添加', items: unwrap(shelves[0]) },
        { title: '高分精选', items: unwrap(shelves[1]) },
        { title: '最新上映', items: unwrap(shelves[2]) },
      ].filter(s => s.items && s.items.length > 0);

      if (shelfData.length === 0) {
        container.innerHTML = '<div class="page-loading"><div style="color:var(--text-secondary)">暂无内容</div></div>';
        return;
      }

      container.innerHTML = shelfData.map(shelf => `
        <div class="shelf-section">
          <div class="shelf-header">
            <h2 class="shelf-title">${shelf.title}</h2>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary)"><polyline points="9 18 15 12 9 6"/></svg>
          </div>
          <div class="shelf-row">
            ${shelf.items.map(item => this.posterCard(item)).join('')}
          </div>
        </div>
      `).join('');

      this.bindPosterCards(container);
    } catch (e) {
      console.error('Render home error:', e);
      container.innerHTML = `<div class="page-loading"><div style="color:var(--text-secondary)">加载失败: ${e.message || e}</div></div>`;
    }
  },

  // ===== 媒体库 =====
  async renderLibrary(container, libraryId) {
    container.innerHTML = '<div class="page-loading"><div class="spinner"></div></div>';
    try {
      const lib = this.libraries.find(l => l.id === libraryId || l.id == libraryId);
      const resp = await API.listLibraryItems(libraryId, { limit: 60 });
      const items = resp?.data || resp?.items || resp || [];
      this.renderPosterWall(container, items, {
        title: lib?.name || '媒体库',
        subtitle: `${items.length} 个项目`,
      });
    } catch (e) {
      console.error('Render library error:', e);
      container.innerHTML = `<div class="page-loading"><div style="color:var(--text-secondary)">加载失败: ${e.message || e}</div></div>`;
    }
  },

  // ===== 合集 =====
  async renderCollection(container, collectionId) {
    container.innerHTML = '<div class="page-loading"><div class="spinner"></div></div>';
    try {
      const resp = await API.listCollectionItems(collectionId);
      const items = resp?.data || resp?.items || resp || [];
      this.renderPosterWall(container, items, {
        title: '合集',
        subtitle: `${items.length} 个项目`,
      });
    } catch (e) {
      console.error('Render collection error:', e);
      container.innerHTML = `<div class="page-loading"><div style="color:var(--text-secondary)">加载失败: ${e.message || e}</div></div>`;
    }
  },

  // ===== 收藏 =====
  async renderFavorites(container) {
    container.innerHTML = '<div class="page-loading"><div class="spinner"></div></div>';
    try {
      const resp = await API.listLibraryItems(this.libraries[0]?.id, { favorites: true, limit: 60 }).catch(() => []);
      const items = resp?.data || resp?.items || resp || [];
      this.renderPosterWall(container, items, {
        title: '我的收藏',
        subtitle: `${items.length} 个项目`,
      });
    } catch (e) {
      container.innerHTML = `<div class="page-loading"><div style="color:var(--text-secondary)">加载失败: ${e.message || e}</div></div>`;
    }
  },

  // ===== 搜索 =====
  async renderSearch(container, query) {
    container.innerHTML = '<div class="page-loading"><div class="spinner"></div></div>';
    try {
      const results = await API.search(query);
      this.renderPosterWall(container, results?.items || results || [], {
        title: `"${query}" 的搜索结果`,
        subtitle: `${(results?.items || results || []).length} 个结果`,
      });
    } catch (e) {
      container.innerHTML = '<div class="page-loading"><div style="color:var(--text-secondary)">搜索失败</div></div>';
    }
  },

  // ===== 详情页 =====
  async renderDetail(container, params) {
    container.innerHTML = '<div class="page-loading"><div class="spinner"></div></div>';
    try {
      const item = await API.getItemDetail(params.libraryId, params.itemId);
      container.innerHTML = `
        <div class="detail-hero">
          <div class="detail-hero-bg">
            <img src="${item.backdropUrl || item.posterUrl || ''}" alt="">
          </div>
          <div class="detail-hero-info">
            <h1 class="detail-title">${item.title}</h1>
            <div class="detail-meta">
              ${item.year ? `<span>${item.year}</span>` : ''}
              ${item.genres?.length ? `<span>${item.genres.slice(0, 3).join(' / ')}</span>` : ''}
              ${item.runtime ? `<span>${item.runtime} 分钟</span>` : ''}
            </div>
            <div class="detail-actions">
              <button class="btn-play" id="btnPlay">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                <span>${item.watched ? '继续播放' : '播放'}</span>
              </button>
              <button class="btn-secondary">详情</button>
            </div>
          </div>
        </div>
        <div class="detail-body">
          ${item.overview ? `<p class="detail-overview">${item.overview}</p>` : ''}
          ${item.episodes?.length ? `
            <div class="detail-section">
              <h3>剧集</h3>
              <div class="episode-grid">
                ${item.episodes.map(ep => `
                  <div class="episode-card" data-episode-id="${ep.id}">
                    <div class="episode-art">
                      <img src="${ep.thumbUrl || ''}" alt="">
                      <div class="episode-num">${ep.episodeNumber}</div>
                    </div>
                    <div class="episode-info">
                      <div class="episode-title">${ep.title}</div>
                      <div class="episode-subtitle">${ep.runtime ? ep.runtime + ' 分钟' : ''}</div>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}
        </div>
      `;

      document.getElementById('btnPlay')?.addEventListener('click', () => {
        this.startPlayback(item);
      });

      container.querySelectorAll('.episode-card').forEach(card => {
        card.addEventListener('click', () => {
          const epId = card.dataset.episodeId;
          const ep = item.episodes?.find(e => e.id == epId);
          if (ep) this.startPlayback({ ...ep, title: item.title + ' - ' + ep.title });
        });
      });
    } catch (e) {
      container.innerHTML = '<div class="page-loading"><div style="color:var(--text-secondary)">加载失败</div></div>';
    }
  },

  // ===== 海报墙渲染 =====
  renderPosterWall(container, items, { title, subtitle }) {
    container.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">${title}</h1>
        <span class="page-subtitle">${subtitle}</span>
      </div>
      <div class="poster-wall">
        <div class="poster-grid">
          ${items.map(item => this.posterCard(item)).join('')}
        </div>
      </div>
    `;
    this.bindPosterCards(container);
  },

  posterCard(item) {
    const progress = item.watchProgress || item.progress || 0;
    const itemId = item.id || item.media_item_id || item.mediaItemId || '';
    const libId = item.libraryId || item.library_id || '';
    const title = item.title || item.name || '未知';
    const posterUrl = item.posterUrl || item.poster_url || item.thumbUrl || item.thumb_url || '';
    const year = item.year || '';
    return `
      <div class="poster-card" data-item-id="${itemId}" data-library-id="${libId}">
        <div class="poster-art">
          <img src="${posterUrl}" alt="${title}" loading="lazy">
          <div class="play-overlay">
            <div class="play-btn">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </div>
          </div>
          ${progress > 0 && progress < 1 ? `
            <div class="poster-progress">
              <div class="poster-progress-fill" style="width:${Math.round(progress * 100)}%"></div>
            </div>
          ` : ''}
        </div>
        <div class="poster-info">
          <div class="poster-title">${title}</div>
          <div class="poster-subtitle">${year}${item.seasons ? ' · ' + item.seasons + ' 季' : ''}</div>
        </div>
      </div>
    `;
  },

  bindPosterCards(container) {
    container.querySelectorAll('.poster-card').forEach(card => {
      card.addEventListener('click', () => {
        const itemId = card.dataset.itemId;
        const libId = card.dataset.libraryId;
        if (itemId) {
          this.navigate('detail', { libraryId: libId || this.libraries[0]?.id, itemId });
        }
      });
    });
  },

  // ===== 设置 =====
  renderSettings(container) {
    container.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">设置</h1>
      </div>
      <div class="settings-body">
        <div class="settings-card">
          <h3>关于</h3>
          <p>MovieClaw Desktop</p>
          <p style="color:var(--text-secondary);margin-top:4px;">版本 0.1.1</p>
        </div>
      </div>
    `;
  },

  // ===== 播放 =====
  async startPlayback(item) {
    const overlay = document.getElementById('playerOverlay');
    const statusEl = overlay.querySelector('.player-overlay-status');
    const title = document.getElementById('playerTitle');
    title.textContent = item.title || '正在播放...';
    statusEl.textContent = '正在准备播放...';
    overlay.hidden = false;

    // 20 秒超时兜底
    const timeout = setTimeout(() => {
      statusEl.textContent = '播放超时，请检查服务器连接';
      setTimeout(() => { overlay.hidden = true; }, 3000);
    }, 20000);

    try {
      // 0. 检查 API 状态
      statusEl.textContent = '正在检查 API 状态...';
      if (!API.baseUrl) {
        throw new Error('未配置服务器地址，请重新连接');
      }
      console.log('API base URL:', API.baseUrl);
      console.log('Tauri available:', !!window.__TAURI__);
      console.log('Tauri http available:', !!window.__TAURI__?.http?.fetch);

      // 1. 创建播放会话
      statusEl.textContent = '正在获取播放链接...';
      const mediaId = item.id || item.mediaItemId;
      if (!mediaId) {
        throw new Error('无效的媒体项 ID');
      }
      console.log('Media item ID:', mediaId);

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
          native_hls: false,
        },
        client: 'web',
        attempt_id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      };
      if (item.seasonNumber != null) body.season_number = item.seasonNumber;
      if (item.episodeNumber != null) body.episode_number = item.episodeNumber;

      console.log('Playback request body:', JSON.stringify(body));
      const sessionResp = await API.request('/playback/sessions', {
        method: 'POST',
        body,
      });
      console.log('Playback response:', sessionResp);

      const session = sessionResp?.data || sessionResp;

      // 2. 检查决策
      if (session?.decision && session.decision.outcome !== 'plan') {
        throw new Error('播放不可用: ' + (session.decision.reason || session.decision.outcome));
      }

      if (!session?.stream_url) {
        throw new Error('服务器未返回播放地址 (stream_url)');
      }

      // 3. 处理流地址
      const origin = API.baseUrl;
      const streamUrl = session.stream_url.startsWith('http')
        ? session.stream_url
        : origin + session.stream_url;
      console.log('Stream URL:', streamUrl);

      const subtitleUrls = (session.subtitle_urls || []).map(s =>
        s.startsWith('http') ? s : origin + s
      );

      // 4. 启动 mpv
      statusEl.textContent = '正在启动播放器...';
      const isSessionTimeline = session.session_id && session.timeline === 'session';
      const mpvStartMs = isSessionTimeline ? null : (session.start_ms > 0 ? session.start_ms : null);

      if (!window.__TAURI__) {
        throw new Error('Tauri API 不可用');
      }

      const result = await window.__TAURI__.core.invoke('launch_player', {
        params: {
          stream_url: streamUrl,
          subtitle_urls: subtitleUrls.length > 0 ? subtitleUrls : null,
          start_ms: mpvStartMs,
          title: item.title || 'MovieClaw',
        },
      });
      console.log('Player launched:', result);
      statusEl.textContent = '播放器已启动';

    } catch (e) {
      console.error('Playback error:', e);
      const msg = e.message || String(e);
      statusEl.textContent = '播放失败: ' + msg;
      clearTimeout(timeout);
      // 显示详细错误 8 秒
      setTimeout(() => { overlay.hidden = true; }, 8000);
      return;
    }

    clearTimeout(timeout);
    setTimeout(() => { overlay.hidden = true; }, 1500);
  },
};

// 启动
document.addEventListener('DOMContentLoaded', () => App.init());
