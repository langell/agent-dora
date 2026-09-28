import { classify } from './classify.js';
import { ChangeKind, githubCommitUrl, MS_PER_HOUR, shortSha } from './constants.js';
import { measureDurability } from './durability.js';
import * as g from './git.js';
import { isDurable } from './metrics.js';
import type { ModeOptions } from './modes.js';
import { causedByShas, findCommitRework } from './rework.js';
import type { ChangeRecord } from './types.js';
import { GIT_CONCURRENCY, mapLimit, progress } from './util.js';

/**
 * Commit mode: every commit on the branch's first-parent chain is one change.
 * A merge commit counts as a single change that carries all the commits it merged,
 * so a branch merged without a PR is measured as one unit.
 */
export async function commitChanges(
  commits: g.BranchCommit[],
  { repoPath, ref, repo, since, cfg, now, bugIssues, cache, log = () => {} }: ModeOptions,
): Promise<ChangeRecord[]> {
  const units = await mapLimit(commits, GIT_CONCURRENCY, async (c) => {
    const merged = c.parents.length >= 2 ? await g.commitsIn(repoPath, `${c.parents[0]}..${c.parents[1]}`) : [];
    return { c, merged, owners: new Set([c.oid, ...merged.map((m) => m.oid)]) };
  });

  const reverts = await g.revertCommits(repoPath, ref, since);
  const resolve = await g.expandOids(repoPath, [
    ...reverts.flatMap((r) => r.reverts),
    ...causedByShas([...commits.map((c) => c.message), ...bugIssues.map((i) => `${i.title}\n${i.body}`)]),
  ]);
  const rework = findCommitRework(
    units.map((u) => ({ oid: u.c.oid, committedAt: u.c.committedAt, message: u.c.message, owners: u.owners })),
    bugIssues,
    reverts,
    resolve,
  );

  log(`Measuring durability of ${units.length} commits against ${ref}...`);
  const tick = progress(log, units.length);
  return mapLimit(units, GIT_CONCURRENCY, async ({ c, merged, owners }): Promise<ChangeRecord> => {
    const cls = classify(
      { author: c.authorName, labels: [], headRefName: '', body: '', commits: [{ message: c.message }, ...merged] },
      cfg,
    );
    // The commits a change carries are already known here, so durability needn't look them up.
    const lines = async () => ({ owners, base: c.parents[0] ?? g.EMPTY_TREE });
    const durability = await measureDurability(repoPath, ref, { oid: c.oid, landedAt: c.committedAt }, lines, cfg, now, cache);
    const firstCommit = Math.min(Date.parse(c.authoredAt), ...merged.map((m) => Date.parse(m.authoredAt)));
    const events = rework.filter((e) => e.target === c.oid);
    const size = await g.diffSize(repoPath, c.parents[0] ?? g.EMPTY_TREE, c.oid);
    tick();
    return {
      kind: ChangeKind.Commit,
      id: shortSha(c.oid),
      number: null,
      title: g.subject(c.message),
      url: githubCommitUrl(repo, c.oid),
      author: c.authorName || null,
      authorClass: cls.authorClass,
      classSource: cls.source,
      classReason: cls.reason,
      createdAt: new Date(firstCommit).toISOString(),
      mergedAt: c.committedAt,
      firstCommitAt: new Date(firstCommit).toISOString(),
      firstReviewAt: null,
      leadTimeHours: Math.max(0, (Date.parse(c.committedAt) - firstCommit) / MS_PER_HOUR),
      reviewWaitHours: null,
      size,
      rework: events,
      durability,
      durable: isDurable(c.committedAt, events, durability, cfg),
    };
  });
}

/**
 * Counts first-parent commits on the branch that didn't arrive through a merged PR.
 * Squash and merge-commit PRs are matched by merge SHA; rebased PR commits get new
 * SHAs, so they're matched by subject line instead.
 */
export function directCommitCount(
  branchCommits: { oid: string; message: string }[],
  prs: { mergeCommitOid: string | null; commits: { message: string }[] }[],
): number {
  const mergeOids = new Set(prs.flatMap((p) => (p.mergeCommitOid ? [p.mergeCommitOid] : [])));
  const subjects = new Set(prs.flatMap((p) => p.commits.map((c) => g.subject(c.message))));
  return branchCommits.filter((c) => !mergeOids.has(c.oid) && !subjects.has(g.subject(c.message))).length;
}
