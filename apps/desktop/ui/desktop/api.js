// MovieClaw Desktop — API client
// Uses tauri-plugin-http for cookie-aware, CORS-free requests

const API = {
  baseUrl: '',

  async init() {
    this.baseUrl = (window.__MOVIECLAW_SERVER__ || '').replace(/\/+$/, '');
    if (!this.baseUrl && window.__TAURI__) {
      try {
        const url = await window.__TAURI__.core.invoke('get_server_url');
        this.baseUrl = (url || '').replace(/\/+$/, '');
      } catch (e) {
        console.error('Failed to get server URL:', e);
      }
    }
  },

  // 通过 tauri-plugin-http 发送请求（自动 Cookie，绕过 CORS）
  async rawFetch(url, options = {}) {
    if (window.__TAURI__?.http?.fetch) {
      console.log('[API] Using tauri-plugin-http fetch:', url);
      return window.__TAURI__.http.fetch(url, options);
    }
    console.warn('[API] tauri-plugin-http not available, falling back to regular fetch');
    return fetch(url, { ...options, credentials: 'include' });
  },

  async request(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const url = this.baseUrl + '/api/v1' + path;

    let body = options.body;
    let headers = { 'Accept': 'application/json', ...options.headers };

    if (body && typeof body !== 'string') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }

    console.log('[API]', method, url);
    let res;
    try {
      res = await this.rawFetch(url, { method, headers, body });
    } catch (e) {
      console.error('[API] Network error:', e);
      throw new Error('网络请求失败: ' + (e.message || e));
    }

    console.log('[API] Response status:', res.status);

    if (res.status === 204) return null;

    const text = await res.text();
    console.log('[API] Response body:', text.substring(0, 200));
    let data;
    try { data = JSON.parse(text); } catch { data = text; }

    if (!res.ok) {
      const msg = (data && data.message) || text || `HTTP ${res.status}`;
      throw new Error(`API ${res.status}: ${msg}`);
    }
    return data;
  },

  // ===== 媒体库 =====
  listLibraries() {
    return this.request('/libraries');
  },

  getLibrary(id) {
    return this.request(`/libraries/${id}`);
  },

  listLibraryItems(libraryId, params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.request(`/libraries/${libraryId}/items${qs ? '?' + qs : ''}`);
  },

  getItemDetail(libraryId, itemId) {
    return this.request(`/libraries/${libraryId}/items/${itemId}`);
  },

  getItemEpisodes(libraryId, itemId) {
    return this.request(`/libraries/${libraryId}/items/${itemId}/episodes`);
  },

  // ===== 合集 =====
  listCollections() {
    return this.request('/collections');
  },

  getCollection(id) {
    return this.request(`/collections/${id}`);
  },

  listCollectionItems(id) {
    return this.request(`/collections/${id}/items`);
  },

  // ===== 搜索 =====
  search(query) {
    return this.request(`/search/library?q=${encodeURIComponent(query)}`);
  },

  // ===== 播放 =====
  startPlayback(mediaItemId, options = {}) {
    return this.request('/playback/sessions', {
      method: 'POST',
      body: {
        mediaItemId,
        capability: { universal: true },
        ...options,
      },
    });
  },

  reportProgress(sessionId, event, timeMs, durationMs) {
    return this.request('/playback/progress', {
      method: 'POST',
      body: {
        sessionId,
        event,
        timeMs,
        durationMs,
      },
    });
  },

  // ===== 认证 =====
  getSession() {
    return this.request('/auth/me');
  },

  async login(username, password, remember = true) {
    return this.request('/auth/login', {
      method: 'POST',
      body: { username, password, remember },
    });
  },

  async getBootstrapStatus() {
    return this.request('/auth/bootstrap');
  },

  async createAdmin(username, password) {
    return this.request('/auth/bootstrap', {
      method: 'POST',
      body: { username, password },
    });
  },
};

API.init();
