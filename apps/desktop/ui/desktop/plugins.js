// Server-advertised entries follow the current member's visibility and navigation preferences.
window.DesktopPlugins = (() => {
  let apps = [], generation = 0, refreshedAt = 0, refreshing = false;
  function reset() { apps = []; generation++; }
  function has(id) { return apps.some(app => app.id === id && app.nav === true); }
  function entries(preferences = {}) {
    const hidden = new Set(preferences.nav?.hidden || []), order = preferences.nav?.order || [];
    return apps.filter(app => app.nav === true).flatMap(app => (app.entries || []).map((entry,index) =>
      ({id:`app:${app.id}:${index}`,appId:app.id,index,label:entry.label || app.name})))
      .filter(entry => !hidden.has(entry.id)).sort((a,b) => {
        const index = id => {const n=order.indexOf(id); return n < 0 ? order.length : n;};
        return index(a.id)-index(b.id);
      });
  }
  async function load(api = API, signal) {
    const sequence = ++generation, epoch = API.contextEpoch;
    try {
      const result = await api.request('/ui/apps',{signal,timeoutMs:3000});
      if (sequence !== generation || epoch !== API.contextEpoch) return;
      const data = result?.data ?? result;
      apps = Array.isArray(data) ? data.filter(app => /^[a-z0-9-]+$/.test(app.id) && Array.isArray(app.entries)) : [];
    } catch (error) {
      if (sequence !== generation || epoch !== API.contextEpoch) return;
      apps = [];
      if (error.name !== 'AbortError' && ![401,403,404].includes(error.status)) console.warn('插件入口暂不可用');
    }
  }
  async function open(id,index=0) {
    if (!has(id)) { App.notice('插件已移除或当前账号没有权限'); return false; }
    const epoch=API.contextEpoch;
    try {
      await API.nativeCall('open_plugin_page',{entryId:id,index});
      return epoch === API.contextEpoch;
    } catch (error) { if (epoch === API.contextEpoch) App.notice(error.message || '无法打开插件'); return false; }
  }
  function nav() {
    const host=document.getElementById('pluginNav'); if (!host) return;
    const rows=entries(App.uiPreferences);
    host.replaceChildren(); host.hidden=!rows.length;
    for (const row of rows) {
      const button=document.createElement('button'); button.className='nav-item';
      button.dataset.pluginId=row.appId; button.dataset.pluginIndex=String(row.index);
      button.textContent=row.label; button.title=row.label; button.setAttribute('aria-label',row.label);
      button.addEventListener('click',()=>open(row.appId,row.index));host.append(button);
    }
  }
  async function refresh(force = false) {
    if (!App.session || App._authPending || refreshing || (!force && Date.now() - refreshedAt < 15000)) return;
    refreshing = true;
    try {
      const before = JSON.stringify(apps), available = window.DesktopFriends?.available();
      API.nativeCall('refresh_server_routes').catch(() => {});
      await load();
      await window.DesktopFriends?.discover();
      if (App.session) nav();
      if (App.currentPage === 'settings' && (before !== JSON.stringify(apps) || available !== window.DesktopFriends?.available())) {
        window.DesktopFriends?.settings(document.getElementById('content'));
      }
      refreshedAt = Date.now();
    } finally { refreshing = false; }
  }
  window.addEventListener('focus', () => refresh());
  window.addEventListener('online', () => refresh(true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  return {load,reset,has,entries,nav,open,refresh};
})();
