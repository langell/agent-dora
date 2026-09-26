import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/config.js';
import { measureDurability } from '../src/durability.js';
import { DAY, lines, T0, TempRepo } from './helpers.js';

test('measures line survival across squash, merge-commit and rebase merges', async () => {
  const r = new TempRepo();
  r.write('a.txt', lines('base', 5));
  r.commit(T0, 'initial');

  // Squash-merged PR adding 10 lines, half of which get rewritten later.
  r.write('b.txt', lines('pr1', 10));
  const squash = r.commit(T0 + 1 * DAY, 'Add b (#1)');

  // Squash-merged PR whose file is later renamed: lines should still count as surviving.
  r.write('c.txt', lines('pr2', 10));
  const renamed = r.commit(T0 + 1 * DAY + 3600_000, 'Add c (#2)');

  // Merge-commit PR with two commits on a feature branch.
  r.git(T0 + 2 * DAY, 'checkout', '-q', '-b', 'feature');
  r.write('e.txt', lines('pr3a', 2));
  r.commit(T0 + 2 * DAY, 'e part 1');
  r.write('e.txt', [...lines('pr3a', 2), ...lines('pr3b', 2)]);
  r.commit(T0 + 2 * DAY, 'e part 2');
  r.git(T0 + 2 * DAY, 'checkout', '-q', 'main');
  r.git(T0 + 2 * DAY, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #3', 'feature');
  const mergeCommit = r.git(T0 + 2 * DAY, 'rev-parse', 'HEAD');

  // Rebase-merged PR: two linear commits, the last is the "merge commit".
  r.write('f.txt', lines('pr4a', 3));
  r.commit(T0 + 3 * DAY, 'feat: f one');
  r.write('g.txt', lines('pr4b', 3));
  const rebased = r.commit(T0 + 3 * DAY, 'feat: f two');

  // Later changes on main: rewrite half of b.txt, rename c.txt.
  r.write('b.txt', [...lines('rewrite', 5), ...lines('pr1', 10).slice(5)]);
  r.git(T0 + 6 * DAY, 'mv', 'c.txt', 'd.txt');
  r.commit(T0 + 6 * DAY, 'refactor');

  // A recent PR still inside its window.
  r.write('h.txt', lines('pr5', 4));
  const recent = r.commit(T0 + 28 * DAY, 'Add h (#5)');

  const now = new Date(T0 + 30 * DAY);
  const at = (d: number) => new Date(T0 + d * DAY).toISOString();
  const measure = (oid: string, mergedAt: string, messages: string[]) =>
    measureDurability(r.dir, 'main', { mergeCommitOid: oid, mergedAt, commitCount: messages.length, commits: messages.map((message) => ({ message })) }, DEFAULT_CONFIG, now);

  assert.deepEqual(await measure(squash, at(1), ['wip', 'more']), { status: 'measured', baseline: 10, surviving: 5 });
  assert.deepEqual(await measure(renamed, at(1), ['add c']), { status: 'measured', baseline: 10, surviving: 10 });
  assert.deepEqual(await measure(mergeCommit, at(2), ['e part 1', 'e part 2']), { status: 'measured', baseline: 4, surviving: 4 });
  assert.deepEqual(await measure(rebased, at(3), ['feat: f one', 'feat: f two']), { status: 'measured', baseline: 6, surviving: 6 });
  assert.equal((await measure(recent, at(28), ['x'])).status, 'pending');
  assert.equal((await measure('0'.repeat(40), at(1), ['x'])).status, 'unavailable');
});

test('uses the cache instead of re-running blame', async () => {
  const r = new TempRepo();
  r.write('a.txt', lines('a', 3));
  const oid = r.commit(T0, 'a');
  const hits: string[] = [];
  const cache = {
    get: (k: string) => (hits.push(k), { baseline: 7, surviving: 3 }),
    set: () => assert.fail('should not write'),
  };
  const d = await measureDurability(r.dir, 'main', { mergeCommitOid: oid, mergedAt: new Date(T0).toISOString(), commitCount: 1, commits: [{ message: 'a' }] }, DEFAULT_CONFIG, new Date(T0 + 40 * DAY), cache);
  assert.deepEqual(d, { status: 'measured', baseline: 7, surviving: 3 });
  assert.deepEqual(hits, [`${oid}:21`]);
});

test('ignores lockfiles and generated files', async () => {
  const r = new TempRepo();
  r.write('README.md', ['hi']);
  r.commit(T0, 'init');
  r.write('package-lock.json', lines('lock', 50));
  r.write('src/app.ts', lines('app', 2));
  const oid = r.commit(T0 + DAY, 'deps');
  const d = await measureDurability(r.dir, 'main', { mergeCommitOid: oid, mergedAt: new Date(T0 + DAY).toISOString(), commitCount: 1, commits: [{ message: 'deps' }] }, DEFAULT_CONFIG, new Date(T0 + 40 * DAY));
  assert.deepEqual(d, { status: 'measured', baseline: 2, surviving: 2 });
});
