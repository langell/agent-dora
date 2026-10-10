import { createHash } from 'node:crypto';
import { fileMatcher, type Config } from './config.js';
import { DurabilityStatus, MS_PER_DAY, UnavailableReason, type ChangeKind } from './constants.js';
import * as g from './git.js';
import type { CurvePoint, Durability, FileSurvival } from './types.js';

/** A change as durability sees it: the commit that landed it on the branch, and when. */
export interface LandedChange {
  /** PR or commit: the same commit can carry different lines in each mode. */
  kind: ChangeKind;
  /** The PR's merge or squash commit, or in commit mode the commit itself. */
  oid: string | null;
  landedAt: string;
}

/** The commits carrying a change's lines, and the commit it was applied on top of. */
export interface ChangeLines {
  owners: Set<string>;
  base: string;
}

/** What `prLines` needs from a PR to recognise its commits after a rebase merge. */
export interface PrCommits {
  commitCount: number;
  commits: { message: string }[];
}

/** Hex digits of the settings hash in a cache key; plenty to tell settings apart. */
const KEY_HASH_LENGTH = 12;

/**
 * Cache key for a measurement. Besides the commit and window, it covers everything
 * else that changes the result: the change kind (a rebase-merged PR's last commit
 * carries the whole PR in PR mode, but only itself in commit mode), the branch it's
 * measured against, and the ignored files.
 */
export function durabilityKey(oid: string, kind: ChangeKind, ref: string, cfg: Config): string {
  const settings = { kind, ref, ignoreFiles: cfg.ignoreFiles, checkpoints: checkpointDays(cfg) };
  const scope = createHash('sha1').update(JSON.stringify(settings)).digest('hex').slice(0, KEY_HASH_LENGTH);
  return `${oid}:${cfg.windowDays}:${scope}`;
}

/** The configured checkpoints that fall inside the window, in order, without duplicates. */
export function checkpointDays(cfg: Config): number[] {
  return [...new Set(cfg.checkpointDays.filter((d) => d < cfg.windowDays))].sort((a, b) => a - b);
}

/** What a measurement found; immutable once the window has passed, so it's cached. */
export type Measurement = Pick<Durability, 'baseline' | 'surviving' | 'files' | 'curve'>;

export interface DurabilityCache {
  get(key: string): Measurement | undefined;
  set(key: string, value: Measurement): void;
}

/**
 * Finds the commits on the branch that carry a PR's lines, plus the commit
 * the PR was applied on top of. Handles the three GitHub merge methods:
 * - merge commit: every commit in M^1..M^2, plus M itself (conflict resolutions);
 * - squash: just M;
 * - rebase: M and the first-parent ancestors whose subjects match the PR's commits.
 */
export async function prLines(repoPath: string, pr: PrCommits, mergeOid: string): Promise<ChangeLines> {
  const ps = await g.parents(repoPath, mergeOid);
  if (ps.length >= 2) {
    const owners = new Set([mergeOid, ...(await g.revList(repoPath, `${ps[0]}..${ps[1]}`))]);
    return { owners, base: ps[0]! };
  }
  const owners = new Set([mergeOid]);
  let last = mergeOid;
  if (pr.commitCount > 1) {
    const subjects = new Set(pr.commits.map((c) => g.subject(c.message)));
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
 * Measures how many of a change's added lines are still on the branch
 * `windowDays` after it landed, using `git blame` at both points in time,
 * per file and at each checkpoint along the way.
 * Lines that were moved to a different file count as churned.
 *
 * `lines` is only called when a measurement is actually needed (not pending,
 * not cached), so callers can pass lookups that run git commands.
 */
export async function measureDurability(
  repoPath: string,
  ref: string,
  change: LandedChange,
  lines: (oid: string) => Promise<ChangeLines>,
  cfg: Config,
  now: Date,
  cache?: DurabilityCache,
): Promise<Durability> {
  const unavailable = (reason: UnavailableReason, baseline = 0, surviving = 0): Durability => ({
    status: DurabilityStatus.Unavailable,
    baseline,
    surviving,
    reason,
  });
  const measured = (m: Measurement): Durability =>
    m.baseline > 0 ? { status: DurabilityStatus.Measured, ...m } : unavailable(UnavailableReason.NoMeasurableLines, m.baseline, m.surviving);

  const oid = change.oid;
  if (!oid) return unavailable(UnavailableReason.NoMergeCommit);

  const due = new Date(Date.parse(change.landedAt) + cfg.windowDays * MS_PER_DAY);
  if (due > now) return { status: DurabilityStatus.Pending, baseline: 0, surviving: 0 };

  const key = durabilityKey(oid, change.kind, ref, cfg);
  const cached = cache?.get(key);
  if (cached) return measured(cached);

  if (!(await g.hasCommit(repoPath, oid))) return unavailable(UnavailableReason.NotInHistory);
  const later = await g.commitAt(repoPath, ref, due);
  if (!later || !(await g.isAncestor(repoPath, oid, later))) return unavailable(UnavailableReason.NotOnBranch);

  const { owners, base } = await lines(oid);
  const ignored = fileMatcher(cfg.ignoreFiles);
  const files = (await g.addedFiles(repoPath, base, oid)).filter((f) => !ignored(f));
  const landedAt = Date.parse(change.landedAt);
  // Each point in time to measure at: the checkpoints (if the branch reaches them), then the window's end.
  const points = await Promise.all(
    checkpointDays(cfg).map(async (days) => {
      const rev = await g.commitAt(repoPath, ref, new Date(landedAt + days * MS_PER_DAY));
      return rev && (await g.isAncestor(repoPath, oid, rev)) ? { days, rev } : { days, rev: null };
    }),
  );
  const revs = [...points.flatMap((p) => (p.rev ? [p.rev] : [])), later];
  const movedAt = new Map(await Promise.all(revs.map(async (rev) => [rev, await g.movedFiles(repoPath, oid, rev)] as const)));
  /** Lines of `file` still attributed to the change at `rev`, following renames. */
  const left = async (file: string, rev: string) => {
    const moved = movedAt.get(rev)!;
    const path = moved.has(file) ? moved.get(file) : file;
    return path ? ((await g.blameCount(repoPath, rev, path, owners)) ?? 0) : 0;
  };

  let baseline = 0;
  let surviving = 0;
  const fileResults: FileSurvival[] = [];
  const atPoint = points.map(() => 0);
  for (const file of files) {
    const before = await g.blameCount(repoPath, oid, file, owners);
    if (!before) continue;
    baseline += before;
    const after = await left(file, later);
    surviving += after;
    fileResults.push({ path: file, baseline: before, surviving: after });
    for (const [i, p] of points.entries()) if (p.rev) atPoint[i]! += await left(file, p.rev);
  }
  const curve: CurvePoint[] = points.map((p, i) => ({ days: p.days, surviving: p.rev ? atPoint[i]! : null }));

  const result: Measurement = { baseline, surviving, files: fileResults, curve };
  cache?.set(key, result);
  return measured(result);
}
