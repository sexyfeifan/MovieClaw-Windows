// Strict HTTP fixtures mirror the server's public response envelopes, without NAS credentials.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ui = path.resolve(__dirname, '../../ui');
const csp = Object.entries(require('../../src-tauri/tauri.conf.json').app.security.csp)
  .map(([directive, values]) => `${directive} ${values}`).join('; ');
const ok = data => ({ code: 0, message: 'ok', data });
let state;
const reset = options => state = { authenticated: true, initialized: true, requests: [], created: [], stopped: [], ...options };
reset({});
const item = n => ({ media_item_id: n, library_id: 1, kind: n === 3 ? 'tv' : 'movie',
  title: n === 3 ? '第三季续播' : `影片 ${String(n).padStart(3, '0')}`, year: 2025,
  poster_url: null, backdrop_url: null, file_count: 1, total_size_bytes: 1024,
  seasons: n === 3 ? [1, 2, 3] : [], episode_count: n === 3 ? 9 : 0, resolutions: ['1080p'], missing_count: 0 });
const file = n => ({ id: n, file_id: n, state: 'in_place', container: 'mkv', video_codec: 'hevc',
  duration_ms: 3600000, size_bytes: 1024, resolution: '1080p', audio_streams: [], subtitle_streams: [],
  season_number: n === 3 ? 3 : null, episode_number: n === 3 ? 2 : null });
const session = body => {
  const sid = `session-${state.created.length + 1}`;
  state.created.push(sid);
  return { session_id: sid, stream_url: state.hls ? '/test-media/index.m3u8' : '/fixture.mp4', timeline: 'session', start_ms: body.start_ms ?? 300000,
    decision: { outcome: 'plan', tier: 1, audio_tracks: [], subtitles: [], source_duration_ms: 3600000 },
    source: { file_id: body.file_id || body.media_item_id, container: 'mkv', video_codec: 'hevc', duration_ms: 3600000 },
    subtitle_urls: [], chapters: [], segments: [], watch: { position_ms: 300000, duration_ms: 3600000 } };
};
async function bodyOf(req) {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString(); return text ? JSON.parse(text) : null;
}
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
}
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/__test/reset') { reset(await bodyOf(req) || {}); return json(res, { ok: true }); }
    if (url.pathname === '/__test/state') return json(res, state);
    if (url.pathname.startsWith('/api/v1/test-media/')) {
      const name = path.basename(url.pathname);
      const filename = path.join(__dirname, 'media', name);
      if (!fs.existsSync(filename)) return json(res, {}, 404);
      const bytes = fs.readFileSync(filename);
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      const headers = { 'Content-Type': name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4', 'Accept-Ranges': 'bytes' };
      if (match) {
        const start = Number(match[1]), end = Math.min(Number(match[2] || bytes.length - 1), bytes.length - 1);
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 });
        return res.end(bytes.subarray(start, end + 1));
      }
      res.writeHead(200, { ...headers, 'Content-Length': bytes.length }); return res.end(bytes);
    }
    if (url.pathname === '/fixture.mp4' || url.pathname === '/api/v1/fixture.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fs.statSync(path.join(__dirname, 'fixture.mp4')).size });
      fs.createReadStream(path.join(__dirname, 'fixture.mp4')).pipe(res); return;
    }
    if (!url.pathname.startsWith('/api/v1/')) {
      const relative = decodeURIComponent(url.pathname === '/' ? '/desktop/index.html' : url.pathname);
      const filename = path.resolve(ui, '.' + relative);
      if (!filename.startsWith(ui + path.sep) || !fs.existsSync(filename)) return json(res, {}, 404);
      const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.wasm': 'application/wasm' }[path.extname(filename)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': csp }); fs.createReadStream(filename).pipe(res); return;
    }
    const route = url.pathname.slice('/api/v1'.length);
    const body = await bodyOf(req);
    // Avoid recording even fixture passwords, so this stays safe for CI artifacts.
    state.requests.push({ method: req.method, path: route, query: Object.fromEntries(url.searchParams), body: body && route === '/auth/login' ? { username: body.username } : body });
    if (route === '/health') return json(res, { status: 'ok', service: 'movieclaw', version: '0.34.0' });
    if (route === '/auth/bootstrap') return json(res, ok({ initialized: state.initialized }));
    if (route === '/auth/login') {
      if (state.loginDelay) await new Promise(resolve => setTimeout(resolve, state.loginDelay));
      if (state.loginFailures > 0) {
        state.loginFailures--;
        return json(res, { message: '密码错误，请重试' }, 401);
      }
      if (!body?.username || !body?.password) return json(res, { message: '密码错误' }, 401);
      state.authenticated = true; state.username = body.username;
      return json(res, ok({ username: state.username, role: 'admin', capabilities: [] }));
    }
    if (!state.authenticated) return json(res, { message: '需要登录' }, 401);
    if (route === '/auth/me') return json(res, ok({ username: state.username || 'fixture', role: 'admin', capabilities: [] }));
    if (route === '/auth/accounts') return json(res, ok([
      { username: state.username || 'fixture', nickname: '当前账号', role: 'admin', active: true },
      { username: 'second', nickname: '另一个账号', role: 'member', active: false },
    ]));
    if (route === '/auth/accounts/switch') {
      if (Object.keys(body || {}).join() !== 'username') return json(res, { message: '必须按 username 切换' }, 422);
      state.username = body.username;
      return json(res, ok({ username: state.username, role: 'member' }));
    }
    if (route === '/libraries') return json(res, ok([{ id: 1, name: '测试媒体库', kind: 'movie', stats: { item_count: 245 } }]));
    if (route === '/collections') return json(res, ok([{ id: 8, name: '测试合集', library_id: 1, hidden: false, item_count: 245 }]));
    if (/^\/(libraries\/1|collections\/8)\/items$/.test(route) || route === '/playback/favorites') {
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 20);
      if (limit > 200) return json(res, { message: 'limit must be <=200' }, 422);
      let items = Array.from({ length: 245 }, (_, i) => item(i + 1));
      if (url.searchParams.get('sort') === 'title' && url.searchParams.get('order') === 'desc') items.reverse();
      const page = items.slice(offset, offset + limit);
      return json(res, ok(route.startsWith('/libraries/') ? page : { items: page, total: 245 }));
    }
    if (route === '/search/library') {
      const q = url.searchParams.get('q') || '';
      if (q === '慢搜索') await new Promise(resolve => setTimeout(resolve, 900));
      const next = url.searchParams.has('cursor');
      return json(res, ok({ items: [{ item: { ...item(next ? 202 : 201), title: q }, library_ids: [1], match: { kind: 'title', text: q } }],
        people: [], suggestions: [], next_cursor: next ? null : 'fixture-next' }));
    }
    if (route === '/playback/up-next') return json(res, ok({ items: [{ ...item(3), season_number: 3, episode_number: 2, position_ms: 300000, duration_ms: 3600000, progress_percent: 8, episode_title: '第二集' }] }));
    if (route === '/playback/marks') return json(res, ok({ played: false, is_favorite: false, unplayed_count: 2 }));
    if (route === '/playback/resume') return json(res, ok({ season_number: 3, episode_number: 2, position_ms: 300000, duration_ms: 3600000 }));
    if (/^\/libraries\/1\/items\/\d+$/.test(route)) {
      const n = Number(route.split('/').pop());
      return json(res, ok({ ...item(n), files: [file(n)], local_meta: { plot: '测试简介', genres: [], runtime_minutes: 60, actors: [{ name: '测试演员', tmdb_person_id: 9 }] }, collections: [] }));
    }
    if (route.endsWith('/episodes')) {
      const season = Number(url.searchParams.get('season_number') || 3);
      return json(res, ok({ season_number: season, resume_episode: 2, episodes: [1, 2, 3].map(n => ({ season_number: season, episode_number: n, name: `第 ${n} 集`, title: `第 ${n} 集`, owned: true, played: n === 1, files: [file(3)], duration_ms: 3600000 })) }));
    }
    if (route === '/people/9') return json(res, ok({ name: '测试演员', credits: [{ ...item(3), department: 'cast', character: '演员', library_id: 1 }] }));
    if (route === '/playback/sessions' && req.method === 'POST') {
      if (!body?.media_item_id || !body?.capability || body.capability.quality_tier != null) return json(res, { message: 'invalid playback contract' }, 422);
      const result = session(body);
      if (state.sessionDelay) await new Promise(resolve => setTimeout(resolve, state.sessionDelay));
      return json(res, ok(result));
    }
    if (/^\/playback\/sessions\/[^/]+$/.test(route) && req.method === 'DELETE') { state.stopped.push(route.split('/').pop()); return json(res, ok(null)); }
    if (route.endsWith('/ping') || route === '/playback/progress') return json(res, ok(null));
    return json(res, { message: `fixture has no route: ${route}` }, 404);
  } catch (error) { json(res, { message: error.message }, 500); }
}).listen(4179, '127.0.0.1');
