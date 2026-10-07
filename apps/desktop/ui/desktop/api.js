// MovieClaw Desktop — API client
// Uses Rust proxy command (proxy_api) for cookie-aware, CORS-free requests

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

  // 通过 proxy_api 的 /__image__ 路径加载需要认证的图片，返回 data URI
  async proxyImage(pathOrUrl) {
    try {
      // 补全相对路径的 /api/v1 前缀（API 返回的路径不带 /api/v1）
      let fullPath = pathOrUrl;
      if (!pathOrUrl.startsWith('http') && !pathOrUrl.startsWith('/api/')) {
        fullPath = '/api/v1' + (pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl);
      }
      const encoded = encodeURIComponent(fullPath);
      const result = await window.__TAURI__.core.invoke('proxy_api', {
        method: 'GET',
        path: '/__image__?url=' + encoded,
        body: null,
      });
      if (result.status === 200 && result.body.startsWith('data:')) {
        return result.body;
      }
      return '';
    } catch (e) {
      console.warn('[API] proxyImage failed:', pathOrUrl, e);
      return '';
    }
  },

  // 通过 Rust proxy_api 命令发送请求（自动 Cookie，绕过 CORS，无 URL scope 限制）
  async rawFetch(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body || null;

    console.log('[API] proxy_api', method, path);
    try {
      const result = await window.__TAURI__.core.invoke('proxy_api', {
        method,
        path,
        body: body || null,
      });
      console.log('[API] Response status:', result.status);
      // 构造一个类 Response 对象
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        text: async () => result.body,
        json: async () => JSON.parse(result.body),
      };
    } catch (e) {
      console.error('[API] proxy_api error:', e);
      throw new Error('网络请求失败: ' + (e.message || e));
    }
  },

  async request(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    let body = options.body;

    // body 已经是对象则序列化为 JSON
    if (body && typeof body !== 'string') {
      body = JSON.stringify(body);
    }

    const res = await this.rawFetch(path, { method, body });

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
