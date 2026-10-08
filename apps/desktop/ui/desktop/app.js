// MovieClaw Desktop — Main application

// 修复图片 URL：相对路径拼接 {server}/api/v1，远程 URL 走服务器代理
function resolveUrl(url) {
  if (!url) return '';
  if (url.startsWith('data:')) return url;
  const base = (window.__MOVIECLAW_SERVER__ || '').replace(/\/+$/, '');
  // 远程 TMDB 等图片走服务器缓存代理（和 Web 端一致）
  if (url.startsWith('http://') || url.startsWith('https://')) {
    if (!base) return url;
    return base + '/api/v1/images/proxy?url=' + encodeURIComponent(url);
  }
  // 相对路径：拼接 {server}/api/v1 前缀（API 返回的路径不带 /api/v1）
  if (!base) return url;
  const path = url.startsWith('/') ? url : '/' + url;
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

    // 键盘快捷键
    document.addEventListener('keydown', (e) => {
      // Esc: 从详情页返回
      if (e.key === 'Escape') {
        if (this.currentPage === 'detail') {
          e.preventDefault();
          this.navigate('home');
        }
      }
      // Ctrl+F: 聚焦搜索框
      if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
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
        API.listLibraryItems(this.libraries[0]?.id, { limit: 12, sort: 'added_at', order: 'desc' }).catch(() => []),
        API.listLibraryItems(this.libraries[0]?.id, { limit: 12, sort: 'rating', order: 'desc' }).catch(() => []),
        API.listLibraryItems(this.libraries[0]?.id, { limit: 12, sort: 'release_date', order: 'desc' }).catch(() => []),
        // 继续观看：有进度的条目
        API.listLibraryItems(this.libraries[0]?.id, { limit: 20, sort: 'last_played', order: 'desc' }).catch(() => []),
      ]);

      const unwrap = (r) => this.unwrapItems(r);
      const allItems = unwrap(shelves[0]);
      const topItems = unwrap(shelves[1]);
      const newItems = unwrap(shelves[2]);
      const continueItems = unwrap(shelves[3]).filter(i => i.progress_percent > 0 && i.progress_percent < 95);

      // 选一部高分影片做英雄横幅
      const heroItem = topItems[0] || allItems[0];

      const shelfData = [];
      if (continueItems.length) shelfData.push({ title: '继续观看', items: continueItems });
      shelfData.push(
        { title: '最近添加', items: allItems },
        { title: '高分精选', items: topItems },
        { title: '最新上映', items: newItems },
      );
      const validShelves = shelfData.filter(s => s.items && s.items.length > 0);

      if (shelfData.length === 0) {
        container.innerHTML = '<div class="page-loading"><div style="color:var(--text-secondary)">暂无内容</div></div>';
        return;
      }

      const heroHtml = heroItem ? `
        <div class="hero-banner" data-hero-id="${heroItem.media_item_id || heroItem.id || ''}" data-hero-lib="${heroItem.library_id ?? heroItem.libraryId ?? this.libraries[0]?.id ?? ''}">
          <div class="hero-bg">
            <img src="${resolveUrl(heroItem.backdrop_url || heroItem.poster_url || '')}" alt="" style="opacity:0;transition:opacity 0.4s" data-raw="${heroItem.backdrop_url || heroItem.poster_url || ''}" onload="this.style.opacity='1'" onerror="imgFallback(this, this.dataset.raw)">
          </div>
          <div class="hero-info">
            <div class="hero-tag">精选推荐</div>
            <h1 class="hero-title">${heroItem.title || heroItem.name || ''}</h1>
            <div class="hero-meta">
              ${heroItem.year ? `<span>${heroItem.year}</span>` : ''}
              ${heroItem.rating ? `<span>★ ${Number(heroItem.rating).toFixed(1)}</span>` : ''}
              ${heroItem.seasons?.length ? `<span>${heroItem.seasons.length} 季</span>` : (heroItem.episode_count ? `<span>${heroItem.episode_count} 集</span>` : '')}
              ${heroItem.air_status ? `<span>${heroItem.air_status}</span>` : ''}
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

      const defaultLibId = this.libraries[0]?.id;
      container.innerHTML = heroHtml + validShelves.map(shelf => `
        <div class="shelf-section">
          <div class="shelf-header" data-shelf-title="${shelf.title}">
            <h2 class="shelf-title">${shelf.title}</h2>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text-secondary)"><polyline points="9 18 15 12 9 6"/></svg>
          </div>
          <div class="shelf-wrapper">
            <button class="shelf-arrow shelf-arrow-left" data-dir="-1" aria-label="向左">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <div class="shelf-row">
              ${shelf.items.map(item => this.posterCard(item, defaultLibId)).join('')}
            </div>
            <button class="shelf-arrow shelf-arrow-right" data-dir="1" aria-label="向右">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
        </div>
      `).join('');

      // 绑定英雄横幅事件
      if (heroItem) {
        document.getElementById('heroPlayBtn')?.addEventListener('click', () => {
          this.startPlayback({ media_item_id: heroItem.media_item_id || heroItem.id, title: heroItem.title });
        });
        document.getElementById('heroDetailBtn')?.addEventListener('click', () => {
          this.navigate('detail', {
            libraryId: heroItem.library_id ?? heroItem.libraryId ?? this.libraries[0]?.id,
            itemId: heroItem.media_item_id || heroItem.id
          });
        });
      }

      this.bindPosterCards(container);

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
    } catch (e) {
      console.error('Render home error:', e);
      container.innerHTML = `<div class="page-loading"><div style="color:var(--text-secondary)">加载失败: ${e.message || e}</div></div>`;
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
    }
    if (resp.items && Array.isArray(resp.items)) return resp.items;
    if (resp.results && Array.isArray(resp.results)) return resp.results;
    return [];
  },

  // ===== 媒体库 =====
  async renderLibrary(container, libraryId) {
    container.innerHTML = '<div class="page-loading"><div class="spinner"></div></div>';
    try {
      const lib = this.libraries.find(l => l.id === libraryId || l.id == libraryId);
      // 分页加载全部条目
      const items = await this.loadAllLibraryItems(libraryId);
      this.renderPosterWall(container, items, {
        title: lib?.name || '媒体库',
        subtitle: `${items.length} 个项目`,
        libraryId,
        showToolbar: true,
      });
    } catch (e) {
      console.error('Render library error:', e);
      container.innerHTML = `<div class="page-loading"><div style="color:var(--text-secondary)">加载失败: ${e.message || e}</div></div>`;
    }
  },

  // 分页加载全部媒体条目
  async loadAllLibraryItems(libraryId, params = {}) {
    const allItems = [];
    let page = 1;
    const pageSize = 100;
    while (true) {
      const resp = await API.listLibraryItems(libraryId, { limit: pageSize, offset: (page - 1) * pageSize, ...params });
      const items = this.unwrapItems(resp);
      if (!items.length) break;
      allItems.push(...items);
      // 如果返回少于 pageSize，说明没有更多了
      if (items.length < pageSize) break;
      // 安全上限，防止死循环
      if (page > 50) break;
      page++;
    }
    return allItems;
  },

  // ===== 合集 =====
  async renderCollection(container, collectionId) {
    container.innerHTML = '<div class="page-loading"><div class="spinner"></div></div>';
    try {
      const resp = await API.listCollectionItems(collectionId);
      const items = this.unwrapItems(resp);
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
      // 查询所有媒体库的收藏
      const promises = this.libraries.map(lib =>
        this.loadAllLibraryItems(lib.id, { favorites: true }).catch(() => [])
      );
      const results = await Promise.all(promises);
      const items = results.flat();
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
      const items = this.unwrapItems(results);
      if (!items.length) {
        container.innerHTML = `
          <div class="page-header">
            <h1 class="page-title">搜索结果</h1>
            <span class="page-subtitle">"${query}"</span>
          </div>
          <div class="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="opacity:0.3"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <p>没有找到与 "${query}" 匹配的内容</p>
            <span>试试其他关键词</span>
          </div>
        `;
        return;
      }
      this.renderPosterWall(container, items, {
        title: `"${query}" 的搜索结果`,
        subtitle: `${items.length} 个结果`,
        showToolbar: true,
      });
    } catch (e) {
      container.innerHTML = '<div class="page-loading"><div style="color:var(--text-secondary)">搜索失败: ' + (e.message || e) + '</div></div>';
    }
  },

  // ===== 详情页 =====
  async renderDetail(container, params) {
    container.innerHTML = '<div class="page-loading"><div class="spinner"></div></div>';
    try {
      const resp = await API.getItemDetail(params.libraryId, params.itemId);
      const info = resp?.data || resp;
      const meta = info.local_meta || {};

      const genres = meta.genres || [];
      const plot = meta.plot || '';
      const runtime = meta.runtime_minutes || null;
      const rating = meta.rating || null;
      const directors = meta.directors || [];
      const actors = meta.actors || [];
      const posterRaw = info.poster_url || info.backdrop_url || '';
      const backdropRaw = info.backdrop_url || info.poster_url || '';

      container.innerHTML = `
        <div class="detail-hero">
          <div class="detail-hero-bg">
            <img src="${resolveUrl(backdropRaw)}" alt="" style="opacity:0;transition:opacity 0.4s" data-raw="${backdropRaw}" onload="this.style.opacity='1'" onerror="imgFallback(this, this.dataset.raw)">
          </div>
          <button class="detail-back-btn" id="btnBack" title="返回 (Esc)">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div class="detail-hero-info">
            <h1 class="detail-title">${info.title}</h1>
            <div class="detail-meta">
              ${info.year ? `<span>${info.year}</span>` : ''}
              ${genres.length ? `<span>${genres.slice(0, 3).join(' / ')}</span>` : ''}
              ${runtime ? `<span>${runtime} 分钟</span>` : ''}
            </div>
            <div class="detail-actions">
              <button class="btn-play" id="btnPlay">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                <span>播放</span>
              </button>
              <button class="btn-icon" id="btnFavorite" title="收藏">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                </svg>
              </button>
              <button class="btn-icon" id="btnMarkWatched" title="标记已看">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
        <div class="detail-body">
          <div class="detail-layout">
            <div class="detail-content">
              ${plot ? `<p class="detail-overview">${plot}</p>` : ''}

              ${info.seasons?.length ? `
                <div class="detail-section">
                  <h3>剧集</h3>
                  <div class="season-selector">
                    ${info.seasons.map((s, i) => `<button class="season-pill ${i === 0 ? 'active' : ''}" data-season="${s}">第 ${s} 季</button>`).join('')}
                  </div>
                  <div class="episode-grid" id="episodeGrid">
                    <div class="page-loading"><div class="spinner"></div></div>
                  </div>
                </div>
              ` : ''}

              ${info.collections?.length ? `
                <div class="detail-section">
                  <h3>所属合集</h3>
                  <div class="collection-chips">
                    ${info.collections.map(c => `<a class="collection-chip" data-collection-id="${c.id}" href="#">${c.name}</a>`).join('')}
                  </div>
                </div>
              ` : ''}
            </div>

            <aside class="detail-sidebar">
              <div class="detail-info-block">
                <h4>影片信息</h4>
                ${info.original_title ? `<div class="info-row"><span class="info-label">原名</span><span>${info.original_title}</span></div>` : ''}
                ${info.year ? `<div class="info-row"><span class="info-label">年份</span><span>${info.year}</span></div>` : ''}
                ${genres.length ? `<div class="info-row"><span class="info-label">类型</span><span>${genres.join(' / ')}</span></div>` : ''}
                ${runtime ? `<div class="info-row"><span class="info-label">片长</span><span>${runtime} 分钟</span></div>` : ''}
                ${directors.length ? `<div class="info-row"><span class="info-label">导演</span><span>${directors.join(' / ')}</span></div>` : ''}
                ${rating ? `<div class="info-row"><span class="info-label">评分</span><span class="rating-score">${rating.toFixed(1)}</span></div>` : ''}
                ${info.files?.length ? `<div class="info-row"><span class="info-label">文件</span><span>${info.files.length} 个</span></div>` : ''}
              </div>
              ${actors.length ? `
                <div class="detail-info-block" style="margin-top:16px">
                  <h4>主演</h4>
                  <div class="cast-list">
                    ${actors.slice(0, 8).map(p => `
                      <div class="cast-item">
                        ${p.thumb_url ? `<img src="${resolveUrl(p.thumb_url)}" alt="" class="cast-avatar" style="opacity:0;transition:opacity 0.3s" onload="this.style.opacity='1'" onerror="this.style.display='none'">` : '<div class="cast-avatar cast-avatar-placeholder"></div>'}
                        <div>
                          <div class="cast-name">${p.name}</div>
                          <div class="cast-role">${p.role || ''}</div>
                        </div>
                      </div>
                    `).join('')}
                  </div>
                </div>
              ` : ''}
            </aside>
          </div>
        </div>
      `;

      // 加载剧集
      if (info.seasons?.length) {
        this.loadEpisodes(container, params.libraryId, params.itemId, info.seasons[0], info.title);
        container.querySelectorAll('.season-pill').forEach(pill => {
          pill.addEventListener('click', () => {
            container.querySelectorAll('.season-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            this.loadEpisodes(container, params.libraryId, params.itemId, parseInt(pill.dataset.season), info.title);
          });
        });
      }

      // 绑定事件
      document.getElementById('btnBack')?.addEventListener('click', () => {
        this.navigate('home');
      });

      document.getElementById('btnPlay')?.addEventListener('click', () => {
        this.startPlayback({ ...info, id: info.media_item_id, title: info.title });
      });

      document.getElementById('btnFavorite')?.addEventListener('click', async () => {
        try {
          await API.request(`/libraries/${params.libraryId}/items/${info.media_item_id}/favorite`, { method: 'POST' });
          document.getElementById('btnFavorite').classList.toggle('active');
        } catch (e) { console.error('Favorite toggle failed:', e); }
      });

      document.getElementById('btnMarkWatched')?.addEventListener('click', async () => {
        try {
          await API.request(`/libraries/${params.libraryId}/items/${info.media_item_id}/watched`, { method: 'POST' });
          document.getElementById('btnMarkWatched').classList.toggle('active');
        } catch (e) { console.error('Mark watched failed:', e); }
      });

    } catch (e) {
      console.error('Render detail error:', e);
      container.innerHTML = '<div class="page-loading"><div style="color:var(--text-secondary)">加载失败: ' + (e.message || e) + '</div></div>';
    }
  },

  // 加载某一季的剧集
  async loadEpisodes(container, libraryId, itemId, seasonNumber, showTitle) {
    const grid = document.getElementById('episodeGrid');
    if (!grid) return;
    grid.innerHTML = '<div class="page-loading"><div class="spinner"></div></div>';
    try {
      const resp = await API.request(`/libraries/${libraryId}/items/${itemId}/episodes?season_number=${seasonNumber}`);
      const data = resp?.data || resp;
      const episodes = data?.episodes || data || [];
      if (!episodes.length) {
        grid.innerHTML = '<div style="color:var(--text-secondary);padding:20px;">暂无剧集信息</div>';
        return;
      }
      grid.innerHTML = episodes.map(ep => `
        <div class="episode-card" data-episode-number="${ep.episode_number}" data-season="${seasonNumber}">
          <div class="episode-art">
            ${ep.still_url ? `<img src="${resolveUrl(ep.still_url)}" alt="" data-raw="${ep.still_url}" onerror="imgFallback(this, this.dataset.raw)">` : ''}
            <div class="episode-num">E${ep.episode_number}</div>
            ${ep.progress_percent ? `<div class="episode-progress"><div class="episode-progress-fill" style="width:${ep.progress_percent}%"></div></div>` : ''}
            ${ep.played ? '<div class="episode-played"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/></svg></div>' : ''}
          </div>
          <div class="episode-info">
            <div class="episode-title">${ep.name || '第 ' + ep.episode_number + ' 集'}</div>
            <div class="episode-subtitle">${ep.air_date || ''}</div>
          </div>
        </div>
      `).join('');

      grid.querySelectorAll('.episode-card').forEach(card => {
        card.addEventListener('click', () => {
          const epNum = card.dataset.episodeNumber;
          this.startPlayback({
            media_item_id: itemId,
            title: `${showTitle} S${seasonNumber}E${epNum}`,
            seasonNumber: parseInt(seasonNumber),
            episodeNumber: parseInt(epNum),
          });
        });
      });
    } catch (e) {
      console.error('Load episodes failed:', e);
      grid.innerHTML = '<div style="color:var(--text-secondary);padding:20px;">加载剧集失败</div>';
    }
  },

  // ===== 海报墙渲染 =====
  renderPosterWall(container, items, { title, subtitle, libraryId, showToolbar }) {
    // 收集所有类型用于筛选
    const allGenres = [...new Set(items.flatMap(i => {
      const meta = i.local_meta || i;
      return meta.genres || [];
    }))].sort();

    const toolbarHtml = showToolbar ? `
      <div class="wall-toolbar">
        <div class="wall-toolbar-left">
          <button class="wall-sort-btn active" data-sort="default">默认</button>
          <button class="wall-sort-btn" data-sort="title">标题</button>
          <button class="wall-sort-btn" data-sort="year">年份</button>
          <button class="wall-sort-btn" data-sort="rating">评分</button>
          ${allGenres.length ? `
            <div class="wall-genre-dropdown">
              <button class="wall-genre-btn" id="wallGenreBtn">
                <span id="wallGenreLabel">类型筛选</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
              <div class="wall-genre-menu" id="wallGenreMenu" hidden>
                <div class="wall-genre-item active" data-genre="">全部</div>
                ${allGenres.map(g => `<div class="wall-genre-item" data-genre="${g}">${g}</div>`).join('')}
              </div>
            </div>
          ` : ''}
        </div>
        <div class="wall-toolbar-right">
          <button class="wall-view-btn active" data-view="grid" title="网格">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
          </button>
        </div>
      </div>
    ` : '';
    container.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">${title}</h1>
        <span class="page-subtitle">${subtitle}</span>
      </div>
      ${toolbarHtml}
      <div class="poster-wall">
        <div class="poster-grid" id="posterGrid">
          ${items.map(item => this.posterCard(item, libraryId)).join('')}
        </div>
      </div>
    `;
    this.bindPosterCards(container);
    if (showToolbar) this.bindWallToolbar(container, items, libraryId);
  },

  // 海报墙排序 + 筛选工具栏
  bindWallToolbar(container, items, libraryId) {
    let currentGenre = '';
    let currentSort = 'default';

    const refreshGrid = () => {
      let filtered = items;
      if (currentGenre) {
        filtered = items.filter(i => {
          const meta = i.local_meta || i;
          return (meta.genres || []).includes(currentGenre);
        });
      }
      const sorted = [...filtered];
      if (currentSort === 'title') sorted.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh'));
      else if (currentSort === 'year') sorted.sort((a, b) => (b.year || 0) - (a.year || 0));
      else if (currentSort === 'rating') sorted.sort((a, b) => (b.rating || 0) - (a.rating || 0));
      const grid = container.querySelector('#posterGrid');
      if (grid) {
        grid.innerHTML = sorted.map(item => this.posterCard(item, libraryId)).join('');
        this.bindPosterCards(container);
      }
    };

    // 排序
    container.querySelectorAll('.wall-sort-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.wall-sort-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentSort = btn.dataset.sort;
        refreshGrid();
      });
    });

    // 类型筛选
    const genreBtn = container.querySelector('#wallGenreBtn');
    const genreMenu = container.querySelector('#wallGenreMenu');
    if (genreBtn && genreMenu) {
      genreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        genreMenu.hidden = !genreMenu.hidden;
      });
      genreMenu.querySelectorAll('.wall-genre-item').forEach(item => {
        item.addEventListener('click', () => {
          genreMenu.querySelectorAll('.wall-genre-item').forEach(i => i.classList.remove('active'));
          item.classList.add('active');
          currentGenre = item.dataset.genre;
          const label = container.querySelector('#wallGenreLabel');
          if (label) label.textContent = currentGenre || '类型筛选';
          genreMenu.hidden = true;
          refreshGrid();
        });
      });
      // 点击外部关闭
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.wall-genre-dropdown')) genreMenu.hidden = true;
      });
    }
  },

  posterCard(item, defaultLibId) {
    const progress = item.progress_percent ? item.progress_percent / 100 : (item.watchProgress || item.progress || 0);
    const itemId = item.media_item_id || item.id || '';
    const libId = item.library_id ?? item.libraryId ?? defaultLibId ?? '';
    const title = item.title || item.name || '未知';
    const rawPoster = item.poster_url || item.posterUrl || '';
    const posterUrl = resolveUrl(rawPoster);
    const year = item.year || '';
    return `
      <div class="poster-card" data-item-id="${itemId}" data-library-id="${libId}">
        <div class="poster-art">
          <img src="${posterUrl}" alt="" loading="lazy" style="opacity:0;transition:opacity 0.3s" data-raw="${rawPoster}" onload="this.style.opacity='1'" onerror="imgFallback(this, this.dataset.raw)">
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
          <div class="poster-subtitle">${year}${item.seasons?.length ? ' · ' + item.seasons.length + ' 季' : (item.episode_count ? ' · ' + item.episode_count + ' 集' : '')}</div>
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
          <p style="color:var(--text-secondary);margin-top:4px;">版本 0.2.107</p>
        </div>
      </div>
    `;
  },

  // ===== 播放（内置 HTML5 播放器） =====
  async startPlayback(item) {
    const loadingText = document.getElementById('playerLoadingText');
    const loading = document.getElementById('playerLoading');
    const playerView = document.getElementById('playerView');

    // 显示加载状态
    playerView.hidden = false;
    loading.hidden = false;
    if (loadingText) loadingText.textContent = '正在获取播放链接...';

    try {
      if (!API.baseUrl) throw new Error('未配置服务器地址');

      const mediaId = item.media_item_id || item.id || item.mediaItemId;
      if (!mediaId) throw new Error('无效的媒体项 ID');

      const body = {
        media_item_id: mediaId,
        capability: {
          universal: true,
          hdr_passthrough: true,
          containers: ['mp4', 'hls-fmp4'],
          video: [],
          audio: [],
          mse: 'managed',
          is_mobile: false,
          native_hls: true,
        },
        client: 'web',
        attempt_id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      };
      if (item.seasonNumber != null) body.season_number = item.seasonNumber;
      if (item.episodeNumber != null) body.episode_number = item.episodeNumber;

      const sessionResp = await API.request('/playback/sessions', { method: 'POST', body });
      const session = sessionResp?.data || sessionResp;

      if (session?.decision && session.decision.outcome !== 'plan') {
        throw new Error('播放不可用: ' + (session.decision.reason || session.decision.outcome));
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
      const startMs = isSessionTimeline ? null : (session.start_ms > 0 ? session.start_ms : null);

      // 打开内置播放器
      loading.hidden = true;
      Player.open(item.title || 'MovieClaw', streamUrl, subtitleUrls, startMs, session);

    } catch (e) {
      console.error('Playback error:', e);
      if (loadingText) loadingText.textContent = '播放失败: ' + (e.message || e);
      setTimeout(() => {
        playerView.hidden = true;
        loading.hidden = true;
      }, 5000);
    }
  },
};

// 启动
document.addEventListener('DOMContentLoaded', () => App.init());
