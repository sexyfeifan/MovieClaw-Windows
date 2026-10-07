// MovieClaw Desktop — API client
// Communicates with the MovieClaw server REST API

const API = {
  baseUrl: '',

  init() {
    // 从注入的全局变量获取服务器地址
    this.baseUrl = window.__MOVIECLAW_SERVER__ || '';
  },

  async request(path, options = {}) {
    const url = this.baseUrl + '/api/v1' + path;
    const headers = { 'Accept': 'application/json', ...options.headers };
    if (options.body && typeof options.body !== 'string' && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    const res = await fetch(url, { ...options, headers });
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
