// MovieClaw Desktop — Main application

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// 修复图片 URL：相对路径拼接 {server}/api/v1，远程 URL 走服务器代理
function resolveUrl(url) {
  if (!url) return '';
  if (typeof url !== 'string') return '';
  if (url.startsWith('data:')) return /^data:image\/(png|jpeg|webp|gif);/i.test(url) ? url : '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:/i.test(url)) return '';
  const base = (window.__MOVIECLAW_SERVER__ || '').replace(/\/+$/, '');
  // 远程 TMDB 等图片走服务器缓存代理（和 Web 端一致）
  if (url.startsWith('http://') || url.startsWith('https://')) {
    if (!base) return url;
    return base + '/api/v1/images/proxy?url=' + encodeURIComponent(url);
  }
  if (!base) return url;
  // 相对路径：如果已含 /api/ 前缀则直接拼 base，否则补 /api/v1
  const path = url.startsWith('/') ? url : '/' + url;
  if (path.startsWith('/api/')) return base + path;
  return base + '/api/v1' + path;
}

// 图片加载失败时通过 Rust 代理（带 Cookie）重试
function imgFallback(imgEl, rawUrl) {
  if (!rawUrl || imgEl.dataset.retried) {
    imgEl.style.display = 'none';
    imgEl.parentElement?.classList.add('no-img');
    return;
  }
  imgEl.dataset.retried = '1';
  API.proxyImage(rawUrl).then(dataUri => {
    if (dataUri) {
      imgEl.src = dataUri;
    } else {
      imgEl.style.display = 'none';
      imgEl.parentElement?.classList.add('no-img');
    }
  });
}

// 「12:34」/「1:02:33」——与 Apple 端 Formatters.clock 同一口径（详情页续播按钮）
function fmtClock(ms) {
  const total = Math.floor((ms || 0) / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// 「48 分钟」「2 小时 12 分钟」——同 Apple 端 Formatters.runtime
function fmtRuntime(minutes) {
  if (!minutes || minutes <= 0) return '';
  const h = Math.floor(minutes / 60), m = minutes % 60;
  if (!h) return `${m} 分钟`;
  return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

// 「58.3 GB」——版本行的文件大小
function fmtBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

// Offset advances by the raw server page; visible items are deduplicated by media id.
class DesktopPager {
  constructor(fetchPage, current) {
    this.fetchPage = fetchPage;
    this.current = current;
    this.items = [];
    this.offset = 0;
    this.cursor = null;
    this.hasMore = true;
    this.loading = false;
    this.total = null;
  }

  async loadMore() {
    if (this.loading || !this.hasMore || !this.current()) return [];
    this.loading = true;
    try {
      const page = await (this.inFlight = this.fetchPage({ offset: this.offset, cursor: this.cursor, limit: 60 }));
      if (!this.current()) return [];
      const known = new Set(this.items.map(item => item.media_item_id));
      const added = page.items.filter(item => {
        if (known.has(item.media_item_id)) return false;
        known.add(item.media_item_id);
        return true;
      });
      this.offset += page.rawCount ?? page.items.length;
      this.items.push(...added);
      this.total = page.total ?? this.total;
      this.hasMore = page.hasMore;
      this.cursor = page.cursor ?? null;
      return added;
    } finally {
      this.loading = false;
    }
  }
}

const App = {
  currentPage: 'home',
  libraries: [],
  collections: [],
  navStack: [],       // 导航历史栈
  viewGeneration: 0,
  session: null,

  isCurrent(generation) {
    return generation === this.viewGeneration && !this._pageController?.signal.aborted;
  },

  async resetContext() {
    this._changingContext = true;
    this._authPending = true;
    this._sessionSequence = (this._sessionSequence || 0) + 1;
    this._startupController?.abort();
    this._sessionController?.abort();
    this._pageController?.abort();
    this.viewGeneration++;
    this._playbackSeq = (this._playbackSeq || 0) + 1;
    await Player.close();
    API.invalidateContext();
    this.libraries = [];
    this.collections = [];
    this.navStack = [];
    this._beforeSearch = null;
    document.getElementById('searchInput').value = '';
  },

  async handleSessionExpired() {
    if (this._authPending) return;
    this._authPending = true;
    this._resumeRoute = { page: this.currentPage, params: this.currentParams || {} };
    const username = this.session?.username || '';
    await this.resetContext();
    this.renderLogin({ username, message: '登录已失效，请重新输入密码。' });
  },

  async init() {
    this.bindEvents();
    API.onUnauthorized = () => this.handleSessionExpired();
    this._authPending = true;
    this._startupController?.abort();
    const controller = this._startupController = new AbortController();
    const sequence = this._startupSequence = (this._startupSequence || 0) + 1;
    const current = () => sequence === this._startupSequence && !controller.signal.aborted;
    const api = API.scope(controller.signal);
    try {
      await API.init();
      if (!current()) return;
      if (!API.baseUrl) {
        this.renderConnectionState('needsServer', '请先选择一台 MovieClaw 服务器。');
        return;
      }
      const health = await api.request('/health', { timeoutMs: 8000 });
      if (!current()) return;
      const server = health?.data || health;
      if (server?.status !== 'ok') {
        this.renderConnectionState('incompatible', '这个地址没有返回健康的 MovieClaw 服务，请核对服务器地址。');
        return;
      }
      const bootstrap = await api.getBootstrapStatus();
      if (!current()) return;
      if (!(bootstrap?.data || bootstrap)?.initialized) {
        this.renderLogin({ setup: true });
        return;
      }
      const session = await api.getSession();
      if (current()) await this.enterSession(session);
    } catch (e) {
      if (!current() || e.name === 'AbortError') return;
      if (e.status === 401) this.renderLogin();
      else if (e.status === 404 || e.status === 405) this.renderConnectionState('incompatible', '服务器缺少本版本必需的接口，请先升级服务器后重试。');
      else this.renderConnectionState('unreachable', e.message);
    }
  },

  async enterSession(response) {
    const epoch = API.contextEpoch;
    const sequence = this._sessionSequence = (this._sessionSequence || 0) + 1;
    this._sessionController?.abort();
    const controller = this._sessionController = new AbortController();
    const current = () => sequence === this._sessionSequence && epoch === API.contextEpoch && !controller.signal.aborted;
    this.session = response?.data || response;
    this._authPending = true;
    try {
      await this.loadSidebarData(API.scope(controller.signal));
    } catch (error) {
      if (!current() || error.name === 'AbortError') return;
      this._authPending = false;
      if (error.status === 401) await this.handleSessionExpired();
      else if (error.status === 404 || error.status === 405) this.renderConnectionState('incompatible', '服务器缺少媒体库或合集接口，请升级服务器后重试。');
      else this.renderConnectionState('unreachable', error.message);
      return;
    }
    if (!current()) return;
    this._authPending = false;
    this._changingContext = false;
    document.getElementById('sidebar').style.display = '';
    const route = this._resumeRoute || { page: 'home', params: {} };
    this._resumeRoute = null;
    await this.navigate(route.page, route.params, false);
  },

  renderConnectionState(phase, message) {
    this._authPending = true;
    this._pageController?.abort();
    this._wallObserver?.disconnect();
    this.viewGeneration++;
    document.getElementById('sidebar').style.display = 'none';
    const content = document.getElementById('content');
    const title = phase === 'incompatible' ? '需要兼容的 MovieClaw 服务器' : phase === 'needsServer' ? '连接服务器' : '连不上服务器';
    content.innerHTML = `<div class="login-page"><div class="login-card">
      <div class="login-logo">MovieClaw</div><h2>${title}</h2>
      <p class="login-subtitle">${escapeHtml(message)}</p>
      <p class="login-subtitle">${escapeHtml(API.baseUrl)}</p>
      <button class="login-btn" id="retryConnection">重试</button>
      <button class="btn-secondary" id="changeServer">更换服务器</button>
    </div></div>`;
    document.getElementById('retryConnection').addEventListener('click', () => this.init());
    document.getElementById('changeServer').addEventListener('click', () => this.changeServer());
  },

  async changeServer() {
    await this.resetContext();
    await window.__TAURI__.core.invoke('clear_server_url');
    window.location.href = '../connect.html';
  },

  // ===== 登录 =====
  renderLogin({ setup = false, addAccount = false, username = '', message = '' } = {}) {
    this._pageController?.abort();
    this._wallObserver?.disconnect();
    this.viewGeneration++;
    const content = document.getElementById('content');
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.style.display = 'none';

    content.innerHTML = `
      <div class="login-page">
        <div class="login-card">
          <div class="login-logo">MovieClaw</div>
          <div class="login-subtitle">${setup ? '初始化这台服务器' : addAccount ? '添加账号' : '登录到服务器'}</div>
          <div class="login-subtitle">${escapeHtml(API.baseUrl)}</div>
          <form id="loginForm">
            <div class="login-field">
              <label for="loginUser">用户名</label>
              <input type="text" id="loginUser" placeholder="输入用户名" autocomplete="username" value="${escapeHtml(username)}" ${setup ? 'minlength="3" maxlength="32"' : ''} required>
            </div>
            <div class="login-field">
              <label for="loginPass">密码</label>
              <input type="password" id="loginPass" placeholder="输入密码" autocomplete="${setup ? 'new-password' : 'current-password'}" ${setup ? 'minlength="8" maxlength="128"' : ''} required>
            </div>
            ${setup ? '<div class="login-field"><label for="loginConfirm">确认密码</label><input type="password" id="loginConfirm" autocomplete="new-password" required></div>' : ''}
            <button type="submit" class="login-btn" id="loginBtn">${setup ? '创建管理员' : '登录'}</button>
            <div class="login-error" id="loginError">${escapeHtml(message)}</div>
          </form>
          <button class="btn-secondary" id="loginChangeServer">更换服务器</button>
          ${addAccount ? '<button class="btn-secondary" id="cancelAddAccount">取消</button>' : ''}
        </div>
      </div>
    `;

    const form = document.getElementById('loginForm');
    const btn = document.getElementById('loginBtn');
    const cancel = document.getElementById('cancelAddAccount');
    const changeServer = document.getElementById('loginChangeServer');
    let submitting = false;
    const setSubmitting = busy => {
      submitting = busy;
      btn.disabled = busy;
      if (cancel) cancel.disabled = busy;
      changeServer.disabled = busy;
    };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submitting) return;
      const err = document.getElementById('loginError');
      setSubmitting(true);
      btn.textContent = '正在登录...';
      err.textContent = '';
      let attemptGeneration = this.viewGeneration;

      try {
        const user = document.getElementById('loginUser').value.trim();
        const pass = document.getElementById('loginPass').value;
        if (setup && pass !== document.getElementById('loginConfirm').value) throw new Error('两次输入的密码不一致');
        // Stop against the old Cookie first, then retire its request/progress identity before Cookie mutation.
        await this.resetContext();
        attemptGeneration = this.viewGeneration;
        // Await the transport's final result; a UI-only timeout cannot undo a late Set-Cookie.
        const result = setup ? await API.createAdmin(user, pass, { timeoutMs: 0 }) : await API.login(user, pass, true, { timeoutMs: 0 });
        if (attemptGeneration !== this.viewGeneration) return;
        await this.enterSession(result);
      } catch (ex) {
        if (attemptGeneration !== this.viewGeneration) return;
        err.textContent = ex.message || '登录失败';
        btn.textContent = setup ? '创建管理员' : '登录';
      } finally {
        if (attemptGeneration === this.viewGeneration && document.getElementById('loginForm') === form) setSubmitting(false);
      }
    });
    changeServer.addEventListener('click', () => { if (!submitting) return this.changeServer(); });
    cancel?.addEventListener('click', async () => {
      if (submitting) return;
      try {
        this._resumeRoute = { page: 'settings', params: {} };
        await this.enterSession(await API.getSession());
      } catch (error) {
        if (error.status === 401) this.renderLogin();
        else this.renderConnectionState('unreachable', error.message);
      }
    });
  },

  bindEvents() {
    if (this._eventsBound) return;
    this._eventsBound = true;
    window.__MOVIECLAW_CHANGE_SERVER__ = () => this.changeServer();
    window.addEventListener('movieclaw:playback-stopped', e => this.refreshStoppedItem(e.detail || {}));
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
    searchInput?.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        const q = searchInput.value.trim();
        if (this._authPending || !this.session) return;
        if (q) {
          if (this.currentPage !== 'search') this._beforeSearch = { page: this.currentPage, params: this.currentParams || {} };
          this.navigate('search', { query: q });
        } else if (this.currentPage === 'search') {
          const route = this._beforeSearch || { page: 'home', params: {} };
          this.navigate(route.page, route.params, false);
        }
      }, 300);
    });

    // 窗口控制
    const getWindow = () => {
      if (window.__TAURI__?.window?.getCurrentWindow) return window.__TAURI__.window.getCurrentWindow();
      return null;
    };
    document.getElementById('btnMinimize')?.addEventListener('click', () => {
      const w = getWindow();
      if (w) w.minimize().catch(e => console.error('minimize failed:', e));
    });
    document.getElementById('btnMaximize')?.addEventListener('click', () => {
      const w = getWindow();
      if (w) w.toggleMaximize().catch(e => console.error('toggleMaximize failed:', e));
    });
    document.getElementById('btnClose')?.addEventListener('click', () => {
      const w = getWindow();
      if (w) w.close().catch(e => console.error('close failed:', e));
    });

    // 键盘快捷键
    document.addEventListener('keydown', (e) => {
      // Esc: 返回上一页
      if (e.key === 'Escape') {
        if (!document.getElementById('playerView').hidden) return;
        if (this.currentPage === 'detail' || this.currentPage === 'search') {
          e.preventDefault();
          this.goBack();
        }
      }
      // Ctrl+F: 聚焦搜索框
      if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (!this.session || this._authPending) return;
        searchInput?.focus();
        searchInput?.select();
      }
    });
  },

  async loadSidebarData(api = API) {
    const epoch = API.contextEpoch;
    try {
      const [libs, colls] = await Promise.all([
        api.listLibraries(),
        api.listCollections(),
      ]);
      // API 可能返回 { data: [...] } 包装
      if (epoch !== API.contextEpoch) return;
      this.libraries = (libs?.data || libs || []).filter(lib => lib.viewer_access !== false && lib.kind !== 'photo');
      this.collections = colls?.data || colls || [];
      console.log('Libraries:', this.libraries.length, 'Collections:', this.collections.length);
      this.renderSidebar();
    } catch (e) {
      if (e.name === 'AbortError') return;
      throw e;
    }
  },

  renderSidebar() {
    const libNav = document.getElementById('libraryNav');
    libNav.innerHTML = this.libraries.map(lib => `
      <a class="nav-item" data-library-id="${Number(lib.id)}" href="#">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          ${lib.kind === 'tv' ? '<rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/>' : '<rect x="2" y="2" width="20" height="20" rx="2"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/>'}
        </svg>
        <span>${escapeHtml(lib.name)}</span>
        ${lib.stats?.item_count != null ? `<span class="badge">${Number(lib.stats.item_count)}</span>` : ''}
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
    // 只显示用户/内置合集，过滤掉自动生成的"系列"合集
    // CollectionView.kind: "user" | "builtin" | "series"
    const userCollections = this.collections.filter(col => col.kind !== 'series' && !col.hidden);
    colNav.innerHTML = userCollections.slice(0, 10).map(col => `
      <a class="nav-item" data-collection-id="${Number(col.id)}" href="#">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
        <span>${escapeHtml(col.name)}</span>
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

  async navigate(page, params = {}, pushHistory = true) {
    if (this._authPending) return;
    this._pageController?.abort();
    this._wallObserver?.disconnect();
    this._wallContext = null;
    this._pageController = new AbortController();
    this.pageAPI = API.scope(this._pageController.signal);
    const generation = ++this.viewGeneration;
    // 记录历史（用于返回）
    if (pushHistory && this.currentPage !== page) {
      this.navStack.push({ page: this.currentPage, params: this.currentParams || {} });
    }
    this.currentPage = page;
    this.currentParams = params;
    this.setActiveNav(page, params.libraryId);
    const content = document.getElementById('content');

    switch (page) {
      case 'home':
        await this.renderHome(content, generation);
        break;
      case 'library':
        await this.renderLibrary(content, params.libraryId, generation);
        break;
      case 'collection':
        await this.renderCollection(content, params.collectionId, generation);
        break;
      case 'favorites':
        await this.renderFavorites(content, generation);
        break;
      case 'search':
        await this.renderSearch(content, params.query, generation);
        break;
      case 'settings':
        this.renderSettings(content);
        break;
      case 'detail':
        await this.renderDetail(content, params, generation);
        break;
      case 'person':
        await this.renderPerson(content, params, generation);
        break;
    }
  },

  goBack() {
    if (this.navStack.length > 0) {
      const prev = this.navStack.pop();
      this.navigate(prev.page, prev.params, false);
    } else {
      this.navigate('home', {}, false);
    }
  },

  // ===== 首页（对齐 macOS 结构） =====
  async renderHome(container, generation = this.viewGeneration) {
    const api = this.pageAPI || API;
    container.innerHTML = '<div class="page-loading"><div class="spinner"></div></div>';
    try {
      if (!this.libraries.length) {
        container.innerHTML = '<div class="page-loading"><div style="color:var(--text-secondary)">暂无媒体库，请先在服务器添加</div></div>';
        return;
      }

      // 并行加载：继续观看 + 收藏 + 各媒体库最近添加
      const upNextPromise = api.getUpNext();
      const favPromise = api.getFavorites();

      const shelfPromises = this.libraries.map(lib =>
        api.listLibraryItems(lib.id, { limit: 20, sort: 'added_at', order: 'desc' })
          .then(items => ({ lib, items: this.filterMediaItems(this.unwrapItems(items)) }))
          .catch(() => ({ lib, items: [] }))
      );

      const [upNextResp, favResp, ...libShelves] = await Promise.all([upNextPromise, favPromise, ...shelfPromises]);
      if (!this.isCurrent(generation)) return;
      const unwrap = (r) => this.filterMediaItems(this.unwrapItems(r));

      // 继续观看 — UpNextItemView: { data: { items: [...] } }
      const upNextData = upNextResp?.data || upNextResp || {};
      const continueItems = (upNextData.items || []).slice(0, 20);

      // 收藏 — FavoriteItemView: { data: { items: [...], total } }
      const favData = favResp?.data || favResp || {};
      const favItems = this.filterMediaItems(favData.items || []).slice(0, 20);

      // 各媒体库最近添加（每库一行）
      const libRows = libShelves.filter(s => s.items.length > 0);

      // Hero 来源：继续观看第一部 > 收藏第一部 > 各库最近添加第一部
      const heroItem = continueItems[0] || favItems[0] || libRows[0]?.items[0] || null;

      // 所有 hero 候选（hover 切换）
      const allHeroItems = [...continueItems, ...favItems, ...libRows.flatMap(s => s.items.slice(0, 5))];

      if (!heroItem && !continueItems.length && !favItems.length && !libRows.length) {
        container.innerHTML = '<div class="page-loading"><div style="color:var(--text-secondary)">暂无内容</div></div>';
        return;
      }

      // ===== 构建各行 =====
      const defaultLibId = this.libraries[0]?.id;
      const shelfData = [];

      if (continueItems.length) shelfData.push({ title: '接下来继续', items: continueItems });
      if (favItems.length) shelfData.push({ title: '我的收藏', items: favItems });

      // 类型行（genres 只在 UpNextItemView 上有）
      const allGenres = [...new Set(continueItems.flatMap(i => i.genres || []))].sort().slice(0, 12);

      // 各库行
      for (const row of libRows) {
        shelfData.push({ title: `最近添加的${row.lib.name}`, items: row.items });
      }

      const genreTilesHtml = allGenres.length ? `
        <div class="shelf-section">
          <div class="shelf-header">
            <h2 class="shelf-title">按类型找</h2>
          </div>
          <div class="genre-tiles">
            ${allGenres.map((g, i) => `
              <div class="genre-tile" data-genre="${escapeHtml(g)}" style="background:${['#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c','#3498db','#9b59b6','#e84393','#fd79a8','#00b894','#0984e3','#6c5ce7'][i % 12]}">
                <span>${escapeHtml(g)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      ` : '';

      const heroHtml = heroItem ? `
        <div class="hero-banner" id="heroBanner" data-hero-id="${Number(heroItem.media_item_id) || ''}" data-hero-lib="${Number(heroItem.library_id ?? defaultLibId) || ''}">
          <div class="hero-bg" id="heroBg">
            <img src="" alt="" id="heroImg" style="opacity:0;transition:opacity 0.5s" data-raw="${escapeHtml(heroItem.backdrop_url || heroItem.poster_url || '')}" onload="this.style.opacity='1'" onerror="imgFallback(this, this.dataset.raw)">
          </div>
          <div class="hero-info">
            <h1 class="hero-title" id="heroTitle">${escapeHtml(heroItem.title)}</h1>
            <div class="hero-meta" id="heroMeta">
              ${heroItem.year ? `<span>${escapeHtml(heroItem.year)}</span>` : ''}
              ${heroItem.rating ? `<span>★ ${Number(heroItem.rating).toFixed(1)}</span>` : ''}
              ${heroItem.seasons?.length ? `<span>${heroItem.seasons.length} 季</span>` : (heroItem.episode_count ? `<span>${Number(heroItem.episode_count)} 集</span>` : '')}
            </div>
            <div class="hero-actions">
              <button class="btn-play" id="heroPlayBtn">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                <span>播放</span>
              </button>
              <button class="btn-secondary" id="heroDetailBtn">详情</button>
            </div>
          </div>
        </div>
      ` : '';

      container.innerHTML = heroHtml + shelfData.map(shelf => `
        <div class="shelf-section">
          <div class="shelf-header" data-shelf-title="${escapeHtml(shelf.title)}">
            <h2 class="shelf-title">${escapeHtml(shelf.title)}</h2>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary)"><polyline points="9 18 15 12 9 6"/></svg>
          </div>
          <div class="shelf-wrapper">
            <button class="shelf-arrow shelf-arrow-left" data-dir="-1" aria-label="向左">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <div class="shelf-row">
              ${shelf.items.map(item => this.posterCard(item, item.library_id ?? defaultLibId)).join('')}
            </div>
            <button class="shelf-arrow shelf-arrow-right" data-dir="1" aria-label="向右">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
        </div>
      `).join('') + genreTilesHtml;

      this.bindPosterCards(container);

      // Hero 头图：通过 Rust 代理加载（带 Cookie）
      if (heroItem) {
        const heroImg = document.getElementById('heroImg');
        const rawUrl = heroItem.backdrop_url || heroItem.poster_url || '';
        if (heroImg && rawUrl) {
          api.proxyImage(rawUrl).then(dataUri => {
            if (!this.isCurrent(generation)) return;
            if (dataUri) {
              heroImg.src = dataUri;
              heroImg.style.opacity = '1';
            } else {
              heroImg.src = resolveUrl(rawUrl);
            }
          });
        }
      }

      // 横排滚动箭头
      container.querySelectorAll('.shelf-arrow').forEach(btn => {
        btn.addEventListener('click', () => {
          const row = btn.closest('.shelf-wrapper')?.querySelector('.shelf-row');
          if (row) {
            const dir = parseInt(btn.dataset.dir);
            row.scrollBy({ left: dir * row.clientWidth * 0.75, behavior: 'smooth' });
          }
        });
      });

      // 类型色卡点击 → 搜索
      container.querySelectorAll('.genre-tile').forEach(tile => {
        tile.addEventListener('click', () => {
          const genre = tile.dataset.genre;
          if (genre) {
            document.getElementById('searchInput').value = genre;
            this.navigate('search', { query: genre });
          }
        });
      });

      // Hero 跟随鼠标（hover 0.3s 后切换）
      if (heroItem) {
        let heroHoverTimer = null;
        container.querySelectorAll('.poster-card').forEach(card => {
          card.addEventListener('mouseenter', () => {
            clearTimeout(heroHoverTimer);
            heroHoverTimer = setTimeout(() => {
              const itemId = card.dataset.itemId;
              const item = allHeroItems.find(i => i.media_item_id == itemId);
              if (!item) return;
              const heroImg = document.getElementById('heroImg');
              const heroTitle = document.getElementById('heroTitle');
              const heroMeta = document.getElementById('heroMeta');
              const heroBanner = document.getElementById('heroBanner');
              if (heroImg && (item.backdrop_url || item.poster_url)) {
                heroImg.style.opacity = '0';
                const switchUrl = item.backdrop_url || item.poster_url || '';
                setTimeout(() => {
                  api.proxyImage(switchUrl).then(dataUri => {
                    if (!this.isCurrent(generation) || document.getElementById('heroBanner')?.dataset.heroId !== String(item.media_item_id)) return;
                    if (dataUri) {
                      heroImg.src = dataUri;
                    } else {
                      heroImg.src = resolveUrl(switchUrl);
                    }
                    heroImg.style.opacity = '1';
                  });
                }, 250);
              }
              if (heroTitle) heroTitle.textContent = item.title || '';
              if (heroMeta) {
                heroMeta.innerHTML = `
                  ${item.year ? `<span>${escapeHtml(item.year)}</span>` : ''}
                  ${item.rating ? `<span>★ ${Number(item.rating).toFixed(1)}</span>` : ''}
                  ${item.seasons?.length ? `<span>${item.seasons.length} 季</span>` : (item.episode_count ? `<span>${Number(item.episode_count)} 集</span>` : '')}
                `;
              }
              if (heroBanner) {
                heroBanner.dataset.heroId = item.media_item_id || '';
                heroBanner.dataset.heroLib = item.library_id ?? defaultLibId ?? '';
              }
            }, 300);
          });
        });

        document.getElementById('heroPlayBtn')?.addEventListener('click', () => {
          const banner = document.getElementById('heroBanner');
          const heroId = banner?.dataset.heroId;
          const item = allHeroItems.find(i => i.media_item_id == heroId) || heroItem;
          // 继续观看的剧集项自带季/集号，直接传：不传会自动选到第一季第一未看集而非续播点
          this.startPlayback({
            media_item_id: item.media_item_id,
            title: item.title,
            library_id: item.library_id ?? defaultLibId,
            seasonNumber: item.season_number,
            episodeNumber: item.episode_number,
          });
        });
        document.getElementById('heroDetailBtn')?.addEventListener('click', () => {
          const banner = document.getElementById('heroBanner');
          const heroId = banner?.dataset.heroId;
          const heroLib = banner?.dataset.heroLib;
          const item = allHeroItems.find(i => i.media_item_id == heroId) || heroItem;
          this.navigate('detail', {
            libraryId: item.library_id ?? heroLib ?? defaultLibId,
            itemId: item.media_item_id
          });
        });
      }
    } catch (e) {
      this.renderPageError(container, e, generation);
    }
  },

  // 解包 API 响应：兼容 {data:[...]}, {data:{items:[...]}}, {items:[...]}, [...] 等
  unwrapItems(resp) {
    if (!resp) return [];
    if (Array.isArray(resp)) return resp;
    if (resp.data) {
      if (Array.isArray(resp.data)) return resp.data;
      if (resp.data.items && Array.isArray(resp.data.items)) return resp.data.items;
      if (Array.isArray(resp.data.results)) return resp.data.results;
      if (resp.data.episodes && Array.isArray(resp.data.episodes)) return resp.data.episodes;
    }
    if (resp.items && Array.isArray(resp.items)) return resp.items;
    if (resp.results && Array.isArray(resp.results)) return resp.results;
    if (resp.episodes && Array.isArray(resp.episodes)) return resp.episodes;
    return [];
  },

  // 过滤出真正的媒体项（排除合集、文件等非媒体条目）
  // 依据 LibraryItemView schema: media_item_id, kind(movie/tv/video), title 必须有
  filterMediaItems(items) {
    return items.filter(i => {
      if (!i) return false;
      if (!i.media_item_id) return false;
      if (!i.title) return false;
      // kind 只能是 movie/tv/video，排除合集等
      if (i.kind && !['movie', 'tv', 'video'].includes(i.kind)) return false;
      return true;
    });
  },

  // ===== 媒体库 / 合集 / 收藏 / 搜索：共享按需分页 =====
  async renderLibrary(container, libraryId, generation = this.viewGeneration) {
    const api = this.pageAPI || API;
    const lib = this.libraries.find(l => Number(l.id) === Number(libraryId));
    const prefs = this.wallPreferences('library-' + libraryId);
    await this.renderPagedWall(container, {
      title: lib?.name || '媒体库', libraryId, generation, prefs,
      preferenceId: 'library-' + libraryId, unwatched: true,
      fetchPage: async page => this.offsetPage(await api.listLibraryItems(libraryId, {
        offset: page.offset, limit: page.limit, sort: prefs.sort, order: prefs.order,
        ...(prefs.unwatched ? { w: 'unwatched' } : {}),
      }), page.limit),
    });
  },

  async renderCollection(container, collectionId, generation = this.viewGeneration) {
    const api = this.pageAPI || API;
    const collection = this.collections.find(c => Number(c.id) === Number(collectionId));
    const prefs = this.wallPreferences('collection-' + collectionId, 'default');
    await this.renderPagedWall(container, {
      title: collection?.name || '合集', generation, prefs, preferenceId: 'collection-' + collectionId,
      fetchPage: async page => this.offsetPage(await api.listCollectionItems(collectionId, {
        offset: page.offset, limit: page.limit,
        ...(prefs.sort !== 'default' ? { sort: prefs.sort, order: prefs.order } : {}),
      }), page.limit),
    });
  },

  async renderFavorites(container, generation = this.viewGeneration) {
    const api = this.pageAPI || API;
    const prefs = this.wallPreferences('favorites', 'favorited_at');
    await this.renderPagedWall(container, {
      title: '我的收藏', generation, prefs, preferenceId: 'favorites',
      fetchPage: async page => this.offsetPage(await api.getFavorites({
        offset: page.offset, limit: page.limit, sort: prefs.sort, order: prefs.order,
      }), page.limit),
    });
  },

  async renderSearch(container, query, generation = this.viewGeneration) {
    const api = this.pageAPI || API;
    await this.renderPagedWall(container, {
      title: `“${query}” 的搜索结果`, generation,
      fetchPage: async page => {
        const response = await api.search(query, { limit: page.limit, ...(page.cursor ? { cursor: page.cursor } : {}) });
        const data = response?.data || response || {};
        return {
          items: this.filterMediaItems((data.items || []).map(hit => ({
            ...hit.item, library_id: hit.item?.library_id ?? hit.library_ids?.[0], match_label: hit.match?.label,
          }))),
          cursor: data.next_cursor, hasMore: !!data.next_cursor,
        };
      },
    });
  },

  offsetPage(response, limit) {
    const raw = this.unwrapItems(response);
    const total = (response?.data || response)?.total;
    return { items: this.filterMediaItems(raw), rawCount: raw.length, hasMore: raw.length === limit, total };
  },

  wallPreferences(id, defaultSort = 'added_at') {
    const key = 'mc_wall.' + API.baseUrl + '#' + (this.session?.username || '') + '.' + id;
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(key) || '{}'); } catch (_) {}
    const allowed = ['added_at', 'release_date', 'rating', 'title'];
    if (id.startsWith('collection-')) allowed.push('default');
    if (id === 'favorites') allowed.push('favorited_at');
    return { key, sort: allowed.includes(stored.sort) ? stored.sort : defaultSort,
      order: stored.order === 'asc' ? 'asc' : 'desc', unwatched: stored.unwatched === true };
  },

  async renderPagedWall(container, { title, libraryId, generation, prefs, preferenceId, unwatched = false, fetchPage }) {
    const sorts = [['added_at', '最近添加'], ['release_date', '最近上映'], ['rating', '评分'], ['title', '片名']];
    if (preferenceId?.startsWith('collection')) sorts.unshift(['default', '合集顺序']);
    if (preferenceId === 'favorites') sorts.unshift(['favorited_at', '最近收藏']);
    container.innerHTML = `<div class="page-header"><h1 class="page-title">${escapeHtml(title)}</h1><span class="page-subtitle" id="wallCount"></span></div>
      ${prefs ? `<div class="wall-toolbar"><select id="wallSort" class="settings-select" aria-label="排序">${sorts.map(([value, label]) => `<option value="${value}" ${prefs.sort === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <select id="wallOrder" class="settings-select" aria-label="排序方向"><option value="desc" ${prefs.order === 'desc' ? 'selected' : ''}>降序</option><option value="asc" ${prefs.order === 'asc' ? 'selected' : ''}>升序</option></select>
        ${unwatched ? `<label><input type="checkbox" id="wallUnwatched" ${prefs.unwatched ? 'checked' : ''}> 只看没看过的</label>` : ''}</div>` : ''}
      <div class="poster-wall"><div class="poster-grid" id="posterGrid"></div><div id="wallStatus" class="empty-state"></div><div id="wallSentinel" style="height:1px"></div></div>`;
    const grid = container.querySelector('#posterGrid');
    const status = container.querySelector('#wallStatus');
    const count = container.querySelector('#wallCount');
    const pager = new DesktopPager(fetchPage, () => this.isCurrent(generation));
    this._wallPager = pager;
    const wall = this._wallContext = { pager, grid, count, container, libraryId, generation, prefs, refreshing: false };
    const load = async () => {
      if (wall.refreshing || pager.loading || !pager.hasMore || !this.isCurrent(generation)) return;
      status.textContent = '加载中…';
      try {
        const added = await pager.loadMore();
        if (!this.isCurrent(generation)) return;
        grid.insertAdjacentHTML('beforeend', added.map(item => this.posterCard(item, libraryId)).join(''));
        this.bindPosterCards(grid);
        count.textContent = pager.total != null ? `${pager.total} 个项目` : `${pager.items.length}${pager.hasMore ? '+' : ''} 个项目`;
        status.textContent = pager.items.length ? (pager.hasMore ? '' : '已加载全部') : '这里还没有内容';
        if (!pager.hasMore) this._wallObserver?.disconnect();
        else if (this._wallObserver && container.querySelector('#wallSentinel').getBoundingClientRect().top <= container.getBoundingClientRect().bottom + 400) {
          queueMicrotask(load);
        }
      } catch (error) {
        if (!this.isCurrent(generation) || error.name === 'AbortError' || error.status === 401) return;
        status.textContent = error.message;
        const retry = document.createElement('button');
        retry.className = 'btn-secondary'; retry.textContent = '重试';
        retry.addEventListener('click', () => { status.textContent = ''; load(); });
        status.appendChild(retry);
      }
    };
    wall.load = load;
    if (prefs) {
      const changed = () => {
        prefs.sort = container.querySelector('#wallSort').value;
        prefs.order = container.querySelector('#wallOrder').value;
        prefs.unwatched = container.querySelector('#wallUnwatched')?.checked || false;
        localStorage.setItem(prefs.key, JSON.stringify({ sort: prefs.sort, order: prefs.order, unwatched: prefs.unwatched }));
        this.navigate(this.currentPage, this.currentParams, false);
      };
      container.querySelectorAll('#wallSort,#wallOrder,#wallUnwatched').forEach(input => input.addEventListener('change', changed));
    }
    await load();
    if (!this.isCurrent(generation) || !pager.hasMore) return;
    if (typeof IntersectionObserver !== 'undefined') {
      this._wallObserver = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) load();
      }, { root: container, rootMargin: '400px' });
      this._wallObserver.observe(container.querySelector('#wallSentinel'));
    }
  },

  async refreshStoppedItem({ mediaItemId, libraryId, seasonNumber, episodeNumber }) {
    if (this._authPending || this._changingContext) return;
    if (this.currentPage === 'home' || (this.currentPage === 'detail'
        && Number(this.currentParams?.itemId) === Number(mediaItemId)
        && Number(this.currentParams?.libraryId) === Number(libraryId))) {
      await this.navigate(this.currentPage, this.currentParams || {}, false);
      return;
    }
    const wall = this._wallContext;
    if (!wall || wall.refreshing || !this.isCurrent(wall.generation)) return;
    const item = wall.pager.items.find(value => Number(value.media_item_id) === Number(mediaItemId)
      && Number(value.library_id ?? wall.libraryId) === Number(libraryId));
    if (!item) return;
    wall.refreshing = true;
    const pendingOffset = wall.pager.loading ? wall.pager.offset : null;
    try {
      // Keep the existing pages and scroll position; pause the next batch while a watched filter changes.
      await wall.pager.inFlight?.catch(() => {});
      const api = this.pageAPI;
      const [marksResponse, resumeResponse] = await Promise.all([
        api.getMarks(mediaItemId), api.getResume(mediaItemId, seasonNumber, episodeNumber),
      ]);
      if (wall !== this._wallContext || !this.isCurrent(wall.generation)) return;
      const marks = marksResponse?.data || marksResponse;
      const resume = resumeResponse?.data || resumeResponse;
      const card = wall.grid.querySelector(`[data-item-id="${Number(mediaItemId)}"][data-library-id="${Number(libraryId)}"]`);
      if (wall.prefs?.unwatched && marks?.played) {
        wall.pager.items = wall.pager.items.filter(value => value !== item);
        wall.pager.offset = Math.max(0, wall.pager.offset - 1);
        if (wall.pager.total != null) wall.pager.total = Math.max(0, wall.pager.total - 1);
        card?.remove();
        if (pendingOffset != null && pendingOffset > 0) {
          // A batch already in flight may have observed the removal before we adjusted its offset.
          const boundary = await wall.pager.fetchPage({ offset: pendingOffset - 1, cursor: null, limit: 1 });
          if (wall !== this._wallContext || !this.isCurrent(wall.generation)) return;
          const repair = boundary.items.find(value => !wall.pager.items.some(known => known.media_item_id === value.media_item_id));
          if (repair) {
            const index = Math.min(pendingOffset - 1, wall.pager.items.length);
            wall.pager.items.splice(index, 0, repair);
            wall.pager.offset++;
            const next = wall.pager.items[index + 1];
            const nextCard = next && wall.grid.querySelector(`[data-item-id="${Number(next.media_item_id)}"]`);
            if (nextCard) nextCard.insertAdjacentHTML('beforebegin', this.posterCard(repair, wall.libraryId));
            else wall.grid.insertAdjacentHTML('beforeend', this.posterCard(repair, wall.libraryId));
            this.bindPosterCards(wall.grid);
          }
        }
        wall.count.textContent = wall.pager.total != null ? `${wall.pager.total} 个项目` : `${wall.pager.items.length}${wall.pager.hasMore ? '+' : ''} 个项目`;
      } else {
        item.is_favorite = marks?.is_favorite ?? item.is_favorite;
        item.progress_percent = !resume?.played && resume?.duration_ms > 0
          ? Math.max(0, Math.min(99, Math.round(resume.position_ms / resume.duration_ms * 100))) : null;
        if (card) card.outerHTML = this.posterCard(item, wall.libraryId);
        this.bindPosterCards(wall.grid);
      }
    } catch (error) {
      if (error.name !== 'AbortError' && error.status !== 401) console.warn('Playback state refresh failed:', error.message);
    } finally {
      wall.refreshing = false;
      if (wall === this._wallContext && this.isCurrent(wall.generation)
          && wall.container.querySelector('#wallSentinel').getBoundingClientRect().top <= wall.container.getBoundingClientRect().bottom + 400) wall.load();
    }
  },

  renderPageError(container, error, generation) {
    if (!this.isCurrent(generation) || error.name === 'AbortError' || error.status === 401) return;
    container.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message || '加载失败')}</p><button class="btn-secondary" id="retryPage">重试</button></div>`;
    container.querySelector('#retryPage').addEventListener('click', () => this.navigate(this.currentPage, this.currentParams, false));
  },

  // ===== 人物页 =====
  async renderPerson(container, params, generation = this.viewGeneration) {
    const api = this.pageAPI || API;
    container.innerHTML = '<div class="page-loading"><div class="spinner"></div></div>';
    try {
      const resp = await api.getPerson(params.personId);
      if (!this.isCurrent(generation)) return;
      const person = resp?.data || resp;

      // 加载作品
      const credits = person.credits || [];
      const sections = [['参演', credits.filter(c => c.department === 'cast')], ['执导', credits.filter(c => c.department === 'director')]].filter(([, items]) => items.length);

      container.innerHTML = `
        <div class="person-hero">
          <button class="detail-back-btn" onclick="App.goBack()">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div class="person-header">
            ${person.avatar_url || person.profile_url ? `
              <img class="person-avatar" src="${escapeHtml(resolveUrl(person.avatar_url || person.profile_url))}" alt="" data-raw="${escapeHtml(person.avatar_url || person.profile_url)}" style="opacity:0;transition:opacity 0.3s" onload="this.style.opacity='1'" onerror="imgFallback(this, this.dataset.raw)">
            ` : '<div class="person-avatar person-avatar-placeholder"></div>'}
            <div class="person-info">
              <h1 class="person-name">${escapeHtml(person.name)}</h1>
              <div class="person-meta">
                ${person.original_name && person.original_name !== person.name ? `<span>${escapeHtml(person.original_name)}</span>` : ''}
                ${credits.length ? `<span>库内 ${new Set(credits.map(c => c.media_item_id)).size} 部作品</span>` : ''}
              </div>
            </div>
          </div>
        </div>
        ${sections.map(([title, items]) => `<div class="person-works"><h2 class="shelf-title" style="margin-bottom:16px">${title}</h2><div class="poster-grid">
          ${items.map(item => this.posterCard({ ...item, source_missing: item.library_id == null,
            match_label: item.library_id == null ? '片源已移除' : item.department === 'director' ? (item.kind === 'tv' ? '主创' : '导演') : item.character ? '饰 ' + item.character : '',
          }, item.library_id)).join('')}</div></div>`).join('') || '<div class="empty-state"><p>库内没有这位影人的作品</p></div>'}
      `;
      this.bindPosterCards(container);
    } catch (e) {
      if (!this.isCurrent(generation) || e.name === 'AbortError') return;
      if (e.status === 404) {
        container.innerHTML = '<div class="empty-state"><p>库内没有这位影人的作品</p><p>作品可能已被移除，或尚未建立影人档案。</p><button class="btn-secondary" id="personBack">返回</button></div>';
        container.querySelector('#personBack').addEventListener('click', () => this.goBack());
      } else this.renderPageError(container, e, generation);
    }
  },

  // ===== 详情页 =====
  // 版式对齐 macOS（apps/apple MacItemDetailView，docs/design/macos-app.md §4.4）：
  // 头图 = Logo、年份类型片长与画质小标签、第几集、三行简介、写明「继续 第 1 季
  // 第 3 集 · 12:34」的主按钮与「从头播放」，右下角浮「导演 / 主演」；
  // 下面 = 分集横排 → 系列 → 演职员 → 合集 → 信息。头图讲的那一集与下面浏览的
  // 那一季是两套状态：换季只换分集横排。
  async renderDetail(container, params, generation = this.viewGeneration) {
    const api = this.pageAPI || API;
    // 详情页一出现就预连（对齐 macOS PlaybackPreconnect.warm）：进了详情紧接着多半就是点播放
    api.preconnectPlayback();
    container.innerHTML = '<div class="page-loading"><div class="spinner"></div></div>';
    try {
      const resp = await api.getItemDetail(params.libraryId, params.itemId);
      if (!this.isCurrent(generation)) return;
      const info = resp?.data || resp;
      const meta = info.local_meta || {};
      const isMovie = info.kind !== 'tv';
      const genres = meta.genres || [];
      const plot = meta.plot || '';
      const runtime = meta.runtime_minutes || null;
      const mediaId = info.media_item_id;

      const inPlace = (info.files || []).filter(f => f.state === 'in_place');
      const badges = this.bestMediaBadges(inPlace);
      const cast = this.castPeople(meta);
      const backdropRaw = info.backdrop_url || info.poster_url || '';
      const logoRaw = info.logo_url || '';
      const seasonCount = (info.seasons || []).filter(s => s > 0).length;

      const st = {
        season: null, episode: null,      // 头图正讲的那一集
        browseSeason: null, browseEpisodes: [], episodesLoading: false,
        watched: null,                    // 头图单元的续播点（PlaybackStateView）
        favorite: false, marking: false,
      };

      const canPlay = () => (isMovie ? inPlace.length > 0 : st.episode?.owned === true);

      container.innerHTML = `
        <div class="detail-hero">
          <div class="detail-hero-bg">
            <img src="${escapeHtml(resolveUrl(backdropRaw))}" alt="" style="opacity:0;transition:opacity 0.4s" data-raw="${escapeHtml(backdropRaw)}" onload="this.style.opacity='1'" onerror="imgFallback(this, this.dataset.raw)">
          </div>
          <button class="detail-back-btn" id="btnBack" title="返回 (Esc)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div class="detail-stage">
            <div class="detail-stage-main" id="detailStage"></div>
            ${this.detailCreditsHtml(cast)}
          </div>
        </div>
        <div class="detail-body">
          <div class="detail-body-bg"><img src="${escapeHtml(resolveUrl(backdropRaw))}" alt="" data-raw="${escapeHtml(backdropRaw)}" onerror="imgFallback(this, this.dataset.raw)"></div>
          <div class="detail-lower">
            <div id="detailSeasonArea"></div>
            <div id="detailSeriesArea"></div>
            ${cast.length ? this.shelfHtml('演职员', null, 'cast-row', cast.map(p => this.personCardHtml(p)).join('')) : ''}
            ${info.collections?.length ? `
              <div class="detail-section">
                <h2 class="shelf-title">所属合集</h2>
                <div class="collection-chips">
                  ${info.collections.map(c => `<a class="collection-chip" data-collection-id="${Number(c.id)}" href="#">${escapeHtml(c.name)}</a>`).join('')}
                </div>
              </div>
            ` : ''}
            ${this.detailInfoHtml(info, meta, inPlace, isMovie, seasonCount)}
          </div>
        </div>
      `;

      // ---- 头图（Logo / 画质标签 / 第几集 / 简介 / 按钮）----
      const renderStage = () => {
        if (!this.isCurrent(generation)) return;
        const ep = st.episode;
        const overview = (isMovie ? plot : (ep?.overview || plot) || '').trim();
        const position = st.watched?.position_ms || 0;
        const finished = st.watched?.played || false;
        const playable = canPlay();
        const resumable = playable && position > 0;
        const verb = resumable ? '继续' : finished ? '重新播放' : '播放';
        const unit = !isMovie && ep
          ? (st.season === 0 ? `特别篇第 ${ep.episode_number} 集` : `第 ${st.season} 季第 ${ep.episode_number} 集`)
          : null;
        const parts = [verb, unit, resumable ? fmtClock(position) : null].filter(Boolean);
        const label = parts.length > 2 ? `${parts[0]} ${parts[1]} · ${parts[2]}` : parts.join(' ');
        const metaLine = [
          info.year || null,
          ...genres.slice(0, 2),
          isMovie
            ? (runtime ? fmtRuntime(runtime) : null)
            : (seasonCount >= 2 ? `共 ${seasonCount} 季` : null),
        ].filter(Boolean).join(' · ');
        const hint = playable ? '' : (isMovie
          ? '片源已移除，暂时不能播放'
          : ((info.seasons || []).length ? '这一集还没有片源，在下面挑别的集' : '这部剧还没有可播放的分集'));

        document.getElementById('detailStage').innerHTML = `
          ${logoRaw
            ? `<img class="detail-logo" src="${escapeHtml(resolveUrl(logoRaw))}" alt="${escapeHtml(info.title)}" data-raw="${escapeHtml(logoRaw)}"
                 onerror="if (!this.dataset.retried) document.getElementById('detailTitleFallback').style.display=''; imgFallback(this, this.dataset.raw)"
                 onload="document.getElementById('detailTitleFallback').style.display='none'">
               <h1 class="detail-title" id="detailTitleFallback" style="display:none">${escapeHtml(info.title)}</h1>`
            : `<h1 class="detail-title">${escapeHtml(info.title)}</h1>`}
          ${metaLine || badges.length ? `
            <div class="detail-meta">
              ${metaLine ? `<span class="detail-meta-text">${escapeHtml(metaLine)}</span>` : ''}
              ${badges.map(b => `<span class="quality-badge${b.filled ? '' : ' outlined'}">${escapeHtml(b.text)}</span>`).join('')}
            </div>
          ` : ''}
          ${!isMovie && ep ? `<div class="detail-episode-line">${escapeHtml(this.episodeLine(st.season, ep))}</div>` : ''}
          ${overview ? `<p class="detail-hero-overview">${escapeHtml(overview)}</p>` : ''}
          ${hint ? `<div class="detail-hint">${hint}</div>` : ''}
          <div class="detail-actions">
            ${playable ? `
              <button class="btn-play" id="btnPlay">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                <span>${escapeHtml(label)}</span>
              </button>
              ${resumable ? `
                <button class="btn-secondary" id="btnRestart" title="从头播放">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                  <span>从头播放</span>
                </button>
              ` : ''}
            ` : ''}
            <button class="btn-icon ${st.favorite ? 'active' : ''}" id="btnFavorite" title="${st.favorite ? '取消收藏' : '收藏'}">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
              </svg>
            </button>
            ${playable ? `
              <button class="btn-icon ${finished ? 'active' : ''}" id="btnMarkWatched" title="${finished ? '标为未看' : '标为已看'}">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/>
                </svg>
              </button>
            ` : ''}
          </div>
        `;
        document.getElementById('btnPlay')?.addEventListener('click', () => playUnit(null));
        document.getElementById('btnRestart')?.addEventListener('click', () => playUnit(0));
        document.getElementById('btnFavorite')?.addEventListener('click', () => toggleFavorite());
        document.getElementById('btnMarkWatched')?.addEventListener('click', () => togglePlayed());
      };

      // ---- 续播点 / 收藏 / 已看 ----
      const loadUnitResume = async () => {
        const request = st.resumeRequest = (st.resumeRequest || 0) + 1;
        try {
          const resp2 = await api.getResume(
            mediaId,
            isMovie ? null : st.season,
            isMovie ? null : st.episode?.episode_number,
          );
          if (!this.isCurrent(generation) || request !== st.resumeRequest) return;
          st.watched = resp2?.data || resp2 || null;
        } catch (error) {
          if (!this.isCurrent(generation) || request !== st.resumeRequest || error.name === 'AbortError') return;
          st.watched = null;
        }
        renderStage();
      };

      const toggleFavorite = async () => {
        if (st.marking) return;
        st.marking = true;
        const next = !st.favorite;
        st.favorite = next;
        renderStage();
        try {
          const resp2 = await api.setMarks(mediaId, { favorite: next });
          if (!this.isCurrent(generation)) return;
          st.favorite = (resp2?.data || resp2)?.is_favorite ?? next;
        } catch (e) {
          console.error('Favorite toggle failed:', e);
          st.favorite = !next;
        }
        st.marking = false;
        renderStage();
      };

      const togglePlayed = async () => {
        if (st.marking || !canPlay()) return;
        st.marking = true;
        try {
          await api.setMarks(mediaId, {
            played: !(st.watched?.played || false),
            seasonNumber: isMovie ? null : st.season,
            episodeNumber: isMovie ? null : st.episode?.episode_number,
          });
          if (!this.isCurrent(generation)) return;
          await loadUnitResume();
          if (!isMovie && st.season != null) await loadBrowse(st.season);
        } catch (e) { console.error('Mark watched failed:', e); }
        st.marking = false;
      };

      // ---- 起播 ----
      const playUnit = (startMs, season, ep) => {
        if (!this.isCurrent(generation)) return;
        if (isMovie) {
          // library_id 必传：startPlayback 自动选集用它查详情判断 kind；
          // files/kind 也带上：能力申报分级要用 files 判片源吃不吃得下，
          // kind 让起播链不必再为「是不是剧集」查一遍详情
          this.startPlayback({ media_item_id: mediaId, title: info.title, library_id: params.libraryId, startMs, files: info.files, kind: info.kind });
          return;
        }
        const useSeason = season ?? st.season;
        const useEp = ep || st.episode;
        if (!useEp || !(ep ? useEp.owned : canPlay())) return;
        // Headline follows the explicit choice; stop reporting refreshes this item on return.
        if (ep && (ep !== st.episode || useSeason !== st.season)) {
          st.season = useSeason;
          st.episode = useEp;
          loadUnitResume();
          renderEpisodeShelf(); // 头图跟到这一集，横排的舞台环也要跟着挪
        }
        this.startPlayback({
          media_item_id: mediaId,
          title: `${info.title} S${useSeason}E${useEp.episode_number}`,
          library_id: params.libraryId,
          seasonNumber: useSeason,
          episodeNumber: useEp.episode_number,
          startMs,
          files: info.files,
          // 同季剧集表：播放器的上一集/下一集与自动下一集都按它算（服务端会话不带
          // next_episode，PlaybackSessionView 里压根没这个字段）
          episodes: st.browseEpisodes,
        });
      };

      // ---- 分集横排（标题 + 「共 N 集 · 已看 · 缺」）----
      const renderEpisodeShelf = () => {
        if (!this.isCurrent(generation)) return;
        const area = document.getElementById('detailSeasonArea');
        if (!area) return;
        const eps = st.browseEpisodes;
        const playedCount = eps.filter(e => e.played).length;
        const missingCount = eps.filter(e => !e.owned).length;
        const summary = (!st.episodesLoading && eps.length)
          ? [`共 ${eps.length} 集`, playedCount ? `已看 ${playedCount} 集` : null, missingCount ? `缺 ${missingCount} 集` : null].filter(Boolean).join(' · ')
          : null;
        const cards = st.episodesLoading
          ? '<div class="page-loading"><div class="spinner"></div></div>'
          : (eps.length
            ? eps.map(ep => this.episodeCardHtml(ep, st, runtime)).join('')
            : '<div style="color:var(--text-secondary);padding:20px;">暂无剧集信息</div>');
        area.innerHTML = `
          ${(info.seasons || []).length > 1 ? `
            <div class="season-selector">
              ${(info.seasons || []).map(s => `<button class="season-pill ${s === st.browseSeason ? 'active' : ''}" data-season="${Number(s)}">${s === 0 ? '特别篇' : `第 ${Number(s)} 季`}</button>`).join('')}
            </div>
          ` : ''}
          ${this.shelfHtml(st.browseSeason === 0 ? '特别篇' : `第 ${st.browseSeason} 季`, summary, 'episode-row', cards)}
        `;
        area.querySelectorAll('.season-pill').forEach(pill => {
          pill.addEventListener('click', () => loadBrowse(parseInt(pill.dataset.season, 10)));
        });
        area.querySelectorAll('.episode-card').forEach(card => {
          const ep = eps.find(e => e.episode_number === parseInt(card.dataset.episodeNumber, 10));
          if (ep) card.addEventListener('click', () => selectEpisode(st.browseSeason, ep));
        });
        area.querySelectorAll('.episode-play-btn').forEach(btn => {
          btn.addEventListener('click', e => {
            e.stopPropagation();
            const ep = eps.find(e2 => e2.episode_number === parseInt(btn.dataset.episodeNumber, 10));
            if (ep) playUnit(null, st.browseSeason, ep);
          });
        });
        area.querySelectorAll('.shelf-arrow').forEach(btn => {
          btn.addEventListener('click', () => {
            const row = btn.closest('.shelf-wrapper')?.querySelector('.shelf-row');
            if (row) row.scrollBy({ left: parseInt(btn.dataset.dir, 10) * row.clientWidth * 0.75, behavior: 'smooth' });
          });
        });
        // 头图正讲的那一集滚进视野
        const stageCard = area.querySelector('.episode-card.stage');
        if (stageCard) stageCard.scrollIntoView({ inline: 'start', block: 'nearest' });
      };

      // 点分集卡：头图改讲这一集（续播点随单元重取），不起播；起播走悬停播放键或头图按钮
      const selectEpisode = (season, ep) => {
        if (!ep?.owned) return;
        st.season = season;
        st.episode = ep;
        loadUnitResume();
        renderEpisodeShelf();
      };

      const loadBrowse = async (seasonNumber) => {
        const request = st.browseRequest = (st.browseRequest || 0) + 1;
        st.browseSeason = seasonNumber;
        st.browseEpisodes = [];
        st.episodesLoading = true;
        renderEpisodeShelf();
        try {
          const resp2 = await api.getItemEpisodes(params.libraryId, mediaId, seasonNumber);
          if (!this.isCurrent(generation) || request !== st.browseRequest) return;
          const data = resp2?.data || resp2 || {};
          st.browseEpisodes = (data.episodes || data || []).slice();
          st.browseAnchor = data.resume_episode;
        } catch (e) {
          if (!this.isCurrent(generation) || request !== st.browseRequest || e.name === 'AbortError') return;
          console.error('Load episodes failed:', e);
        }
        st.episodesLoading = false;
        renderEpisodeShelf();
      };

      // ---- 初始化 ----
      // 收藏是整片级（Mac 头图那颗心也是）；已看/续播跟着头图那一集走
      try {
        const marksResp = await api.getMarks(mediaId);
        if (!this.isCurrent(generation)) return;
        st.favorite = !!(marksResp?.data || marksResp)?.is_favorite;
      } catch (_) {}

      if (isMovie) {
        await loadUnitResume();
      } else {
        // 「接下来继续」里那一集优先；否则第一个有片源的季（综艺常只收了最新一季）
        let preferred = null;
        try {
          const upNextResp = await api.getUpNext();
          if (!this.isCurrent(generation)) return;
          const upNext = this.unwrapItems(upNextResp).find(
            x => x.media_item_id === mediaId && x.kind === 'tv',
          );
          if (upNext) preferred = { season: upNext.season_number, episode: upNext.episode_number };
        } catch (_) {}
        const ownedSeasons = new Set(inPlace.map(f => f.season_number));
        const seasons = info.seasons || [];
        const start = (preferred && seasons.includes(preferred.season) ? preferred.season : null)
          ?? seasons.find(s => s > 0 && ownedSeasons.has(s))
          ?? seasons.find(s => ownedSeasons.has(s))
          ?? seasons.find(s => s > 0)
          ?? seasons[0];
        if (start != null) {
          st.season = start;
          await loadBrowse(start);
          if (!this.isCurrent(generation)) return;
          const eps = st.browseEpisodes;
          st.episode = (preferred?.season === start ? eps.find(e => e.episode_number === preferred.episode && e.owned) : null)
            || eps.find(e => e.episode_number === st.browseAnchor && e.owned)
            || this.resumeEpisode(eps)
            || eps[0]
            || null;
          await loadUnitResume();
          renderEpisodeShelf();
        } else {
          renderStage();
        }
      }

      // ---- 电影的作品系列 ----
      if (isMovie && info.series_collection_id) {
        try {
          const resp2 = await api.getCollectionSeries(info.series_collection_id);
          if (!this.isCurrent(generation)) return;
          const series = resp2?.data || resp2;
          if (series?.available && (series.parts || []).length > 1) {
            const area = document.getElementById('detailSeriesArea');
            area.innerHTML = this.shelfHtml(
              series.series_name || info.series_name || '系列',
              `已有 ${series.owned_count} / 共 ${series.total}`,
              'series-row',
              series.parts.map(part => this.seriesCardHtml(part, mediaId, params.libraryId)).join(''),
            );
            area.querySelectorAll('.series-card[data-item-id]').forEach(card => {
              card.addEventListener('click', () => {
                const id = parseInt(card.dataset.itemId, 10);
                if (id && id !== mediaId) this.navigate('detail', { libraryId: params.libraryId, itemId: id });
              });
            });
            area.querySelectorAll('.shelf-arrow').forEach(btn => {
              btn.addEventListener('click', () => {
                const row = btn.closest('.shelf-wrapper')?.querySelector('.shelf-row');
                if (row) row.scrollBy({ left: parseInt(btn.dataset.dir, 10) * row.clientWidth * 0.75, behavior: 'smooth' });
              });
            });
          }
        } catch (e) { console.error('Load series failed:', e); }
      }

      // ---- 事件绑定 ----
      document.getElementById('btnBack')?.addEventListener('click', () => {
        this.goBack();
      });

      // 合集 → 合集海报墙（原先只有 href="#"，点了没有反应）
      container.querySelectorAll('.collection-chip').forEach(chip => {
        chip.addEventListener('click', e => {
          e.preventDefault();
          const id = chip.dataset.collectionId;
          if (id) this.navigate('collection', { collectionId: id });
        });
      });

      // 演职员 → 人物页（TMDB 影人 id）
      container.querySelectorAll('.person-card[data-person-id]').forEach(card => {
        card.addEventListener('click', () => {
          const pid = card.dataset.personId;
          if (pid) this.navigate('person', { personId: pid });
        });
      });

      // 演职员横排的滚动箭头（这排是静态渲染的，没走 loadBrowse）
      container.querySelectorAll('.detail-lower .shelf-arrow').forEach(btn => {
        if (btn.dataset.bound) return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', () => {
          const row = btn.closest('.shelf-wrapper')?.querySelector('.shelf-row');
          if (row) row.scrollBy({ left: parseInt(btn.dataset.dir, 10) * row.clientWidth * 0.75, behavior: 'smooth' });
        });
      });

    } catch (e) {
      this.renderPageError(container, e, generation);
    }
  },

  // 一季里「接着看的那一集」：看了一半的 → 第一集没看过的 → 第一集（同 Mac resumeEpisode）
  resumeEpisode(episodes) {
    const owned = (episodes || []).filter(e => e.owned);
    return owned.find(e => e.position_ms > 0) || owned.find(e => !e.played) || owned[0] || (episodes || [])[0] || null;
  },

  // 「第 2 季 第 6 集 · 集名」（同 Mac MacStageInfo.episodeLine）：TMDB 没起名字的集不重复写
  episodeLine(season, ep) {
    const number = season === 0 ? `特别篇 第 ${ep.episode_number} 集` : `第 ${season} 季 第 ${ep.episode_number} 集`;
    const name = (ep.name || '').trim();
    if (!name || /^(第\s*\d+\s*集|Episode\s*\d+)$/i.test(name)) return number;
    return `${number} · ${name}`;
  },

  // 画质小标签：在位文件里各挑最好的一档（同 Mac MacMediaBadge.best）
  bestMediaBadges(files) {
    const resHeight = raw => {
      const s = String(raw || '').trim().toLowerCase();
      if (s === '8k') return 4320;
      if (s === '4k' || s === 'uhd') return 2160;
      if (s === '2k') return 1440;
      const n = s.replace(/[^0-9]/g, '');
      return n ? parseInt(n, 10) : 0;
    };
    const badges = [];
    const best = Math.max(0, ...files.map(f => resHeight(f.resolution)));
    if (best >= 4320) badges.push({ text: '8K', filled: true });
    else if (best >= 2160) badges.push({ text: '4K', filled: true });
    else if (best >= 720) badges.push({ text: 'HD', filled: true });
    const hdrPriority = ['Dolby Vision', 'HDR10+', 'HDR10', 'HLG', 'HDR'];
    const hdrs = files.map(f => f.hdr).filter(Boolean)
      .sort((a, b) => (hdrPriority.indexOf(a) + 1 || 99) - (hdrPriority.indexOf(b) + 1 || 99));
    if (hdrs.length) {
      const hdr = hdrs[0];
      badges.push({ text: hdr === 'Dolby Vision' ? 'DOLBY VISION' : hdr.toUpperCase(), filled: false });
    }
    const audio = files.flatMap(f => f.audio_streams || []);
    const described = audio.map(a => [a.profile, a.title, a.codec].filter(Boolean).join(' ').toLowerCase());
    if (described.some(s => s.includes('atmos'))) {
      badges.push({ text: 'DOLBY ATMOS', filled: false });
    } else if (described.some(s => s.includes('dts:x') || s.includes('dts-x'))) {
      badges.push({ text: 'DTS:X', filled: false });
    } else {
      const channels = Math.max(0, ...audio.map(a => a.channels || 0));
      if (channels >= 6) badges.push({ text: channels >= 8 ? '7.1' : '5.1', filled: false });
    }
    return badges;
  },

  // 演职员：导演在前（结构化 person 关系优先，没有退回姓名），演员跟着（同 Mac castPeople）
  castPeople(meta) {
    const people = [];
    const credits = meta.director_credits || [];
    if (credits.length) {
      credits.forEach(d => people.push({ name: d.name, role: '导演', avatar: d.thumb_url, personId: d.tmdb_person_id }));
    } else {
      [...new Set(meta.directors || [])].forEach(n => people.push({ name: n, role: '导演', avatar: null, personId: null }));
    }
    (meta.actors || []).forEach(a => people.push({
      name: a.name,
      role: (a.role || '').trim() ? `饰 ${a.role}` : '',
      avatar: a.thumb_url,
      personId: a.tmdb_person_id,
    }));
    return people;
  },

  // 头图右下角的演职员：「导演 某某」「主演 某某、某某」（同 Apple TV App）
  detailCreditsHtml(cast) {
    const directors = cast.filter(p => p.role === '导演');
    const actors = cast.filter(p => p.role !== '导演');
    const line = (label, names) => (names.length
      ? `<div class="credit-line"><span class="credit-label">${escapeHtml(label)}</span><span class="credit-names">${escapeHtml(names.join('、'))}</span></div>`
      : '');
    const html = line('导演', directors.slice(0, 1).map(p => p.name)) + line('主演', actors.slice(0, 3).map(p => p.name));
    return html ? `<div class="detail-credits">${html}</div>` : '';
  },

  // 横排货架（同 Mac MacShelf）：标题 + 说明小字 + 一排卡
  shelfHtml(title, detail, rowClass, cardsHtml) {
    return `
      <div class="detail-section">
        <div class="shelf-header">
          <h2 class="shelf-title">${escapeHtml(title)}</h2>
          ${detail ? `<span class="shelf-detail">${escapeHtml(detail)}</span>` : ''}
        </div>
        <div class="shelf-wrapper">
          <button class="shelf-arrow shelf-arrow-left" data-dir="-1" aria-label="向左">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div class="shelf-row ${rowClass}">${cardsHtml}</div>
          <button class="shelf-arrow shelf-arrow-right" data-dir="1" aria-label="向右">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      </div>
    `;
  },

  // 分集卡（同 Mac MacEpisodeCard）：剧照 + 已看角标 + 左下「看到 mm:ss / ▶ 片长」压进度条，
  // 悬停浮出播放键；下面第几集、集名、三行简介、首播日期（缺集写「缺集」并置灰）
  episodeCardHtml(ep, st, runtimeMinutes) {
    const inProgress = ep.position_ms > 0;
    const bandText = inProgress ? `看到 ${fmtClock(ep.position_ms)}` : (runtimeMinutes ? `▶ ${fmtRuntime(runtimeMinutes)}` : '');
    const isStage = !!st.episode && ep.owned && st.browseSeason === st.season
      && ep.episode_number === st.episode.episode_number;
    return `
      <div class="episode-card ${ep.owned ? '' : 'missing'} ${isStage ? 'stage' : ''}" data-episode-number="${Number(ep.episode_number)}">
        <div class="episode-art">
          ${ep.still_url ? `<img src="${escapeHtml(resolveUrl(ep.still_url))}" alt="" data-raw="${escapeHtml(ep.still_url)}" onerror="imgFallback(this, this.dataset.raw)">` : ''}
          ${ep.played ? `
            <div class="episode-watched">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="5 13 10 18 19 6"/></svg>
              已看
            </div>
          ` : ''}
          ${ep.owned ? `
            <div class="episode-hover">
              <button class="episode-play-btn" data-episode-number="${Number(ep.episode_number)}" title="播放">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              </button>
            </div>
          ` : ''}
          ${bandText || inProgress ? `
            <div class="episode-band">
              ${bandText ? `<div class="episode-band-text">${bandText}</div>` : ''}
              ${inProgress && ep.progress_percent ? `<div class="episode-progress"><div class="episode-progress-fill" style="width:${Math.max(0, Math.min(100, Number(ep.progress_percent) || 0))}%"></div></div>` : ''}
            </div>
          ` : ''}
        </div>
        <div class="episode-info">
          <div class="episode-ep">第 ${Number(ep.episode_number)} 集</div>
          <div class="episode-title">${escapeHtml(ep.name || '第 ' + ep.episode_number + ' 集')}</div>
          <div class="episode-overview">${escapeHtml(ep.overview)}</div>
          <div class="episode-subtitle">${escapeHtml(ep.owned ? (ep.air_date ? String(ep.air_date).slice(0, 10) : '') : '缺集')}</div>
        </div>
      </div>
    `;
  },

  // 演职员一格（同 Mac MacPersonCard）：圆头像 + 姓名 + 身份；有 TMDB 影人 id 的点进人物页
  personCardHtml(p) {
    return `
      <div class="person-card" ${p.personId ? `data-person-id="${Number(p.personId)}"` : ''}>
        ${p.avatar
          ? `<img class="person-card-avatar" src="${escapeHtml(resolveUrl(p.avatar))}" alt="" data-raw="${escapeHtml(p.avatar)}" onerror="imgFallback(this, this.dataset.raw)">`
          : '<div class="person-card-avatar person-card-avatar-placeholder"></div>'}
        <div class="person-card-name">${escapeHtml(p.name)}</div>
        <div class="person-card-role">${escapeHtml(p.role)}</div>
      </div>
    `;
  },

  // 系列里的一部：本片标「本片」、没入库的置灰标「未入库」（同 Mac seriesShelf）
  seriesCardHtml(part, currentId, libraryId) {
    const current = part.media_item_id === currentId;
    const missing = part.media_item_id == null;
    return `
      <div class="series-card ${missing ? 'missing' : ''}" ${part.media_item_id != null ? `data-item-id="${Number(part.media_item_id)}"` : ''} data-library-id="${Number(libraryId)}">
        <div class="series-art">
          ${part.poster_url ? `<img src="${escapeHtml(resolveUrl(part.poster_url))}" alt="" data-raw="${escapeHtml(part.poster_url)}" onerror="imgFallback(this, this.dataset.raw)">` : ''}
          ${current ? '<div class="series-badge">本片</div>' : missing ? '<div class="series-badge">未入库</div>' : ''}
        </div>
        <div class="series-title">${escapeHtml(part.title)}</div>
        <div class="series-year">${escapeHtml(part.release_date ? String(part.release_date).slice(0, 4) : '')}</div>
      </div>
    `;
  },

  // 页底信息（同 Apple Music 专辑页的发行信息）：事实 + 电影的在位版本
  detailInfoHtml(info, meta, inPlace, isMovie, seasonCount) {
    const facts = [];
    if (info.original_title && info.original_title !== info.title) facts.push(['原名', info.original_title]);
    if (info.year) facts.push(['年份', String(info.year)]);
    if ((meta.genres || []).length) facts.push(['类型', meta.genres.join(' / ')]);
    if (meta.rating) facts.push(['评分', Number(meta.rating).toFixed(1)]);
    if (isMovie) {
      if (meta.runtime_minutes > 0) facts.push(['片长', fmtRuntime(meta.runtime_minutes)]);
    } else if (seasonCount > 0) {
      facts.push(['季数', `${seasonCount} 季`]);
    }
    const inPlaceSize = inPlace.reduce((n, f) => n + (f.size_bytes || 0), 0);
    facts.push(['文件', inPlace.length ? `${inPlace.length} 个 · ${fmtBytes(inPlaceSize)}` : '没有在位的文件']);
    const versions = isMovie ? inPlace.map(f => [
      f.resolution,
      f.video_codec ? String(f.video_codec).toUpperCase() : null,
      f.hdr,
      fmtBytes(f.size_bytes),
    ].filter(Boolean).join(' · ')) : [];
    return `
      <div class="detail-section detail-info">
        <h2 class="shelf-title">信息</h2>
        <div class="detail-info-cols">
          <div class="detail-info-grid">
            ${facts.map(([k, v]) => `<div class="info-row"><span class="info-label">${escapeHtml(k)}</span><span class="info-value">${escapeHtml(v)}</span></div>`).join('')}
          </div>
          ${versions.length ? `
            <div class="detail-versions">
              <div class="info-label">版本</div>
              ${versions.map(v => `<div class="version-line">${escapeHtml(v)}</div>`).join('')}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  },

  posterCard(item, defaultLibId) {
    // LibraryItemView 字段：media_item_id, title, year, poster_url, rating, is_favorite, seasons, episode_count, kind
    // UpNextItemView 额外字段：progress_percent, position_ms, duration_ms, season_number, episode_number
    const progress = item.progress_percent != null ? item.progress_percent / 100 : 0;
    const itemId = item.media_item_id || '';
    const libId = item.library_id ?? defaultLibId ?? '';
    const title = item.title || '未知';
    const rawPoster = item.poster_url || '';
    const posterUrl = resolveUrl(rawPoster);
    const year = item.year || '';
    const rating = item.rating;
    const isFav = item.is_favorite;
    return `
      <div class="poster-card" role="button" tabindex="${item.source_missing ? '-1' : '0'}" aria-disabled="${item.source_missing ? 'true' : 'false'}" style="${item.source_missing ? 'opacity:0.45' : ''}" data-item-id="${escapeHtml(itemId)}" data-library-id="${escapeHtml(libId)}">
        <div class="poster-art">
          ${rawPoster ? `<img src="${escapeHtml(posterUrl)}" alt="" loading="lazy" style="opacity:0;transition:opacity 0.3s" data-raw="${escapeHtml(rawPoster)}" onload="this.style.opacity='1'" onerror="imgFallback(this, this.dataset.raw)">` : ''}
          <div class="focus-glow"></div>
          ${isFav ? '<div class="poster-fav"><svg width="14" height="14" viewBox="0 0 24 24" fill="#ff375f"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></div>' : ''}
          ${progress > 0 && progress < 1 ? `
            <div class="poster-progress">
              <div class="poster-progress-fill" style="width:${Math.round(progress * 100)}%"></div>
            </div>
          ` : ''}
        </div>
        <div class="poster-info">
          <div class="poster-title">${escapeHtml(title)}</div>
          <div class="poster-subtitle">${[
            year,
            rating != null ? Number(rating).toFixed(1) : '',
            item.match_label || '',
            item.kind === 'tv' && item.seasons?.length ? item.seasons.length + ' 季' : (item.episode_count > 0 ? item.episode_count + ' 集' : '')
          ].filter(Boolean).map(escapeHtml).join(' · ')}</div>
        </div>
      </div>
    `;
  },

  bindPosterCards(container) {
    container.querySelectorAll('.poster-card').forEach(card => {
      if (card.dataset.bound) return;
      card.dataset.bound = '1';
      const open = () => {
        if (card.getAttribute('aria-disabled') === 'true') return;
        const itemId = card.dataset.itemId;
        const libId = card.dataset.libraryId;
        if (itemId && libId) {
          this.navigate('detail', { libraryId: libId, itemId });
        }
      };
      card.addEventListener('click', open);
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
      // macOS focus 效果：鼠标追踪光晕 + 微倾斜
      card.addEventListener('mousemove', (e) => {
        const rect = card.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top) / rect.height;
        card.style.setProperty('--mouse-x', (x * 100).toFixed(1) + '%');
        card.style.setProperty('--mouse-y', (y * 100).toFixed(1) + '%');
        const tiltX = (y - 0.5) * -8;
        const tiltY = (x - 0.5) * 8;
        const art = card.querySelector('.poster-art');
        if (art) art.style.transform = `rotateX(${tiltX.toFixed(1)}deg) rotateY(${tiltY.toFixed(1)}deg)`;
      });
      card.addEventListener('mouseleave', () => {
        const art = card.querySelector('.poster-art');
        if (art) art.style.transform = '';
      });
    });
  },

  // ===== 设置 =====
  renderSettings(container) {
    const generation = this.viewGeneration;
    container.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">设置</h1>
      </div>
      <div class="settings-body">
        <div class="settings-card">
          <h3>播放设置</h3>
          <div class="settings-row">
            <span>自动播放下一集</span>
            <label class="settings-toggle">
              <input type="checkbox" id="setAutoNext" ${localStorage.getItem('mc_autoNext') !== '0' ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row">
            <span>硬件解码</span>
            <label class="settings-toggle">
              <input type="checkbox" id="setHwDecode" ${localStorage.getItem('mc_hwDecode') !== '0' ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="settings-row">
            <span>默认字幕语言</span>
            <select id="setSubLang" class="settings-select">
              <option value="">关闭</option>
              <option value="zh" ${localStorage.getItem('mc_subLang') === 'zh' ? 'selected' : ''}>中文</option>
              <option value="en" ${localStorage.getItem('mc_subLang') === 'en' ? 'selected' : ''}>English</option>
            </select>
          </div>
          <div class="settings-row">
            <span>默认音轨语言</span>
            <select id="setAudioLang" class="settings-select">
              <option value="">自动</option>
              <option value="zh" ${localStorage.getItem('mc_audioLang') === 'zh' ? 'selected' : ''}>中文</option>
              <option value="en" ${localStorage.getItem('mc_audioLang') === 'en' ? 'selected' : ''}>English</option>
            </select>
          </div>
        </div>

        <div class="settings-card">
          <h3>服务器</h3>
          <div class="settings-row">
            <span>当前服务器</span>
            <span style="color:var(--text-secondary)">${escapeHtml(API.baseUrl || '未配置')}</span>
          </div>
          <div class="settings-actions">
            <button class="btn-secondary" id="btnSwitchServer">更改服务器</button>
            <button class="btn-secondary btn-danger" id="btnLogout">退出登录</button>
          </div>
        </div>

        <div class="settings-card">
          <h3>账号</h3>
          <div id="accountList">
            <div style="color:var(--text-secondary);padding:8px 0">加载中...</div>
          </div>
          <div class="settings-actions">
            <button class="btn-secondary" id="btnAddAccount">添加账号</button>
            <button class="btn-secondary" id="btnQRLogin">QR 配对登录</button>
          </div>
          <div id="qrArea" style="margin-top:12px;display:none">
            <div id="qrCode" style="text-align:center;padding:20px;background:var(--surface-inset);border-radius:var(--radius-md)">
              <div style="font-size:13px;color:var(--text-secondary)">请使用手机扫码配对</div>
              <div id="qrCodeData" style="margin:12px 0;font-family:monospace;font-size:20px;letter-spacing:4px;color:var(--accent)"></div>
              <div style="font-size:12px;color:var(--text-tertiary)">在 MovieClaw 服务器「设备管理」中扫描或输入配对码</div>
            </div>
          </div>
        </div>

        <div class="settings-card">
          <h3>关于</h3>
          <p>MovieClaw Desktop</p>
          <p style="color:var(--text-secondary);margin-top:4px;" id="settingsVersion">正在读取版本…</p>
          <button class="btn-secondary" id="btnCheckUpdates">检查更新</button>
        </div>
      </div>
    `;
    window.__TAURI__.core.invoke('get_app_version').then(version => {
      if (this.isCurrent(generation)) document.getElementById('settingsVersion').textContent = '版本 ' + version;
    }).catch(() => {
      if (this.isCurrent(generation)) document.getElementById('settingsVersion').textContent = '版本信息暂不可用';
    });

    // 事件绑定
    document.getElementById('btnCheckUpdates')?.addEventListener('click', () => window.DesktopUpdates?.check());
    document.getElementById('setAutoNext')?.addEventListener('change', (e) => {
      localStorage.setItem('mc_autoNext', e.target.checked ? '1' : '0');
    });
    document.getElementById('setHwDecode')?.addEventListener('change', (e) => {
      localStorage.setItem('mc_hwDecode', e.target.checked ? '1' : '0');
    });
    document.getElementById('setSubLang')?.addEventListener('change', (e) => {
      localStorage.setItem('mc_subLang', e.target.value);
    });
    document.getElementById('setAudioLang')?.addEventListener('change', (e) => {
      localStorage.setItem('mc_audioLang', e.target.value);
    });
    document.getElementById('btnSwitchServer')?.addEventListener('click', () => this.changeServer());
    document.getElementById('btnLogout')?.addEventListener('click', async () => {
      if (this._authPending || this._changingContext) return;
      if (!window.confirm('退出当前账号？其他已保存账号会保留。')) return;
      try {
        await this.resetContext();
        const response = await API.request('/auth/logout', { method: 'POST' });
        this.session = null;
        if (response?.data) await this.enterSession(response);
        else this.renderLogin();
      } catch (error) { this.renderConnectionState('unreachable', error.message); }
    });

    // 多账号列表
    this.loadAccounts();

    // 添加账号
    document.getElementById('btnAddAccount')?.addEventListener('click', async () => {
      await Player.close();
      this.renderLogin({ addAccount: true });
    });

    // The full device-token welcome flow is not part of this release; do not call nonexistent QR endpoints.
    document.getElementById('btnQRLogin')?.addEventListener('click', () => {
      const area = document.getElementById('qrArea');
      area.style.display = 'block';
      area.textContent = '此版本请使用账号密码登录，扫码登录暂不可用。';
    });
  },

  async loadAccounts() {
    const generation = this.viewGeneration;
    const api = this.pageAPI || API;
    const list = document.getElementById('accountList');
    if (!list) return;
    try {
      const accounts = this.unwrapItems(await api.listAccounts());
      if (!this.isCurrent(generation)) return;
      list.innerHTML = accounts.map(acc => `
        <div class="settings-row" data-username="${escapeHtml(acc.username)}">
          <span>${escapeHtml(acc.nickname || acc.username)}</span><div>
            ${acc.active ? '<span style="color:var(--accent);font-size:12px">当前</span>' : '<button class="btn-secondary account-switch" style="padding:4px 12px;font-size:12px">切换</button>'}
            <button class="btn-secondary account-remove" style="padding:4px 12px;font-size:12px">移除</button>
          </div>
        </div>`).join('') || '<div style="color:var(--text-secondary)">没有已保存账号</div>';
      list.querySelectorAll('.account-switch').forEach(button => button.addEventListener('click', () => this.switchToAccount(button.closest('[data-username]').dataset.username)));
      list.querySelectorAll('.account-remove').forEach(button => button.addEventListener('click', async () => {
        if (this._authPending || this._changingContext) return;
        const username = button.closest('[data-username]').dataset.username;
        if (!window.confirm(`从这台电脑移除“${username}”的登录状态？`)) return;
        button.disabled = true;
        try {
          await this.resetContext();
          const response = await API.removeAccount(username);
          this.session = null;
          if (response?.data) await this.enterSession(response);
          else this.renderLogin();
        } catch (error) {
          if (error.status === 401) this.renderLogin({ message: '登录已失效，请重新输入密码。' });
          else this.renderConnectionState('unreachable', error.message);
        }
      }));
    } catch (error) {
      if (!this.isCurrent(generation) || error.name === 'AbortError') return;
      if (error.status === 401) { this.handleSessionExpired(); return; }
      list.textContent = '无法读取账号：' + error.message;
    }
  },

  async switchToAccount(username) {
    if (this._authPending || this._changingContext) return;
    try {
      await this.resetContext();
      const response = await API.switchAccount(username);
      await this.enterSession(response);
    } catch (error) {
      if (error.status === 404 || error.status === 401) {
        this.renderLogin({ addAccount: true, username, message: '该账号的登录已失效，请重新输入密码。' });
      } else this.renderConnectionState('unreachable', '切换失败：' + error.message);
    }
  },

  // ===== 播放（内置 HTML5 播放器） =====
  async startPlayback(item, isRetry) {
    if (this._authPending || this._changingContext) return;
    item = { ...item };
    if (!item.attemptId) item.attemptId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    // 错误对话框的「重试」要重跑这一份（同 macOS retry() 重新 request）
    this._retryItem = item;
    this._retryStartMs = null;
    // 连点/返回竞态：新请求立即作废旧请求（清掉上一部的播放器状态），
    // 后续每个 await 之后用 alive() 检查，旧请求回来不再碰界面
    const closing = Player.close({ hide: false });
    if (!isRetry || item.__resetFailures) {
      // 全新播放：清掉上一轮的降档记录（web-player.md §6.3 的 failed_tiers 回路）
      this._failedTiers = [];
      this._contentFailures = 0;
      this._netRestarts = 0;
    }
    delete item.__resetFailures;
    const seq = (this._playbackSeq = (this._playbackSeq || 0) + 1);
    const alive = () => this._playbackSeq === seq;
    let session = null;

    const loadingText = document.getElementById('playerLoadingText');
    const loading = document.getElementById('playerLoading');
    const playerView = document.getElementById('playerView');
    const titleEl = document.getElementById('playerTitle');
    if (titleEl) titleEl.textContent = item.title || 'MovieClaw';

    // 显示加载状态
    playerView.hidden = false;
    loading.hidden = false;
    if (loadingText) loadingText.textContent = '正在获取播放链接...';

    try {
      await closing;
      if (!alive()) return;

      if (!API.baseUrl) throw new Error('未配置服务器地址');

      const mediaId = Number(item.media_item_id);
      if (!mediaId || isNaN(mediaId)) throw new Error('无效的媒体项 ID: ' + item.media_item_id);

      // TV 剧集需要季/集号 — 若未指定则自动选择。
      // 详情页起播已把 kind 带在 item 上（和 files 同理）：已知就不用为判「是不是剧集」
      // 再查一遍详情——电影起播链上少一次串行往返
      if (item.seasonNumber == null || item.episodeNumber == null) {
        try {
          let detail = item.kind != null ? { kind: item.kind } : null;
          if (!detail) {
            const detailResp = await API.getItemDetail(item.library_id || this.libraries[0]?.id, mediaId);
            detail = detailResp?.data || detailResp;
          }
          if (!alive()) return;
          if (detail?.files && !item.files) item.files = detail.files;
          if (detail?.kind) item.kind = detail.kind;
          if (detail?.kind === 'tv') {
            // 优先用续播信息
            try {
              const resumeResp = await API.getResume(mediaId);
              const resume = resumeResp?.data || resumeResp;
              if (!alive()) return;
              if (resume?.season_number != null && resume?.episode_number != null) {
                item.seasonNumber = resume.season_number;
                item.episodeNumber = resume.episode_number;
              }
            } catch (_) {}
            // 若仍无，获取第一季第一集（未观看的优先）
            if (item.seasonNumber == null) {
              const seasons = detail.seasons || [1];
              const firstSeason = seasons.find(s => s >= 1) || seasons[0] || 1;
              try {
                const epsResp = await API.getItemEpisodes(item.library_id || this.libraries[0]?.id, mediaId, firstSeason);
                const epsData = epsResp?.data || epsResp || {};
                const eps = epsData.episodes || [];
                const ep = eps.find(e => !e.played) || eps[0];
                if (ep) {
                  item.seasonNumber = firstSeason;
                  item.episodeNumber = ep.episode_number;
                }
                item.episodes = eps;
              } catch (_) {}
            }
          }
        } catch (_) { /* 获取详情失败则按电影处理 */ }
      }
      if (!alive()) return;

      if (item.seasonNumber > 0 && item.episodeNumber > 0 && !Array.isArray(item.episodes)) {
        try {
          const response = await API.getItemEpisodes(item.library_id || this.libraries[0]?.id, mediaId, item.seasonNumber);
          item.episodes = (response?.data || response)?.episodes || [];
        } catch (_) { item.episodes = []; }
        if (!alive()) return;
      }

      // ---- 能力申报分级（对齐 macOS PlayerCapability.native()）----
      // mpv 在场且这单片源 HTML5 啃不动 → 报 universal 换 tier-0 原文件直出，交给 mpv；
      // 否则报浏览器真值，服务端据此直通/换壳/转码。报了 universal 就必须真让 mpv 播：
      // 档 0 给的是裸文件地址，HTML5 啃不动 mkv/ISO
      //
      // 例外：用户限了画质上限就绝不能报 universal——decide.py 的 universal 分支
      // 故意不受 max_height 影响（全解码客户端自己拉流），报了还是原文件直出、上限
      // 整个失效。按浏览器真值申报让服务端按上限转码，交 HTML5 放（对齐 macOS
      // negotiationInputs「限了画质时按系统播放器的能力申报，让服务端按上限转码」）
      const qualityCapped = item.__maxHeight > 0;
      const mpvReady = await this.hasEmbeddedPlayer();
      if (!alive()) return;
      let wantsMpv = false;
      if (mpvReady && !item.__forceHtml5 && !qualityCapped) {
        // 详情页起播已把 files 带在 item 上（省一次详情请求）；别的入口没有就现查
        let files = item.files;
        if (!files) {
          try {
            const d = await API.getItemDetail(item.library_id || this.libraries[0]?.id, mediaId);
            files = (d?.data || d)?.files;
            if (files) item.files = files;
          } catch (_) { /* 查不到片源元数据就不报 universal，按浏览器真值走 */ }
        }
        const unitFile = this.pickUnitFile(files, item.seasonNumber, item.episodeNumber);
        wantsMpv = !!unitFile && this.needsNativePlayer(unitFile, unitFile.audio_streams);
      }
      item.__universalClaim = wantsMpv;

      const body = {
        media_item_id: mediaId,
        // 真实解码能力（探测一次后缓存）：报空数组会让服务端判定浏览器
        // 什么都不支持 → 所有影片全量转码，起播慢、个别文件决策卡死
        capability: wantsMpv ? getUniversalCapabilitySnapshot() : await getCapabilitySnapshot(),
        client: 'web',
        attempt_id: item.attemptId,
      };
      if (item.file_id != null) body.file_id = Number(item.file_id);
      if (item.audio_track != null) body.audio_track = item.audio_track;
      if (item.subtitle_track != null) body.subtitle_track = item.subtitle_track;
      if (item.seasonNumber != null) body.season_number = Number(item.seasonNumber);
      if (item.episodeNumber != null) body.episode_number = Number(item.episodeNumber);
      // 上几档播失败了：带上让服务端跳过它们换下一档（decide.py 降档回路）
      if (this._failedTiers && this._failedTiers.length) body.failed_tiers = this._failedTiers;

      // 续播位置：详情页「从头播放」带 startMs=0 必须显式传——缺省时
      // 服务端会自己按观看记录续播（playback.py resolved_start_ms）。
      // 不传就别再抢着问一次 /resume：服务端开会话时本来就把续播点并进
      // start_ms 一起带回，前端先问一遍等于起播链上白加一次串行往返
      if (item.startMs != null) {
        body.start_ms = item.startMs;
      }
      // 画质上限（decide.py 的 max_height 参数）：只有不报 universal 时它才生效
      if (qualityCapped) body.max_height = item.__maxHeight;
      if (!alive()) return;

      // 服务端个别文件的决策/转码准备可能极慢：45 秒无响应给出明确错误，
      // 而不是永远停在「正在获取播放链接...」
      let sessionTimeout;
      let sessionResp;
      let timedOut = false;
      try {
        // 创建会话不硬取消：迟到响应里才有可 DELETE 的会话 id。
        const request = API.request('/playback/sessions', { method: 'POST', body, timeoutMs: 0 }).then((response) => {
          if (!alive() || timedOut) this.releasePlaybackSession(response?.data || response);
          return response;
        });
        sessionResp = await Promise.race([
          request,
          new Promise((_, reject) => {
            sessionTimeout = setTimeout(() => { timedOut = true; reject(new Error('播放服务响应超时，请稍后重试')); }, 45000);
          }),
        ]);
      } finally {
        clearTimeout(sessionTimeout);
      }
      if (!alive()) return;
      session = sessionResp?.data || sessionResp;

      // 决策三态（同 macOS PlaybackController.handleSession）：
      // consent = 要用户同意开软件转码；rejected = 彻底放不了。两者都换对话框，
      // 不再像别的错误那样 5 秒后自己消失——用户还没表态
      const outcome = session?.decision ? session.decision.outcome : null;
      if (outcome === 'consent') {
        this.releasePlaybackSession(session);
        if (loading) loading.hidden = true;
        Player.showConsentDialog(session.decision);
        return;
      }
      if (outcome === 'rejected') {
        this.releasePlaybackSession(session);
        this._showPlaybackError(session.decision.reason || '播放不可用', session.decision.suggestion);
        return;
      }
      if (outcome && outcome !== 'plan') {
        throw new Error('播放不可用: ' + (session.decision.reason || outcome));
      }
      if (!session?.stream_url) throw new Error('服务器未返回播放地址');

      // 处理流地址
      const origin = API.baseUrl;
      const streamUrl = session.stream_url.startsWith('http')
        ? session.stream_url
        : origin + (session.stream_url.startsWith('/api/') ? session.stream_url : '/api/v1' + (session.stream_url.startsWith('/') ? session.stream_url : '/' + session.stream_url));

      const subtitleUrls = (session.subtitle_urls || []).map(s =>
        s.startsWith('http') ? s : origin + (s.startsWith('/api/') ? s : '/api/v1' + (s.startsWith('/') ? s : '/' + s))
      );

      const isSessionTimeline = session.session_id && session.timeline === 'session';
      const startMs = isSessionTimeline ? 0 : (session.start_ms ?? body.start_ms ?? 0);

      // 保存必要字段到 session 中供进度上报使用
      if (!session.media_item_id) session.media_item_id = mediaId;
      session.library_id = item.library_id ?? null;
      if (session.season_number == null) session.season_number = item.seasonNumber ?? null;
      if (session.episode_number == null) session.episode_number = item.episodeNumber ?? null;

      // 起播引擎：申报了 universal 的一定要 mpv 播（裸文件 HTML5 啃不动），
      // 其余按会话给出的片源特征判断（与改前一致）。
      // __forceHtml5 是上一轮 mpv 没起来的重谈：这回一律 HTML5，别再试一遍 mpv
      const source = session.source || {};
      const decision = session.decision || {};
      const needsNative = !item.__forceHtml5 && !qualityCapped
        && (wantsMpv || (mpvReady && this.needsNativePlayer(source, decision.audio_tracks || [])));

      if (needsNative && window.__TAURI__) {
        loading.hidden = true;
        // 档 0 直出的是裸文件，mpv 自己就 demux 得出 MKV 内封字幕轨。再把
        // embedded:N 当 --sub-file 传进去：轨重复一遍，还让服务端现场从几十 GB
        // 的 MKV 里逐条抽字幕——同一部片 10 条字幕首播实测 30 秒没出首帧。
        // 只留外挂字幕（容器里没有，必须旁挂）。HLS 档的流里没有内封轨，全留
        const nativeSubs = decision.tier === 0
          ? subtitleUrls.filter((s) => !decodeURIComponent(s).includes('track=embedded:'))
          : subtitleUrls;
        await this.openEmbeddedPlayer(item, streamUrl, nativeSubs, startMs, session, seq);
      } else {
        // 打开内置 HTML5 播放器
        loading.hidden = true;
        Player.open(item.title || 'MovieClaw', streamUrl, subtitleUrls, startMs, session, item);
      }

    } catch (e) {
      if (session?.session_id && Player.sessionId !== session.session_id) this.releasePlaybackSession(session);
      if (!alive()) return; // 已被新的播放请求取代，别覆盖新界面
      console.error('Playback error:', e);
      // 错误对话框（重试/关闭）代替「5 秒后自己消失」的加载文案：用户还没表态
      this._showPlaybackError((e && e.message) || String(e));
    }
  },

  releasePlaybackSession(session) {
    if (session?.session_id) return API.sessionStop(session.session_id).catch(() => {});
    return Promise.resolve();
  },

  restartPlaybackAt(positionMs, overrides = {}) {
    if (!Player.context) return;
    return this.startPlayback({ ...Player.context, startMs: positionMs, ...overrides }, true);
  },

  // 首帧前播放失败（解不了 / 无数据）→ failed_tiers 降档回路（web-player.md §6.3）：
  // 把当前档记入失败集合重开会话，服务端跳过它们换下一档；连败两次直接一步到兜底转码档。
  // 典型场景：直通重封装产出的 init.mp4 hvcC 缺参数集（源片 CodecPrivate 为空），
  // 浏览器 MSE 拒收 → 换转码档重新编码即可修复
  onPlaybackContentFailed(reason) {
    const view = document.getElementById('playerView');
    if (view && view.hidden) return; // 用户已关闭播放器，不再重试
    const sd = Player.sessionData;
    // 同一次播放的重复上报必须静默忽略（hls 同帧连发多个 buffer fatal、destroy 尾声再报一次）：
    // 第一个已发起降档重试，若后续重复走 _showPlaybackError → Player.close() 会推进
    // _playbackSeq，把刚发起的重试在首个 await 处作废（2026-10-09 真机：3 个 fatal
    // 挤掉唯一一次重试，重试的会话 POST 根本没发出去）
    if (sd && sd.__contentFailed) return;
    if (!sd) {
      this._showPlaybackError(reason);
      return;
    }
    sd.__contentFailed = true;
    const tier = sd.decision && typeof sd.decision.tier === 'number' ? sd.decision.tier : null;
    if (tier === null) {
      this._showPlaybackError(reason);
      return;
    }
    const failed = new Set(this._failedTiers || []);
    failed.add(tier);
    this._contentFailures = (this._contentFailures || 0) + 1;
    if (this._contentFailures >= 2) {
      for (let t = 0; t < 4; t += 1) failed.add(t);
    }
    if (tier >= 4) {
      this._showPlaybackError(reason + '（已尝试所有播放方式）');
      return;
    }
    this._failedTiers = [...failed].sort((a, b) => a - b);
    const loadingText = document.getElementById('playerLoadingText');
    if (loadingText) loadingText.textContent = '正在切换播放方式...';
    // 降档是「换一档接着看」，不是「从头再来」：把当前位置带上（startPlayback 会先
    // Player.close()，位置必须在这之前读）
    const resumeMs = Math.floor(Player.engPos() * 1000);
    this.restartPlaybackAt(resumeMs, Player.isMpv() ? { __forceHtml5: true } : {});
  },

  // 缓冲见底且连续 N 秒一个字节都没收到（StallWatch 的 .dead）→ 同档原地重开。
  // 预算连续 2 次（NetworkRestartBudget）：归因可能出错，防「网络」误判导致无限重开
  onPlaybackNetworkDead(reason) {
    const view = document.getElementById('playerView');
    if (view && view.hidden) return;
    const sd = Player.sessionData;
    if (!sd || sd.__networkRestarting) return;
    sd.__networkRestarting = true;
    this._netRestarts = (this._netRestarts || 0) + 1;
    const loadingText = document.getElementById('playerLoadingText');
    if (this._netRestarts > 2) {
      // 预算用尽：原文件直出没得可降，落错误页；服务端流还能走降档回路
      const tier = sd && sd.decision ? sd.decision.tier : null;
      if (tier === 0) this._showPlaybackError(reason + '（已多次重连失败）');
      else this.onPlaybackContentFailed(reason);
      return;
    }
    if (loadingText) loadingText.textContent = '连接中断，正在重连...';
    const resumeMs = Math.floor(Player.engPos() * 1000);
    this.restartPlaybackAt(resumeMs);
  },

  // 真播起来过就清网络重开预算（同 macOS reachedPlaying()）
  onPlaybackRecovered() {
    this._netRestarts = 0;
  },

  // 终态错误：清掉播放器与服务端会话，换成「重试 / 关闭」对话框
  // （同 macOS fail() → phase .error → MacPlayerDialog(title:message:重试:关闭)）
  _showPlaybackError(reason, suggestion) {
    // 位置要在 close() 之前读：close 会把 <video> 的 src 摘掉
    const resumeMs = Math.floor(Player.engPos() * 1000);
    this._retryStartMs = Player.context ? resumeMs : null;
    Player.close();
    const view = document.getElementById('playerView');
    const loading = document.getElementById('playerLoading');
    if (view) view.hidden = false;
    if (loading) loading.hidden = true;
    Player.showPlayerDialog({
      title: reason,
      message: suggestion || null,
      primary: ['重试', () => this.retryPlayback()],
      secondary: ['关闭', () => Player.close()],
    });
  },

  // 对话框「重试」：上一次播放以失败收尾，这是一次新的（同 macOS retry()）。
  // 起播链里的 Player.close() 会顺手把对话框收掉
  retryPlayback() {
    const item = this._retryItem;
    if (!item) { Player.close(); return; }
    const next = Object.assign({}, item);
    if (this._retryStartMs != null) next.startMs = this._retryStartMs;
    delete next.attemptId;
    this.startPlayback(next);
  },

  // 同意弹窗「开启并播放」：写入全局开关后重新决策（同 macOS grantConsent）。
  // 失败不关框——原因就显示在框里，用户还能再点一次
  async grantConsent() {
    const seq = this._playbackSeq;
    const saved = await API.playbackPolicySet({ software_transcode_enabled: true });
    if (seq !== this._playbackSeq) return;
    const view = (saved && saved.data !== undefined) ? saved.data : saved;
    // 保存接口回显的是落库后的取值：不是 true 说明开关根本没生效，不能假装成功
    if (!view || view.software_transcode_enabled !== true) {
      throw new Error('软件转码开关保存后未生效，请重试或查看服务端日志');
    }
    this.retryPlayback();
  },

  // 播放结束 → 自动下一集
  // 下一集按同季剧集表算（服务端会话没有 next_episode 字段，旧代码读它这一段从没跑过）。
  // 把剧集表条目补成 showAutoNextCard 认的形状，卡片本身不动
  onPlaybackEnded() {
    if (localStorage.getItem('mc_autoNext') === '0') return;
    const next = Player.nextEpisode();
    if (!next) return;
    this.showAutoNextCard({
      context: Player.context,
      media_item_id: Player.sessionData?.media_item_id ?? Player.mediaItemId,
      title: next.name || `第 ${next.episode_number} 集`,
      season_number: Player.seasonNumber,
      episode_number: next.episode_number,
    });
  },

  // 这单片源 HTML5 是否啃不动（DV/全景声/TrueHD/MKV/冷门编码）→ 要原生引擎。
  // audioTracks 形状两用：detail.files[].audio_streams（codec+profile）和
  // decision.audio_tracks（只有 codec）。触发词常在 profile 里——
  // 实测 3301 是 codec:"dts" + profile:"DTS-HD MA + DTS:X"，4425 是
  // codec:"eac3" + profile:"Dolby Digital Plus + Dolby Atmos"，
  // 只看 codec 两条都漏，只剩容器规则兜底
  needsNativePlayer(source, audioTracks) {
    // 杜比视界
    const hdr = (source.hdr || '').toLowerCase();
    if (hdr.includes('dolby') || hdr.includes('dv') || hdr.includes('dovi')) return true;
    // 全景声/TrueHD/DTS-HD
    for (const t of audioTracks || []) {
      const text = `${t.codec || ''} ${t.profile || ''}`.toLowerCase();
      if (text.includes('truehd') || text.includes('atmos') || text.includes('dts-hd') || text.includes('dtshd') || text.includes('dts:x')) return true;
    }
    // 不支持的容器
    const container = (source.container || '').toLowerCase();
    if (['mkv', 'iso', 'ts', 'm2ts', 'avi', 'wmv', 'flv'].includes(container)) return true;
    // 特殊视频编码
    const vcodec = (source.video_codec || '').toLowerCase();
    if (['vp9', 'vc-1', 'vc1', 'mpeg2', 'mpeg-2', 'theora'].includes(vcodec)) return true;
    return false;
  },

  // 嵌入式 mpv 在不在（只查路径，不启动进程）。结果缓存住：起播热路径上不能
  // 每次都走一遍 Tauri invoke
  async hasEmbeddedPlayer() {
    if (this._mpvReady == null) {
      this._mpvReady = !!(window.__TAURI__?.core?.invoke)
        ? await window.__TAURI__.core.invoke('has_embedded_player').catch(() => false)
        : false;
    }
    return this._mpvReady;
  },

  // 从 detail.files 挑出这一集/这一部实际要播的那一路（in_place 的）。
  // 电影的 season/episode 是 0/0，剧集按季集号对
  pickUnitFile(files, seasonNumber, episodeNumber) {
    const inPlace = (files || []).filter(f => f && f.state === 'in_place');
    if (!inPlace.length) return null;
    const wantEp = seasonNumber != null && episodeNumber != null
      && !(Number(seasonNumber) === 0 && Number(episodeNumber) === 0);
    if (!wantEp) return inPlace[0];
    return inPlace.find(f =>
      Number(f.season_number) === Number(seasonNumber) &&
      Number(f.episode_number) === Number(episodeNumber)
    ) || null;
  },

  // 打开嵌入式 mpv 播放器
  async openEmbeddedPlayer(item, streamUrl, subtitleUrls, startMs, session, seq) {
    const alive = () => this._playbackSeq === seq;
    try {
      // 获取视频区域位置
      const playerView = document.getElementById('playerView');
      const videoWrap = document.querySelector('.player-video-wrap');
      if (!playerView || !videoWrap) throw new Error('播放器容器未找到');

      // 显示播放器 UI（但不显示 video 元素，mpv 自己渲染）
      playerView.hidden = false;
      const video = document.getElementById('playerVideo');
      if (video) video.style.display = 'none'; // 隐藏 HTML5 video

      // Tauri 2 获取 HWND
      const hwnd = await window.__TAURI__.core.invoke('get_main_window_hwnd')
        .catch(() => 0);
      if (!alive()) { await this.releasePlaybackSession(session); return; }

      // 计算视频区域在窗口中的位置
      const rect = videoWrap.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;

      await window.__TAURI__.core.invoke('launch_embedded_player', {
        parentHwnd: hwnd || 0,
        streamUrl: streamUrl,
        subtitleUrls: subtitleUrls,
        startMs: startMs,
        title: item.title || 'MovieClaw',
        x: Math.round(rect.left * scale),
        y: Math.round(rect.top * scale),
        width: Math.round(rect.width * scale),
        height: Math.round(rect.height * scale),
        instanceId: seq,
      });
      if (!alive()) {
        await window.__TAURI__.core.invoke('stop_embedded_player', { instanceId: seq }).catch(() => {});
        await this.releasePlaybackSession(session);
        return;
      }

      // 两个引擎采用同一播放上下文，画质、重连与进度都从这里继续。
      window.__MOVIECLAW_MPV_ACTIVE = true;

      Player.adoptSession(item.title || 'MovieClaw', session, item, 'mpv');
      Player.mpvInstanceId = seq;
      // 选中态是 HTML5 那条链跟的，mpv 自己挑默认轨；留着上一次的值会把勾打错行
      Player.selectedSubtitle = undefined;
      // 上下集按钮只在剧集里亮；mpv 这条链不走 Player.open，季集号与兄弟表同步要在这做

      // mpv 没有 media element 也没有事件：进度/时长/暂停态靠轮询喂给 UI
      Player.startMpvPoll(startMs);
      Player.syncEmbeddedPlayerRect();

      // 显示控制栏（复用现有 UI）
      Player.showControls();
      Player.autoHideControls();

    } catch (e) {
      if (!alive()) { await this.releasePlaybackSession(session); return; }
      console.error('Embedded player failed:', e);
      window.__MOVIECLAW_MPV_ACTIVE = false;
      // 恢复被隐藏的 video 元素
      const v = document.getElementById('playerVideo');
      if (v) v.style.display = '';
      // 申报了 universal 但 mpv 没起来：档 0 给的是裸文件地址，HTML5 啃不动，
      // 不能就地拿这个 URL 交给 <video>。标 __forceHtml5 重谈一次，
      // 这回如实报浏览器能力，服务端给能播的换壳/转码流
      if (item.__universalClaim) {
        await this.releasePlaybackSession(session);
        if (!alive()) return;
        item.__universalClaim = false;
        item.__forceHtml5 = true;
        return this.startPlayback(item, true);
      }
      Player.open(item.title || 'MovieClaw', streamUrl, subtitleUrls, startMs, session, item);
    }
  },

  showAutoNextCard(next) {
    this.cancelAutoNext();
    const generation = Player.generation;
    const playNext = () => {
      if (generation !== Player.generation || !Player.activeEngine) return;
      const context = next.context || Player.context || {};
      this.cancelAutoNext();
      const item = { ...context, media_item_id: next.media_item_id, title: next.title,
        seasonNumber: next.season_number, episodeNumber: next.episode_number, startMs: null };
      delete item.attemptId;
      delete item.file_id;
      this.startPlayback(item);
    };
    let card;

    card = document.createElement('div');
    card.id = 'autoNextCard';
    card.className = 'auto-next-card';
    card.innerHTML = `
      <div class="auto-next-info">
        <div class="auto-next-label">即将播放</div>
        <div class="auto-next-title">${next.title || '下一集'}</div>
        <div class="auto-next-subtitle">S${next.season_number || 1}E${next.episode_number || ''}</div>
      </div>
      <div class="auto-next-countdown" id="autoNextCountdown">8</div>
      <div class="auto-next-actions">
        <button class="btn-secondary" id="btnCancelAutoNext">取消</button>
        <button class="btn-play" id="btnPlayNext">立即播放</button>
      </div>
    `;
    document.getElementById('playerView')?.appendChild(card);

    let countdown = 8;
    const timer = this._autoNextTimer = setInterval(() => {
      if (generation !== Player.generation || !Player.activeEngine) { this.cancelAutoNext(); return; }
      countdown--;
      const el = document.getElementById('autoNextCountdown');
      if (el) el.textContent = countdown;
      if (countdown <= 0) {
        clearInterval(timer);
        card.remove();
        playNext();
      }
    }, 1000);

    document.getElementById('btnCancelAutoNext')?.addEventListener('click', () => {
      clearInterval(timer);
      card.remove();
    });
    document.getElementById('btnPlayNext')?.addEventListener('click', () => {
      clearInterval(timer);
      card.remove();
      playNext();
    });
  },

  cancelAutoNext() {
    if (this._autoNextTimer) clearInterval(this._autoNextTimer);
    this._autoNextTimer = null;
    document.getElementById('autoNextCard')?.remove();
  },
};

// 启动
document.addEventListener('DOMContentLoaded', () => App.init());
