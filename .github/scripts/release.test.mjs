import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./release.mjs', import.meta.url));
const commit = 'a'.repeat(40);
const notes = 'Keep literal text: `code`, $(echo example), and a second line.\nMigration details.';

// Run the real release command against fake Git/GitHub executables, never a real repository.
function run({ config = {}, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ontology-release-test-'));
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.5.0' }));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ commit, ...config }));
    const stub = `#!/usr/bin/env node
      const fs = require('node:fs');
      const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
      const args = process.argv.slice(2);
      if (process.argv[1].endsWith('/git')) {
        console.log(cfg.checkoutCommit ?? cfg.commit);
        process.exit(0);
      }
      fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
      const path = args.find(arg => arg.startsWith('repos/')) ?? '';
      const json = value => console.log(JSON.stringify(value));
      if (cfg.networkError) process.exit(1);
      if (args[0] === 'release') {
        fs.writeFileSync('published-notes.md', fs.readFileSync(args[args.indexOf('--notes-file') + 1]));
        console.log('https://example.test/releases/v0.5.0');
      } else if (path.endsWith('git/ref/heads/main')) {
        json({object: {sha: cfg.commit}});
      } else if (path.includes('actions/workflows/')) {
        json({workflow_runs: [{conclusion: cfg.ci ?? 'success'}]});
      } else if (path.includes('matching-refs/')) {
        json([cfg.tagCommit ? [{ref: 'refs/tags/v0.5.0', object: {type: 'tag', sha: 'annotation'}}] : []]);
      } else if (path.endsWith('git/tags/annotation')) {
        json({object: {type: 'commit', sha: cfg.tagCommit}});
      } else if (path.includes('/releases?')) {
        json([cfg.published ? [{tag_name: 'v0.5.0', draft: false, prerelease: false, html_url: 'existing'}] : []]);
      } else if (path.endsWith('git/tags') && args.includes('-f')) {
        json({sha: 'annotation'});
      } else if (path.endsWith('git/refs') && args.includes('-f')) {
        json({ref: 'refs/tags/v0.5.0'});
      } else {
        throw new Error('Unexpected gh call: ' + JSON.stringify(args));
      }
    `;
    for (const name of ['git', 'gh']) writeFileSync(join(dir, 'bin', name), stub, { mode: 0o755 });
    const result = spawnSync(process.execPath, [script], {
      cwd: dir, encoding: 'utf8', env: {
        ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'example/repo',
        RELEASE_VERSION: '0.5.0', RELEASE_COMMIT: commit, RELEASE_NOTES: notes,
        RELEASE_DRY_RUN: 'false', ...env,
      },
    });
    const read = name => { try { return readFileSync(join(dir, name), 'utf8'); } catch { return ''; } };
    const calls = read('calls.jsonl').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { ...result, writes: calls.filter(args => args.includes('-f') || args[0] === 'release'), notes: read('published-notes.md') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('dry run validates a new release without any writes', () => {
  const result = run({ env: { RELEASE_DRY_RUN: 'true' } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.writes, []);
});

test('publication creates an annotated tag and preserves literal release notes', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.writes.length, 3);
  assert.ok(result.writes[0].includes('type=commit'));
  assert.ok(result.writes[1].includes('ref=refs/tags/v0.5.0'));
  assert.ok(result.writes[2].includes('--verify-tag'));
  assert.equal(result.notes, notes);
});

test('a retry after tag creation publishes without recreating the tag', () => {
  const result = run({ config: { tagCommit: commit } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.writes.length, 1);
  assert.equal(result.writes[0][0], 'release');
});

test('an already published version is left untouched', () => {
  const result = run({ config: { tagCommit: commit, published: true } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.writes, []);
});

for (const [name, options] of Object.entries({
  'another branch': { env: { GITHUB_REF: 'refs/heads/next' } },
  'another main commit': { config: { commit: 'b'.repeat(40) } },
  'another checkout': { config: { checkoutCommit: 'b'.repeat(40) } },
  'a mismatched version': { env: { RELEASE_VERSION: '0.6.0' } },
  'invalid version input': { env: { RELEASE_VERSION: '--help' } },
  'missing release notes': { env: { RELEASE_NOTES: '' } },
  'failed CI': { config: { ci: 'failure' } },
  'a reused version': { config: { tagCommit: 'b'.repeat(40) } },
  'an API failure': { config: { networkError: true } },
})) test(`refuses ${name} before writing`, () => {
  const result = run(options);
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.writes, []);
});
