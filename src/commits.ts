import { classify, isIgnoredAuthor } from './classify.js';
import type { Config } from './config.js';
import { ChangeKind, githubCommitUrl, MS_PER_HOUR, shortSha } from './constants.js';
import { measureDurability, type DurabilityCache } from './durability.js';
import * as g from './git.js';
import { isDurable } from './metrics.js';
import { causedByShas, findCommitRework } from './rework.js';
import type { ChangeRecord, RawIssue } from './types.js';
import { progress } from './util.js';

export interface CommitModeOptions {
  repoPath: string;
  ref: string;
  repo: string;
  since: Date;
  cfg: Config;
  now: Date;
  bugIssues: RawIssue[];
  cache?: DurabilityCache;
  log?: (msg: string) => void;
}

/**
 * Commit mode: every commit on the branch's first-parent chain is one change.
 * A merge commit counts as a single change that carries all the commits it merged,
 * so a branch merged without a PR is measured as one unit.
 */
export async function commitChanges({ repoPath, ref, repo, since, cfg, now, bugIssues, cache, log = () => {} }: CommitModeOptions): Promise<ChangeRecord[]> {
  const commits = (await g.firstParentCommits(repoPath, ref, since)).filter((c) => !isIgnoredAuthor(c.authorName, cfg));

  const units = [];
  for (const c of commits) {
    const merged = c.parents.length >= 2 ? await g.commitsIn(repoPath, `${c.parents[0]}..${c.parents[1]}`) : [];
    units.push({ c, merged, owners: new Set([c.oid, ...merged.map((m) => m.oid)]) });
  }

  const reverts = await g.revertCommits(repoPath, ref, since);
  const shorts = new Set([
    ...reverts.flatMap((r) => r.reverts),
    ...causedByShas([...commits.map((c) => c.message), ...bugIssues.map((i) => `${i.title}\n${i.body}`)]),
  ]);
  const resolved = new Map<string, string>();
  for (const s of shorts) resolved.set(s, (await g.expandOid(repoPath, s)) ?? s);
  const rework = findCommitRework(
    units.map((u) => ({ oid: u.c.oid, committedAt: u.c.committedAt, message: u.c.message, owners: u.owners })),
    bugIssues,
    reverts,
    (s) => resolved.get(s) ?? s,
  );

  log(`Measuring durability of ${units.length} commits against ${ref}...`);
  const out: ChangeRecord[] = [];
  const tick = progress(log, units.length);
  for (const { c, merged } of units) {
    const cls = classify(
      { author: c.authorName, labels: [], headRefName: '', body: '', commits: [{ message: c.message }, ...merged] },
      cfg,
    );
    const durability = await measureDurability(repoPath, ref, { mergeCommitOid: c.oid, mergedAt: c.committedAt, commitCount: 1, commits: [] }, cfg, now, cache);
    const firstCommit = Math.min(Date.parse(c.authoredAt), ...merged.map((m) => Date.parse(m.authoredAt)));
    const events = rework.filter((e) => e.target === c.oid);
    out.push({
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
      size: await g.diffSize(repoPath, c.parents[0] ?? g.EMPTY_TREE, c.oid),
      rework: events,
      durability,
      durable: isDurable(c.committedAt, events, durability, cfg),
    });
    tick();
  }
  return out;
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
