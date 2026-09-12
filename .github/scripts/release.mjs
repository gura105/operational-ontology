import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { RELEASE_VERSION: version, RELEASE_COMMIT: commit, RELEASE_NOTES: notes } = process.env;
const dryRun = process.env.RELEASE_DRY_RUN === 'true';
const repo = process.env.GITHUB_REPOSITORY;
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();
const api = (path, ...args) => JSON.parse(gh('api', `repos/${repo}/${path}`, ...args));

assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Run Release on main.');
assert.match(version ?? '', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Use a stable package version without v.');
assert.match(commit ?? '', /^[a-f0-9]{40}$/, 'Supply the full main commit.');
assert.ok(notes?.trim(), 'Release notes are required.');
assert.ok(['true', 'false'].includes(process.env.RELEASE_DRY_RUN), 'Choose dry_run explicitly.');
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), commit);
assert.equal(api('git/ref/heads/main').object.sha, commit, 'The release commit must be current main.');
assert.equal(JSON.parse(readFileSync('package.json', 'utf8')).version, version, 'package.json must match the release.');

const runs = api(`actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${commit}&per_page=1`).workflow_runs;
assert.equal(runs[0]?.conclusion, 'success', 'Wait for successful CI on this main commit.');

const tag = `v${version}`;
// Listing with pagination distinguishes a missing tag from an API/network error.
const refs = JSON.parse(gh('api', '--paginate', '--slurp', `repos/${repo}/git/matching-refs/tags/${tag}`)).flat();
const existing = refs.find(ref => ref.ref === `refs/tags/${tag}`);
if (existing) {
  assert.equal(existing.object.type, 'tag', 'The version tag must be annotated.');
  const target = api(`git/tags/${existing.object.sha}`).object;
  assert.equal(target.type, 'commit');
  assert.equal(target.sha, commit, 'This version already identifies a different commit. Choose a new version.');
}

if (dryRun) {
  console.log(`Validated ${tag} at ${commit}; no tag or Release was created.`);
  process.exit(0);
}

// Recheck main just before publication in case another release was merged.
assert.equal(api('git/ref/heads/main').object.sha, commit, 'main changed during release preparation.');
if (!existing) {
  const annotation = api('git/tags', '-f', `tag=${tag}`, '-f', `message=${tag}`, '-f', `object=${commit}`, '-f', 'type=commit');
  api('git/refs', '-f', `ref=refs/tags/${tag}`, '-f', `sha=${annotation.sha}`);
}

const releases = JSON.parse(gh('api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`)).flat();
const published = releases.find(release => release.tag_name === tag);
if (published) {
  assert.ok(!published.draft && !published.prerelease, 'An existing draft/prerelease needs explicit review.');
  console.log(`Already published: ${published.html_url}`);
} else {
  const dir = mkdtempSync(join(tmpdir(), 'ontology-release-'));
  try {
    const file = join(dir, 'notes.md');
    writeFileSync(file, notes);
    console.log(gh('release', 'create', tag, '--repo', repo, '--verify-tag', '--target', commit,
      '--title', tag, '--notes-file', file, '--latest'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
