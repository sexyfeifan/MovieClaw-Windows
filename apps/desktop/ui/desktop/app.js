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

const App = {
  currentPage: 'home',
  libraries: [],
  collections: [],
  navStack: [],       // 导航历史栈

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
        if (this.currentPage === 'detail' || this.currentPage === 'search') {
          e.preventDefault();
          this.goBack();
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
    // 只显示用户/内置合集，过滤掉自动生成的"系列"合集
    // CollectionView.kind: "user" | "builtin" | "series"
    const userCollections = this.collections.filter(col => col.kind !== 'series');
    colNav.innerHTML = userCollections.slice(0, 10).map(col => `
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

  async navigate(page, params = {}, pushHistory = true) {
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
      case 'person':
        await this.renderPerson(content, params);
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
  async renderHome(container) {
    container.innerHTML = '<div class="page-loading"><div class="spinner"></div></div>';
    try {
      if (!this.libraries.length) {
        container.innerHTML = '<div class="page-loading"><div style="color:var(--text-secondary)">暂无媒体库，请先在服务器添加</div></div>';
        return;
      }

      // 并行加载：继续观看 + 收藏 + 各媒体库最近添加
      const upNextPromise = API.getUpNext().catch(() => null);
      const favPromise = API.getFavorites().catch(() => null);

      const shelfPromises = this.libraries.map(lib =>
        API.listLibraryItems(lib.id, { limit: 20, sort: 'added_at', order: 'desc' })
          .then(items => ({ lib, items: this.filterMediaItems(this.unwrapItems(items)) }))
          .catch(() => ({ lib, items: [] }))
      );

      const [upNextResp, favResp, ...libShelves] = await Promise.all([upNextPromise, favPromise, ...shelfPromises]);
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
              <div class="genre-tile" data-genre="${g}" style="background:${['#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c','#3498db','#9b59b6','#e84393','#fd79a8','#00b894','#0984e3','#6c5ce7'][i % 12]}">
                <span>${g}</span>
              </div>
            `).join('')}
          </div>
        </div>
      ` : '';

      const heroHtml = heroItem ? `
        <div class="hero-banner" id="heroBanner" data-hero-id="${heroItem.media_item_id || ''}" data-hero-lib="${heroItem.library_id ?? defaultLibId ?? ''}">
          <div class="hero-bg" id="heroBg">
            <img src="" alt="" id="heroImg" style="opacity:0;transition:opacity 0.5s" data-raw="${heroItem.backdrop_url || heroItem.poster_url || ''}" onload="this.style.opacity='1'" onerror="imgFallback(this, this.dataset.raw)">
          </div>
          <div class="hero-info">
            <h1 class="hero-title" id="heroTitle">${heroItem.title || ''}</h1>
            <div class="hero-meta" id="heroMeta">
              ${heroItem.year ? `<span>${heroItem.year}</span>` : ''}
              ${heroItem.rating ? `<span>★ ${Number(heroItem.rating).toFixed(1)}</span>` : ''}
              ${heroItem.seasons?.length ? `<span>${heroItem.seasons.length} 季</span>` : (heroItem.episode_count ? `<span>${heroItem.episode_count} 集</span>` : '')}
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
          <div class="shelf-header" data-shelf-title="${shelf.title}">
            <h2 class="shelf-title">${shelf.title}</h2>
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
          API.proxyImage(rawUrl).then(dataUri => {
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
                  API.proxyImage(switchUrl).then(dataUri => {
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
                  ${item.year ? `<span>${item.year}</span>` : ''}
                  ${item.rating ? `<span>★ ${Number(item.rating).toFixed(1)}</span>` : ''}
                  ${item.seasons?.length ? `<span>${item.seasons.length} 季</span>` : (item.episode_count ? `<span>${item.episode_count} 集</span>` : '')}
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
          this.startPlayback({ media_item_id: item.media_item_id, title: item.title });
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

  // ===== 媒体库 =====
  async renderLibrary(container, libraryId) {
    container.innerHTML = '<div class="page-loading"><div class="spinner"></div></div>';
    try {
      const lib = this.libraries.find(l => l.id === libraryId || l.id == libraryId);
      // 分页加载全部条目（服务端排序）
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

  // 分页加载全部媒体条目（支持服务端排序参数）
  async loadAllLibraryItems(libraryId, params = {}) {
    const allItems = [];
    let page = 1;
    const pageSize = 100;
    while (true) {
      const resp = await API.listLibraryItems(libraryId, { limit: pageSize, offset: (page - 1) * pageSize, ...params });
      const items = this.filterMediaItems(this.unwrapItems(resp));
      if (!items.length) break;
      allItems.push(...items);
      if (items.length < pageSize) break;
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
      const items = this.filterMediaItems(this.unwrapItems(resp));
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
      // GET /playback/favorites → { data: { items: [FavoriteItemView], total } }
      // FavoriteItemView = LibraryItemView + library_id + favorite_season_number + favorite_episode_number
      const resp = await API.getFavorites();
      const data = resp?.data || resp || {};
      let items = this.filterMediaItems(data.items || this.unwrapItems(resp));

      if (!items.length) {
        container.innerHTML = `
          <div class="page-header">
            <h1 class="page-title">我的收藏</h1>
            <span class="page-subtitle">0 个项目</span>
          </div>
          <div class="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="opacity:0.3"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            <p>暂无收藏</p>
            <span>点击影片详情页的收藏按钮来添加</span>
          </div>
        `;
        return;
      }
      this.renderPosterWall(container, items, {
        title: '我的收藏',
        subtitle: `${data.total ?? items.length} 个项目`,
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
      const items = this.filterMediaItems(this.unwrapItems(results));
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

  // ===== 人物页 =====
  async renderPerson(container, params) {
    container.innerHTML = '<div class="page-loading"><div class="spinner"></div></div>';
    try {
      const resp = await API.getPerson(params.personId);
      const person = resp?.data || resp;

      // 加载作品
      const creditsResp = await API.getPersonCredits(params.personId).catch(() => null);
      const credits = this.unwrapItems(creditsResp);

      container.innerHTML = `
        <div class="person-hero">
          <button class="detail-back-btn" onclick="App.goBack()">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <div class="person-header">
            ${person.avatar_url || person.profile_url ? `
              <img class="person-avatar" src="${resolveUrl(person.avatar_url || person.profile_url)}" alt="" style="opacity:0;transition:opacity 0.3s" onload="this.style.opacity='1'" onerror="this.style.display='none'">
            ` : '<div class="person-avatar person-avatar-placeholder"></div>'}
            <div class="person-info">
              <h1 class="person-name">${person.name || ''}</h1>
              <div class="person-meta">
                ${person.department ? `<span>${person.department}</span>` : ''}
                ${person.birthday ? `<span>生于 ${person.birthday}</span>` : ''}
                ${credits.length ? `<span>${credits.length} 部作品</span>` : ''}
              </div>
              ${person.biography ? `<p class="person-bio">${person.biography}</p>` : ''}
            </div>
          </div>
        </div>
        ${credits.length ? `
          <div class="person-works">
            <h2 class="shelf-title" style="margin-bottom:16px">作品</h2>
            <div class="poster-grid" id="posterGrid">
              ${credits.map(item => this.posterCard(item, item.library_id)).join('')}
            </div>
          </div>
        ` : '<div class="empty-state"><p>暂无作品信息</p></div>'}
      `;
      this.bindPosterCards(container);
    } catch (e) {
      container.innerHTML = '<div class="page-loading"><div style="color:var(--text-secondary)">加载人物失败: ' + (e.message || e) + '</div></div>';
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
                      <div class="cast-item" ${p.person_id || p.id ? `data-person-id="${p.person_id || p.id}"` : ''} style="cursor:${p.person_id || p.id ? 'pointer' : 'default'}">
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
        this.goBack();
      });

      document.getElementById('btnPlay')?.addEventListener('click', () => {
        this.startPlayback({ media_item_id: info.media_item_id, title: info.title });
      });

      // 收藏/已看 — 使用 /playback/marks API
      // GET 响应: { played: bool, is_favorite: bool, unplayed_count: int|null }
      // POST body: { media_item_id, played?, favorite? }
      const mediaId = info.media_item_id;
      let marks = { is_favorite: false, played: false };
      try {
        const marksResp = await API.getMarks(mediaId);
        marks = marksResp?.data || marksResp || {};
      } catch (_) {}

      if (marks.is_favorite) document.getElementById('btnFavorite')?.classList.add('active');
      if (marks.played) document.getElementById('btnMarkWatched')?.classList.add('active');

      document.getElementById('btnFavorite')?.addEventListener('click', async () => {
        const btn = document.getElementById('btnFavorite');
        const wasActive = btn.classList.contains('active');
        try {
          await API.setMarks(mediaId, { favorite: !wasActive });
          btn.classList.toggle('active');
        } catch (e) { console.error('Favorite toggle failed:', e); }
      });

      document.getElementById('btnMarkWatched')?.addEventListener('click', async () => {
        const btn = document.getElementById('btnMarkWatched');
        const wasActive = btn.classList.contains('active');
        try {
          await API.setMarks(mediaId, { played: !wasActive });
          btn.classList.toggle('active');
        } catch (e) { console.error('Mark watched failed:', e); }
      });

      // 演员点击 → 人物页
      container.querySelectorAll('.cast-item[data-person-id]').forEach(item => {
        item.addEventListener('click', () => {
          const pid = item.dataset.personId;
          if (pid) this.navigate('person', { personId: pid });
        });
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
    // LibraryItemView 没有 genres 字段 — 只有 UpNextItemView / detail 有
    // 所以这里可能为空
    const allGenres = [...new Set(items.flatMap(i => i.genres || []))].sort();

    // 虚拟滚动：大列表分批渲染
    const VIRTUAL_THRESHOLD = 200;
    const BATCH_SIZE = 60;

    const toolbarHtml = showToolbar ? `
      <div class="wall-toolbar">
        <div class="wall-toolbar-left">
          <button class="wall-sort-btn active" data-sort="default">默认</button>
          <button class="wall-sort-btn" data-sort="added_at">最近添加</button>
          <button class="wall-sort-btn" data-sort="release_date">最新上映</button>
          <button class="wall-sort-btn" data-sort="rating">评分</button>
          <button class="wall-sort-btn" data-sort="title">标题</button>
          <button class="wall-sort-btn" data-sort="year">年份</button>
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
    // 分批渲染：大列表时只渲染前一批，滚动加载更多
    const renderBatch = (allItems, container2) => {
      const grid = container2.querySelector('#posterGrid');
      if (!grid) return;
      if (allItems.length <= VIRTUAL_THRESHOLD) {
        grid.innerHTML = allItems.map(item => this.posterCard(item, libraryId)).join('');
        this.bindPosterCards(container2);
      } else {
        // 虚拟滚动：只渲染当前批次
        grid.innerHTML = allItems.slice(0, BATCH_SIZE).map(item => this.posterCard(item, libraryId)).join('');
        this.bindPosterCards(container2);
        // 监听滚动加载更多（监听 content 容器的滚动）
        const scrollTarget = document.getElementById('content');
        if (scrollTarget) {
          // 移除旧的虚拟滚动监听
          if (scrollTarget._virtualHandler) {
            scrollTarget.removeEventListener('scroll', scrollTarget._virtualHandler);
          }
          let rendered = BATCH_SIZE;
          const handler = () => {
            if (scrollTarget.scrollTop + scrollTarget.clientHeight >= scrollTarget.scrollHeight - 200) {
              if (rendered < allItems.length) {
                const nextBatch = allItems.slice(rendered, rendered + BATCH_SIZE);
                grid.insertAdjacentHTML('beforeend', nextBatch.map(item => this.posterCard(item, libraryId)).join(''));
                rendered += BATCH_SIZE;
                this.bindPosterCards(container2);
              }
            }
          };
          scrollTarget._virtualHandler = handler;
          scrollTarget.addEventListener('scroll', handler);
        }
      }
    };

    container.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">${title}</h1>
        <span class="page-subtitle">${subtitle}</span>
      </div>
      ${toolbarHtml}
      <div class="poster-wall">
        <div class="poster-grid" id="posterGrid">
          ${items.slice(0, VIRTUAL_THRESHOLD).map(item => this.posterCard(item, libraryId)).join('')}
        </div>
      </div>
    `;
    this.bindPosterCards(container);
    if (showToolbar) this.bindWallToolbar(container, items, libraryId);
  },

  // 海报墙排序 + 筛选工具栏（客户端即时 + 服务端排序）
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
      else if (currentSort === 'added_at') sorted.sort((a, b) => new Date(b.added_at || 0) - new Date(a.added_at || 0));
      else if (currentSort === 'release_date') sorted.sort((a, b) => new Date(b.release_date || b.year || 0) - new Date(a.release_date || a.year || 0));
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
      <div class="poster-card" data-item-id="${itemId}" data-library-id="${libId}">
        <div class="poster-art">
          ${rawPoster ? `<img src="${posterUrl}" alt="" loading="lazy" style="opacity:0;transition:opacity 0.3s" data-raw="${rawPoster}" onload="this.style.opacity='1'" onerror="imgFallback(this, this.dataset.raw)">` : ''}
          <div class="focus-glow"></div>
          ${isFav ? '<div class="poster-fav"><svg width="14" height="14" viewBox="0 0 24 24" fill="#ff375f"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg></div>' : ''}
          ${progress > 0 && progress < 1 ? `
            <div class="poster-progress">
              <div class="poster-progress-fill" style="width:${Math.round(progress * 100)}%"></div>
            </div>
          ` : ''}
        </div>
        <div class="poster-info">
          <div class="poster-title">${title}</div>
          <div class="poster-subtitle">${[
            year,
            rating != null ? Number(rating).toFixed(1) : '',
            item.kind === 'tv' && item.seasons?.length ? item.seasons.length + ' 季' : (item.episode_count > 0 ? item.episode_count + ' 集' : '')
          ].filter(Boolean).join(' · ')}</div>
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
            <span style="color:var(--text-secondary)">${API.baseUrl || '未配置'}</span>
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
          <p style="color:var(--text-secondary);margin-top:4px;" id="settingsVersion">版本 0.2.108</p>
        </div>
      </div>
    `;

    // 事件绑定
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
    document.getElementById('btnSwitchServer')?.addEventListener('click', async () => {
      if (window.__TAURI__) {
        await window.__TAURI__.core.invoke('clear_server_url');
        window.location.href = 'http://tauri.localhost/connect.html';
      }
    });
    document.getElementById('btnLogout')?.addEventListener('click', async () => {
      try { await API.request('/auth/logout', { method: 'POST' }); } catch (_) {}
      try { await window.__TAURI__?.core.invoke('clear_server_url'); } catch (_) {}
      window.location.reload();
    });

    // 多账号列表
    this.loadAccounts();

    // 添加账号
    document.getElementById('btnAddAccount')?.addEventListener('click', () => {
      window.location.href = 'http://tauri.localhost/connect.html';
    });

    // QR 配对
    document.getElementById('btnQRLogin')?.addEventListener('click', async () => {
      const qrArea = document.getElementById('qrArea');
      const qrData = document.getElementById('qrCodeData');
      if (!qrArea || !qrData) return;

      if (qrArea.style.display === 'none') {
        qrArea.style.display = 'block';
        try {
          const resp = await API.getDeviceCode();
          const data = resp?.data || resp;
          qrData.textContent = data?.code || data?.device_code || '------';
          // 轮询状态
          const pollTimer = setInterval(async () => {
            try {
              const status = await API.checkDeviceStatus(data?.code || data?.device_code);
              const s = status?.data || status;
              if (s?.status === 'approved' || s?.authorized) {
                clearInterval(pollTimer);
                qrArea.innerHTML = '<div style="text-align:center;padding:16px;color:#66bb6a">配对成功！</div>';
                setTimeout(() => window.location.reload(), 1500);
              }
            } catch (_) {}
          }, 3000);
          // 30秒后自动关闭
          setTimeout(() => {
            clearInterval(pollTimer);
            if (qrArea.style.display !== 'none') {
              qrArea.style.display = 'none';
            }
          }, 60000);
        } catch (e) {
          qrData.textContent = '获取配对码失败';
        }
      } else {
        qrArea.style.display = 'none';
      }
    });
  },

  async loadAccounts() {
    const list = document.getElementById('accountList');
    if (!list) return;
    try {
      const resp = await API.listAccounts().catch(() => null);
      const accounts = this.unwrapItems(resp);
      if (!accounts.length) {
        list.innerHTML = '<div style="color:var(--text-secondary);padding:8px 0">仅当前账号</div>';
        return;
      }
      list.innerHTML = accounts.map(acc => `
        <div class="settings-row" data-account-id="${acc.id}">
          <span>${acc.name || acc.username || '账号'}</span>
          <div>
            ${acc.is_current ? '<span style="color:var(--accent);font-size:12px">当前</span>' : `
              <button class="btn-secondary" style="padding:4px 12px;font-size:12px" onclick="App.switchToAccount('${acc.id}')">切换</button>
            `}
          </div>
        </div>
      `).join('');
    } catch (_) {
      list.innerHTML = '<div style="color:var(--text-secondary);padding:8px 0">仅当前账号</div>';
    }
  },

  async switchToAccount(accountId) {
    try {
      await API.switchAccount(accountId);
      window.location.reload();
    } catch (e) {
      console.error('Switch account failed:', e);
    }
  },

  // ===== 播放（内置 HTML5 播放器） =====
  async startPlayback(item, isRetry) {
    // 连点/返回竞态：新请求立即作废旧请求（清掉上一部的播放器状态），
    // 后续每个 await 之后用 alive() 检查，旧请求回来不再碰界面
    Player.close();
    if (!isRetry) {
      // 全新播放：清掉上一轮的降档记录（web-player.md §6.3 的 failed_tiers 回路）
      this._failedTiers = [];
      this._contentFailures = 0;
    }
    const seq = (this._playbackSeq = (this._playbackSeq || 0) + 1);
    const alive = () => this._playbackSeq === seq;

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
      if (!API.baseUrl) throw new Error('未配置服务器地址');

      const mediaId = Number(item.media_item_id);
      if (!mediaId || isNaN(mediaId)) throw new Error('无效的媒体项 ID: ' + item.media_item_id);

      // TV 剧集需要季/集号 — 若未指定则自动选择
      if (item.seasonNumber == null || item.episodeNumber == null) {
        try {
          const detailResp = await API.getItemDetail(item.library_id || this.libraries[0]?.id, mediaId);
          const detail = detailResp?.data || detailResp;
          if (detail?.kind === 'tv') {
            // 优先用续播信息
            try {
              const resumeResp = await API.getResume(mediaId);
              const resume = resumeResp?.data || resumeResp;
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
              } catch (_) {}
            }
          }
        } catch (_) { /* 获取详情失败则按电影处理 */ }
      }
      if (!alive()) return;

      const body = {
        media_item_id: mediaId,
        // 真实解码能力（探测一次后缓存）：报空数组会让服务端判定浏览器
        // 什么都不支持 → 所有影片全量转码，起播慢、个别文件决策卡死
        capability: await getCapabilitySnapshot(),
        client: 'web',
        attempt_id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      };
      if (item.seasonNumber != null) body.season_number = Number(item.seasonNumber);
      if (item.episodeNumber != null) body.episode_number = Number(item.episodeNumber);
      // 上几档播失败了：带上让服务端跳过它们换下一档（decide.py 降档回路）
      if (this._failedTiers && this._failedTiers.length) body.failed_tiers = this._failedTiers;

      // 获取续播位置
      try {
        const resumeResp = await API.getResume(mediaId, item.seasonNumber, item.episodeNumber);
        const resume = resumeResp?.data || resumeResp;
        if (resume?.position_ms > 0) {
          body.start_ms = resume.position_ms;
        }
      } catch (_) { /* 无续播位置 */ }
      if (!alive()) return;

      // 服务端个别文件的决策/转码准备可能极慢：45 秒无响应给出明确错误，
      // 而不是永远停在「正在获取播放链接...」
      let sessionTimeout;
      let sessionResp;
      try {
        sessionResp = await Promise.race([
          API.request('/playback/sessions', { method: 'POST', body }),
          new Promise((_, reject) => {
            sessionTimeout = setTimeout(() => reject(new Error('播放服务响应超时，请稍后重试')), 45000);
          }),
        ]);
      } finally {
        clearTimeout(sessionTimeout);
      }
      if (!alive()) return;
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
      const startMs = isSessionTimeline ? null : (session.start_ms > 0 ? session.start_ms : (body.start_ms || null));

      // 保存必要字段到 session 中供进度上报使用
      if (!session.media_item_id) session.media_item_id = mediaId;
      if (session.season_number == null) session.season_number = item.seasonNumber ?? null;
      if (session.episode_number == null) session.episode_number = item.episodeNumber ?? null;

      // 检测是否需要嵌入式 mpv 播放器（杜比视界/全景声/MKV 等）
      const source = session.source || {};
      const decision = session.decision || {};
      const needsNative = this.needsNativePlayer(source, decision);

      if (needsNative && window.__TAURI__) {
        loading.hidden = true;
        await this.openEmbeddedPlayer(item, streamUrl, subtitleUrls, startMs, session);
      } else {
        // 打开内置 HTML5 播放器
        loading.hidden = true;
        Player.open(item.title || 'MovieClaw', streamUrl, subtitleUrls, startMs, session);
      }

    } catch (e) {
      if (!alive()) return; // 已被新的播放请求取代，别覆盖新界面
      console.error('Playback error:', e);
      if (loadingText) loadingText.textContent = '播放失败: ' + (e.message || e);
      setTimeout(() => {
        if (!alive()) return;
        playerView.hidden = true;
        loading.hidden = true;
      }, 5000);
    }
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
    this.startPlayback({
      media_item_id: sd.media_item_id,
      title: Player.currentTitle,
      library_id: sd.library_id,
      seasonNumber: sd.season_number,
      episodeNumber: sd.episode_number,
    }, true);
  },

  // 终态错误展示：清掉播放器与服务端会话，但保持错误文字可见
  _showPlaybackError(reason) {
    Player.close();
    const view = document.getElementById('playerView');
    const loading = document.getElementById('playerLoading');
    const loadingText = document.getElementById('playerLoadingText');
    if (view) view.hidden = false;
    if (loading) loading.hidden = false;
    if (loadingText) loadingText.textContent = '播放失败: ' + reason;
  },

  // 播放结束 → 自动下一集
  onPlaybackEnded(sessionData) {
    if (localStorage.getItem('mc_autoNext') === '0') return;
    if (!sessionData?.next_episode) return;
    const next = sessionData.next_episode;
    this.showAutoNextCard(next);
  },

  // 检测是否需要原生播放器（杜比/全景声/MKV/ISO 等）
  needsNativePlayer(source, decision) {
    // 杜比视界
    const hdr = (source.hdr || '').toLowerCase();
    if (hdr.includes('dolby') || hdr.includes('dv') || hdr.includes('dovi')) return true;
    // 全景声/TrueHD
    const audioTracks = decision.audio_tracks || [];
    for (const t of audioTracks) {
      const codec = (t.codec || '').toLowerCase();
      if (codec.includes('truehd') || codec.includes('atmos') || codec.includes('dts-hd') || codec.includes('dtshd')) return true;
    }
    // 不支持的容器
    const container = (source.container || '').toLowerCase();
    if (['mkv', 'iso', 'ts', 'm2ts', 'avi', 'wmv', 'flv'].includes(container)) return true;
    // 特殊视频编码
    const vcodec = (source.video_codec || '').toLowerCase();
    if (['vp9', 'vc-1', 'vc1', 'mpeg2', 'mpeg-2', 'theora'].includes(vcodec)) return true;
    return false;
  },

  // 打开嵌入式 mpv 播放器
  async openEmbeddedPlayer(item, streamUrl, subtitleUrls, startMs, session) {
    try {
      // 获取视频区域位置
      const playerView = document.getElementById('playerView');
      const videoWrap = document.querySelector('.player-video-wrap');
      if (!playerView || !videoWrap) throw new Error('播放器容器未找到');

      // 显示播放器 UI（但不显示 video 元素，mpv 自己渲染）
      playerView.hidden = false;
      const video = document.getElementById('playerVideo');
      if (video) video.style.display = 'none'; // 隐藏 HTML5 video

      // 获取主窗口 HWND
      const mainWindow = window.__TAURI__.window.getCurrentWindow();
      const rawHwnd = await window.__TAURI__.core.invoke('plugin:window|internal_current_window')
        .catch(() => null);

      // Tauri 2 获取 HWND
      const hwnd = await window.__TAURI__.core.invoke('get_main_window_hwnd')
        .catch(() => 0);

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
      });

      // 显示控制栏（复用现有 UI）
      Player.showControls();
      Player.autoHideControls();

      // 关闭按钮 → 停止嵌入式播放器
      document.getElementById('playerBack')?.addEventListener('click', async () => {
        await window.__TAURI__.core.invoke('stop_embedded_player').catch(() => {});
        playerView.hidden = true;
        if (video) video.style.display = '';
      }, { once: true });

    } catch (e) {
      console.error('Embedded player failed:', e);
      // 回退到 HTML5 播放器（恢复被隐藏的 video 元素）
      const v = document.getElementById('playerVideo');
      if (v) v.style.display = '';
      Player.open(item.title || 'MovieClaw', streamUrl, subtitleUrls, startMs, session);
    }
  },

  showAutoNextCard(next) {
    let card = document.getElementById('autoNextCard');
    if (card) card.remove();

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
    const timer = setInterval(() => {
      countdown--;
      const el = document.getElementById('autoNextCountdown');
      if (el) el.textContent = countdown;
      if (countdown <= 0) {
        clearInterval(timer);
        card.remove();
        this.startPlayback({
          media_item_id: next.media_item_id,
          title: next.title,
          seasonNumber: next.season_number,
          episodeNumber: next.episode_number,
        });
      }
    }, 1000);

    document.getElementById('btnCancelAutoNext')?.addEventListener('click', () => {
      clearInterval(timer);
      card.remove();
    });
    document.getElementById('btnPlayNext')?.addEventListener('click', () => {
      clearInterval(timer);
      card.remove();
      this.startPlayback({
        media_item_id: next.media_item_id,
        title: next.title,
        seasonNumber: next.season_number,
        episodeNumber: next.episode_number,
      });
    });
  },
};

// 启动
document.addEventListener('DOMContentLoaded', () => App.init());
