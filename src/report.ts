/**
 * Report formatting and wording shared by the markdown summary (here) and the
 * HTML dashboard (`report-html.ts`).
 */
import {
  ALL_CLASSES,
  CHANGE_STATUS_NAMES,
  CLASS_KEYS,
  CLASS_NAMES,
  DurabilityStatus,
  FAILURE_REASON_NAMES,
  HOURS_PER_DAY,
  isoDate,
  MINUTES_PER_HOUR,
  REVIEW_DEPTH_NAMES,
  TOOL_NAME,
  UNAVAILABLE_REASON_NAMES,
  Unit,
} from './constants.js';
import type { ClassStats, Report, ReportedChange } from './metrics.js';

/** Shown wherever a value can't be computed yet. */
export const EMPTY_VALUE = '—';

const PERCENT = 100;
/** Durations under this many hours read better in hours than in days. */
const SHOW_DAYS_AFTER_HOURS = 48;
export const pct = (x: number | null) => (x === null ? EMPTY_VALUE : `${Math.round(x * PERCENT)}%`);
/** Dollars below this show cents. */
const SHOW_CENTS_BELOW = 100;
export const usd = (x: number | null) =>
  x === null ? EMPTY_VALUE : `$${x < SHOW_CENTS_BELOW ? x.toFixed(2) : Math.round(x).toLocaleString('en-US')}`;
export const num = (x: number | null, digits = 1) => (x === null ? EMPTY_VALUE : x.toFixed(digits).replace(/\.0+$/, ''));
export const duration = (hours: number | null) => {
  if (hours === null) return EMPTY_VALUE;
  if (hours < 1) return `${Math.round(hours * MINUTES_PER_HOUR)}m`;
  if (hours < SHOW_DAYS_AFTER_HOURS) return `${num(hours)}h`;
  return `${num(hours / HOURS_PER_DAY)}d`;
};

// ---- Wording that depends on the unit ------------------------------------------

export interface Nouns {
  /** "PR" or "commit", mid-sentence */
  singular: string;
  /** "PRs" or "commits" */
  plural: string;
  /** Row label for the count */
  count: string;
  /** Section heading for the change list */
  heading: string;
  /** Table column heading for a change */
  column: string;
  /** Table column heading for when it landed */
  date: string;
  /** "merging" or "landing" */
  landing: string;
  /** Row label for the size metric */
  size: string;
}

export function nouns(unit: Report['unit']): Nouns {
  return unit === Unit.Commits
    ? { singular: 'commit', plural: 'commits', count: 'Commits', heading: 'Commits', column: 'Commit', date: 'Landed', landing: 'landing', size: 'Commit size (p50)' }
    : { singular: 'PR', plural: 'PRs', count: 'Merged PRs', heading: 'Pull requests', column: 'PR', date: 'Merged', landing: 'merging', size: 'PR size (p50)' };
}

interface Row {
  label: string;
  hint: string;
  value: (s: ClassStats) => string;
}

export function rows(r: Report): Row[] {
  const n = nouns(r.unit);
  return [
    { label: n.count, hint: `${n.count} on ${r.branch} in the period`, value: (s) => String(s.merged) },
    { label: 'Fixes and reverts', hint: `${n.count} that revert or fix earlier ones; left out of every durability metric`, value: (s) => String(s.remedial) },
    { label: `Durable ${n.plural} / week`, hint: `Matured ${n.plural} that were not reverted or reworked and kept enough of their lines`, value: (s) => num(s.durablePerWeek) },
    { label: 'Surviving lines / week', hint: `Added lines from matured ${n.plural} still there after ${r.windowDays} days`, value: (s) => num(s.survivingLinesPerWeek, 0) },
    { label: 'Durable rate', hint: `Share of matured ${n.plural} that were durable`, value: (s) => pct(s.durableRate) },
    { label: 'Line churn', hint: 'Share of all added lines gone by the end of the window (big changes weigh more)', value: (s) => pct(s.churn) },
    { label: 'Lines kept (p50)', hint: `Median share of a ${n.singular}'s lines kept by the end of the window (every change weighs the same)`, value: (s) => pct(s.keptP50) },
    { label: 'Change failure rate', hint: `Matured ${n.plural} reverted, reworked or blamed for a bug within the window`, value: (s) => pct(s.changeFailureRate) },
    { label: 'Failing early', hint: `${n.count} still inside the window that were already reverted or reworked`, value: (s) => String(s.failingEarly) },
    { label: 'Lead time (p50)', hint: `First commit to ${r.unit === Unit.Prs ? 'merge' : 'landing on the branch'}`, value: (s) => duration(s.leadTimeP50Hours) },
    ...(r.unit === Unit.Prs ? [{ label: 'Time to first review (p50)', hint: 'PR opened to first review by a person other than the author (AI review bots excluded)', value: (s: ClassStats) => duration(s.reviewWaitP50Hours) }] : []),
    ...(r.unit === Unit.Prs ? [{ label: 'Rubber-stamped', hint: 'PRs merged with no human review, or a human approval with nothing written', value: (s: ClassStats) => pct(s.rubberStampRate) }] : []),
    ...(r.delivery?.deploySource
      ? [{ label: 'Lead time to production (p50)', hint: `First commit to the first production deployment containing the ${n.singular}`, value: (s: ClassStats) => duration(s.deployLeadTimeP50Hours) }]
      : []),
    ...(r.delivery?.incidents !== null && r.delivery?.incidents !== undefined
      ? [{ label: 'Escaped defects', hint: `${n.count} an incident or production bug named as its cause`, value: (s: ClassStats) => String(s.escapedDefects) }]
      : []),
    { label: n.size, hint: 'Lines added plus deleted, excluding ignored files', value: (s) => num(s.sizeP50, 0) },
    { label: 'Open PRs awaiting review', hint: 'Non-draft open PRs no person has reviewed yet', value: (s) => String(s.awaitingReview) },
    { label: 'Not measurable', hint: `${n.count} whose durability couldn't be measured, e.g. missing history`, value: (s) => String(s.unknown) },
  ];
}

/** Why most numbers are empty, if they are. */
export function emptyReason(r: Report): string | null {
  const all = r.stats[ALL_CLASSES];
  const n = nouns(r.unit);
  if (all.merged === 0) return `No ${n.plural} on ${r.branch} since ${isoDate(r.since)}.`;
  if (all.matured > 0) return null;
  return `Not enough history yet: ${n.plural} need ${r.windowDays} days after ${n.landing} before they count toward durability.`;
}

/** The headline metrics compared between the latest matured stretch and the one before. */
export const COMPARED: { label: string; field: keyof ClassStats; format: (x: number | null) => string; higherIsBetter: boolean }[] = [
  { label: 'Durable rate', field: 'durableRate', format: pct, higherIsBetter: true },
  { label: 'Change failure rate', field: 'changeFailureRate', format: pct, higherIsBetter: false },
  { label: 'Line churn', field: 'churn', format: pct, higherIsBetter: false },
  { label: 'Lead time (p50)', field: 'leadTimeP50Hours', format: duration, higherIsBetter: false },
];

/** The value of a compared stat, or null if it's missing or not a number. */
export const statValue = (s: ClassStats | undefined, field: keyof ClassStats) => {
  const v = s?.[field];
  return typeof v === 'number' ? v : null;
};

export function subtitle(r: Report): string {
  return `${r.branch} · counting ${nouns(r.unit).plural} · since ${isoDate(r.since)} · durability window ${r.windowDays} days · survival threshold ${pct(r.survivalThreshold)}`;
}

// ---- Markdown -------------------------------------------------------------------

export function renderMarkdown(r: Report): string {
  const lines = [
    `## ${TOOL_NAME}: ${r.repo}`,
    '',
    subtitle(r),
    '',
    ...r.notes.flatMap((note) => [`> ${note}`, '']),
    `| Metric | ${CLASS_KEYS.map((k) => CLASS_NAMES[k]).join(' | ')} |`,
    `|---|${CLASS_KEYS.map(() => '--:').join('|')}|`,
    ...rows(r).map((row) => `| ${row.label} | ${CLASS_KEYS.map((k) => row.value(r.stats[k])).join(' | ')} |`),
    '',
  ];
  const empty = emptyReason(r);
  if (empty) lines.push(`> ${empty}`, '');

  const cmp = r.comparison;
  if (cmp?.previous) {
    lines.push(`### Last ${cmp.days} matured days vs the ${cmp.days} before`, '', `| Metric | ${CLASS_KEYS.map((k) => CLASS_NAMES[k]).join(' | ')} |`, `|---|${CLASS_KEYS.map(() => '--:').join('|')}|`);
    for (const m of COMPARED) {
      const cell = (k: (typeof CLASS_KEYS)[number]) => `${m.format(statValue(cmp.previous![k], m.field))} → ${m.format(statValue(cmp.current[k], m.field))}`;
      lines.push(`| ${m.label} | ${CLASS_KEYS.map(cell).join(' | ')} |`);
    }
    lines.push('');
  }

  const d = r.delivery;
  if (d) {
    lines.push('### Delivery', '', '| Measure | Value |', '|---|--:|');
    if (d.deploySource) {
      lines.push(`| Production deploys / week | ${num(d.deploysPerWeek)} |`, `| Lead time to production (p50) | ${duration(r.stats[ALL_CLASSES].deployLeadTimeP50Hours)} |`);
    }
    if (d.incidents !== null) {
      lines.push(`| Incidents | ${d.incidents} |`, `| Deploys followed by an incident | ${pct(d.deployFailureRate)} |`, `| Time to restore (p50) | ${duration(d.timeToRestoreP50Hours)} |`);
    }
    lines.push('');
  }

  const c = r.cost;
  if (c) {
    lines.push(`### AI spend, ${c.from} to ${c.until}`, '', '| Tool | Spend | Durable changes | Per durable change |', '|---|--:|--:|--:|');
    for (const t of c.byTool) lines.push(`| ${t.tool} | ${usd(t.usd)} | ${t.durable} | ${usd(t.perDurableChange)} |`);
    lines.push(`| **All** | **${usd(c.usd)}** | **${c.durable}** | **${usd(c.perDurableChange)}** |`, '');
  }

  if (r.tools.length) {
    const n = nouns(r.unit);
    lines.push('### By tool', '', `| Tool | ${n.count} | Durable rate | Line churn | Change failure rate |`, '|---|--:|--:|--:|--:|');
    for (const t of r.tools) lines.push(`| ${t.tool} | ${t.stats.merged} | ${pct(t.stats.durableRate)} | ${pct(t.stats.churn)} | ${pct(t.stats.changeFailureRate)} |`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---- CSV -------------------------------------------------------------------------

/** Separates several values inside one CSV cell. */
const CSV_LIST_SEP = '; ';
const CSV_NEEDS_QUOTES = /[",\r\n]/;

const csvCell = (v: string | number | boolean | null | undefined) => {
  const s = v === null || v === undefined ? '' : String(v);
  return CSV_NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The change table's columns, for spreadsheets and other tools. */
const CSV_COLUMNS: { header: string; value: (c: ReportedChange) => string | number | boolean | null | undefined }[] = [
  { header: 'repo', value: (c) => c.repo },
  { header: 'kind', value: (c) => c.kind },
  { header: 'id', value: (c) => c.id },
  { header: 'title', value: (c) => c.title },
  { header: 'url', value: (c) => c.url },
  { header: 'author', value: (c) => c.author },
  { header: 'author_class', value: (c) => c.authorClass },
  { header: 'tool', value: (c) => c.tool },
  { header: 'class_source', value: (c) => c.classSource },
  { header: 'class_reason', value: (c) => c.classReason },
  { header: 'merged_at', value: (c) => c.mergedAt },
  { header: 'lead_time_hours', value: (c) => c.leadTimeHours },
  { header: 'review_wait_hours', value: (c) => c.reviewWaitHours },
  { header: 'review_depth', value: (c) => (c.reviewDepth ? REVIEW_DEPTH_NAMES[c.reviewDepth] : null) },
  { header: 'size', value: (c) => c.size },
  { header: 'lines_added', value: (c) => (c.durability.status === DurabilityStatus.Measured ? c.durability.baseline : null) },
  { header: 'lines_kept', value: (c) => (c.durability.status === DurabilityStatus.Measured ? c.durability.surviving : null) },
  { header: 'status', value: (c) => CHANGE_STATUS_NAMES[c.status] },
  { header: 'failure_reasons', value: (c) => c.failureReasons.map((f) => FAILURE_REASON_NAMES[f]).join(CSV_LIST_SEP) },
  { header: 'not_measured_because', value: (c) => (c.durability.reason ? UNAVAILABLE_REASON_NAMES[c.durability.reason] : null) },
  { header: 'rework', value: (c) => c.rework.map((e) => `${e.kind} ${e.source}`).join(CSV_LIST_SEP) },
];

export const CSV_HEADER = CSV_COLUMNS.map((col) => col.header).join(',');
export const csvRow = (c: ReportedChange) => CSV_COLUMNS.map((col) => csvCell(col.value(c))).join(',');

export function renderCsv(r: Report): string {
  return [CSV_HEADER, ...r.changes.map(csvRow)].join('\n') + '\n';
}

/** Escapes text for HTML. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
