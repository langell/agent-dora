import { fileMatcher, type Config } from './config.js';
import * as g from './git.js';
import { NO_MEASURABLE_LINES } from './metrics.js';
import type { Durability } from './types.js';

export interface DurabilityInput {
  mergeCommitOid: string | null;
  mergedAt: string;
  commitCount: number;
  commits: { message: string }[];
}

export interface DurabilityCache {
  get(key: string): { baseline: number; surviving: number } | undefined;
  set(key: string, value: { baseline: number; surviving: number }): void;
}

const DAY = 86_400_000;

/**
 * Finds the commits on the default branch that carry a PR's lines, plus the commit
 * the PR was applied on top of. Handles the three GitHub merge methods:
 * - merge commit: every commit in M^1..M^2, plus M itself (conflict resolutions);
 * - squash: just M;
 * - rebase: M and the first-parent ancestors whose subjects match the PR's commits.
 */
export async function prOwners(repoPath: string, pr: DurabilityInput, mergeOid: string): Promise<{ owners: Set<string>; base: string }> {
  const ps = await g.parents(repoPath, mergeOid);
  if (ps.length >= 2) {
    const owners = new Set([mergeOid, ...(await g.revList(repoPath, `${ps[0]}..${ps[1]}`))]);
    return { owners, base: ps[0]! };
  }
  const owners = new Set([mergeOid]);
  let last = mergeOid;
  if (pr.commitCount > 1) {
    const subjects = new Set(pr.commits.map((c) => c.message.split('\n')[0]!.trim()));
    const chain = await g.firstParentSubjects(repoPath, mergeOid, pr.commitCount);
    for (const c of chain.slice(1)) {
      if (!subjects.has(c.subject.trim())) break;
      owners.add(c.oid);
      last = c.oid;
    }
  }
  const lastParents = last === mergeOid ? ps : await g.parents(repoPath, last);
  return { owners, base: lastParents[0] ?? g.EMPTY_TREE };
}

/**
 * Measures how many of a PR's added lines are still in the default branch
 * `windowDays` after it merged, using `git blame` at both points in time.
 * Lines that were moved to a different file count as churned.
 */
export async function measureDurability(
  repoPath: string,
  ref: string,
  pr: DurabilityInput,
  cfg: Config,
  now: Date,
  cache?: DurabilityCache,
): Promise<Durability> {
  const unavailable = (reason: string): Durability => ({ status: 'unavailable', baseline: 0, surviving: 0, reason });
  const oid = pr.mergeCommitOid;
  if (!oid) return unavailable('no merge commit');

  const due = new Date(Date.parse(pr.mergedAt) + cfg.windowDays * DAY);
  if (due > now) return { status: 'pending', baseline: 0, surviving: 0 };

  const key = `${oid}:${cfg.windowDays}`;
  const cached = cache?.get(key);
  if (cached) return cached.baseline > 0 ? { status: 'measured', ...cached } : { status: 'unavailable', ...cached, reason: NO_MEASURABLE_LINES };

  if (!(await g.hasCommit(repoPath, oid))) return unavailable('merge commit not in local history (use fetch-depth: 0)');
  const later = await g.commitAt(repoPath, ref, due);
  if (!later || !(await g.isAncestor(repoPath, oid, later))) return unavailable('not merged into the default branch');

  const { owners, base } = await prOwners(repoPath, pr, oid);
  const ignored = fileMatcher(cfg.ignoreFiles);
  const files = (await g.addedFiles(repoPath, base, oid)).filter((f) => !ignored(f));
  const moved = await g.movedFiles(repoPath, oid, later);

  let baseline = 0;
  let surviving = 0;
  for (const file of files) {
    const before = await g.blameCount(repoPath, oid, file, owners);
    if (!before) continue;
    baseline += before;
    const nowPath = moved.has(file) ? moved.get(file) : file;
    if (nowPath) surviving += (await g.blameCount(repoPath, later, nowPath, owners)) ?? 0;
  }

  cache?.set(key, { baseline, surviving });
  if (baseline === 0) return { status: 'unavailable', baseline, surviving, reason: NO_MEASURABLE_LINES };
  return { status: 'measured', baseline, surviving };
}
