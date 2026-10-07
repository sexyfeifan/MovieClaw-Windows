// MovieClaw Desktop — API client
// Communicates with the MovieClaw server REST API

const API = {
  baseUrl: '',

  init() {
    // 从注入的全局变量获取服务器地址，去掉末尾斜杠
    this.baseUrl = (window.__MOVIECLAW_SERVER__ || '').replace(/\/+$/, '');
  },

  async request(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    let body = options.body || null;
    let contentType = null;

    if (body && typeof body !== 'string') {
      contentType = 'application/json';
      body = JSON.stringify(body);
    }

    // 通过 Tauri Rust 后端代理请求，绕过 CORS
    if (window.__TAURI__) {
      const resp = await window.__TAURI__.core.invoke('proxy_api', {
        method,
        path,
        body: body || null,
        contentType,
      });
      if (resp.status === 204) return null;
      if (resp.status >= 400) {
        throw new Error(`API error ${resp.status}: ${resp.body}`);
      }
      try {
        return JSON.parse(resp.body);
      } catch {
        return resp.body;
      }
    }

    // 回退：直接 fetch（同源部署时可用）
    const url = this.baseUrl + '/api/v1' + path;
    const headers = { 'Accept': 'application/json' };
    if (contentType) headers['Content-Type'] = contentType;
    const res = await fetch(url, { method, headers, body });
    if (res.status === 204) return null;
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);
    }
    return res.json();
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
    return this.request('/auth/session');
  },
};

API.init();
