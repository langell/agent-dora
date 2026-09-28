import type { Classification } from './classify.js';
import type { Config } from './config.js';
import {
  ALL_CLASSES,
  CLASS_KEYS,
  ChangeKind,
  ChangeStatus,
  DurabilityStatus,
  ReworkKind,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_WEEK,
  prId,
  UnavailableReason,
  isoDate,
  type ClassKey,
} from './constants.js';
import type { ChangeRecord, Durability, OpenPrRecord, RawPr, ReworkEvent, Snapshot, Unit } from './types.js';

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
  if (d.status === DurabilityStatus.Pending) return null;
  const due = Date.parse(mergedAt) + cfg.windowDays * MS_PER_DAY;
  if (rework.some((e) => Date.parse(e.at) <= due)) return false;
  if (d.status === DurabilityStatus.Measured) return d.surviving / d.baseline >= cfg.survivalThreshold;
  // Deletion-only or config/binary-only PRs have nothing to churn; judge them on rework alone.
  return d.reason === UnavailableReason.NoMeasurableLines ? true : null;
}

/** A change's standing, as shown and filtered in the report. */
export function changeStatus(c: Pick<ChangeRecord, 'durable' | 'durability'>): ChangeStatus {
  if (c.durable === true) return ChangeStatus.Durable;
  if (c.durable === false) return ChangeStatus.Failed;
  return c.durability.status === DurabilityStatus.Pending ? ChangeStatus.Pending : ChangeStatus.Unknown;
}

export function buildPrRecord(pr: RawPr, cls: Classification, rework: ReworkEvent[], durability: Durability, cfg: Config): ChangeRecord {
  const mergedAt = pr.mergedAt!;
  const commitTimes = pr.commits.map((c) => Date.parse(c.authoredDate)).filter(Number.isFinite);
  const firstCommit = commitTimes.length ? Math.min(...commitTimes) : null;
  const start = Math.min(firstCommit ?? Infinity, Date.parse(pr.createdAt));
  const review = firstReviewAt(pr);
  return {
    kind: ChangeKind.Pr,
    id: prId(pr.number),
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    authorClass: cls.authorClass,
    classSource: cls.source,
    classReason: cls.reason,
    createdAt: pr.createdAt,
    mergedAt,
    firstCommitAt: firstCommit === null ? null : new Date(firstCommit).toISOString(),
    firstReviewAt: review,
    leadTimeHours: (Date.parse(mergedAt) - start) / MS_PER_HOUR,
    reviewWaitHours: review ? (Date.parse(review) - Date.parse(pr.createdAt)) / MS_PER_HOUR : null,
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
  /** Every change that landed this week has passed its durability window. */
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
  changes: ReportedChange[];
  openPrs: OpenPrRecord[];
}

export type ReportedChange = ChangeRecord & { status: ChangeStatus };

/** Per-week rates need at least this many matured weeks to mean anything. */
const MIN_WEEKS_FOR_RATE = 1;

const zeroes = () => Object.fromEntries(CLASS_KEYS.map((k) => [k, 0])) as Record<ClassKey, number>;

export function startOfWeek(t: number): number {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7; // getUTCDay() is 0 on Sunday
  return d.getTime() - daysSinceMonday * MS_PER_DAY;
}

/** The stretch of time the metrics cover. */
export interface Period {
  /** The first change, or `since` if that's later. Young repos aren't averaged over empty weeks. */
  start: number;
  /** Changes that landed before this have passed their durability window. */
  maturedUntil: number;
  /** Length of the matured part of the period, in weeks. */
  maturedWeeks: number;
  windowMs: number;
}

export function period(snap: Snapshot, now: Date): Period {
  const windowMs = snap.windowDays * MS_PER_DAY;
  const maturedUntil = now.getTime() - windowMs;
  const firstChange = Math.min(...snap.changes.map((c) => Date.parse(c.mergedAt)));
  const start = Math.max(Date.parse(snap.since), Number.isFinite(firstChange) ? firstChange : 0);
  return { start, maturedUntil, maturedWeeks: Math.max(0, (maturedUntil - start) / MS_PER_WEEK), windowMs };
}

/** Stats for one author class's changes and open PRs. */
export function classStats(changes: ChangeRecord[], openPrs: OpenPrRecord[], p: Period, now: Date): ClassStats {
  const matured = changes.filter((c) => c.durable !== null);
  const durable = matured.filter((c) => c.durable).length;
  const measured = changes.filter((c) => c.durability.status === DurabilityStatus.Measured);
  const baseline = measured.reduce((s, c) => s + c.durability.baseline, 0);
  const surviving = measured.reduce((s, c) => s + c.durability.surviving, 0);
  const failed = matured.filter((c) => c.rework.some((e) => Date.parse(e.at) <= Date.parse(c.mergedAt) + p.windowMs)).length;
  const waiting = openPrs.filter((o) => o.awaitingFirstReview);
  const present = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);
  return {
    merged: changes.length,
    matured: matured.length,
    durable,
    durableRate: matured.length ? durable / matured.length : null,
    durablePerWeek: p.maturedWeeks >= MIN_WEEKS_FOR_RATE && matured.length ? durable / p.maturedWeeks : null,
    churn: baseline ? 1 - surviving / baseline : null,
    changeFailureRate: matured.length ? failed / matured.length : null,
    reverts: changes.filter((c) => c.rework.some((e) => e.kind === ReworkKind.Revert)).length,
    leadTimeP50Hours: median(present(changes.map((c) => c.leadTimeHours))),
    reviewWaitP50Hours: median(present(changes.map((c) => c.reviewWaitHours))),
    sizeP50: median(changes.map((c) => c.size)),
    openPrs: openPrs.length,
    awaitingReview: waiting.length,
    awaitingReviewAgeP50Hours: median(waiting.map((o) => (now.getTime() - Date.parse(o.createdAt)) / MS_PER_HOUR)),
  };
}

/** Changes landed and durable per week (Monday start, UTC), from the period start to `now`. */
export function weeklySeries(changes: ChangeRecord[], p: Period, now: Date): WeekRow[] {
  const weeks: WeekRow[] = [];
  for (let w = startOfWeek(p.start); w <= now.getTime(); w += MS_PER_WEEK) {
    weeks.push({ week: isoDate(new Date(w).toISOString()), matured: w + MS_PER_WEEK <= p.maturedUntil, merged: zeroes(), durable: zeroes() });
  }
  const first = weeks.length ? Date.parse(weeks[0]!.week) : 0;
  for (const c of changes) {
    const row = weeks[Math.floor((startOfWeek(Date.parse(c.mergedAt)) - first) / MS_PER_WEEK)];
    if (!row) continue;
    for (const key of [c.authorClass, ALL_CLASSES] as const) {
      row.merged[key]++;
      if (c.durable) row.durable[key]++;
    }
  }
  return weeks;
}

export function aggregate(snap: Snapshot, now: Date = new Date(snap.collectedAt)): Report {
  const p = period(snap, now);
  const inClass = (key: ClassKey) => (x: { authorClass: string }) => key === ALL_CLASSES || x.authorClass === key;
  const stats = Object.fromEntries(
    CLASS_KEYS.map((key) => [key, classStats(snap.changes.filter(inClass(key)), snap.openPrs.filter(inClass(key)), p, now)]),
  ) as Record<ClassKey, ClassStats>;

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
    maturedWeeks: p.maturedWeeks,
    stats,
    weeks: weeklySeries(snap.changes, p, now),
    changes: [...snap.changes]
      .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))
      .map((c) => ({ ...c, status: changeStatus(c) })),
    openPrs: snap.openPrs,
  };
}
