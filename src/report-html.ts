import {
  ALL_CLASSES,
  AUTHOR_CLASSES,
  CHANGE_STATUS_NAMES,
  CLASS_KEYS,
  CLASS_NAMES,
  CLASS_SOURCE_NAMES,
  CLASS_SOURCES,
  ChangeStatus,
  DurabilityStatus,
  FAILURE_REASON_NAMES,
  FIXER_KEYS,
  FIXER_NAMES,
  INCIDENT_SOURCE_NAMES,
  incidentKey,
  ReworkSourceKind,
  DAYS_PER_WEEK,
  HOURS_PER_DAY,
  ISO_DATE_LENGTH,
  ISO_MONTH_DAY_OFFSET,
  isoDate,
  isoMinute,
  MS_PER_HOUR,
  prId,
  REVIEW_DEPTH_NAMES,
  REVIEW_DEPTHS,
  ReportFile,
  TOOL_NAME,
  UNAVAILABLE_REASON_NAMES,
  Unit,
  type AuthorClass,
} from './constants.js';
import type { ClassStats, Report } from './metrics.js';
import { CLIENT_JS } from './report-client.js';
import { cssVars, seriesVar, STYLES } from './report-theme.js';
import { COMPARED, CSV_HEADER, csvRow, duration, EMPTY_VALUE, emptyReason, esc, nouns, num, pct, rows, statValue, subtitle, usd } from './report.js';

/** The dashboard's change table renders at most this many rows. */
const MAX_TABLE_ROWS = 500;
const MAX_QUEUE_ROWS = 25;
/** The scatter plot draws at most this many changes, the most recent first. */
const MAX_SCATTER_POINTS = 2000;
/** Rates from fewer matured changes than this are drawn faded and flagged as a small sample. */
const MIN_SAMPLE = 10;
/** Percentage points in a share; a change of a rate is shown in points. */
const POINTS = 100;
/** The delivery card lists at most this many recent incidents. */
const MAX_INCIDENT_ROWS = 15;
/** Geometry of the delivery card's weekly deploy columns, in viewBox units. */
const DEPLOY_CHART = { width: 720, height: 120, gap: 2, labelHeight: 14, marker: 3 };

/** Lead-time axis ticks, in hours: an hour, a day, a week, four weeks. */
const LEAD_TIME_TICKS_HOURS = [1, HOURS_PER_DAY, DAYS_PER_WEEK * HOURS_PER_DAY, 4 * DAYS_PER_WEEK * HOURS_PER_DAY];

/** Element ids shared by the page markup and the client script. */
const Ids = {
  Data: 'report-data',
  Legend: 'legend',
  Weekly: 'weekly',
  WeeklyModes: 'weekly-modes',
  Curve: 'survival-curve',
  Scatter: 'scatter',
  LeadTime: 'lead-time',
  ReviewDepth: 'review-depth',
  Changes: 'changes',
  ChangeCount: 'change-count',
  FilterClass: 'filter-class',
  FilterStatus: 'filter-status',
  FilterTool: 'filter-tool',
  Search: 'search',
  Download: 'download',
} as const;

/** What the weekly chart can plot. */
const WeeklyMode = { Count: 'count', Rate: 'rate', Share: 'share' } as const;
const WEEKLY_MODE_NAMES: Record<(typeof WeeklyMode)[keyof typeof WeeklyMode], string> = {
  [WeeklyMode.Count]: 'Durable count',
  [WeeklyMode.Rate]: 'Durable rate',
  [WeeklyMode.Share]: 'Share of durable output',
};

/** How each change status is drawn. */
const STATUS_STYLE: Record<ChangeStatus, { icon: string; className: string }> = {
  [ChangeStatus.Durable]: { icon: '✓', className: 'status-good' },
  [ChangeStatus.Failed]: { icon: '✕', className: 'status-bad' },
  [ChangeStatus.Pending]: { icon: '◷', className: 'hint' },
  [ChangeStatus.Unknown]: { icon: '?', className: 'hint' },
  [ChangeStatus.Remedial]: { icon: '↺', className: 'hint' },
};

/** The per-author bar charts: which stat each plots, its confidence interval, and its tooltip detail per class. */
function barCharts(r: Report) {
  const n = nouns(r.unit);
  const detail = (f: (s: ClassStats) => string) => Object.fromEntries(AUTHOR_CLASSES.map((c) => [c, f(r.stats[c])]));
  return [
    { id: 'bar-durable', title: 'Durable rate', note: `Higher is better. The pale band is the 95% range; faded bars rest on fewer than ${MIN_SAMPLE} ${n.plural}.`, field: 'durableRate', ci: 'durableRateCi', detail: detail((s) => `${s.durable} of ${s.matured} matured ${n.plural}`) },
    { id: 'bar-churn', title: 'Line churn', note: 'Lower is better. Share of all added lines gone by the end of the window.', field: 'churn', ci: null, detail: detail((s) => `lines kept by the median ${n.singular}: ${pct(s.keptP50)}`) },
    { id: 'bar-cfr', title: 'Change failure rate', note: 'Lower is better. The pale band is the 95% range.', field: 'changeFailureRate', ci: 'changeFailureRateCi', detail: detail((s) => `${s.reverts} reverted, ${s.failingEarly} more failing early`) },
  ] satisfies { id: string; title: string; note: string; field: keyof ClassStats; ci: keyof ClassStats | null; detail: Record<string, string> }[];
}

function selectOptions(values: readonly string[], names: Record<string, string>, all = CLASS_NAMES[ALL_CLASSES]): string {
  return [`<option value="">${all}</option>`, ...values.map((v) => `<option value="${esc(v)}">${esc(names[v] ?? v)}</option>`)].join('');
}

function swatch(c: AuthorClass): string {
  return `<span class="swatch" style="background:var(${seriesVar(c)})"></span>`;
}

const badge = (c: AuthorClass) => `<span class="badge">${swatch(c)}${CLASS_NAMES[c]}</span>`;

/** A plain table; columns from `numericFrom` on are right-aligned numbers. */
function table(head: string[], body: string[][], numericFrom = 1): string {
  const cell = (tag: string, i: number, html: string) => `<${tag}${i >= numericFrom ? ' class="n"' : ''}>${html}</${tag}>`;
  return `<div class="scroll"><table><thead><tr>${head.map((h, i) => cell('th', i, h)).join('')}</tr></thead><tbody>${body
    .map((row) => `<tr>${row.map((v, i) => cell('td', i, v)).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

const card = (title: string, note: string, body: string, extra = '') => `<section class="card"${extra}><h2>${title}</h2>${note ? `<p class="note">${note}</p>` : ''}${body}</section>`;

/** "▲ 6 pts" or "▼ 12%": how a stat moved between the previous stretch and the current one, colored by whether that's good. */
function delta(r: Report, field: keyof ClassStats, higherIsBetter: boolean, relative: boolean): string {
  const cmp = r.comparison;
  const before = statValue(cmp?.previous?.[ALL_CLASSES], field);
  const after = statValue(cmp?.current[ALL_CLASSES], field);
  if (!cmp || before === null || after === null) return '';
  const change = relative ? (before ? (after - before) / before : null) : after - before;
  if (change === null) return '';
  const shown = Math.round(Math.abs(change) * POINTS);
  if (shown === 0) return `<span class="delta">no change vs the prior ${cmp.days} days</span>`;
  const better = change > 0 === higherIsBetter;
  const amount = relative ? `${shown}%` : `${shown} ${shown === 1 ? 'pt' : 'pts'}`;
  return `<span class="delta ${better ? 'status-good' : 'status-bad'}">${change > 0 ? '▲' : '▼'} ${amount} vs the prior ${cmp.days} days</span>`;
}

function tiles(r: Report): string {
  const a = r.stats[ALL_CLASSES];
  const n = nouns(r.unit);
  const tile = (label: string, value: string, sub: string, change = '') =>
    `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div><div class="tile-sub">${esc(sub)}</div>${change}</div>`;
  return `<div class="tiles">
  ${tile(`Durable ${n.plural} / week`, num(a.durablePerWeek), `${a.durable} of ${a.matured} matured ${n.plural}`, delta(r, 'durablePerWeek', true, true))}
  ${tile('Surviving lines / week', num(a.survivingLinesPerWeek, 0), `added lines still there after ${r.windowDays} days`, delta(r, 'survivingLinesPerWeek', true, true))}
  ${tile('Durable rate', pct(a.durableRate), `matured ${n.plural} that held up`, delta(r, 'durableRate', true, false))}
  ${tile('Change failure rate', pct(a.changeFailureRate), a.failingEarly ? `${a.failingEarly} more failing early` : 'reverted, reworked or caused a bug', delta(r, 'changeFailureRate', false, false))}
  ${tile('Line churn', pct(a.churn), `added lines gone after ${r.windowDays} days`, delta(r, 'churn', false, false))}
  ${r.delivery?.deploySource ? tile('Lead time to production', duration(a.deployLeadTimeP50Hours), `first commit to live, median · ${num(r.delivery.deploysPerWeek)} deploys a week`) : ''}
  ${r.cost ? tile('AI spend / durable change', usd(r.cost.perDurableChange), `${usd(r.cost.usd)} over ${r.cost.durable} durable AI-written ${n.plural}`) : ''}
  ${r.unit === Unit.Prs ? tile('Rubber-stamped', pct(a.rubberStampRate), 'PRs merged with no human review or a silent approval', delta(r, 'rubberStampRate', false, false)) : ''}
  ${tile('Awaiting review', String(a.awaitingReview), a.awaitingReviewAgeP50Hours === null ? 'open PRs no person has reviewed' : `median wait ${duration(a.awaitingReviewAgeP50Hours)}`)}
</div>`;
}

function comparisonCard(r: Report): string {
  const cmp = r.comparison;
  if (!cmp?.previous) return '';
  const body = COMPARED.map((m) => [
    esc(m.label),
    ...CLASS_KEYS.map((k) => {
      const before = statValue(cmp.previous![k], m.field);
      const after = statValue(cmp.current[k], m.field);
      return `<span class="hint">${m.format(before)} →</span> ${m.format(after)}`;
    }),
  ]);
  return card(
    `Last ${cmp.days} matured days vs the ${cmp.days} before`,
    `${nouns(r.unit).count} that landed in each stretch, up to ${isoDate(cmp.until)}, the last day whose ${nouns(r.unit).plural} have all matured.`,
    table(['Metric', ...CLASS_KEYS.map((k) => CLASS_NAMES[k])], body),
  );
}

function toolsCard(r: Report): string {
  if (!r.tools.length) return '';
  const n = nouns(r.unit);
  const cost = new Map((r.cost?.byTool ?? []).map((t) => [t.tool, t]));
  const body = r.tools.map((t) => [
    esc(t.tool),
    String(t.stats.merged),
    `${pct(t.stats.durableRate)}<div class="meter"><span style="width:${(t.stats.durableRate ?? 0) * POINTS}%"></span></div>`,
    pct(t.stats.churn),
    pct(t.stats.changeFailureRate),
    duration(t.stats.leadTimeP50Hours),
    ...(r.unit === Unit.Prs ? [pct(t.stats.rubberStampRate)] : []),
    ...(r.cost ? [usd(cost.get(t.tool)?.usd ?? null), usd(cost.get(t.tool)?.perDurableChange ?? null)] : []),
  ]);
  const head = [
    'Tool', n.count, 'Durable rate', 'Line churn', 'Change failure rate', 'Lead time (p50)',
    ...(r.unit === Unit.Prs ? ['Rubber-stamped'] : []),
    ...(r.cost ? ['AI spend', 'Per durable change'] : []),
  ];
  return card('By tool', 'The AI tool behind agent and assisted changes, read from the agent account, branch prefix or co-author trailer.', table(head, body));
}

/** A row of labelled figures inside a card. */
const figures = (items: [string, string, string?][]) =>
  `<div class="figures">${items.map(([label, value, sub]) => `<div><div class="tile-label">${esc(label)}</div><div class="figure">${esc(value)}</div>${sub ? `<div class="tile-sub">${esc(sub)}</div>` : ''}</div>`).join('')}</div>`;

/** Weekly production deploys as columns, with a mark over weeks that had incidents. Native tooltips. */
function deployColumns(r: Report): string {
  const weeks = r.weeks;
  if (!weeks.length) return '';
  const { width, height, gap, labelHeight, marker } = DEPLOY_CHART;
  const plot = height - labelHeight - marker * 3;
  const max = Math.max(1, ...weeks.map((w) => w.deploys));
  const slot = width / weeks.length;
  const bars = weeks.map((w, i) => {
    const h = (w.deploys / max) * plot;
    const x = i * slot + gap / 2;
    const tip = `Week of ${w.week}: ${w.deploys} deploys${w.incidents ? `, ${w.incidents} incidents` : ''}`;
    const mark = w.incidents ? `<circle cx="${x + (slot - gap) / 2}" cy="${marker * 1.5}" r="${marker}" class="incident-mark"/>` : '';
    return `<g><title>${esc(tip)}</title><rect x="${x}" y="${height - labelHeight - h}" width="${Math.max(1, slot - gap)}" height="${h}" rx="2" class="deploy-bar"/>${mark}<rect x="${i * slot}" y="0" width="${slot}" height="${height}" fill="transparent"/></g>`;
  });
  const first = weeks[0]!.week, last = weeks.at(-1)!.week;
  return `<svg class="deploys" viewBox="0 0 ${width} ${height}" role="img" aria-label="Production deploys per week">${bars.join('')}<text x="0" y="${height - 2}">${first}</text><text x="${width}" y="${height - 2}" text-anchor="end">${last}</text></svg>`;
}

function deliveryCard(r: Report): string {
  const d = r.delivery;
  if (!d) return '';
  const n = nouns(r.unit);
  const items: [string, string, string?][] = [];
  if (d.deploySource) {
    items.push(
      ['Production deploys / week', num(d.deploysPerWeek), `${d.deploys} in the period; a commit deployed to several projects counts once`],
      ['Lead time to production', duration(r.stats[ALL_CLASSES].deployLeadTimeP50Hours), 'median, first commit to live'],
      ['Failed deploys', String(d.failedDeploys), 'builds that never went live'],
      ['Not in production yet', String(d.undeployed), `${n.plural} landed but not deployed`],
    );
  }
  if (d.incidents !== null) {
    items.push(
      ['Incidents', String(d.incidents), Object.entries(d.incidentsBySource).map(([src, count]) => `${INCIDENT_SOURCE_NAMES[src as keyof typeof INCIDENT_SOURCE_NAMES]} ${count}`).join(' · ') || 'none in the period'],
      ['Deploys followed by an incident', pct(d.deployFailureRate), d.deploysWithIncident === null ? 'needs deployment data' : `${d.deploysWithIncident} of ${d.deploys}, within ${d.attributionHours}h`],
      ['Time to restore', duration(d.timeToRestoreP50Hours), 'median, opened to resolved'],
      ['Linked to a change', String(d.linkedIncidents), 'incidents with a Caused-by reference'],
    );
  }
  // Which changes each incident named as its cause.
  const blamed = new Map<string, string[]>();
  for (const c of r.changes) {
    for (const e of c.rework) {
      if (e.from?.kind !== ReworkSourceKind.Incident) continue;
      const key = incidentKey(e.from.source, e.from.id);
      blamed.set(key, [...(blamed.get(key) ?? []), `<a href="${esc(c.url)}">${esc(c.id)}</a>`]);
    }
  }
  const incidents = [...(r.incidents ?? [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, MAX_INCIDENT_ROWS);
  const list = incidents.length
    ? table(
        ['Incident', 'Source', 'Opened', 'Time to restore', 'Caused by'],
        incidents.map((i) => [
          `<a href="${esc(i.url)}">${esc(i.id)}</a> ${esc(i.title)}`,
          INCIDENT_SOURCE_NAMES[i.source],
          `<span class="nw">${isoDate(i.createdAt)}</span>`,
          i.resolvedAt ? duration((Date.parse(i.resolvedAt) - Date.parse(i.createdAt)) / MS_PER_HOUR) : '<span class="hint">open</span>',
          (blamed.get(incidentKey(i.source, i.id)) ?? []).join(', ') || '<span class="hint">not linked</span>',
        ]),
        5,
      )
    : '';
  const env = d.environments.length ? ` Environments: ${d.environments.map(esc).join(', ')}.` : '';
  return card(
    'Delivery',
    `Deployments and incidents, DORA style. A deploy counts as failed if an incident opened within ${d.attributionHours} hours of it going live.${env}`,
    figures(items) + (d.deploySource ? `<div class="legend"><span><span class="swatch deploy-bar-swatch"></span>Production deploys per week</span>${d.incidents !== null ? '<span><span class="swatch incident-swatch"></span>Week with an incident</span>' : ''}</div>${deployColumns(r)}` : '') + list,
  );
}

function costCard(r: Report): string {
  const c = r.cost;
  if (!c) return '';
  const n = nouns(r.unit);
  const items: [string, string, string?][] = [
    ['AI spend', usd(c.usd), `${c.from} to ${c.until}`],
    ['Per durable change', usd(c.perDurableChange), `${c.durable} durable agent and assisted ${n.plural}`],
    ['Per 1,000 surviving lines', usd(c.perThousandSurvivingLines), 'AI-written lines still there after the window'],
    ['Still maturing', usd(c.maturingUsd), 'spend on changes not judged yet'],
  ];
  const tools = c.byTool.length
    ? table(['Tool', 'Spend', `Durable ${n.plural}`, 'Per durable change'], c.byTool.map((t) => [esc(t.tool), usd(t.usd), String(t.durable), usd(t.perDurableChange)]))
    : '<p class="hint">No AI spend recorded in the matured period.</p>';
  return card(
    'AI spend',
    `Spend over the matured period, against the agent and assisted ${n.plural} that landed in it and held up. Spend from ${c.actors} ${c.actors === 1 ? 'person' : 'people'}; it covers all their work, so limit it with <code>cost.actors</code> or combine repositories with <code>rollup</code>.`,
    figures(items) + tools,
  );
}

function fixesCard(r: Report): string {
  const max = Math.max(0, ...AUTHOR_CLASSES.flatMap((c) => FIXER_KEYS.map((f) => r.fixes[c][f])));
  if (!max) return card('Who fixed whom', '', '<p class="hint">No reverts, rework or bugs inside the window.</p>');
  // A matrix, not a list: equal columns, centered counts, and each cell shaded by its count.
  const cell = (v: number) => (v ? `<td class="heat" style="--heat:${Math.round((v / max) * POINTS)}%">${v}</td>` : '<td class="hint">0</td>');
  const head = `<tr><th>Fixed</th>${FIXER_KEYS.map((f) => `<th>${FIXER_NAMES[f]}</th>`).join('')}</tr>`;
  const body = AUTHOR_CLASSES.map((c) => `<tr><td>${badge(c)}</td>${FIXER_KEYS.map((f) => cell(r.fixes[c][f])).join('')}</tr>`).join('');
  return card(
    'Who fixed whom',
    `Reverts, rework and bugs within the window. Rows: whose ${nouns(r.unit).plural} needed fixing. Columns: who fixed them.`,
    `<div class="scroll"><table class="matrix"><thead>${head}</thead><tbody>${body}</tbody></table></div>`,
  );
}

function hotspotsCard(r: Report): string {
  if (!r.hotspots.length) return '';
  const legend = `<div class="legend">${AUTHOR_CLASSES.map((c) => `<span>${swatch(c)}${CLASS_NAMES[c]}</span>`).join('')}</div>`;
  const body = r.hotspots.map((h) => {
    const segs = AUTHOR_CLASSES.filter((c) => h.byClass[c].lost > 0)
      .map((c) => `<span title="${CLASS_NAMES[c]}: ${h.byClass[c].lost} of ${h.byClass[c].baseline} lines lost" style="flex:${h.byClass[c].lost};background:var(${seriesVar(c)})"></span>`)
      .join('');
    return [`<code>${esc(h.dir)}</code>`, String(h.baseline), String(h.lost), pct(h.lost / h.baseline), `<div class="stack">${segs}</div>`];
  });
  return card(
    'Hotspots',
    `Directories that lost the most added lines by the end of the window, across matured ${nouns(r.unit).plural}.`,
    legend + table(['Directory', 'Lines added', 'Lines lost', 'Churn', 'Lost lines by author'], body),
  );
}

function sourcesCard(r: Report): string {
  const body = CLASS_SOURCES.map((s) => [esc(CLASS_SOURCE_NAMES[s]), ...AUTHOR_CLASSES.map((c) => String(r.classSources[c][s]))]);
  return card(
    'How authorship was decided',
    'Which signal classified each change. Labels are the strongest; branch prefixes the weakest. Correct a misclassified PR with an ai:* label.',
    table(['Signal', ...AUTHOR_CLASSES.map((c) => CLASS_NAMES[c])], body),
  );
}

function queueCard(r: Report): string {
  const bounds = r.queueAges.map((b) => b.maxDays);
  const label = (i: number) => {
    const max = bounds[i];
    const min = i ? bounds[i - 1] : null;
    if (max === null) return `${min}+ days`;
    return min === null ? `Under ${max} ${max === 1 ? 'day' : 'days'}` : `${min}–${max} days`;
  };
  const ages = table(['Author', ...r.queueAges.map((_, i) => label(i))], AUTHOR_CLASSES.map((c) => [badge(c), ...r.queueAges.map((b) => String(b.counts[c]))]));
  const waiting = r.openPrs
    .filter((p) => p.awaitingFirstReview)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, MAX_QUEUE_ROWS);
  const age = (iso: string) => duration((Date.parse(r.collectedAt) - Date.parse(iso)) / MS_PER_HOUR);
  const repo = (p: { repo?: string }) => (p.repo ? `<span class="hint">${esc(p.repo)}</span> ` : '');
  const list = waiting.length
    ? table(['PR', 'Author', 'Waiting'], waiting.map((p) => [`${repo(p)}<a href="${esc(p.url)}">${prId(p.number)}</a> ${esc(p.title)}`, badge(p.authorClass), age(p.createdAt)]), 2)
    : '<p class="hint">Nothing waiting.</p>';
  return card('Review queue', 'Open, non-draft PRs no person has reviewed yet (AI review bots don’t count), by how long they’ve waited; oldest first below.', ages + list);
}

function chartCard(title: string, note: string, id: string, extra = ''): string {
  return `<div class="card"><h2>${title}</h2><p class="note">${note}</p>${extra}<div class="chart" id="${id}"></div></div>`;
}

const classLegend = () => `<div class="legend">${AUTHOR_CLASSES.map((c) => `<span>${swatch(c)}${CLASS_NAMES[c]}</span>`).join('')}</div>`;

export function renderHtml(r: Report): string {
  const n = nouns(r.unit);
  const bars = barCharts(r);
  const prMode = r.unit === Unit.Prs;
  const multiRepo = !!r.repos?.length;
  const ui = {
    ids: Ids,
    classes: AUTHOR_CLASSES,
    classNames: CLASS_NAMES,
    seriesVars: Object.fromEntries(AUTHOR_CLASSES.map((c) => [c, `var(${seriesVar(c)})`])),
    statusNames: CHANGE_STATUS_NAMES,
    statusStyle: STATUS_STYLE,
    failureNames: FAILURE_REASON_NAMES,
    reasonNames: UNAVAILABLE_REASON_NAMES,
    reviewDepths: REVIEW_DEPTHS,
    reviewDepthNames: REVIEW_DEPTH_NAMES,
    measured: DurabilityStatus.Measured,
    remedial: ChangeStatus.Remedial,
    unknown: ChangeStatus.Unknown,
    weeklyModes: WeeklyMode,
    isoDateLength: ISO_DATE_LENGTH,
    monthDayOffset: ISO_MONTH_DAY_OFFSET,
    nouns: n,
    empty: EMPTY_VALUE,
    maxRows: MAX_TABLE_ROWS,
    maxScatter: MAX_SCATTER_POINTS,
    minSample: MIN_SAMPLE,
    multiRepo,
    bars: bars.map(({ id, field, ci, detail }) => ({ id, field, ci, detail })),
    leadTicks: LEAD_TIME_TICKS_HOURS.map((hours) => ({ hours, label: duration(hours) })),
    leadLabels: Object.fromEntries(
      AUTHOR_CLASSES.map((c) => {
        const q = r.stats[c].leadTime;
        return [c, q ? `p10 ${duration(q.p10)} · p25 ${duration(q.p25)} · p50 ${duration(q.p50)} · p75 ${duration(q.p75)} · p90 ${duration(q.p90)}` : EMPTY_VALUE];
      }),
    ),
    csv: { file: ReportFile.Csv, header: CSV_HEADER, rows: r.changes.map(csvRow) },
  };
  // The client doesn't use per-file results; leave them out to keep the page small.
  const slim = { ...r, changes: r.changes.map((c) => ({ ...c, durability: { ...c.durability, files: undefined } })) };
  // Keep the embedded JSON from closing the <script> tag early.
  const payload = JSON.stringify({ report: slim, ui }).replace(/</g, '\\u003c');
  const banners = [...r.notes, ...(emptyReason(r) ? [emptyReason(r)!] : [])];
  const modeButtons = Object.values(WeeklyMode)
    .map((m, i) => `<button type="button" data-mode="${m}" aria-pressed="${i === 0}">${WEEKLY_MODE_NAMES[m]}</button>`)
    .join('');

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
  ${multiRepo ? `<div class="meta">${r.repos!.map(esc).join(' · ')}</div>` : ''}
  <div class="meta">${esc(subtitle(r))} · collected ${isoMinute(r.collectedAt)} UTC</div>
</header>

${banners.map((b) => `<div class="banner">${esc(b)}</div>`).join('\n')}

${tiles(r)}

<section class="card">
  <div class="card-head">
    <h2>Durable ${n.plural} per week</h2>
    <div class="segmented" id="${Ids.WeeklyModes}" role="group" aria-label="What to plot">${modeButtons}</div>
  </div>
  <p class="note">Recent weeks are shaded until all their ${n.plural} pass the ${r.windowDays}-day window. Fixes and reverts aren’t counted.</p>
  <div class="legend" id="${Ids.Legend}"></div>
  <div class="chart" id="${Ids.Weekly}"></div>
</section>

<section>
  <div class="grid3">
    ${bars.map((b) => `<div class="card"><h2>${b.title}</h2><p class="note">${b.note}</p><div class="chart" id="${b.id}"></div></div>`).join('\n    ')}
  </div>
</section>

${comparisonCard(r)}

<section class="card">
  <h2>By author</h2>
  <p class="note">Agent: opened by a coding agent. Assisted: human-opened, with AI co-authored commits. Human: no AI signal.</p>
  <div class="scroll"><table>
    <thead><tr><th>Metric</th>${CLASS_KEYS.map((k) => `<th class="n">${CLASS_NAMES[k]}</th>`).join('')}</tr></thead>
    <tbody>${rows(r).map((row) => `<tr><td>${esc(row.label)}<div class="hint">${esc(row.hint)}</div></td>${CLASS_KEYS.map((k) => `<td class="n">${esc(row.value(r.stats[k]))}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>
</section>

${toolsCard(r)}

${deliveryCard(r)}

${costCard(r)}

<section>
  <div class="grid2">
    ${chartCard('Survival curve', `Share of added lines still on the branch after each day, across matured ${n.plural} measured at every point.`, Ids.Curve, classLegend())}
    ${chartCard('Lead time spread', `First commit to ${prMode ? 'merge' : 'landing'}. Boxes span the middle half of ${n.plural}, whiskers the middle 80%, the line marks the median.`, Ids.LeadTime)}
  </div>
</section>

<section class="card">
  <h2>Size vs lines kept</h2>
  <p class="note">Each dot is a matured ${n.singular}. Click one to open it. Dots below the line kept less than ${pct(r.survivalThreshold)} of their lines. Size is on a log scale.</p>
  ${classLegend()}
  <div class="chart" id="${Ids.Scatter}"></div>
</section>

<section>
  <div class="grid2">
    ${fixesCard(r)}
    ${prMode ? chartCard('Review depth', 'How closely a person reviewed each merged PR. AI review bots don’t count.', Ids.ReviewDepth, `<div class="legend">${REVIEW_DEPTHS.map((d, i) => `<span><span class="swatch depth-${i}"></span>${REVIEW_DEPTH_NAMES[d]}</span>`).join('')}</div>`) : ''}
  </div>
</section>

${hotspotsCard(r)}

${prMode || r.openPrs.length ? queueCard(r) : ''}

${sourcesCard(r)}

<section class="card">
  <h2>${n.heading}</h2>
  <div class="controls">
    <input type="search" id="${Ids.Search}" placeholder="Search title, id, author or tool" aria-label="Search">
    <label>Author <select id="${Ids.FilterClass}">${selectOptions(AUTHOR_CLASSES, CLASS_NAMES)}</select></label>
    <label>Status <select id="${Ids.FilterStatus}">${selectOptions(Object.values(ChangeStatus), CHANGE_STATUS_NAMES)}</select></label>
    ${r.tools.length ? `<label>Tool <select id="${Ids.FilterTool}">${selectOptions(r.tools.map((t) => t.tool), {})}</select></label>` : ''}
    <button type="button" id="${Ids.Download}">Download CSV</button>
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
