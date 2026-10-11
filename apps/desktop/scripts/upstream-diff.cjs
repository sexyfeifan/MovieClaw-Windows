'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function compareRepository(directory, baseline, target = 'refs/remotes/origin/main') {
  if (baseline.schemaVersion !== 1 || !/^[\w.-]+\/[\w.-]+$/.test(baseline.repository) ||
      !/^[0-9a-f]{40}$/.test(baseline.revision)) throw new Error('Invalid upstream baseline');
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
  const resolve = ref => git('rev-parse', '--verify', '--end-of-options', ref + '^{commit}').trim();
  const base = resolve(baseline.revision);
  const latest = resolve(target);
  // Complete trees include deletions; commit-list API responses contain no file lists.
  const names = git('diff', '--name-status', '--no-renames', '-z', base, latest, '--').split('\0');
  names.pop();
  const changes = [];
  for (let i = 0; i < names.length; i += 2) {
    const file = names[i + 1];
    const components = Object.entries(baseline.components).filter(([, prefixes]) =>
      prefixes.some(prefix => prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix))
      .map(([name]) => name);
    if (components.length) changes.push({ status: names[i], path: file, components });
  }
  return {
    schemaVersion: 1, repository: baseline.repository, baselineRevision: base,
    latestRevision: latest, status: changes.length ? 'needs_review' : 'unchanged',
    compareUrl: 'https://github.com/' + baseline.repository + '/compare/' + base + '...' + latest,
    changes,
  };
}

function markdown(report) {
  const safe = value => value.replace(/[\r\n]/g, ' ').replace(/`/g, "'");
  return [
    '# MovieClaw upstream baseline comparison', '',
    'Repository: ' + report.repository, 'Baseline: ' + report.baselineRevision,
    'Latest main: ' + report.latestRevision, 'Status: ' + report.status, '',
    '[Compare source](' + report.compareUrl + ')', '',
    'Changes require review against the Windows parity matrix and regression tests before updating the baseline.',
    'This job does not import code, advance the baseline, or publish a release.', '',
    ...report.changes.map(c => '- ' + c.status + ' `' + safe(c.path) + '` (' + c.components.join(', ') + ')'),
    ...(report.changes.length ? [] : ['No changes in the tracked UI, build or media contracts.']), '',
  ].join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--repository-dir' || args[2] !== '--output') {
    throw new Error('Usage: upstream-diff.cjs --repository-dir PATH --output PATH');
  }
  const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '../upstream-baseline.json'), 'utf8'));
  const report = compareRepository(args[1], baseline);
  fs.mkdirSync(args[3], { recursive: true });
  fs.writeFileSync(path.join(args[3], 'upstream-diff.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(args[3], 'upstream-diff.md'), markdown(report));
  console.log('Upstream ' + report.status + ': ' + report.changes.length + ' tracked files; ' + report.latestRevision);
}

module.exports = { compareRepository, markdown };
