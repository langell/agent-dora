import {
  ALL_CLASSES,
  AUTHOR_CLASSES,
  CHANGE_STATUS_NAMES,
  CLASS_KEYS,
  CLASS_NAMES,
  ChangeStatus,
  DurabilityStatus,
  isoDate,
  isoMinute,
  MS_PER_HOUR,
  TOOL_NAME,
  Unit,
  AuthorClass,
} from './constants.js';
import type { ClassStats, Report } from './metrics.js';

/** Shown wherever a value can't be computed yet. */
export const EMPTY_VALUE = '—';

const PERCENT = 100;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
/** Durations under this many hours read better in hours than in days. */
const SHOW_DAYS_AFTER_HOURS = 48;
/** The dashboard's change table renders at most this many rows. */
const MAX_TABLE_ROWS = 500;
const MAX_QUEUE_ROWS = 25;

const pct = (x: number | null) => (x === null ? EMPTY_VALUE : `${Math.round(x * PERCENT)}%`);
const num = (x: number | null, digits = 1) => (x === null ? EMPTY_VALUE : x.toFixed(digits).replace(/\.0+$/, ''));
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
function emptyReason(r: Report): string | null {
  const all = r.stats[ALL_CLASSES];
  const n = nouns(r.unit);
  if (all.merged === 0) return `No ${n.plural} on ${r.branch} since ${isoDate(r.since)}.`;
  if (all.matured > 0) return null;
  return `Not enough history yet: ${n.plural} need ${r.windowDays} days after ${n.landing} before they count toward durability.`;
}

function subtitle(r: Report): string {
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

// ---- HTML -----------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Element ids shared by the page markup and the client script. */
const Ids = {
  Data: 'report-data',
  Legend: 'legend',
  Weekly: 'weekly',
  Changes: 'changes',
  ChangeCount: 'change-count',
  FilterClass: 'filter-class',
  FilterStatus: 'filter-status',
} as const;

/** Design tokens, emitted as CSS custom properties. Series colors are validated for colorblind safety. */
const THEME = {
  light: {
    page: '#f9f9f7', surface: '#fcfcfb', ink: '#0b0b0b', 'ink-2': '#52514e', muted: '#898781',
    grid: '#e1e0d9', axis: '#c3c2b7', border: 'rgba(11,11,11,0.10)', wash: 'rgba(11,11,11,0.04)',
    good: '#006300', critical: '#d03b3b',
  },
  dark: {
    page: '#0d0d0d', surface: '#1a1a19', ink: '#ffffff', 'ink-2': '#c3c2b7', muted: '#898781',
    grid: '#2c2c2a', axis: '#383835', border: 'rgba(255,255,255,0.10)', wash: 'rgba(255,255,255,0.05)',
    good: '#0ca30c', critical: '#e66767',
  },
} as const;

const SERIES_COLORS: Record<AuthorClass, { light: string; dark: string }> = {
  [AuthorClass.Agent]: { light: '#2a78d6', dark: '#3987e5' },
  [AuthorClass.Assisted]: { light: '#eb6834', dark: '#d95926' },
  [AuthorClass.Human]: { light: '#1baf7a', dark: '#199e70' },
};

/** CSS custom property holding an author class's series color. */
const seriesVar = (c: AuthorClass) => `--series-${c}`;

function cssVars(mode: keyof typeof THEME): string {
  const tokens = Object.entries(THEME[mode]).map(([k, v]) => `--${k}: ${v};`);
  const series = AUTHOR_CLASSES.map((c) => `${seriesVar(c)}: ${SERIES_COLORS[c][mode]};`);
  return [`color-scheme: ${mode};`, ...tokens, ...series].join(' ');
}

/** How each change status is drawn. */
const STATUS_STYLE: Record<ChangeStatus, { icon: string; className: string }> = {
  [ChangeStatus.Durable]: { icon: '✓', className: 'status-good' },
  [ChangeStatus.Failed]: { icon: '✕', className: 'status-bad' },
  [ChangeStatus.Pending]: { icon: '◷', className: 'hint' },
  [ChangeStatus.Unknown]: { icon: '?', className: 'hint' },
};

/** The per-author bar charts: which stat each plots, and its tooltip detail per class. */
function barCharts(r: Report) {
  const n = nouns(r.unit);
  const detail = (f: (s: ClassStats) => string) => Object.fromEntries(AUTHOR_CLASSES.map((c) => [c, f(r.stats[c])]));
  return [
    { id: 'bar-durable', title: 'Durable rate', note: 'Higher is better.', field: 'durableRate', detail: detail((s) => `${s.durable} of ${s.matured} matured ${n.plural}`) },
    { id: 'bar-churn', title: 'Line churn', note: 'Lower is better.', field: 'churn', detail: detail(() => `of added lines gone after ${r.windowDays} days`) },
    { id: 'bar-cfr', title: 'Change failure rate', note: 'Lower is better.', field: 'changeFailureRate', detail: detail((s) => `${s.reverts} reverted`) },
  ] satisfies { id: string; title: string; note: string; field: keyof ClassStats; detail: Record<string, string> }[];
}

function selectOptions(values: readonly string[], names: Record<string, string>): string {
  return [`<option value="">${CLASS_NAMES[ALL_CLASSES]}</option>`, ...values.map((v) => `<option value="${v}">${esc(names[v]!)}</option>`)].join('');
}

function swatch(c: AuthorClass): string {
  return `<span class="swatch" style="background:var(${seriesVar(c)})"></span>`;
}

function reviewQueue(r: Report): string {
  const waiting = r.openPrs
    .filter((p) => p.awaitingFirstReview)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, MAX_QUEUE_ROWS);
  if (!waiting.length) return '<tr><td class="hint">Nothing waiting.</td></tr>';
  const age = (iso: string) => duration((Date.parse(r.collectedAt) - Date.parse(iso)) / MS_PER_HOUR);
  return `<thead><tr><th>PR</th><th>Author</th><th class="n">Waiting</th></tr></thead><tbody>${waiting
    .map((p) => `<tr><td><a href="${esc(p.url)}">#${p.number}</a> ${esc(p.title)}</td><td><span class="badge">${swatch(p.authorClass)}${CLASS_NAMES[p.authorClass]}</span></td><td class="n">${age(p.createdAt)}</td></tr>`)
    .join('')}</tbody>`;
}

export function renderHtml(r: Report): string {
  const a = r.stats[ALL_CLASSES];
  const n = nouns(r.unit);
  const bars = barCharts(r);
  const ui = {
    ids: Ids,
    classes: AUTHOR_CLASSES,
    classNames: CLASS_NAMES,
    seriesVars: Object.fromEntries(AUTHOR_CLASSES.map((c) => [c, `var(${seriesVar(c)})`])),
    statusNames: CHANGE_STATUS_NAMES,
    statusStyle: STATUS_STYLE,
    measured: DurabilityStatus.Measured,
    nouns: n,
    empty: EMPTY_VALUE,
    maxRows: MAX_TABLE_ROWS,
    bars: bars.map(({ id, field, detail }) => ({ id, field, detail })),
  };
  // Keep the embedded JSON from closing the <script> tag early.
  const payload = JSON.stringify({ report: r, ui }).replace(/</g, '\\u003c');
  const tile = (label: string, value: string, sub: string) =>
    `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div><div class="tile-sub">${esc(sub)}</div></div>`;
  const banners = [...r.notes, ...(emptyReason(r) ? [emptyReason(r)!] : [])];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TOOL_NAME} · ${esc(r.repo)}</title>
<style>
:root { ${cssVars('light')} }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { ${cssVars('dark')} }
}
:root[data-theme="dark"] { ${cssVars('dark')} }
${STYLES}
</style>
</head>
<body>
<main>
<header>
  <div class="eyebrow">${TOOL_NAME}</div>
  <h1>${esc(r.repo)}</h1>
  <div class="meta">${esc(subtitle(r))} · collected ${isoMinute(r.collectedAt)} UTC</div>
</header>

${banners.map((b) => `<div class="banner">${esc(b)}</div>`).join('\n')}

<div class="tiles">
  ${tile(`Durable ${n.plural} / week`, num(a.durablePerWeek), `${a.durable} of ${a.matured} matured ${n.plural}`)}
  ${tile('Durable rate', pct(a.durableRate), `matured ${n.plural} that held up`)}
  ${tile('Line churn', pct(a.churn), `added lines gone after ${r.windowDays} days`)}
  ${tile('Change failure rate', pct(a.changeFailureRate), 'reverted, reworked or caused a bug')}
  ${tile('Awaiting review', String(a.awaitingReview), a.awaitingReviewAgeP50Hours === null ? 'open PRs with no review' : `median wait ${duration(a.awaitingReviewAgeP50Hours)}`)}
</div>

<section class="card">
  <h2>Durable ${n.plural} per week</h2>
  <p class="note">Weeks whose ${n.plural} have all passed the ${r.windowDays}-day window. Recent weeks appear once they mature.</p>
  <div class="legend" id="${Ids.Legend}"></div>
  <div class="chart" id="${Ids.Weekly}"></div>
</section>

<section>
  <div class="grid2">
    ${bars.map((b) => `<div class="card"><h2>${b.title}</h2><p class="note">${b.note}</p><div class="chart" id="${b.id}"></div></div>`).join('\n    ')}
  </div>
</section>

<section class="card">
  <h2>By author</h2>
  <p class="note">Agent: opened by a coding agent. Assisted: human-opened, with AI co-authored commits. Human: no AI signal.</p>
  <div class="scroll"><table>
    <thead><tr><th>Metric</th>${CLASS_KEYS.map((k) => `<th class="n">${CLASS_NAMES[k]}</th>`).join('')}</tr></thead>
    <tbody>${rows(r).map((row) => `<tr><td>${esc(row.label)}<div class="hint">${esc(row.hint)}</div></td>${CLASS_KEYS.map((k) => `<td class="n">${esc(row.value(r.stats[k]))}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>
</section>

<section class="card">
  <h2>Review queue</h2>
  <p class="note">Open, non-draft PRs with no review yet, oldest first.</p>
  <div class="scroll"><table>${reviewQueue(r)}</table></div>
</section>

<section class="card">
  <h2>${n.heading}</h2>
  <div class="controls">
    <label>Author <select id="${Ids.FilterClass}">${selectOptions(AUTHOR_CLASSES, CLASS_NAMES)}</select></label>
    <label>Status <select id="${Ids.FilterStatus}">${selectOptions(Object.values(ChangeStatus), CHANGE_STATUS_NAMES)}</select></label>
    <span class="hint" id="${Ids.ChangeCount}"></span>
  </div>
  <div class="scroll"><table id="${Ids.Changes}"></table></div>
</section>

<footer>Generated by ${TOOL_NAME} at ${isoMinute(r.generatedAt)} UTC.</footer>
</main>
<script type="application/json" id="${Ids.Data}">${payload}</script>
<script>
const { report: R, ui: UI } = JSON.parse(document.getElementById(${JSON.stringify(Ids.Data)}).textContent);
${CLIENT_JS}
</script>
</body>
</html>
`;
}

const STYLES = `* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1120px; margin: 0 auto; padding: 32px 16px 64px; }
header .eyebrow { color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
h1 { font-size: 24px; margin: 4px 0; }
h2 { font-size: 16px; margin: 0 0 4px; }
.meta, .note { color: var(--ink-2); font-size: 13px; }
.note { margin: 0 0 16px; }
a { color: inherit; }
section { margin-top: 32px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 24px; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
.tile-label { color: var(--ink-2); font-size: 13px; }
.tile-value { font-size: 32px; font-weight: 600; margin: 4px 0; }
.tile-sub { color: var(--muted); font-size: 12px; }
.banner { margin-top: 24px; padding: 12px 16px; border-radius: 8px; background: var(--wash); border: 1px solid var(--border); color: var(--ink-2); }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.legend { display: flex; gap: 16px; flex-wrap: wrap; margin: 8px 0 12px; color: var(--ink-2); font-size: 13px; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.chart { position: relative; }
.chart svg { display: block; width: 100%; overflow: visible; }
.chart text { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.chart .direct { fill: var(--ink-2); font-size: 12px; }
.tooltip { position: absolute; pointer-events: none; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.12); white-space: nowrap; opacity: 0; transition: opacity .1s; z-index: 2; }
.tooltip .row { display: flex; align-items: center; gap: 6px; justify-content: space-between; }
.tooltip .row b { font-variant-numeric: tabular-nums; margin-left: 12px; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--grid); vertical-align: top; }
th { color: var(--ink-2); font-weight: 600; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
tr:hover td { background: var(--wash); }
.hint { color: var(--muted); font-size: 12px; }
.nw { white-space: nowrap; }
.badge { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.status-good { color: var(--good); }
.status-bad { color: var(--critical); }
.controls { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
select { font: inherit; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--ink); }
footer { margin-top: 48px; color: var(--muted); font-size: 12px; }`;

/**
 * Client-side rendering: charts, hover tooltips and table filters. No dependencies.
 * Everything it shares with the server (ids, class names, wording) comes from `UI`.
 */
const CLIENT_JS = String.raw`
const NS = 'http://www.w3.org/2000/svg';
const PERCENT = 100;
const RESIZE_DEBOUNCE_MS = 150;
// Chart geometry, in px.
const LINE = { height: 260, margin: { t: 12, r: 72, b: 28, l: 36 }, gridLines: 4, minLabelGap: 72, labelNudge: 14, dot: 4 };
const BAR = { rowHeight: 36, barHeight: 20, radius: 4, minWidth: 4, margin: { l: 72, r: 48 }, labelGap: 8 };
const TOOLTIP_OFFSET = { x: 12, y: 8, lineChart: 40 };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
const pct = (x) => (x === null || x === undefined ? UI.empty : Math.round(x * PERCENT) + '%');
const color = (c) => UI.seriesVars[c];
const swatch = (c) => '<span class="swatch" style="background:' + color(c) + '"></span>';
const byId = (id) => document.getElementById(id);

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

function tooltip(host) {
  const t = document.createElement('div');
  t.className = 'tooltip';
  host.appendChild(t);
  return {
    show(html, x, y) {
      t.innerHTML = html;
      t.style.opacity = 1;
      const w = t.offsetWidth, hw = host.clientWidth;
      t.style.left = Math.max(0, Math.min(x + TOOLTIP_OFFSET.x, hw - w)) + 'px';
      t.style.top = Math.max(0, y - t.offsetHeight - TOOLTIP_OFFSET.y) + 'px';
    },
    hide() { t.style.opacity = 0; },
  };
}

/** Smallest "round" number (1, 2, 2.5, 5 x 10^n) at or above v, for the y-axis top. */
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function lineChart(host) {
  const weeks = R.weeks.filter((w) => w.matured);
  byId(UI.ids.Legend).innerHTML = UI.classes.map((c) => '<span>' + swatch(c) + UI.classNames[c] + '</span>').join('');
  if (weeks.length < 2) {
    host.innerHTML = '<p class="hint">Needs at least two matured weeks of history.</p>';
    return;
  }
  const W = host.clientWidth || 800, H = LINE.height, m = LINE.margin;
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = niceMax(Math.max(1, ...weeks.flatMap((w) => UI.classes.map((c) => w.durable[c]))));
  const x = (i) => m.l + (i / (weeks.length - 1)) * iw;
  const y = (v) => m.t + ih - (v / max) * ih;
  const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': 'Durable ' + UI.nouns.plural + ' per week by author' }, host);
  for (let i = 0; i <= LINE.gridLines; i++) {
    const v = (max / LINE.gridLines) * i;
    el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: i ? 'var(--grid)' : 'var(--axis)', 'stroke-width': 1 }, svg);
    el('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, svg).textContent = Math.round(v * 10) / 10;
  }
  const step = Math.max(1, Math.ceil(weeks.length / Math.max(2, Math.floor(iw / LINE.minLabelGap))));
  weeks.forEach((w, i) => {
    // "MM-DD" of the week's Monday.
    if (i % step === 0) el('text', { x: x(i), y: H - 8, 'text-anchor': 'middle' }, svg).textContent = w.week.slice('YYYY-'.length);
  });
  const ends = [];
  for (const c of UI.classes) {
    const d = weeks.map((w, i) => (i ? 'L' : 'M') + x(i) + ' ' + y(w.durable[c])).join(' ');
    el('path', { d, fill: 'none', stroke: color(c), 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    ends.push({ c, y: y(weeks[weeks.length - 1].durable[c]) });
  }
  // Direct labels at line ends, nudged apart so they never overlap.
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + LINE.labelNudge);
  for (const e of ends) el('text', { x: W - m.r + 8, y: e.y + 4, class: 'direct' }, svg).textContent = UI.classNames[e.c];

  const cross = el('line', { y1: m.t, y2: m.t + ih, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' }, svg);
  const dots = UI.classes.map((c) => el('circle', { r: LINE.dot, fill: color(c), stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }, svg));
  const tip = tooltip(host);
  const hit = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' }, svg);
  hit.addEventListener('pointermove', (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(weeks.length - 1, Math.round(((px - m.l) / iw) * (weeks.length - 1))));
    const w = weeks[i];
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    UI.classes.forEach((c, k) => { dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(w.durable[c])); dots[k].setAttribute('visibility', 'visible'); });
    const rows = UI.classes.map((c) => '<div class="row"><span>' + swatch(c) + UI.classNames[c] + '</span><b>' + w.durable[c] + ' of ' + w.merged[c] + '</b></div>').join('');
    tip.show('<div class="hint">Week of ' + w.week + '</div>' + rows, (x(i) / W) * box.width, (m.t / H) * box.height + TOOLTIP_OFFSET.lineChart);
  });
  hit.addEventListener('pointerleave', () => { tip.hide(); cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); });
}

function barChart(host, bar) {
  const W = host.clientWidth || 320, m = BAR.margin, rowH = BAR.rowHeight, half = BAR.barHeight / 2;
  const H = rowH * UI.classes.length;
  const iw = W - m.l - m.r;
  const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img' }, host);
  const tip = tooltip(host);
  UI.classes.forEach((c, i) => {
    const v = R.stats[c][bar.field];
    const cy = i * rowH + rowH / 2;
    el('text', { x: m.l - 10, y: cy + 4, 'text-anchor': 'end', class: 'direct' }, svg).textContent = UI.classNames[c];
    el('rect', { x: m.l, y: cy - half, width: iw, height: BAR.barHeight, rx: BAR.radius, fill: 'var(--wash)' }, svg);
    if (v) el('rect', { x: m.l, y: cy - half, width: Math.max(BAR.minWidth, v * iw), height: BAR.barHeight, rx: BAR.radius, fill: color(c) }, svg);
    el('text', { x: m.l + (v === null ? 0 : v * iw) + BAR.labelGap, y: cy + 4, class: 'direct' }, svg).textContent = pct(v);
    const hit = el('rect', { x: 0, y: i * rowH, width: W, height: rowH, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', (ev) => {
      const box = host.getBoundingClientRect();
      tip.show('<div class="row"><span>' + swatch(c) + UI.classNames[c] + '</span><b>' + pct(v) + '</b></div><div class="hint">' + esc(bar.detail[c]) + '</div>', ev.clientX - box.left, (cy / H) * box.height);
    });
    hit.addEventListener('pointerleave', () => tip.hide());
  });
}

function statusCell(p) {
  const style = UI.statusStyle[p.status];
  const title = p.durability.reason ? ' title="' + esc(p.durability.reason) + '"' : '';
  return '<span class="' + style.className + '"' + title + '>' + style.icon + ' ' + UI.statusNames[p.status] + '</span>';
}

function changeTable() {
  const t = byId(UI.ids.Changes);
  const fc = byId(UI.ids.FilterClass), fs = byId(UI.ids.FilterStatus);
  const draw = () => {
    const rows = R.changes.filter((p) => (!fc.value || p.authorClass === fc.value) && (!fs.value || p.status === fs.value));
    byId(UI.ids.ChangeCount).textContent = rows.length + ' ' + UI.nouns.plural;
    t.innerHTML = '<thead><tr><th>' + UI.nouns.column + '</th><th>Author</th><th>' + UI.nouns.date + '</th><th class="n">Size</th><th class="n">Lines kept</th><th>Status</th><th>Rework</th></tr></thead><tbody>' +
      rows.slice(0, UI.maxRows).map((p) => {
        const d = p.durability;
        const kept = d.status === UI.measured ? pct(d.surviving / d.baseline) : UI.empty;
        const rw = p.rework.map((e) => e.kind + ' ' + esc(e.source)).join(', ');
        return '<tr><td><a href="' + esc(p.url) + '">' + esc(p.id) + '</a> ' + esc(p.title) + '</td>' +
          '<td><span class="badge" title="' + esc(p.classReason) + '">' + swatch(p.authorClass) + UI.classNames[p.authorClass] + '</span></td>' +
          '<td class="nw">' + p.mergedAt.slice(0, 'YYYY-MM-DD'.length) + '</td><td class="n">' + p.size + '</td><td class="n">' + kept + '</td>' +
          '<td>' + statusCell(p) + '</td><td class="hint">' + rw + '</td></tr>';
      }).join('') + '</tbody>';
  };
  fc.addEventListener('change', draw);
  fs.addEventListener('change', draw);
  draw();
}

function drawCharts() {
  const weekly = byId(UI.ids.Weekly);
  weekly.innerHTML = '';
  lineChart(weekly);
  for (const bar of UI.bars) {
    const host = byId(bar.id);
    host.innerHTML = '';
    barChart(host, bar);
  }
}

drawCharts();
changeTable();
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawCharts, RESIZE_DEBOUNCE_MS); });
`;
