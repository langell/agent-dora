/**
 * Report formatting and wording shared by the markdown summary (here) and the
 * HTML dashboard (`report-html.ts`).
 */
import { ALL_CLASSES, CLASS_KEYS, CLASS_NAMES, isoDate, TOOL_NAME, Unit } from './constants.js';
import type { ClassStats, Report } from './metrics.js';

/** Shown wherever a value can't be computed yet. */
export const EMPTY_VALUE = '—';

const PERCENT = 100;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
/** Durations under this many hours read better in hours than in days. */
const SHOW_DAYS_AFTER_HOURS = 48;
export const pct = (x: number | null) => (x === null ? EMPTY_VALUE : `${Math.round(x * PERCENT)}%`);
export const num = (x: number | null, digits = 1) => (x === null ? EMPTY_VALUE : x.toFixed(digits).replace(/\.0+$/, ''));
export const duration = (hours: number | null) => {
  if (hours === null) return EMPTY_VALUE;
  if (hours < 1) return `${Math.round(hours * MINUTES_PER_HOUR)}m`;
  if (hours < SHOW_DAYS_AFTER_HOURS) return `${num(hours)}h`;
  return `${num(hours / HOURS_PER_DAY)}d`;
};

// ---- Wording that depends on the unit ------------------------------------------

export interface Nouns {
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
    ? { plural: 'commits', count: 'Commits', heading: 'Commits', column: 'Commit', date: 'Landed', landing: 'landing', size: 'Commit size (p50)' }
    : { plural: 'PRs', count: 'Merged PRs', heading: 'Pull requests', column: 'PR', date: 'Merged', landing: 'merging', size: 'PR size (p50)' };
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
    { label: `Durable ${n.plural} / week`, hint: `Matured ${n.plural} that were not reverted or reworked and kept enough of their lines`, value: (s) => num(s.durablePerWeek) },
    { label: 'Durable rate', hint: `Share of matured ${n.plural} that were durable`, value: (s) => pct(s.durableRate) },
    { label: 'Line churn', hint: 'Share of added lines gone by the end of the window', value: (s) => pct(s.churn) },
    { label: 'Change failure rate', hint: `Matured ${n.plural} reverted, reworked or blamed for a bug within the window`, value: (s) => pct(s.changeFailureRate) },
    { label: 'Lead time (p50)', hint: `First commit to ${r.unit === Unit.Prs ? 'merge' : 'landing on the branch'}`, value: (s) => duration(s.leadTimeP50Hours) },
    ...(r.unit === Unit.Prs ? [{ label: 'Time to first review (p50)', hint: 'PR opened to first review by someone else', value: (s: ClassStats) => duration(s.reviewWaitP50Hours) }] : []),
    { label: n.size, hint: 'Lines added plus deleted', value: (s) => num(s.sizeP50, 0) },
    { label: 'Open PRs awaiting review', hint: 'Non-draft open PRs with no review yet', value: (s) => String(s.awaitingReview) },
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
  return lines.join('\n');
}

/** Escapes text for HTML. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
