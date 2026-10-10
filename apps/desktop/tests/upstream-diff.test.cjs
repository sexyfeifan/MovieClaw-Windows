'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { compareRepository, markdown } = require('../scripts/upstream-diff.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'movieclaw-upstream-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'MovieClaw fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  };
  const commit = () => { git('add', '.'); git('commit', '--quiet', '-m', 'synthetic upstream'); return git('rev-parse', 'HEAD'); };
  write('apps/apple/MovieClawMac/Home.swift', 'baseline');
  write('src/movieclaw_api/schemas/playback.py', 'baseline');
  const revision = commit();
  git('update-ref', 'refs/remotes/origin/main', revision);
  const baseline = { ...require('../upstream-baseline.json'), revision };
  return { dir, git, write, commit, baseline };
}

test('upstream report compares the pinned tree independently of recent-commit time windows', t => {
  const f = fixture(t);
  assert.equal(compareRepository(f.dir, f.baseline).status, 'unchanged');
  f.write('docs/unrelated.md', 'new docs');
  f.git('update-ref', 'refs/remotes/origin/main', f.commit());
  assert.equal(compareRepository(f.dir, f.baseline).changes.length, 0);
});

test('upstream report tracks UI deletes and API changes including filenames with spaces', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.dir, 'apps/apple/MovieClawMac/Home.swift'));
  f.write('apps/apple/MovieClawMac/New home.swift', 'replacement');
  f.write('src/movieclaw_api/schemas/playback.py', 'new contract');
  const latest = f.commit();
  f.git('update-ref', 'refs/remotes/origin/main', latest);
  const result = compareRepository(f.dir, f.baseline);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.latestRevision, latest);
  assert.equal(result.changes.length, 3);
  assert.deepEqual(result.changes.find(c => c.status === 'D').components, ['macOS UI']);
  assert.match(markdown(result), /New home\.swift/);
  assert.match(markdown(result), /require review/);
});
