import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { chooseUnit } from '../src/collect.js';
import { commitChanges, directCommitCount } from '../src/commits.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { Store } from '../src/db.js';
import { DAY, lines, T0, TempRepo } from './helpers.js';

const cfg = DEFAULT_CONFIG;
const TRAILER = '\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';

test('commit mode: direct commits, a branch merge, reverts and Caused-by', async () => {
  const r = new TempRepo();
  r.write('a.txt', lines('base', 3));
  r.commit(T0, 'initial');

  r.write('b.txt', lines('b', 10));
  const kept = r.commit(T0 + 1 * DAY, `Add b${TRAILER}`);

  r.write('c.txt', lines('c', 4));
  const reverted = r.commit(T0 + 2 * DAY, 'Add c');

  // A feature branch merged without a PR: counted as one change carrying both commits.
  r.git(T0 + 3 * DAY, 'checkout', '-q', '-b', 'feature');
  r.write('d.txt', lines('d', 2));
  r.commit(T0 + 3 * DAY, `d one${TRAILER}`);
  r.write('e.txt', lines('e', 2));
  r.commit(T0 + 3 * DAY, 'd two');
  r.git(T0 + 4 * DAY, 'checkout', '-q', 'main');
  r.git(T0 + 4 * DAY, 'merge', '-q', '--no-ff', '-m', 'Merge branch feature', 'feature');
  const merge = r.git(T0 + 4 * DAY, 'rev-parse', 'HEAD');

  r.write('f.txt', lines('f', 3));
  const buggy = r.commit(T0 + 5 * DAY, 'Add f');

  r.git(T0 + 6 * DAY, 'revert', '--no-edit', reverted);
  r.write('f.txt', lines('f-fixed', 3));
  r.commit(T0 + 7 * DAY, `Fix f\n\nCaused-by: ${buggy.slice(0, 8)}`);

  const now = new Date(T0 + 40 * DAY);
  const changes = await commitChanges({ repoPath: r.dir, ref: 'main', repo: 'o/r', since: new Date(T0 - DAY), cfg, now, bugIssues: [] });
  const byId = new Map(changes.map((c) => [c.id, c]));

  assert.equal(changes.length, 7); // initial, b, c, merge, f, revert, fix
  const b = byId.get(kept.slice(0, 7))!;
  assert.equal(b.kind, 'commit');
  assert.equal(b.number, null);
  assert.equal(b.authorClass, 'assisted');
  assert.equal(b.url, `https://github.com/o/r/commit/${kept}`);
  assert.deepEqual(b.durability, { status: 'measured', baseline: 10, surviving: 10 });
  assert.equal(b.durable, true);
  assert.equal(b.size, 10);

  const c = byId.get(reverted.slice(0, 7))!;
  assert.deepEqual(c.rework.map((e) => e.kind), ['revert']);
  assert.equal(c.durable, false);

  const m = byId.get(merge.slice(0, 7))!;
  assert.equal(m.authorClass, 'assisted', 'a merged commit with an AI trailer marks the merge assisted');
  assert.deepEqual(m.durability, { status: 'measured', baseline: 4, surviving: 4 });
  assert.equal(m.leadTimeHours, 24);

  const f = byId.get(buggy.slice(0, 7))!;
  assert.deepEqual(f.rework.map((e) => e.kind), ['bug']);
  assert.equal(f.durable, false);
});

test('directCommitCount and chooseUnit', () => {
  const branch = [
    { oid: 'm1', message: 'Merge pull request #1' },
    { oid: 's2', message: 'Squashed thing (#2)' },
    { oid: 'r3', message: 'rebased: part b' },
    { oid: 'x4', message: 'direct push' },
    { oid: 'x5', message: 'another direct push' },
  ];
  const prs = [
    { mergeCommitOid: 'm1', commits: [{ message: 'work' }] },
    { mergeCommitOid: 's2', commits: [{ message: 'wip' }] },
    { mergeCommitOid: 'r3-orig', commits: [{ message: 'rebased: part b\n\nbody' }] },
  ];
  assert.equal(directCommitCount(branch, prs), 2);
  assert.equal(chooseUnit('auto', 3, 2), 'prs');
  assert.equal(chooseUnit('auto', 1, 66), 'commits');
  assert.equal(chooseUnit('prs', 1, 66), 'prs');
  assert.equal(chooseUnit('commits', 50, 0), 'commits');
});

test('store migrates 0.1.x snapshots', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'agent-dora-db-')), 'cache.db');
  new Store(path).close();
  const db = new DatabaseSync(path);
  const old = { repo: 'o/r', defaultBranch: 'main', collectedAt: '2026-01-01T00:00:00Z', since: '2025-07-01T00:00:00Z', windowDays: 21, survivalThreshold: 0.7, openPrs: [], prs: [{ number: 5, title: 't' }] };
  db.prepare('INSERT INTO snapshots (repo, collected_at, data) VALUES (?, ?, ?)').run('o/r', old.collectedAt, JSON.stringify(old));
  db.close();
  const snap = new Store(path).loadSnapshot('o/r')!;
  assert.equal(snap.unit, 'prs');
  assert.equal(snap.branch, 'main');
  assert.deepEqual(snap.notes, []);
  assert.equal(snap.changes[0]!.id, '#5');
  assert.equal(snap.changes[0]!.kind, 'pr');
});
