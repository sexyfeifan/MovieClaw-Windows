const { test, expect } = require('@playwright/test');
const { openDesktop, browseLibrary, state } = require('./helpers.cjs');

async function nativeTracks(page, request) {
  await page.route('**/api/v1/playback/sessions', async route => {
    const response = await route.fetch(); const body = await response.json();
    Object.assign(body.data, { timeline: 'file', start_ms: 0 });
    Object.assign(body.data.decision, { tier: 0, file_id: 1,
      audio_tracks: [
        { ref: 'embedded:0', codec: 'aac', language: 'eng', channels: 2, is_default: true },
        { ref: 'embedded:1', codec: 'aac', language: 'zho', channels: 2 },
      ], subtitles: [
        { track_ref: 'embedded:0', kind: 'ass', language: 'eng' },
        { track_ref: 'embedded:1', kind: 'pgs', language: 'zho' },
      ] });
    await route.fulfill({ response, json: body });
  });
  await page.addInitScript(() => {
    localStorage.setItem('mc_audioLang', 'en'); localStorage.setItem('mc_subLang', 'off');
  });
  await openDesktop(page, request); await browseLibrary(page);
  await page.evaluate(() => Object.assign(window.__fixture.props, {
    aid: 7, sid: 'no', speed: 1, 'sub-delay': 0, 'hwdec-current': 'd3d11va',
    // Deliberately out of order: ffmpeg indexes, type ordinals and mpv IDs differ.
    'track-list': [
      { type: 'video', id: 1, 'ff-index': 0 },
      { type: 'audio', id: 42, 'ff-index': 5, lang: 'zho' },
      { type: 'audio', id: 7, 'ff-index': 2, lang: 'eng' },
      { type: 'sub', id: 19, 'ff-index': 9, lang: 'zho' },
      { type: 'sub', id: 11, 'ff-index': 8, lang: 'eng' },
    ],
  }));
  await page.locator('#posterGrid .poster-card[data-item-id="1"]').click();
  await page.locator('#btnPlay').click();
  await expect.poll(() => page.evaluate(() => Player.mpvTracks.audio.length)).toBe(2);
  await expect.poll(() => page.evaluate(() => Player._reportedStart)).toBe(true);
}
async function property(page, key) { return page.evaluate(key => window.__fixture.props[key], key); }

test('native track menus control actual mpv IDs, subtitle off, delay and speed', async ({ page, request }) => {
  await nativeTracks(page, request);
  await page.locator('#btnSettings').click();
  await page.locator('.player-settings-tab[data-tab="audio"]').click();
  await page.locator('.player-settings-item[onclick*="embedded:1"]').click();
  await expect.poll(() => property(page, 'aid')).toBe(42);
  await page.locator('.player-settings-tab[data-tab="subtitles"]').click();
  await page.locator('[data-sub-index="1"]').click();
  await expect.poll(() => property(page, 'sid')).toBe(19);
  await page.locator('.offset-btn').filter({ hasText: '+0.5s' }).click();
  await expect.poll(() => property(page, 'sub-delay')).toBe(.5);
  await page.locator('[data-sub-index="-1"]').click();
  await expect.poll(() => property(page, 'sid')).toBe('no');
  await page.locator('.player-settings-tab[data-tab="speed"]').click();
  await page.locator('.player-settings-item[onclick="Player.setSpeed(1.5)"]').click();
  await expect.poll(() => property(page, 'speed')).toBe(1.5);
  expect(await page.evaluate(() => document.querySelector('#playerVideo').playbackRate)).toBe(1);
  const calls = await page.evaluate(() => window.__fixture.calls.filter(c => c.command === 'send_mpv_command_embedded').map(c => c.args.command));
  expect(calls).toContainEqual(['set_property', 'aid', 42]);
  expect(calls).toContainEqual(['set_property', 'sid', 19]);
  await page.locator('#playerBack').click();
  await expect.poll(async () => (await state(request)).stopped).toEqual(['session-1']);
});

test('keyboard controls drive the active native engine and close once', async ({ page, request }) => {
  await nativeTracks(page, request);
  await page.locator('#playerTitle').click();
  await page.keyboard.press('Space');
  await expect.poll(() => property(page, 'pause')).toBe(true);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => property(page, 'time-pos')).toBe(31);
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => property(page, 'time-pos')).toBe(30);
  await page.keyboard.press(']');
  await expect.poll(() => property(page, 'speed')).toBe(1.25);
  await page.keyboard.press('Control+.');
  await expect(page.locator('#playerView')).toBeHidden();
  await expect.poll(async () => (await state(request)).stopped).toEqual(['session-1']);
});
