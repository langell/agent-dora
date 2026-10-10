import { isHumanReview, type Classification } from './classify.js';
import { DEFAULT_CONFIG, type Config } from './config.js';
import {
  ALL_CLASSES,
  AUTHOR_CLASSES,
  CLASS_KEYS,
  CLASS_SOURCES,
  AuthorClass,
  ChangeKind,
  ChangeStatus,
  DeployStatus,
  DurabilityStatus,
  FailureReason,
  FIXER_ISSUE,
  FIXER_KEYS,
  FIXER_OUTSIDE,
  incidentKey,
  REVIEW_DEPTHS,
  ReviewDepth,
  ReviewState,
  ReworkKind,
  ReworkSourceKind,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_WEEK,
  prId,
  shortSha,
  UnavailableReason,
  isoDate,
  type ClassKey,
  type ClassSource,
  type DeploySource,
  type FixerKey,
  type IncidentSource,
} from './constants.js';
import { releases } from './deployments.js';
import type { ChangeRecord, CostEntry, Deployment, Durability, Incident, OpenPrRecord, RawPr, ReworkEvent, Snapshot, Unit } from './types.js';

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The `q` quantile (0-1) of `xs`, interpolating between neighbours; null if empty. */
export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** z for a 95% confidence interval. */
const Z_95 = 1.96;

/** Wilson score interval for `successes` out of `n`: honest error bars for small samples. */
export function wilson(successes: number, n: number): [number, number] | null {
  if (!n) return null;
  const p = successes / n;
  const z2 = Z_95 * Z_95;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (Z_95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function firstReviewAt(pr: RawPr, cfg: Config): string | null {
  const times = pr.reviews.filter((r) => isHumanReview(r, pr.author, cfg)).map((r) => Date.parse(r.submittedAt));
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

/**
 * How closely people reviewed a PR: not at all, an approval with nothing written, or
 * a review that commented or asked for changes. Bot reviews don't count.
 */
export function reviewDepth(pr: RawPr, cfg: Config): ReviewDepth {
  const human = pr.reviews.filter((r) => isHumanReview(r, pr.author, cfg));
  if (!human.length) return ReviewDepth.None;
  return human.some((r) => r.commented || r.state === ReviewState.ChangesRequested) ? ReviewDepth.Engaged : ReviewDepth.Silent;
}

/**
 * A PR is durable when, `windowDays` after merging, it has not been reverted or
 * reworked and at least `survivalThreshold` of its added lines are still there.
 * A revert or fix inside the window fails it at once, without waiting for the window
 * to end. Otherwise returns null while that can't be known yet (or history is missing).
 */
export function isDurable(mergedAt: string, rework: ReworkEvent[], d: Durability, cfg: Config): boolean | null {
  const due = Date.parse(mergedAt) + cfg.windowDays * MS_PER_DAY;
  if (rework.some((e) => Date.parse(e.at) <= due)) return false;
  if (d.status === DurabilityStatus.Pending) return null;
  // Too few lines for a survival share to mean much; judge them on rework alone.
  if (d.status === DurabilityStatus.Measured) return d.baseline < cfg.minSurvivalLines || d.surviving / d.baseline >= cfg.survivalThreshold;
  // Deletion-only or config/binary-only PRs have nothing to churn; judge them on rework alone.
  return d.reason === UnavailableReason.NoMeasurableLines ? true : null;
}

/** A change's standing, as shown and filtered in the report. */
export function changeStatus(c: Pick<ChangeRecord, 'durable' | 'durability' | 'remedial'>): ChangeStatus {
  if (c.remedial) return ChangeStatus.Remedial;
  if (c.durable === true) return ChangeStatus.Durable;
  if (c.durable === false) return ChangeStatus.Failed;
  return c.durability.status === DurabilityStatus.Pending ? ChangeStatus.Pending : ChangeStatus.Unknown;
}

/** What `buildPrRecord` takes from local git, when it has it. */
export interface PrExtras {
  /** Lines added plus deleted, excluding ignored files. Defaults to GitHub's count. */
  size?: number;
  remedial?: boolean;
}

export function buildPrRecord(pr: RawPr, cls: Classification, rework: ReworkEvent[], durability: Durability, cfg: Config, extras: PrExtras = {}): ChangeRecord {
  const mergedAt = pr.mergedAt!;
  const commitTimes = pr.commits.map((c) => Date.parse(c.authoredDate)).filter(Number.isFinite);
  const firstCommit = commitTimes.length ? Math.min(...commitTimes) : null;
  const start = Math.min(firstCommit ?? Infinity, Date.parse(pr.createdAt));
  const review = firstReviewAt(pr, cfg);
  return {
    kind: ChangeKind.Pr,
    id: prId(pr.number),
    number: pr.number,
    oid: pr.mergeCommitOid,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    authorClass: cls.authorClass,
    classSource: cls.source,
    classReason: cls.reason,
    tool: cls.tool,
    createdAt: pr.createdAt,
    mergedAt,
    firstCommitAt: firstCommit === null ? null : new Date(firstCommit).toISOString(),
    deployedAt: null,
    deployLeadTimeHours: null,
    firstReviewAt: review,
    leadTimeHours: (Date.parse(mergedAt) - start) / MS_PER_HOUR,
    reviewWaitHours: review ? (Date.parse(review) - Date.parse(pr.createdAt)) / MS_PER_HOUR : null,
    reviewDepth: reviewDepth(pr, cfg),
    size: extras.size ?? pr.additions + pr.deletions,
    rework,
    durability,
    durable: isDurable(mergedAt, rework, durability, cfg),
    remedial: extras.remedial ?? false,
  };
}

/** Spread of a duration across changes, in hours. */
export interface Quantiles {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

const QUANTILES = { p10: 0.1, p25: 0.25, p50: 0.5, p75: 0.75, p90: 0.9 } as const satisfies Record<keyof Quantiles, number>;

function quantiles(xs: number[]): Quantiles | null {
  if (!xs.length) return null;
  return Object.fromEntries(Object.entries(QUANTILES).map(([k, q]) => [k, quantile(xs, q)!])) as unknown as Quantiles;
}

export interface ClassStats {
  merged: number;
  /** Changes that revert or fix earlier ones. Counted in `merged`, left out of everything durable. */
  remedial: number;
  /** Changes whose durability window has elapsed and that got a verdict. Excludes remedial changes. */
  matured: number;
  durable: number;
  durableRate: number | null;
  /** 95% confidence interval of `durableRate`. */
  durableRateCi: [number, number] | null;
  durablePerWeek: number | null;
  /** Lines from matured changes still there at the end of the window, per matured week. */
  survivingLinesPerWeek: number | null;
  /** Share of added lines gone by the end of the window, across matured changes (line-weighted). */
  churn: number | null;
  /** Median share of a change's lines kept by the end of the window (change-weighted). */
  keptP50: number | null;
  /** Matured changes reverted, reworked or blamed for a bug within the window. */
  changeFailureRate: number | null;
  /** 95% confidence interval of `changeFailureRate`. */
  changeFailureRateCi: [number, number] | null;
  /** Matured changes reverted within the window. */
  reverts: number;
  /** Changes still inside their window that have already been reverted or reworked. */
  failingEarly: number;
  /** Changes whose durability couldn't be measured (missing history, not on the branch). */
  unknown: number;
  leadTimeP50Hours: number | null;
  leadTime: Quantiles | null;
  reviewWaitP50Hours: number | null;
  /** First commit to production, for changes deployed so far. */
  deployLeadTimeP50Hours: number | null;
  /** Changes a tracker incident blamed with `Caused-by`, at any time: defects that escaped to production. */
  escapedDefects: number;
  /** PRs by how closely a person reviewed them (PR mode only). */
  reviewDepth: Record<ReviewDepth, number>;
  /** Share of PRs merged with no human review, or a human approval with nothing written. */
  rubberStampRate: number | null;
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
  /** Commits that went live in production this week (once each, however many projects deployed them). */
  deploys: number;
  /** Incidents opened this week. */
  incidents: number;
}

/** DORA's delivery measures, from deployments and incident trackers. */
export interface DeliveryStats {
  /** Where deployments came from; null without deployment data. */
  deploySource: DeploySource | null;
  environments: string[];
  /** Commits that went live in production in the period; one commit deployed to several projects counts once. */
  deploys: number;
  deploysPerWeek: number | null;
  failedDeploys: number;
  /** Changes not in production yet. */
  undeployed: number;
  /** Incidents in the period; null without a tracker. */
  incidents: number | null;
  incidentsBySource: Partial<Record<IncidentSource, number>>;
  /** Incidents that named the change that caused them. */
  linkedIncidents: number;
  /** Deployments followed by an incident within `attributionHours`. */
  deploysWithIncident: number | null;
  /** DORA change failure rate by deployment: share of deployments followed by an incident. */
  deployFailureRate: number | null;
  /** Incident opened to resolved (DORA's time to restore). */
  timeToRestoreP50Hours: number | null;
  attributionHours: number;
}

/** AI spend for one tool, against the durable changes it helped write. */
export interface ToolCost {
  tool: string;
  usd: number;
  durable: number;
  perDurableChange: number | null;
}

/** AI spend over the matured period, against durable AI-written output from the same period. */
export interface CostStats {
  /** The stretch spend is counted over: the matured period, so every change in it has a verdict. */
  from: string;
  until: string;
  usd: number;
  /** Durable agent and assisted changes that landed in the same stretch. */
  durable: number;
  perDurableChange: number | null;
  /** Spend per thousand added lines from matured AI-written changes still there at the end of the window. */
  perThousandSurvivingLines: number | null;
  byTool: ToolCost[];
  /** People (or API keys) the spend came from. */
  actors: number;
  /** Spend after the matured period: its changes haven't been judged yet. */
  maturingUsd: number;
}

/** Stats for one AI tool's changes. */
export interface ToolRow {
  tool: string;
  stats: ClassStats;
}

/** The latest matured stretch of `days` next to the one before it. */
export interface Comparison {
  days: number;
  /** End of the current stretch; the previous one ends `days` earlier. */
  until: string;
  current: Record<ClassKey, ClassStats>;
  /** null when the data doesn't reach back two full stretches. */
  previous: Record<ClassKey, ClassStats> | null;
}

/** Rework events inside the window: rows are the class of the change fixed, columns who fixed it. */
export type FixMatrix = Record<AuthorClass, Record<FixerKey, number>>;

/** A directory's added lines and lines lost by the end of the window, across matured changes. */
export interface Hotspot {
  dir: string;
  baseline: number;
  lost: number;
  byClass: Record<AuthorClass, { baseline: number; lost: number }>;
}

/** Share of matured lines left `days` after landing, per class. Day 0 is always 1. */
export interface CurveRow {
  days: number;
  kept: Record<ClassKey, number | null>;
}

/** Open PRs awaiting review, by how long they've waited. */
export interface QueueAgeBucket {
  /** Upper bound of the bucket in days; null for the last, open-ended one. */
  maxDays: number | null;
  counts: Record<AuthorClass, number>;
}

export interface Report {
  repo: string;
  /** Set when several repositories are combined. */
  repos?: string[];
  defaultBranch: string;
  branch: string;
  unit: Unit;
  notes: string[];
  generatedAt: string;
  collectedAt: string;
  since: string;
  windowDays: number;
  survivalThreshold: number;
  minSurvivalLines: number;
  maturedWeeks: number;
  stats: Record<ClassKey, ClassStats>;
  tools: ToolRow[];
  comparison: Comparison | null;
  fixes: FixMatrix;
  hotspots: Hotspot[];
  survivalCurve: CurveRow[];
  classSources: Record<AuthorClass, Record<ClassSource, number>>;
  queueAges: QueueAgeBucket[];
  /** Null unless deployments or incidents were collected. */
  delivery: DeliveryStats | null;
  /** Null unless AI spend was collected. */
  cost: CostStats | null;
  /** Incidents from trackers, if any were collected. */
  incidents: Incident[];
  weeks: WeekRow[];
  changes: ReportedChange[];
  openPrs: OpenPrRecord[];
}

export type ReportedChange = ChangeRecord & { status: ChangeStatus; failureReasons: FailureReason[] };

/** Per-week rates need at least this many matured weeks to mean anything. */
const MIN_WEEKS_FOR_RATE = 1;
/** The hotspot table lists at most this many directories. */
const MAX_HOTSPOTS = 15;
/** Upper bounds, in days, of the review queue's age buckets; a last bucket takes the rest. */
const QUEUE_AGE_BOUNDS_DAYS = [1, 3, 7];

const zeroes = () => Object.fromEntries(CLASS_KEYS.map((k) => [k, 0])) as Record<ClassKey, number>;
const perClass = <T>(make: () => T) => Object.fromEntries(AUTHOR_CLASSES.map((c) => [c, make()])) as Record<AuthorClass, T>;
const counts = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

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

/** Rework events that landed inside the change's durability window. */
const inWindow = (c: ChangeRecord, p: Period) => c.rework.filter((e) => Date.parse(e.at) <= Date.parse(c.mergedAt) + p.windowMs);

/** The window has elapsed for changes that landed by `p.maturedUntil`. */
const elapsed = (c: ChangeRecord, p: Period) => Date.parse(c.mergedAt) <= p.maturedUntil;

/** Changes that count toward rates: not fixes or reverts, window elapsed, verdict known. */
const maturedOf = (changes: ChangeRecord[], p: Period) => changes.filter((c) => !c.remedial && c.durable !== null && elapsed(c, p));

const isMeasured = (c: ChangeRecord) => c.durability.status === DurabilityStatus.Measured;

/** Stats for one author class's changes and open PRs. */
export function classStats(changes: ChangeRecord[], openPrs: OpenPrRecord[], p: Period, now: Date): ClassStats {
  const counted = changes.filter((c) => !c.remedial);
  // Rates only use changes whose window has fully elapsed. Early failures show in the
  // change list right away, but counting them before their durable peers mature would
  // inflate failure rates for recent work.
  const matured = maturedOf(changes, p);
  const durable = matured.filter((c) => c.durable).length;
  const measured = matured.filter(isMeasured);
  const baseline = measured.reduce((s, c) => s + c.durability.baseline, 0);
  const surviving = measured.reduce((s, c) => s + c.durability.surviving, 0);
  const failed = matured.filter((c) => inWindow(c, p).length > 0).length;
  const waiting = openPrs.filter((o) => o.awaitingFirstReview);
  const present = (xs: (number | null | undefined)[]) => xs.filter((x): x is number => x !== null && x !== undefined);
  const enoughWeeks = p.maturedWeeks >= MIN_WEEKS_FOR_RATE && matured.length > 0;
  const depth = counts(REVIEW_DEPTHS);
  for (const c of changes) if (c.reviewDepth) depth[c.reviewDepth]++;
  const reviewed = REVIEW_DEPTHS.reduce((n, d) => n + depth[d], 0);
  const leadTimes = present(changes.map((c) => c.leadTimeHours));
  return {
    merged: changes.length,
    remedial: changes.length - counted.length,
    matured: matured.length,
    durable,
    durableRate: matured.length ? durable / matured.length : null,
    durableRateCi: wilson(durable, matured.length),
    durablePerWeek: enoughWeeks ? durable / p.maturedWeeks : null,
    survivingLinesPerWeek: enoughWeeks && measured.length ? surviving / p.maturedWeeks : null,
    churn: baseline ? 1 - surviving / baseline : null,
    keptP50: median(measured.map((c) => c.durability.surviving / c.durability.baseline)),
    changeFailureRate: matured.length ? failed / matured.length : null,
    changeFailureRateCi: wilson(failed, matured.length),
    reverts: matured.filter((c) => inWindow(c, p).some((e) => e.kind === ReworkKind.Revert)).length,
    failingEarly: counted.filter((c) => c.durable === false && !elapsed(c, p)).length,
    unknown: counted.filter((c) => changeStatus(c) === ChangeStatus.Unknown).length,
    leadTimeP50Hours: median(leadTimes),
    leadTime: quantiles(leadTimes),
    reviewWaitP50Hours: median(present(changes.map((c) => c.reviewWaitHours))),
    deployLeadTimeP50Hours: median(present(changes.map((c) => c.deployLeadTimeHours))),
    escapedDefects: counted.filter((c) => c.rework.some((e) => e.kind === ReworkKind.Incident)).length,
    reviewDepth: depth,
    rubberStampRate: reviewed ? (depth[ReviewDepth.None] + depth[ReviewDepth.Silent]) / reviewed : null,
    sizeP50: median(changes.map((c) => c.size)),
    openPrs: openPrs.length,
    awaitingReview: waiting.length,
    awaitingReviewAgeP50Hours: median(waiting.map((o) => (now.getTime() - Date.parse(o.createdAt)) / MS_PER_HOUR)),
  };
}

const inClass = (key: ClassKey) => (x: { authorClass: string }) => key === ALL_CLASSES || x.authorClass === key;

function statsByClass(changes: ChangeRecord[], openPrs: OpenPrRecord[], p: Period, now: Date): Record<ClassKey, ClassStats> {
  return Object.fromEntries(CLASS_KEYS.map((key) => [key, classStats(changes.filter(inClass(key)), openPrs.filter(inClass(key)), p, now)])) as Record<ClassKey, ClassStats>;
}

/**
 * Changes landed and durable per week (Monday start, UTC), from the period start to `now`,
 * plus deployments and incidents. Fixes and reverts aren't counted as changes.
 */
export function weeklySeries(changes: ChangeRecord[], p: Period, now: Date, deploys: Deployment[] = [], incidents: Incident[] = []): WeekRow[] {
  const weeks: WeekRow[] = [];
  for (let w = startOfWeek(p.start); w <= now.getTime(); w += MS_PER_WEEK) {
    weeks.push({ week: isoDate(new Date(w).toISOString()), matured: w + MS_PER_WEEK <= p.maturedUntil, merged: zeroes(), durable: zeroes(), deploys: 0, incidents: 0 });
  }
  const first = weeks.length ? Date.parse(weeks[0]!.week) : 0;
  const rowAt = (iso: string) => weeks[Math.floor((startOfWeek(Date.parse(iso)) - first) / MS_PER_WEEK)];
  for (const d of releases(deploys)) {
    const row = rowAt(d.readyAt!);
    if (row) row.deploys++;
  }
  for (const i of incidents) {
    const row = rowAt(i.createdAt);
    if (row) row.incidents++;
  }
  for (const c of changes) {
    if (c.remedial) continue;
    const row = rowAt(c.mergedAt);
    if (!row) continue;
    for (const key of [c.authorClass, ALL_CLASSES] as const) {
      row.merged[key]++;
      if (c.durable === true) row.durable[key]++;
    }
  }
  return weeks;
}

/** Stats per AI tool, busiest first. */
export function toolStats(changes: ChangeRecord[], p: Period, now: Date): ToolRow[] {
  const tools = [...new Set(changes.flatMap((c) => (c.tool ? [c.tool] : [])))];
  return tools
    .map((tool) => ({ tool, stats: classStats(changes.filter((c) => c.tool === tool), [], p, now) }))
    .sort((a, b) => b.stats.merged - a.stats.merged || a.tool.localeCompare(b.tool));
}

/** The latest full matured stretch of `days`, and the one before it if the data reaches back that far. */
export function comparison(changes: ChangeRecord[], p: Period, now: Date, days: number): Comparison | null {
  const span = days * MS_PER_DAY;
  const stretch = (end: number) => {
    const start = end - span;
    const sp: Period = { start, maturedUntil: end, maturedWeeks: span / MS_PER_WEEK, windowMs: p.windowMs };
    const landed = changes.filter((c) => Date.parse(c.mergedAt) > start && Date.parse(c.mergedAt) <= end);
    return statsByClass(landed, [], sp, now);
  };
  if (p.maturedUntil - span < p.start) return null;
  return {
    days,
    until: new Date(p.maturedUntil).toISOString(),
    current: stretch(p.maturedUntil),
    previous: p.maturedUntil - 2 * span >= p.start ? stretch(p.maturedUntil - span) : null,
  };
}

/** Who fixed whom: rework inside the window, by the class of the fixed and the fixing change. */
export function fixMatrix(changes: ChangeRecord[], p: Period): FixMatrix {
  const scoped = (c: ChangeRecord, k: string) => `${c.repo ?? ''}\n${k}`;
  const byRef = new Map<string, ChangeRecord>();
  for (const c of changes) {
    if (c.number !== null) byRef.set(scoped(c, `${ReworkSourceKind.Pr}:${c.number}`), c);
    if (c.oid) byRef.set(scoped(c, `${ReworkSourceKind.Commit}:${c.oid}`), c);
    // Snapshots from before 0.3 have no commit oid, only the short SHA as the id.
    if (c.kind === ChangeKind.Commit) byRef.set(scoped(c, `${ReworkSourceKind.Commit}:${c.id}`), c);
  }
  const fixer = (c: ChangeRecord, e: ReworkEvent): FixerKey => {
    const from = e.from;
    if (!from) return FIXER_OUTSIDE;
    if (from.kind === ReworkSourceKind.Issue || from.kind === ReworkSourceKind.Incident) return FIXER_ISSUE;
    const key = from.kind === ReworkSourceKind.Pr ? `${from.kind}:${from.number}` : `${from.kind}:${from.oid}`;
    const short = from.kind === ReworkSourceKind.Commit ? byRef.get(scoped(c, `${from.kind}:${shortSha(from.oid)}`)) : undefined;
    return (byRef.get(scoped(c, key)) ?? short)?.authorClass ?? FIXER_OUTSIDE;
  };
  const matrix = perClass(() => counts(FIXER_KEYS));
  for (const c of changes) for (const e of inWindow(c, p)) matrix[c.authorClass][fixer(c, e)]++;
  return matrix;
}

/** The first `depth` directories of a path; files at the top level group under ".". */
export function dirOf(path: string, depth: number): string {
  return path.split('/').slice(0, -1).slice(0, depth).join('/') || '.';
}

/** Directories that lost the most added lines by the end of the window. */
export function hotspots(changes: ChangeRecord[], p: Period, depth: number): Hotspot[] {
  const dirs = new Map<string, Hotspot>();
  for (const c of maturedOf(changes, p).filter(isMeasured)) {
    for (const f of c.durability.files ?? []) {
      const dir = dirOf(f.path, depth);
      let h = dirs.get(dir);
      if (!h) dirs.set(dir, (h = { dir, baseline: 0, lost: 0, byClass: perClass(() => ({ baseline: 0, lost: 0 })) }));
      const lost = f.baseline - f.surviving;
      h.baseline += f.baseline;
      h.lost += lost;
      h.byClass[c.authorClass].baseline += f.baseline;
      h.byClass[c.authorClass].lost += lost;
    }
  }
  return [...dirs.values()].filter((h) => h.lost > 0).sort((a, b) => b.lost - a.lost).slice(0, MAX_HOTSPOTS);
}

/**
 * Share of lines left at each checkpoint and at the end of the window, per class, over
 * matured changes measured at every checkpoint (so each point covers the same changes).
 */
export function survivalCurve(changes: ChangeRecord[], p: Period, windowDays: number): CurveRow[] {
  const measured = maturedOf(changes, p).filter(isMeasured);
  const days = [...new Set(measured.flatMap((c) => (c.durability.curve ?? []).map((pt) => pt.days)))].sort((a, b) => a - b);
  if (!days.length) return [];
  const complete = measured.filter((c) => days.every((d) => c.durability.curve?.some((pt) => pt.days === d && pt.surviving !== null)));
  const at = (c: ChangeRecord, d: number) => (d === windowDays ? c.durability.surviving : c.durability.curve!.find((pt) => pt.days === d)!.surviving!);
  return [0, ...days, windowDays].map((d) => ({
    days: d,
    kept: Object.fromEntries(
      CLASS_KEYS.map((key) => {
        const set = complete.filter(inClass(key));
        const base = set.reduce((s, c) => s + c.durability.baseline, 0);
        return [key, base ? (d === 0 ? 1 : set.reduce((s, c) => s + at(c, d), 0) / base) : null];
      }),
    ) as Record<ClassKey, number | null>,
  }));
}

/** How many changes of each class each signal decided. */
export function classSources(changes: ChangeRecord[]): Record<AuthorClass, Record<ClassSource, number>> {
  const out = perClass(() => counts(CLASS_SOURCES));
  for (const c of changes) out[c.authorClass][c.classSource]++;
  return out;
}

/** Open PRs awaiting review, bucketed by how long they've waited. */
export function queueAges(openPrs: OpenPrRecord[], now: Date): QueueAgeBucket[] {
  const buckets: QueueAgeBucket[] = [...QUEUE_AGE_BOUNDS_DAYS, null].map((maxDays) => ({ maxDays, counts: perClass(() => 0) }));
  for (const o of openPrs.filter((x) => x.awaitingFirstReview)) {
    const days = (now.getTime() - Date.parse(o.createdAt)) / MS_PER_DAY;
    const bucket = buckets.find((b) => b.maxDays === null || days < b.maxDays)!;
    bucket.counts[o.authorClass]++;
  }
  return buckets;
}

/** Why a change wasn't durable: rework kinds inside the window, then rewritten lines. */
export function failureReasons(c: ChangeRecord, p: Period, threshold: number, minLines: number): FailureReason[] {
  const kinds = new Set(inWindow(c, p).map((e) => e.kind));
  const reasons: FailureReason[] = Object.values(ReworkKind).filter((k) => kinds.has(k));
  const d = c.durability;
  if (d.status === DurabilityStatus.Measured && d.baseline >= minLines && d.surviving / d.baseline < threshold) reasons.push(FailureReason.Churned);
  return reasons;
}

/**
 * Deployment frequency, failure and restore times. A deployment counts as failed when an
 * incident opened within `attributionHours` after it went live (and before the next one did).
 */
export function deliveryStats(snap: Snapshot, p: Period, now: Date, attributionHours: number): DeliveryStats | null {
  if (!snap.deployments && !snap.incidents) return null;
  const inPeriod = (iso: string) => Date.parse(iso) >= p.start && Date.parse(iso) <= now.getTime();
  const live = releases(snap.deployments ?? []);
  const deploys = live.filter((d) => inPeriod(d.readyAt!));
  const incidents = (snap.incidents ?? []).filter((i) => inPeriod(i.createdAt));
  const weeks = (now.getTime() - p.start) / MS_PER_WEEK;
  const hit = new Set<Deployment>();
  for (const i of incidents) {
    const at = Date.parse(i.createdAt);
    // The deployment that was live when the incident opened, if it went live recently enough.
    const cause = live.filter((d) => Date.parse(d.readyAt!) <= at).at(-1);
    if (cause && at - Date.parse(cause.readyAt!) <= attributionHours * MS_PER_HOUR) hit.add(cause);
  }
  const bySource: Partial<Record<IncidentSource, number>> = {};
  for (const i of incidents) bySource[i.source] = (bySource[i.source] ?? 0) + 1;
  const linked = new Set(snap.changes.flatMap((c) => c.rework.flatMap((e) => (e.from?.kind === ReworkSourceKind.Incident ? [incidentKey(e.from.source, e.from.id)] : []))));
  const restore = incidents.filter((i) => i.resolvedAt).map((i) => (Date.parse(i.resolvedAt!) - Date.parse(i.createdAt)) / MS_PER_HOUR);
  const tracked = !!snap.incidents;
  const withIncident = deploys.filter((d) => hit.has(d)).length;
  return {
    deploySource: snap.deployments?.[0]?.source ?? null,
    environments: [...new Set((snap.deployments ?? []).map((d) => d.environment))].sort(),
    deploys: deploys.length,
    deploysPerWeek: snap.deployments && weeks >= MIN_WEEKS_FOR_RATE ? deploys.length / weeks : null,
    failedDeploys: (snap.deployments ?? []).filter((d) => d.status === DeployStatus.Failure && inPeriod(d.createdAt)).length,
    undeployed: snap.deployments ? snap.changes.filter((c) => !c.deployedAt).length : 0,
    incidents: tracked ? incidents.length : null,
    incidentsBySource: bySource,
    linkedIncidents: incidents.filter((i) => linked.has(incidentKey(i.source, i.id))).length,
    deploysWithIncident: tracked && snap.deployments ? withIncident : null,
    deployFailureRate: tracked && deploys.length ? withIncident / deploys.length : null,
    timeToRestoreP50Hours: median(restore),
    attributionHours,
  };
}

/** Thousand, for spend per thousand lines. */
const PER_THOUSAND = 1000;

/**
 * AI spend over the matured period against the durable agent and assisted changes that
 * landed in it, overall and per tool. Spend after the matured period is reported apart,
 * since its changes don't have a verdict yet.
 */
export function costStats(costs: CostEntry[] | undefined, changes: ChangeRecord[], p: Period): CostStats | null {
  if (!costs) return null;
  const from = isoDate(new Date(p.start).toISOString());
  const until = isoDate(new Date(p.maturedUntil).toISOString());
  const counted = costs.filter((e) => e.date >= from && e.date <= until);
  const aiDurable = maturedOf(changes, p).filter((c) => c.durable && c.authorClass !== AuthorClass.Human);
  const aiMeasured = maturedOf(changes, p).filter((c) => c.authorClass !== AuthorClass.Human && isMeasured(c));
  const usd = counted.reduce((n, e) => n + e.usd, 0);
  const surviving = aiMeasured.reduce((n, c) => n + c.durability.surviving, 0);
  const tools = [...new Set([...counted.map((e) => e.tool), ...aiDurable.flatMap((c) => (c.tool ? [c.tool] : []))])];
  const byTool = tools
    .map((tool): ToolCost => {
      const spent = counted.filter((e) => e.tool === tool).reduce((n, e) => n + e.usd, 0);
      const durable = aiDurable.filter((c) => c.tool === tool).length;
      return { tool, usd: spent, durable, perDurableChange: durable && spent ? spent / durable : null };
    })
    .filter((t) => t.usd > 0)
    .sort((a, b) => b.usd - a.usd);
  return {
    from,
    until,
    usd,
    durable: aiDurable.length,
    perDurableChange: aiDurable.length && usd ? usd / aiDurable.length : null,
    perThousandSurvivingLines: surviving && usd ? (usd / surviving) * PER_THOUSAND : null,
    byTool,
    actors: new Set(counted.flatMap((e) => (e.actor ? [e.actor] : []))).size,
    maturingUsd: costs.filter((e) => e.date > until).reduce((n, e) => n + e.usd, 0),
  };
}

/** Settings the report uses that aren't recorded in the snapshot. */
export interface ReportOptions {
  compareDays: number;
  hotspotDepth: number;
  /** Hours after a deployment in which an incident counts against it. */
  attributionHours: number;
}

export function aggregate(snap: Snapshot, now: Date = new Date(snap.collectedAt), options: Partial<ReportOptions> = {}): Report {
  const { compareDays = DEFAULT_CONFIG.compareDays, hotspotDepth = DEFAULT_CONFIG.hotspotDepth, attributionHours = DEFAULT_CONFIG.incidents.attributionHours } = options;
  const minLines = snap.minSurvivalLines ?? DEFAULT_CONFIG.minSurvivalLines;
  const p = period(snap, now);
  return {
    repo: snap.repo,
    ...(snap.repos ? { repos: snap.repos } : {}),
    defaultBranch: snap.defaultBranch,
    branch: snap.branch,
    unit: snap.unit,
    notes: snap.notes,
    generatedAt: new Date().toISOString(),
    collectedAt: snap.collectedAt,
    since: snap.since,
    windowDays: snap.windowDays,
    survivalThreshold: snap.survivalThreshold,
    minSurvivalLines: minLines,
    maturedWeeks: p.maturedWeeks,
    stats: statsByClass(snap.changes, snap.openPrs, p, now),
    tools: toolStats(snap.changes, p, now),
    comparison: comparison(snap.changes, p, now, compareDays),
    fixes: fixMatrix(snap.changes, p),
    hotspots: hotspots(snap.changes, p, hotspotDepth),
    survivalCurve: survivalCurve(snap.changes, p, snap.windowDays),
    classSources: classSources(snap.changes),
    queueAges: queueAges(snap.openPrs, now),
    delivery: deliveryStats(snap, p, now, attributionHours),
    cost: costStats(snap.costs, snap.changes, p),
    incidents: snap.incidents ?? [],
    weeks: weeklySeries(snap.changes, p, now, snap.deployments, snap.incidents),
    changes: [...snap.changes]
      .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))
      .map((c) => ({ ...c, status: changeStatus(c), failureReasons: failureReasons(c, p, snap.survivalThreshold, minLines) })),
    openPrs: snap.openPrs,
  };
}
