import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// GitHub keeps repository traffic for 14 days only. This script merges each
// fetched window into permanent JSON files, one row per day or per snapshot.
const repo = process.env.GITHUB_REPOSITORY;
const dir = process.argv[2] ?? 'traffic';
const today = new Date().toISOString().slice(0, 10);
const api = path => JSON.parse(execFileSync('gh', ['api', `repos/${repo}/traffic/${path}`], { encoding: 'utf8' }));

function read(name) {
  try {
    return JSON.parse(readFileSync(join(dir, name), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  }
}
const write = (name, rows) => writeFileSync(join(dir, name), JSON.stringify(rows, null, 2) + '\n');

// Rows are keyed by date. A newer fetch replaces the same date because the
// latest day of a window may still have been in progress when first recorded.
const merge = (rows, updates) => [...new Map([...rows, ...updates].map(row => [row.date, row])).values()]
  .sort((a, b) => a.date.localeCompare(b.date));

mkdirSync(dir, { recursive: true });
for (const kind of ['views', 'clones']) {
  const daily = api(kind)[kind].map(({ timestamp, count, uniques }) => ({ date: timestamp.slice(0, 10), count, uniques }));
  write(`${kind}.json`, merge(read(`${kind}.json`), daily));
}
// Referrers and paths are 14-day totals without a daily breakdown, so keep one snapshot per run.
for (const kind of ['referrers', 'paths']) {
  write(`${kind}.json`, merge(read(`${kind}.json`), [{ date: today, [kind]: api(`popular/${kind}`) }]));
}
console.log(`Recorded traffic through ${today} in ${dir}.`);
