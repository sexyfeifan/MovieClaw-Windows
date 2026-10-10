// Native update events must have a visible result, including failures and no update.
window.DesktopUpdates = {
  show(info) {
    document.getElementById('desktopUpdateDialog')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'desktopUpdateDialog';
    dialog.style.cssText = 'margin:auto;width:min(520px,90vw);padding:24px;border:1px solid var(--border-color,#444);border-radius:16px;background:var(--surface,#202020);color:var(--text-primary,#fff)';
    const title = document.createElement('h2');
    title.textContent = info.has_update ? '发现新版本' : '检查更新';
    const message = document.createElement('p');
    message.textContent = info.message || '检查完成';
    message.style.marginTop = '12px';
    dialog.append(title, message);
    if (info.release_notes) {
      const notes = document.createElement('p');
      notes.textContent = info.release_notes;
      notes.style.cssText = 'white-space:pre-wrap;max-height:240px;overflow:auto;margin-top:12px';
      dialog.append(notes);
    }
    const actions = document.createElement('div');
    actions.className = 'settings-actions';
    const close = document.createElement('button');
    close.className = 'btn-secondary'; close.textContent = '关闭';
    close.addEventListener('click', () => dialog.close());
    actions.append(close);
    if (info.has_update) {
      const download = document.createElement('button');
      download.className = 'btn-secondary'; download.textContent = '打开下载页面';
      download.addEventListener('click', async () => {
        try { await window.__TAURI__.core.invoke('open_release_page'); }
        catch (_) { message.textContent = '无法打开下载页面，请稍后重试。'; }
      });
      actions.append(download);
    }
    dialog.append(actions);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog); dialog.showModal();
  },
  async check() {
    try { this.show(await window.__TAURI__.core.invoke('check_for_updates')); }
    catch (_) { this.show({ message: '检查更新失败，请检查网络后重试。' }); }
  },
};

if (window.__TAURI__?.event?.listen) {
  window.__TAURI__.event.listen('update_available', event => window.DesktopUpdates.show({ ...event.payload, has_update: true })).catch(() => {});
  window.__TAURI__.event.listen('update_check_result', event => window.DesktopUpdates.show(event.payload)).catch(() => {});
}
