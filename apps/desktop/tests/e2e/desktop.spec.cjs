const { test, expect } = require('@playwright/test');

// Browser tests exercise the shipped DOM and HTTP contract. This bridge is deliberately a
// fixture: native WebView2, Win32 child-window rendering and hardware decode need Windows.
async function openDesktop(page, request, options = {}) {
  await request.post('/__test/reset', { data: options });
  await page.addInitScript(({ native }) => {
    window.__fixture = { calls: [], windows: [], running: false, instanceId: null,
      props: { 'time-pos': 21, duration: 3300, pause: false, 'eof-reached': false,
        'video-out-params': { w: 1280, h: 720 }, 'demuxer-cache-duration': 30 } };
    const pending = new Map();
    const listeners = new Map();
    window.__TAURI__ = {
      event: { listen: async (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); } },
      window: { getCurrentWindow: () => Object.fromEntries(['minimize', 'toggleMaximize', 'close', 'setFullscreen'].map(name => [name, async () => window.__fixture.windows.push(name)])) },
      core: { invoke: async (command, args = {}) => {
        const f = window.__fixture;
        f.calls.push({ command, args });
        if (command === 'get_server_url') return location.origin;
        if (command === 'get_app_version') return '0.2.111';
        if (command === 'check_for_updates') return { has_update: false, message: '已是最新版本 (0.2.111)' };
        if (command === 'proxy_api') {
          const controller = new AbortController(); pending.set(args.requestId, controller);
          try {
            let target = args.path;
            if (target.startsWith('/__image__')) return { status: 404, body: '', headers: {} };
            if (target.startsWith('/__stream__')) target = new URLSearchParams(target.split('?')[1]).get('url');
            const url = target.startsWith('http') ? target : location.origin + (target.startsWith('/api/') ? target : '/api/v1' + target);
            const response = await fetch(url, { method: args.method, body: args.body,
              signal: controller.signal, headers: { 'Content-Type': 'application/json', ...args.headers } });
            const binary = args.path.startsWith('/__stream__') && response.headers.get('Content-Type')?.includes('video/');
            const body = binary ? btoa(String.fromCharCode(...new Uint8Array(await response.arrayBuffer()))) : await response.text();
            return { status: response.status, body, headers: Object.fromEntries(response.headers) };
          } finally { pending.delete(args.requestId); }
        }
        if (command === 'cancel_proxy_request') { pending.get(args.requestId)?.abort(); return; }
        if (command === 'has_embedded_player') return native;
        if (command === 'get_main_window_hwnd') return 1;
        if (command === 'launch_embedded_player') { f.running = true; f.instanceId = args.instanceId; return; }
        if (command === 'stop_embedded_player') {
          if (args.instanceId == null || args.instanceId === f.instanceId) f.running = false;
          return;
        }
        if (command === 'get_embedded_player_status') return { running: f.running && (args.instanceId == null || args.instanceId === f.instanceId), exit_code: null };
        if (command === 'send_mpv_command_embedded') {
          const c = args.command;
          if (c[0] === 'get_property') return { data: f.props[c[1]] ?? 0 };
          if (c[0] === 'set_property') f.props[c[1]] = c[2];
          if (c[0] === 'seek') f.props['time-pos'] = c[1];
          return { data: null };
        }
        if (['resize_embedded_player', 'set_embedded_player_visible', 'complete_shutdown', 'clear_server_url'].includes(command)) return;
        throw new Error('Unexpected fixture command: ' + command);
      } },
    };
  }, { native: options.native !== false });
  await page.goto('/desktop/index.html');
}
async function state(request) { return (await request.get('/__test/state')).json(); }
async function browseLibrary(page) {
  await page.locator('#libraryNav [data-library-id="1"]').click();
  await expect(page.locator('#posterGrid .poster-card')).toHaveCount(60);
}

test('login keeps window controls usable and enters the authenticated library', async ({ page, request }) => {
  await openDesktop(page, request, { authenticated: false });
  await expect(page.locator('#loginForm')).toBeVisible();
  await page.locator('#btnMinimize').click();
  await expect.poll(() => page.evaluate(() => window.__fixture.windows)).toEqual(['minimize']);
  await page.locator('#loginUser').fill('fixture');
  await page.locator('#loginPass').fill('fixture-password');
  await page.locator('#loginBtn').click();
  await expect(page.locator('#heroBanner')).toBeVisible();
  await browseLibrary(page);
  // A second initialization must not accumulate titlebar handlers.
  await page.evaluate(() => App.init());
  await page.locator('#btnMinimize').click();
  await expect.poll(() => page.evaluate(() => window.__fixture.windows.length)).toBe(2);
});

test('library loads beyond 200 and sorts through server pagination', async ({ page, request }) => {
  await openDesktop(page, request);
  await browseLibrary(page);
  let snapshot = await state(request);
  expect(snapshot.requests.filter(r => r.path === '/libraries/1/items' && r.query.limit === '60')).toHaveLength(1);
  for (let i = 0; i < 6; i++) {
    await page.locator('#wallSentinel').scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
  }
  await expect(page.locator('#posterGrid .poster-card')).toHaveCount(245);
  await page.locator('#wallSort').selectOption('title');
  await expect(page.locator('#posterGrid .poster-card').first()).toHaveAttribute('data-item-id', '245');
  snapshot = await state(request);
  expect(snapshot.requests.some(r => r.path === '/libraries/1/items' && r.query.sort === 'title' && r.query.offset === '0')).toBe(true);
  await page.locator('#wallOrder').selectOption('asc');
  await expect(page.locator('#posterGrid .poster-card').first()).toHaveAttribute('data-item-id', '1');
  await page.locator('[data-page="favorites"]').click();
  await page.locator('#libraryNav [data-library-id="1"]').click();
  await expect(page.locator('#wallOrder')).toHaveValue('asc');
});

test('nested search hits render as text, paginate and clear back to the prior page', async ({ page, request }) => {
  await openDesktop(page, request);
  await browseLibrary(page);
  const query = '<img src=x onerror="window.__xss=1">';
  await page.locator('#searchInput').fill(query);
  await expect(page.locator('#posterGrid .poster-card').first()).toHaveAttribute('data-item-id', '201');
  await expect(page.locator('#posterGrid')).toContainText(query);
  await page.locator('#wallSentinel').scrollIntoViewIfNeeded();
  await expect(page.locator('#posterGrid .poster-card')).toHaveCount(2);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(await page.locator('#posterGrid img[onerror*="__xss"]').count()).toBe(0);
  await page.locator('#searchInput').fill('');
  await expect(page.locator('.page-title')).toHaveText('测试媒体库');
});

test('a delayed search response cannot overwrite a newer route', async ({ page, request }) => {
  await openDesktop(page, request);
  await expect(page.locator('#heroBanner')).toBeVisible();
  await page.locator('#searchInput').fill('慢搜索');
  await expect.poll(async () => (await state(request)).requests.some(r => r.path === '/search/library')).toBe(true);
  await page.locator('[data-page="favorites"]').click();
  await expect(page.locator('.page-title')).toHaveText('我的收藏');
  await page.waitForTimeout(1100);
  await expect(page.locator('.page-title')).toHaveText('我的收藏');
  expect(await page.evaluate(() => window.__fixture.calls.some(c => c.command === 'cancel_proxy_request'))).toBe(true);
});

test('accounts switch by username and mark the active account', async ({ page, request }) => {
  await openDesktop(page, request);
  await page.locator('[data-page="settings"]').click();
  await expect(page.locator('#accountList')).toContainText('当前');
  await page.locator('#accountList button').filter({ hasText: '切换' }).click();
  await expect.poll(async () => (await state(request)).username).toBe('second');
  const requestBody = (await state(request)).requests.find(r => r.path === '/auth/accounts/switch').body;
  expect(requestBody).toEqual({ username: 'second' });
});

test('third-season resume and mpv close report the final file position then release session', async ({ page, request }) => {
  await openDesktop(page, request);
  await browseLibrary(page);
  await page.locator('#posterGrid .poster-card[data-item-id="3"]').click();
  await expect(page.locator('#btnPlay')).toContainText('第 3 季');
  await page.locator('#btnPlay').click();
  await expect(page.locator('#playerView')).toBeVisible();
  await expect.poll(async () => (await state(request)).requests.some(r => r.path === '/playback/progress' && r.body.event === 'start')).toBe(true);
  const start = (await state(request)).requests.find(r => r.path === '/playback/sessions').body;
  expect(start.season_number).toBe(3); expect(start.episode_number).toBe(2);
  expect(start.capability.universal).toBe(true);
  await expect(page.locator('#playerTime')).toHaveText('5:21');
  await page.locator('#playerBack').click();
  await expect(page.locator('#playerView')).toBeHidden();
  await expect.poll(async () => (await state(request)).stopped).toEqual(['session-1']);
  const stop = (await state(request)).requests.find(r => r.path === '/playback/progress' && r.body.event === 'stop');
  expect(stop.body).toMatchObject({ position_ms: 321000, season_number: 3, episode_number: 2 });
  expect(await page.evaluate(() => window.__fixture.running)).toBe(false);
});

test('closing during a delayed session response releases it without reopening the player', async ({ page, request }) => {
  await openDesktop(page, request, { sessionDelay: 900 });
  await browseLibrary(page);
  await page.locator('#posterGrid .poster-card[data-item-id="1"]').click();
  await page.locator('#btnPlay').click();
  await expect.poll(async () => (await state(request)).created.length).toBe(1);
  await page.locator('#playerBack').click();
  await expect(page.locator('#playerView')).toBeHidden();
  await expect.poll(async () => (await state(request)).stopped).toEqual(['session-1']);
  expect(await page.evaluate(() => window.__fixture.calls.filter(c => c.command === 'launch_embedded_player').length)).toBe(0);
  await expect(page.locator('#playerView')).toBeHidden();
});

test('HTML5 decodes a real MP4 before reporting start and closes on the file timeline', async ({ page, request }) => {
  await openDesktop(page, request, { native: false });
  await browseLibrary(page);
  await page.locator('#posterGrid .poster-card[data-item-id="1"]').click();
  await page.locator('#btnPlay').click();
  await expect.poll(async () => (await state(request)).requests.some(r => r.path === '/playback/progress' && r.body.event === 'start')).toBe(true);
  await expect.poll(() => page.evaluate(() => document.querySelector('#playerVideo').getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(0);
  await page.locator('#btnPlayPause').click();
  const position = await page.evaluate(() => Player.snapshot().positionMs);
  expect(position).toBeGreaterThanOrEqual(300000);
  expect(position).toBeLessThan(308000);
  expect(await page.evaluate(() => Player.engDuration())).toBe(3600);
  await page.locator('#playerBack').click();
  await expect.poll(async () => (await state(request)).stopped).toEqual(['session-1']);
  const stop = (await state(request)).requests.find(r => r.path === '/playback/progress' && r.body.event === 'stop');
  expect(Math.abs(stop.body.position_ms - position)).toBeLessThan(500);
});

test('an actor opens credits from the person detail response and returns to the media', async ({ page, request }) => {
  await openDesktop(page, request);
  await browseLibrary(page);
  await page.locator('#posterGrid .poster-card[data-item-id="3"]').click();
  await page.locator('.person-card[data-person-id="9"]').click();
  await expect(page.locator('.person-name')).toHaveText('测试演员');
  await expect(page.locator('.person-works .poster-card')).toHaveCount(1);
  expect((await state(request)).requests.filter(r => r.path === '/people/9/credits')).toHaveLength(0);
  await page.locator('.person-works .poster-card').click();
  await expect(page.locator('#btnPlay')).toContainText('第 3 季');
});

test('session expiration prompts for a password and restores the requested route', async ({ page, request }) => {
  await openDesktop(page, request);
  await browseLibrary(page);
  await request.post('/__test/reset', { data: { authenticated: false } });
  await page.locator('[data-page="favorites"]').click();
  await expect(page.locator('#loginForm')).toBeVisible();
  await expect(page.locator('#loginError')).toContainText('登录已失效');
  await page.locator('#loginPass').fill('fixture-password');
  await page.locator('#loginBtn').click();
  await expect(page.locator('.page-title')).toHaveText('我的收藏');
});

test('manual update check shows a visible result with the runtime version', async ({ page, request }) => {
  await openDesktop(page, request);
  await page.locator('[data-page="settings"]').click();
  await expect(page.locator('#settingsVersion')).toHaveText('版本 0.2.111');
  await page.locator('#btnCheckUpdates').click();
  await expect(page.locator('#desktopUpdateDialog')).toContainText('已是最新版本');
  await page.locator('#desktopUpdateDialog button').filter({ hasText: '关闭' }).click();
  await expect(page.locator('#desktopUpdateDialog')).toHaveCount(0);
});

test('HLS loads real fMP4 fragments through the proxy loader and reports file time', async ({ page, request }) => {
  await openDesktop(page, request, { native: false, hls: true });
  await browseLibrary(page);
  await page.locator('#posterGrid .poster-card[data-item-id="1"]').click();
  await page.locator('#btnPlay').click();
  await expect.poll(() => page.evaluate(() => document.querySelector('#playerVideo').getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(0);
  await expect.poll(async () => (await state(request)).requests.some(r => r.path === '/playback/progress' && r.body.event === 'start')).toBe(true);
  expect(await page.evaluate(() => !!Player.hls)).toBe(true);
  expect(await page.evaluate(() => Player.engPos())).toBeGreaterThanOrEqual(300);
  await page.locator('#playerBack').click();
  await expect.poll(async () => (await state(request)).stopped).toEqual(['session-1']);
  await expect(page.locator('#playerView')).toBeHidden();
});
