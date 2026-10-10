const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function harness(options = {}) {
  const calls = [], events = [], timers = new Map(), intervals = new Map(), elements = new Map();
  let timer = 0;
  function element(id) {
    const listeners = new Map();
    return {
      id, style: {}, dataset: {}, hidden: false, children: [], innerHTML: '', textContent: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
      emit(name) { for (const fn of listeners.get(name) || []) fn({ target: this }); },
      appendChild(child) { this.children.push(child); if (child.id) elements.set(child.id, child); },
      remove() { elements.delete(this.id); },
      removeAttribute() {}, querySelectorAll() { return []; },
      getBoundingClientRect() { return { left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700 }; },
    };
  }
  for (const id of ['playerView', 'playerTitle', 'playerLoading', 'playerLoadingText', 'playerSeek', 'playerRemaining', 'playerVideo', 'playerTopbar', 'playerControls']) {
    elements.set(id, element(id));
  }
  const video = Object.assign(elements.get('playerVideo'), {
    currentTime: 0, duration: 0, paused: true, volume: 1, muted: false, textTracks: [], readyState: 0,
    buffered: { length: 0 }, play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; }, load() {},
  });
  const API = {
    baseUrl: 'https://server.invalid', contextEpoch: 0,
    reportProgress(...args) { calls.push(['progress', ...args]); return options.reportProgress ? options.reportProgress(...args) : Promise.resolve(); },
    sessionStop(id) { calls.push(['stop', id]); return Promise.resolve(); },
    sessionPing(id) { calls.push(['ping', id]); return Promise.resolve(); },
    getItemDetail() { return Promise.resolve({ kind: 'movie', files: [] }); },
    getItemEpisodes() { return Promise.resolve({ episodes: [] }); },
    getResume() { return Promise.resolve({}); },
    request(route, args) { calls.push(['request', route, args]); return options.request ? options.request(route, args) : Promise.resolve(session()); },
  };
  const win = {
    devicePixelRatio: 1, __MOVIECLAW_SERVER__: API.baseUrl,
    dispatchEvent(event) { events.push(event); }, addEventListener() {},
    __TAURI__: { core: { async invoke(name, args) {
      calls.push(['invoke', name, args]);
      if (options.invoke) return options.invoke(name, args);
      if (name === 'has_embedded_player') return false;
      if (name === 'get_main_window_hwnd') return 1;
      if (name === 'get_embedded_player_status') return { running: true };
      return {};
    } } },
  };
  const context = vm.createContext({
    window: win, API, navigator: {}, performance: { now: () => 1000 },
    console: { log() {}, warn() {}, error() {} },
    localStorage: { getItem() { return null; }, setItem() {} },
    document: { fullscreenElement: null, addEventListener() {}, removeEventListener() {},
      getElementById: id => elements.get(id) || null,
      querySelector: () => element('wrap'), querySelectorAll: () => [], createElement: () => element(''),
    },
    CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
    setTimeout(fn, ms) { const id = ++timer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = ++timer; intervals.set(id, { fn, ms }); return id; },
    clearInterval(id) { intervals.delete(id); },
    requestAnimationFrame(fn) { fn(); },
    atob: data => Buffer.from(data, 'base64').toString('binary'),
  });
  for (const file of ['player.js', 'app.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/desktop', file), 'utf8'), context);
  vm.runInContext('globalThis.P = Player; globalThis.A = App; getCapabilitySnapshot = async () => ({video:[],audio:[],containers:["mp4"]});', context);
  const P = context.P, A = context.A;
  P.init();
  A.libraries = [{ id: 9 }];
  return { P, A, API, calls, events, video, elements, timers, intervals, context, win };
}

function session(overrides = {}) {
  return { media_item_id: 77, session_id: 'session-a', stream_url: '/playback/a.mp4', timeline: 'file',
    start_ms: 0, watch: { duration_ms: 3600000 }, decision: { tier: 3, file_id: 81 }, ...overrides };
}
function item(overrides = {}) {
  return { media_item_id: 77, library_id: 9, title: 'Title', kind: 'movie', files: [],
    seasonNumber: 0, episodeNumber: 0, episodes: [], ...overrides };
}

test('HTML5 reports only after first frame and uses file time for a session-relative stream', async () => {
  const h = harness();
  h.P.open('Title', 'https://server.invalid/a.mp4', [], 0, session({ timeline: 'session', start_ms: 1800000 }), item());
  assert.equal(h.calls.filter(c => c[0] === 'progress').length, 0);
  h.video.currentTime = 60;
  h.video.duration = 1800;
  h.video.emit('playing');
  await flush();
  assert.equal(h.P.engPos(), 1860);
  assert.equal(h.P.engDuration(), 3600);
  assert.equal(h.calls.find(c => c[0] === 'progress')[3], 1860000);
  const ping = [...h.intervals.values()].find(t => t.ms === 30000);
  await ping.fn();
  assert.deepEqual(h.calls.filter(c => c[0] === 'ping'), [['ping', 'session-a']]);
  await h.P.close();
  assert.equal(h.calls.filter(c => c[0] === 'progress').at(-1)[3], 1860000);
  assert.equal(h.events.at(-1).type, 'movieclaw:playback-stopped');
});

test('closing mpv snapshots its position before clearing the engine and reports stop once', async () => {
  const h = harness();
  h.P.adoptSession('Title', session(), item(), 'mpv');
  h.win.__MOVIECLAW_MPV_ACTIVE = true;
  h.P.mpvInstanceId = 42;
  h.P.mpvState = { time: 321, duration: 3600, paused: false };
  h.P.startProgressReporting();
  await flush();
  await h.P.close();
  await h.P.close();
  const stops = h.calls.filter(c => c[0] === 'progress' && c[2] === 'stop');
  assert.equal(stops.length, 1);
  assert.equal(stops[0][3], 321000);
  assert.equal(stops[0][4], 3600000);
  assert.equal(h.calls.find(c => c[0] === 'invoke' && c[1] === 'stop_embedded_player')[2].instanceId, 42);
});

test('TV quality switch preserves unit, library, file, track choices and attempt and replaces the session', async () => {
  const h = harness({ request: () => Promise.resolve(session({ session_id: 'session-b', timeline: 'session', start_ms: 300000 })) });
  const source = item({ seasonNumber: 2, episodeNumber: 4, attemptId: 'logical-play', file_id: 81,
    audio_track: 'embedded:2', subtitle_track: 'off', episodes: [{ owned: true, episode_number: 5 }] });
  h.P.open('Title', 'https://server.invalid/a.mp4', [], 0, session(), source);
  h.video.currentTime = 300;
  h.video.emit('playing');
  await h.P.selectQuality(720);
  const body = h.calls.find(c => c[0] === 'request')[2].body;
  assert.equal(body.season_number, 2);
  assert.equal(body.episode_number, 4);
  assert.equal(body.file_id, 81);
  assert.equal(body.audio_track, 'embedded:2');
  assert.equal(body.subtitle_track, 'off');
  assert.equal(body.max_height, 720);
  assert.equal(body.start_ms, 300000);
  assert.equal(body.attempt_id, 'logical-play');
  assert.equal(h.P.context.library_id, 9);
  assert.equal(h.P.sessionId, 'session-b');
  assert.equal(h.video.currentTime, 0);
  assert.equal(h.P.engPos(), 300);
  assert.ok(h.calls.some(c => c[0] === 'stop' && c[1] === 'session-a'));
});

test('explicit zero remains zero in negotiation and does not reuse an old video position', async () => {
  const h = harness();
  h.video.currentTime = 123;
  await h.A.startPlayback(item({ startMs: 0 }));
  assert.equal(h.calls.find(c => c[0] === 'request')[2].body.start_ms, 0);
  assert.equal(h.video.currentTime, 0);
});

test('a session arriving after close is deleted and cannot reopen the player', async () => {
  const pending = deferred();
  const h = harness({ request: () => pending.promise });
  const start = h.A.startPlayback(item());
  await flush();
  await h.P.close();
  pending.resolve(session({ session_id: 'late-session' }));
  await start;
  assert.equal(h.P.activeEngine, null);
  assert.equal(h.elements.get('playerView').hidden, true);
  assert.ok(h.calls.some(c => c[0] === 'stop' && c[1] === 'late-session'));
});

test('a session arriving after the UI timeout is also deleted', async () => {
  const pending = deferred();
  const h = harness({ request: () => pending.promise });
  h.A._showPlaybackError = () => h.P.close();
  const start = h.A.startPlayback(item());
  await flush();
  const timeout = [...h.timers.values()].find(t => t.ms === 45000);
  timeout.fn();
  await start;
  pending.resolve(session({ session_id: 'timeout-session' }));
  await flush();
  assert.ok(h.calls.some(c => c[0] === 'stop' && c[1] === 'timeout-session'));
  assert.equal(h.P.activeEngine, null);
});

test('EOF completes once; early EOF restarts at the current file position', async () => {
  const h = harness();
  h.P.open('Title', 'a.mp4', [], 0, session(), item());
  h.video.currentTime = 300;
  h.video.emit('playing');
  const restarted = [];
  h.A.restartPlaybackAt = ms => restarted.push(ms);
  h.P.reportPlaybackEnd();
  assert.deepEqual(restarted, [300000]);
  assert.equal(h.P._ended, false);
  h.video.currentTime = 3598;
  h.P.reportPlaybackEnd();
  h.P.reportPlaybackEnd();
  await flush();
  assert.equal(h.P._ended, true);
  assert.equal(h.calls.filter(c => c[0] === 'progress' && c[2] === 'stop').length, 1);
});

test('seeking outside a session-relative buffer renegotiates with file time', () => {
  const h = harness();
  h.P.open('Title', 'a.mp4', [], 0, session({ timeline: 'session', start_ms: 1800000 }), item());
  h.video.currentTime = 60;
  h.video.buffered = { length: 1, start: () => 0, end: () => 120 };
  const restarted = [];
  h.A.restartPlaybackAt = ms => restarted.push(ms);
  h.P.engSeekTo(600);
  assert.deepEqual(restarted, [600000]);
  h.P.engSeekTo(1890);
  assert.equal(h.video.currentTime, 90);
});

test('auto next is cancelled on close; if executed it carries the original library and episode context', async () => {
  const h = harness();
  h.P.adoptSession('Title', session(), item({ seasonNumber: 2, episodeNumber: 4 }), 'html5');
  h.A.showAutoNextCard({ context: h.P.context, media_item_id: 77, title: 'E5', season_number: 2, episode_number: 5 });
  const callback = [...h.intervals.values()].find(t => t.ms === 1000).fn;
  const plays = [];
  h.A.startPlayback = value => plays.push(value);
  await h.P.close();
  for (let i = 0; i < 8; i++) callback();
  assert.equal(plays.length, 0);
  h.P.adoptSession('Title', session(), item({ seasonNumber: 2, episodeNumber: 4 }), 'html5');
  h.A.showAutoNextCard({ context: h.P.context, media_item_id: 77, title: 'E5', season_number: 2, episode_number: 5 });
  const next = [...h.intervals.values()].find(t => t.ms === 1000).fn;
  for (let i = 0; i < 8; i++) next();
  assert.equal(plays.length, 1);
  assert.equal(plays[0].library_id, 9);
  assert.equal(plays[0].episodeNumber, 5);
  assert.equal(plays[0].file_id, undefined);
  assert.equal(plays[0].attemptId, undefined);
});

test('changing an episode releases the old file pin while quality changes retain it', () => {
  const h = harness();
  h.P.adoptSession('Title S2E4', session(), item({ seasonNumber: 2, episodeNumber: 4, file_id: 81, attemptId: 'old-attempt' }), 'html5');
  const plays = [];
  h.A.startPlayback = value => plays.push(value);
  h.P.playEpisode({ owned: true, episode_number: 5 });
  assert.equal(plays[0].library_id, 9);
  assert.equal(plays[0].seasonNumber, 2);
  assert.equal(plays[0].episodeNumber, 5);
  assert.equal(plays[0].file_id, undefined);
  assert.equal(plays[0].attemptId, undefined);
  assert.equal(plays[0].startMs, null);
});

test('file duration prioritizes source metadata and never invents a total from a session tail', () => {
  const h = harness();
  h.P.adoptSession('Title', session({ source: { duration_ms: 7200000 } }), item(), 'html5');
  assert.equal(h.P.engDuration(), 7200);
  h.P.adoptSession('Title', session({ timeline: 'session', start_ms: 1800000, watch: { duration_ms: null } }), item(), 'html5');
  h.video.duration = 30;
  assert.equal(h.P.engDuration(), 0);
  h.P.adoptSession('Title', session({ timeline: 'session', watch: { duration_ms: null } }), item({ files: [{ id: 81, duration_seconds: 5000 }] }), 'html5');
  assert.equal(h.P.engDuration(), 5000);
  h.P.adoptSession('Title', session({ session_id: null, timeline: 'session', start_ms: 1800000, watch: null }), item(), 'html5');
  h.video.duration = 3600;
  assert.equal(h.P.engDuration(), 3600);
  assert.equal(h.P.originMs, 0);
});

test('mpv reports only after rendered video and detects EOF through the actual native poll', async () => {
  let position = 60, rendered = false, eof = false;
  const h = harness({ invoke(name, args) {
    if (name === 'send_mpv_command_embedded') return { data: {
      'time-pos': position, duration: 1800, pause: false, 'demuxer-cache-duration': 30,
      'eof-reached': eof, 'video-out-params': rendered ? { width: 1920, height: 1080 } : null,
    }[args.command[1]] };
    if (name === 'get_embedded_player_status') return { running: true };
    return {};
  } });
  h.P.adoptSession('Title', session({ timeline: 'session', start_ms: 1800000 }), item(), 'mpv');
  h.win.__MOVIECLAW_MPV_ACTIVE = true;
  h.P.mpvInstanceId = 12;
  let completions = 0;
  h.A.onPlaybackEnded = () => completions++;
  h.P.startMpvPoll();
  await flush();
  assert.equal(h.calls.filter(c => c[0] === 'progress').length, 0);
  rendered = true;
  const poll = [...h.intervals.values()].find(t => t.ms === 500);
  await poll.fn();
  await flush();
  assert.equal(h.calls.find(c => c[0] === 'progress')[3], 1860000);
  assert.equal(h.P.engDuration(), 3600);
  assert.equal(h.elements.get('playerLoading').hidden, true);
  position = 1799; eof = true;
  await poll.fn();
  await poll.fn();
  await flush();
  assert.equal(completions, 1);
  assert.equal(h.calls.filter(c => c[0] === 'progress' && c[2] === 'stop').length, 1);
  assert.equal(h.calls.filter(c => c[0] === 'progress').at(-1)[3], 3600000);
});

test('a native launch finishing after close is stopped by instance and does not revive the player', async () => {
  const pending = deferred();
  const h = harness({ invoke(name) {
    if (name === 'launch_embedded_player') return pending.promise;
    return name === 'get_main_window_hwnd' ? 1 : {};
  } });
  h.A._playbackSeq = 12;
  const launch = h.A.openEmbeddedPlayer(item(), 'a.mp4', [], 0, session(), 12);
  await flush();
  await h.P.close();
  pending.resolve({});
  await launch;
  assert.equal(h.P.activeEngine, null);
  assert.equal(h.elements.get('playerView').hidden, true);
  assert.equal(h.video.style.display, '');
  assert.ok(h.calls.some(c => c[1] === 'stop_embedded_player' && c[2].instanceId === 12));
  assert.ok(h.calls.some(c => c[0] === 'stop' && c[1] === 'session-a'));
});

test('closing during a failed native launch cleanup prevents its HTML5 fallback from reopening', async () => {
  const deletion = deferred();
  const h = harness({ invoke(name) {
    if (name === 'launch_embedded_player') return Promise.reject(new Error('mpv launch failed'));
    return name === 'get_main_window_hwnd' ? 1 : {};
  } });
  h.API.sessionStop = id => { h.calls.push(['stop', id]); return deletion.promise; };
  h.A._playbackSeq = 12;
  const launch = h.A.openEmbeddedPlayer(item({ __universalClaim: true }), 'a.mkv', [], 0, session(), 12);
  await flush();
  assert.ok(h.calls.some(c => c[0] === 'stop' && c[1] === 'session-a'));
  await h.P.close();
  deletion.resolve();
  await launch;
  assert.equal(h.P.activeEngine, null);
  assert.equal(h.elements.get('playerView').hidden, true);
  assert.equal(h.calls.filter(c => c[0] === 'request').length, 0);
});

test('closing while consent is being saved prevents playback from reopening after the PUT succeeds', async () => {
  const saving = deferred();
  const h = harness();
  h.API.playbackPolicySet = () => saving.promise;
  h.A._retryItem = item();
  const granted = h.A.grantConsent();
  await h.P.close();
  saving.resolve({ software_transcode_enabled: true });
  await granted;
  await flush();
  assert.equal(h.P.activeEngine, null);
  assert.equal(h.elements.get('playerView').hidden, true);
  assert.equal(h.calls.filter(c => c[0] === 'request').length, 0);
});

test('progress queue coalesces periodic updates, preserves start/stop order, and is bounded', async () => {
  const pending = deferred();
  let count = 0;
  const h = harness({ reportProgress() { return ++count === 1 ? pending.promise : Promise.resolve(); } });
  h.P.adoptSession('Title', session(), item(), 'html5');
  const first = h.P.sendSnapshot('start', h.P.snapshot());
  h.video.currentTime = 100;
  const progress = h.P.sendSnapshot('progress', h.P.snapshot());
  h.video.currentTime = 200;
  assert.equal(h.P.sendSnapshot('progress', h.P.snapshot()), progress);
  const last = h.P.sendSnapshot('stop', h.P.snapshot());
  pending.resolve();
  await Promise.all([first, progress, last]);
  assert.deepEqual(h.calls.filter(c => c[0] === 'progress').map(c => [c[2], c[3]]), [
    ['start', 0], ['progress', 200000], ['stop', 200000],
  ]);
  const blocked = deferred();
  h.API.reportProgress = () => blocked.promise;
  const tasks = Array.from({ length: 20 }, () => h.P.sendSnapshot('stop', h.P.snapshot()).catch(() => {}));
  assert.equal(h.P._reportQueue.length, 7);
  blocked.resolve();
  await Promise.all(tasks);
});

test('reports retry network and 5xx twice, never retry 4xx, and drop queued data after account change', async () => {
  let attempt = 0;
  const h = harness({ reportProgress() {
    attempt++;
    return attempt < 3 ? Promise.reject(Object.assign(new Error('temporary'), { status: 503 })) : Promise.resolve();
  } });
  h.P.adoptSession('Title', session(), item(), 'html5');
  const retried = h.P.sendSnapshot('start', h.P.snapshot());
  await flush();
  [...h.timers.values()].find(t => t.ms === 200).fn();
  await flush();
  [...h.timers.values()].find(t => t.ms === 400).fn();
  await retried;
  assert.equal(attempt, 3);
  assert.equal(h.calls[0][8].timeoutMs, 3000);
  h.API.reportProgress = () => { attempt++; return Promise.reject(Object.assign(new Error('unauthorized'), { status: 401 })); };
  await assert.rejects(h.P.sendSnapshot('stop', h.P.snapshot()), /unauthorized/);
  assert.equal(attempt, 4);
  const blocked = deferred();
  h.API.reportProgress = () => blocked.promise;
  const active = h.P.sendSnapshot('start', h.P.snapshot());
  const stale = assert.rejects(h.P.sendSnapshot('progress', h.P.snapshot()), /上下文已更换/);
  h.A.session = { username: 'someone-else' };
  h.API.contextEpoch++;
  blocked.resolve();
  await Promise.all([active, stale]);
});

test('shutdown bounds unfinished progress work and always completes the native handshake', async () => {
  const pending = deferred();
  const h = harness({ reportProgress: () => pending.promise });
  h.P.open('Title', 'a.mp4', [], 0, session(), item());
  h.video.emit('playing');
  await flush();
  const shutdown = h.win.__MOVIECLAW_SHUTDOWN__();
  await flush();
  assert.equal(h.P.activeEngine, null);
  [...h.timers.values()].find(t => t.ms === 1200).fn();
  await shutdown;
  assert.ok(h.calls.some(c => c[1] === 'complete_shutdown'));
  pending.resolve();
  await flush();
});

test('HLS loader sends an inclusive Range, accepts 206, exposes response headers and really cancels', async () => {
  const pending = deferred();
  const h = harness({ invoke(name) { if (name === 'proxy_api') return pending.promise; return Promise.resolve(); } });
  const loader = new h.win.ProxyHlsLoader({});
  let success;
  loader.load({ url: 'https://server.invalid/part.mp4', responseType: 'arraybuffer', rangeStart: 4, rangeEnd: 8 }, {}, {
    onSuccess(response, stats, context, details) { success = { response, stats, details }; }, onError(error) { throw error; },
  });
  assert.equal(h.calls.find(c => c[1] === 'proxy_api')[2].headers.Range, 'bytes=4-7');
  pending.resolve({ status: 206, body: Buffer.from('abcd').toString('base64'), headers: { 'content-range': 'bytes 4-7/20' } });
  await flush();
  assert.equal(success.response.code, 206);
  assert.equal(success.stats.loaded, 4);
  assert.equal(success.details.headers['content-range'], 'bytes 4-7/20');
  const other = deferred();
  h.win.__TAURI__.core.invoke = (name, args) => { h.calls.push(['invoke', name, args]); return name === 'proxy_api' ? other.promise : Promise.resolve(); };
  let delivered = false;
  loader.load({ url: 'https://server.invalid/other.mp4', responseType: 'arraybuffer' }, {}, { onSuccess() { delivered = true; }, onError() {} });
  loader.destroy();
  other.resolve({ status: 200, body: '', headers: {} });
  await flush();
  assert.equal(delivered, false);
  assert.ok(h.calls.some(c => c[1] === 'cancel_proxy_request' && c[2].requestId));
});
