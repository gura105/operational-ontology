import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./traffic.mjs', import.meta.url));
const day = (date, count, uniques) => ({ timestamp: `${date}T00:00:00Z`, count, uniques });
const today = new Date().toISOString().slice(0, 10);

// Run the real script against a fake gh executable that serves one 14-day window.
function run(dir, window) {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'window.json'), JSON.stringify(window));
  writeFileSync(join(dir, 'bin', 'gh'), `#!/usr/bin/env node
    const fs = require('node:fs');
    const path = process.argv.slice(2).find(arg => arg.startsWith('repos/example/repo/traffic/'));
    if (!path || process.argv[2] !== 'api') throw new Error('Unexpected gh call: ' + process.argv.slice(2).join(' '));
    console.log(JSON.stringify(JSON.parse(fs.readFileSync('window.json', 'utf8'))[path.split('/traffic/')[1]]));
  `, { mode: 0o755 });
  const result = spawnSync(process.execPath, [script, 'data'], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, GITHUB_REPOSITORY: 'example/repo' },
  });
  assert.equal(result.status, 0, result.stderr);
  return name => JSON.parse(readFileSync(join(dir, 'data', name), 'utf8'));
}

test('overlapping windows merge into one row per day, newest fetch first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ontology-traffic-test-'));
  try {
    run(dir, {
      views: { count: 3, uniques: 2, views: [day('2026-09-01', 1, 1), day('2026-09-02', 2, 1)] },
      clones: { count: 5, uniques: 5, clones: [day('2026-09-02', 5, 5)] },
      'popular/referrers': [{ referrer: 'github.com', count: 3, uniques: 2 }],
      'popular/paths': [{ path: '/example/repo', title: 'Overview', count: 3, uniques: 2 }],
    });
    const read = run(dir, {
      views: { count: 9, uniques: 6, views: [day('2026-09-02', 4, 2), day('2026-09-03', 5, 4)] },
      clones: { count: 0, uniques: 0, clones: [] },
      'popular/referrers': [{ referrer: 'example.test', count: 9, uniques: 6 }],
      'popular/paths': [],
    });
    assert.deepEqual(read('views.json'), [
      { date: '2026-09-01', count: 1, uniques: 1 },
      { date: '2026-09-02', count: 4, uniques: 2 },
      { date: '2026-09-03', count: 5, uniques: 4 },
    ]);
    assert.deepEqual(read('clones.json'), [{ date: '2026-09-02', count: 5, uniques: 5 }]);
    assert.deepEqual(read('referrers.json'), [{ date: today, referrers: [{ referrer: 'example.test', count: 9, uniques: 6 }] }]);
    assert.deepEqual(read('paths.json'), [{ date: today, paths: [] }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt data file stops the run instead of being overwritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ontology-traffic-test-'));
  try {
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'views.json'), '{ not json');
    assert.throws(() => run(dir, { views: { views: [] }, clones: { clones: [] }, 'popular/referrers': [], 'popular/paths': [] }));
    assert.equal(readFileSync(join(dir, 'data', 'views.json'), 'utf8'), '{ not json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
