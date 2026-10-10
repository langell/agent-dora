import type { Snapshot } from './types.js';

/** Shown for the branch when combined repositories measured different branches. */
const MIXED_BRANCHES = 'several branches';

/**
 * Combines snapshots of several repositories into one, so a team or org sees one report.
 * Each change and open PR is tagged with its repository. The snapshots must share the
 * unit, window and threshold, since the combined rates would mean nothing otherwise.
 */
export function combineSnapshots(all: Snapshot[]): Snapshot {
  // A repository found in several caches counts once, from its latest collection.
  const latest = new Map<string, Snapshot>();
  for (const s of all) if ((latest.get(s.repo)?.collectedAt ?? '') < s.collectedAt) latest.set(s.repo, s);
  const snaps = [...latest.values()];
  const [first, ...rest] = snaps;
  if (!first) throw new Error('No collected data to combine. Run `collect` in each repository first.');
  if (!rest.length) return first;
  for (const s of rest) {
    for (const key of ['unit', 'windowDays', 'survivalThreshold'] as const) {
      if (s[key] !== first[key]) throw new Error(`Can't combine ${first.repo} and ${s.repo}: their ${key} differs (${first[key]} vs ${s[key]}).`);
    }
  }
  const repos = [...new Set(snaps.map((s) => s.repo))].sort();
  const same = <T>(f: (s: Snapshot) => T, mixed: T) => (snaps.every((s) => f(s) === f(first)) ? f(first) : mixed);
  const earliest = (f: (s: Snapshot) => string) => snaps.map(f).sort()[0]!;
  return {
    repo: `${repos.length} repositories`,
    repos,
    defaultBranch: same((s) => s.defaultBranch, MIXED_BRANCHES),
    branch: same((s) => s.branch, MIXED_BRANCHES),
    unit: first.unit,
    // The earliest collection time, so no change counts as matured before its snapshot says so.
    collectedAt: earliest((s) => s.collectedAt),
    since: earliest((s) => s.since),
    windowDays: first.windowDays,
    survivalThreshold: first.survivalThreshold,
    minSurvivalLines: same((s) => s.minSurvivalLines, first.minSurvivalLines),
    changes: snaps.flatMap((s) => s.changes.map((c) => ({ ...c, repo: s.repo }))),
    openPrs: snaps.flatMap((s) => s.openPrs.map((o) => ({ ...o, repo: s.repo }))),
    notes: snaps.flatMap((s) => s.notes.map((n) => `${s.repo}: ${n}`)),
  };
}
