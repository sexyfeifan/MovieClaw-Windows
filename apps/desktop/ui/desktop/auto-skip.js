// Account preferences come from the playback session, never from another device's local storage.
window.DesktopAutoSkip = (() => {
  let state, timer;
  const owner = () => JSON.stringify([API.baseUrl, App.session?.username || '', API.contextEpoch]);
  const current = s => s === state && s.owner === owner() && s.generation === s.player.generation;
  function clearNotice() {
    clearTimeout(timer);
    const node = document.getElementById('autoSkipFeedback');
    if (node) { node.hidden = true; node.replaceChildren(); }
  }
  function reset() { state = null; clearNotice(); }
  function attach(player, session) {
    reset();
    state = {player, owner:owner(), generation:player.generation, seen:new Set(),
      enabled:session?.auto_skip?.enabled !== false, intro:session?.auto_skip?.intro === true};
  }
  function notice(s, text, undo) {
    if (!current(s)) return;
    clearNotice();
    const node = document.getElementById('autoSkipFeedback');
    if (!node) return;
    node.hidden = false;
    const label = document.createElement('span'); label.textContent = text; node.append(label);
    if (undo) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '撤回';
      button.onclick = async () => {
        if (!current(s)) return;
        button.disabled = true;
        try { await undo(); if (current(s)) clearNotice(); }
        catch (_) { if (current(s)) { button.disabled = false; label.textContent = '设置未保存，请重试'; } }
      };
      node.append(button);
    }
    s.player.syncEmbeddedPlayerRect?.();
    timer = setTimeout(() => { if (current(s)) { clearNotice(); s.player.syncEmbeddedPlayerRect?.(); } }, 8000);
  }
  async function preference(s, intro, enabled) {
    if (!current(s)) return false;
    const id = Number(s.player.context?.media_item_id);
    if (intro && !(id > 0)) return false;
    await API.request(intro ? '/playback/auto-skip/intro/' + id : '/playback/auto-skip',
      {method:'PUT', body:{enabled}, timeoutMs:3000, cancelable:true});
    if (!current(s)) return false;
    s[intro ? 'intro' : 'enabled'] = enabled;
    return true;
  }
  const key = segment => [segment.type,segment.start_ms,segment.end_ms].join(':');
  function check(player) {
    const s = state;
    if (!s || !current(s) || s.player !== player || !s.enabled || !player.activeEngine) return false;
    const position = player.engPos();
    const segment = player.currentSegments.find(v => ['ad','preview','intro'].includes(v.type) &&
      (v.type !== 'intro' || s.intro) && Number.isFinite(v.start_ms) && Number.isFinite(v.end_ms) &&
      position * 1000 >= v.start_ms && position * 1000 < v.end_ms - 3000 && !s.seen.has(key(v)));
    if (!segment) return false;
    s.seen.add(key(segment));
    player.engSeekTo(segment.end_ms / 1000);
    player.currentSkipIndex = -1;
    const button = document.getElementById('playerSkipBtn'); if (button) button.hidden = true;
    notice(s, {ad:'已跳过广告',preview:'已跳过预告',intro:'已跳过片头'}[segment.type], async () => {
      if (segment.type === 'intro' && !await preference(s,true,false)) return;
      if (current(s)) player.engSeekTo(position);
    });
    return true;
  }
  async function manual(player, segment) {
    const s = state;
    if (!s || !current(s) || s.player !== player || !s.enabled || s.intro || segment.type !== 'intro') return;
    s.seen.add(key(segment));
    try {
      if (await preference(s,true,true)) notice(s,'以后这部剧自动跳片头',() => preference(s,true,false));
    } catch (_) { notice(s,'已跳过，本次未能保存自动跳过偏好'); }
  }
  function controls(host) {
    const s = state;
    if (!s || !current(s)) return;
    const row = document.createElement('label'); row.className = 'player-auto-skip-setting';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = s.enabled;
    const label = document.createElement('span'); label.textContent = '自动跳过广告、预告和已记住的片头';
    input.onchange = async () => {
      input.disabled = true;
      try { await preference(s,false,input.checked); }
      catch (_) { notice(s,'自动跳过设置未保存，请重试'); }
      finally { if (current(s)) { input.checked = s.enabled; input.disabled = false; } }
    };
    row.append(input,label); host.append(row);
  }
  return {attach,reset,check,manual,controls};
})();
