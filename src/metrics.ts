import type { Config } from './config.js';
import { AUTHOR_CLASSES, type AuthorClass, type ChangeRecord, type ClassKey, type Durability, type OpenPrRecord, type RawPr, type ReworkEvent, type Snapshot, type Unit } from './types.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export const NO_MEASURABLE_LINES = 'no measurable added lines';

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function firstReviewAt(pr: RawPr): string | null {
  const times = pr.reviews.filter((r) => r.author !== pr.author).map((r) => Date.parse(r.submittedAt));
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

/**
 * A PR is durable when, `windowDays` after merging, it has not been reverted or
 * reworked and at least `survivalThreshold` of its added lines are still there.
 * Returns null while that can't be known yet (or history is missing).
 */
export function isDurable(mergedAt: string, rework: ReworkEvent[], d: Durability, cfg: Config): boolean | null {
  if (d.status === 'pending') return null;
  const due = Date.parse(mergedAt) + cfg.windowDays * DAY;
  if (rework.some((e) => Date.parse(e.at) <= due)) return false;
  if (d.status === 'measured') return d.surviving / d.baseline >= cfg.survivalThreshold;
  // Deletion-only or config/binary-only PRs have nothing to churn; judge them on rework alone.
  return d.reason === NO_MEASURABLE_LINES ? true : null;
}

export function buildPrRecord(pr: RawPr, authorClass: AuthorClass, classReason: string, rework: ReworkEvent[], durability: Durability, cfg: Config): ChangeRecord {
  const mergedAt = pr.mergedAt!;
  const commitTimes = pr.commits.map((c) => Date.parse(c.authoredDate)).filter(Number.isFinite);
  const firstCommit = commitTimes.length ? Math.min(...commitTimes) : null;
  const start = Math.min(firstCommit ?? Infinity, Date.parse(pr.createdAt));
  const review = firstReviewAt(pr);
  return {
    kind: 'pr',
    id: `#${pr.number}`,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    authorClass,
    classReason,
    createdAt: pr.createdAt,
    mergedAt,
    firstCommitAt: firstCommit === null ? null : new Date(firstCommit).toISOString(),
    firstReviewAt: review,
    leadTimeHours: (Date.parse(mergedAt) - start) / HOUR,
    reviewWaitHours: review ? (Date.parse(review) - Date.parse(pr.createdAt)) / HOUR : null,
    size: pr.additions + pr.deletions,
    rework,
    durability,
    durable: isDurable(mergedAt, rework, durability, cfg),
  };
}

export interface ClassStats {
  merged: number;
  /** Changes whose durability window has elapsed. */
  matured: number;
  durable: number;
  durableRate: number | null;
  durablePerWeek: number | null;
  /** Share of added lines gone by the end of the window, across measured PRs. */
  churn: number | null;
  /** Matured changes reverted, reworked or blamed for a bug within the window. */
  changeFailureRate: number | null;
  reverts: number;
  leadTimeP50Hours: number | null;
  reviewWaitP50Hours: number | null;
  sizeP50: number | null;
  openPrs: number;
  awaitingReview: number;
  awaitingReviewAgeP50Hours: number | null;
}

export interface WeekRow {
  week: string;
  /** Every PR merged this week has passed its durability window. */
  matured: boolean;
  merged: Record<ClassKey, number>;
  durable: Record<ClassKey, number>;
}

export interface Report {
  repo: string;
  defaultBranch: string;
  branch: string;
  unit: Unit;
  notes: string[];
  generatedAt: string;
  collectedAt: string;
  since: string;
  windowDays: number;
  survivalThreshold: number;
  maturedWeeks: number;
  stats: Record<ClassKey, ClassStats>;
  weeks: WeekRow[];
  changes: ChangeRecord[];
  openPrs: OpenPrRecord[];
}

const KEYS: ClassKey[] = [...AUTHOR_CLASSES, 'all'];
const zeroes = (): Record<ClassKey, number> => ({ agent: 0, assisted: 0, human: 0, all: 0 });

export function startOfWeek(t: number): number {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY; // Monday
}

export function aggregate(snap: Snapshot, now: Date = new Date(snap.collectedAt)): Report {
  const windowMs = snap.windowDays * DAY;
  const maturedUntil = now.getTime() - windowMs;
  // The period starts at the first change, so young repos aren't averaged over empty weeks.
  const firstChange = Math.min(...snap.changes.map((c) => Date.parse(c.mergedAt)));
  const periodStart = Math.max(Date.parse(snap.since), Number.isFinite(firstChange) ? firstChange : 0);
  const maturedWeeks = Math.max(0, (maturedUntil - periodStart) / WEEK);

  const stats = {} as Record<ClassKey, ClassStats>;
  for (const key of KEYS) {
    const prs = snap.changes.filter((p) => key === 'all' || p.authorClass === key);
    const matured = prs.filter((p) => p.durable !== null);
    const durable = matured.filter((p) => p.durable).length;
    const measured = prs.filter((p) => p.durability.status === 'measured');
    const baseline = measured.reduce((s, p) => s + p.durability.baseline, 0);
    const surviving = measured.reduce((s, p) => s + p.durability.surviving, 0);
    const failed = matured.filter((p) => p.rework.some((e) => Date.parse(e.at) <= Date.parse(p.mergedAt) + windowMs)).length;
    const open = snap.openPrs.filter((p) => key === 'all' || p.authorClass === key);
    const waiting = open.filter((p) => p.awaitingFirstReview);
    stats[key] = {
      merged: prs.length,
      matured: matured.length,
      durable,
      durableRate: matured.length ? durable / matured.length : null,
      durablePerWeek: maturedWeeks >= 1 && matured.length ? durable / maturedWeeks : null,
      churn: baseline ? 1 - surviving / baseline : null,
      changeFailureRate: matured.length ? failed / matured.length : null,
      reverts: prs.filter((p) => p.rework.some((e) => e.kind === 'revert')).length,
      leadTimeP50Hours: median(prs.flatMap((p) => (p.leadTimeHours === null ? [] : [p.leadTimeHours]))),
      reviewWaitP50Hours: median(prs.flatMap((p) => (p.reviewWaitHours === null ? [] : [p.reviewWaitHours]))),
      sizeP50: median(prs.map((p) => p.size)),
      openPrs: open.length,
      awaitingReview: waiting.length,
      awaitingReviewAgeP50Hours: median(waiting.map((p) => (now.getTime() - Date.parse(p.createdAt)) / HOUR)),
    };
  }

  const weeks: WeekRow[] = [];
  for (let w = startOfWeek(periodStart); w <= now.getTime(); w += WEEK) {
    weeks.push({ week: new Date(w).toISOString().slice(0, 10), matured: w + WEEK <= maturedUntil, merged: zeroes(), durable: zeroes() });
  }
  const first = weeks.length ? Date.parse(weeks[0]!.week) : 0;
  for (const p of snap.changes) {
    const row = weeks[Math.floor((startOfWeek(Date.parse(p.mergedAt)) - first) / WEEK)];
    if (!row) continue;
    row.merged[p.authorClass]++;
    row.merged.all++;
    if (p.durable) {
      row.durable[p.authorClass]++;
      row.durable.all++;
    }
  }

  return {
    repo: snap.repo,
    defaultBranch: snap.defaultBranch,
    branch: snap.branch,
    unit: snap.unit,
    notes: snap.notes,
    generatedAt: new Date().toISOString(),
    collectedAt: snap.collectedAt,
    since: snap.since,
    windowDays: snap.windowDays,
    survivalThreshold: snap.survivalThreshold,
    maturedWeeks,
    stats,
    weeks,
    changes: [...snap.changes].sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt)),
    openPrs: snap.openPrs,
  };
}
