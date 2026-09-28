import {
  ALL_CLASSES,
  AUTHOR_CLASSES,
  CHANGE_STATUS_NAMES,
  CLASS_KEYS,
  CLASS_NAMES,
  ChangeStatus,
  DurabilityStatus,
  isoMinute,
  MS_PER_HOUR,
  TOOL_NAME,
  type AuthorClass,
} from './constants.js';
import type { ClassStats, Report } from './metrics.js';
import { CLIENT_JS } from './report-client.js';
import { cssVars, seriesVar, STYLES } from './report-theme.js';
import { duration, EMPTY_VALUE, emptyReason, esc, nouns, num, pct, rows, subtitle } from './report.js';

/** The dashboard's change table renders at most this many rows. */
const MAX_TABLE_ROWS = 500;
const MAX_QUEUE_ROWS = 25;

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

