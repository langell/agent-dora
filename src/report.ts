import type { ClassStats, Report } from './metrics.js';
import { AUTHOR_CLASSES, type ClassKey } from './types.js';

const CLASS_NAMES: Record<ClassKey, string> = { agent: 'Agent', assisted: 'Assisted', human: 'Human', all: 'All' };
const KEYS: ClassKey[] = [...AUTHOR_CLASSES, 'all'];

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
const num = (x: number | null, digits = 1) => (x === null ? '—' : x.toFixed(digits).replace(/\.0+$/, ''));
export const duration = (hours: number | null) => {
  if (hours === null) return '—';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${num(hours)}h`;
  return `${num(hours / 24)}d`;
};

interface Row {
  label: string;
  hint: string;
  value: (s: ClassStats) => string;
}

export const ROWS: Row[] = [
  { label: 'Merged PRs', hint: 'PRs merged into the default branch in the period', value: (s) => String(s.merged) },
  { label: 'Durable PRs / week', hint: 'Matured PRs that were not reverted or reworked and kept enough of their lines', value: (s) => num(s.durablePerWeek) },
  { label: 'Durable rate', hint: 'Share of matured PRs that were durable', value: (s) => pct(s.durableRate) },
  { label: 'Line churn', hint: 'Share of added lines gone by the end of the window', value: (s) => pct(s.churn) },
  { label: 'Change failure rate', hint: 'Matured PRs reverted, reworked or blamed for a bug within the window', value: (s) => pct(s.changeFailureRate) },
  { label: 'Lead time (p50)', hint: 'First commit to merge', value: (s) => duration(s.leadTimeP50Hours) },
  { label: 'Time to first review (p50)', hint: 'PR opened to first review by someone else', value: (s) => duration(s.reviewWaitP50Hours) },
  { label: 'PR size (p50)', hint: 'Lines added plus deleted', value: (s) => num(s.sizeP50, 0) },
  { label: 'Open PRs awaiting review', hint: 'Non-draft open PRs with no review yet', value: (s) => String(s.awaitingReview) },
];

export function renderMarkdown(r: Report): string {
  const lines = [
    `## agent-dora: ${r.repo}`,
    '',
    `Since ${r.since.slice(0, 10)} · durability window ${r.windowDays} days · survival threshold ${pct(r.survivalThreshold)}`,
    '',
    `| Metric | ${KEYS.map((k) => CLASS_NAMES[k]).join(' | ')} |`,
    `|---|${KEYS.map(() => '--:').join('|')}|`,
    ...ROWS.map((row) => `| ${row.label} | ${KEYS.map((k) => row.value(r.stats[k])).join(' | ')} |`),
    '',
  ];
  if (r.maturedWeeks < 1) {
    lines.push(`> Not enough history yet: PRs need ${r.windowDays} days after merging before they count as durable.`, '');
  }
  return lines.join('\n');
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderHtml(r: Report): string {
  // Keep the embedded JSON from closing the <script> tag early.
  const data = JSON.stringify(r).replace(/</g, '\\u003c');
  const a = r.stats.all;
  const tile = (label: string, value: string, sub: string) =>
    `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div><div class="tile-sub">${esc(sub)}</div></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-dora · ${esc(r.repo)}</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10); --wash: rgba(11,11,11,0.04);
  --agent: #2a78d6; --assisted: #eb6834; --human: #1baf7a;
  --good: #006300; --critical: #d03b3b;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10); --wash: rgba(255,255,255,0.05);
    --agent: #3987e5; --assisted: #d95926; --human: #199e70;
    --good: #0ca30c; --critical: #e66767;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10); --wash: rgba(255,255,255,0.05);
  --agent: #3987e5; --assisted: #d95926; --human: #199e70;
  --good: #0ca30c; --critical: #e66767;
}
* { box-sizing: border-box; }
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
.badge { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.status-good { color: var(--good); }
.status-bad { color: var(--critical); }
.controls { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
select { font: inherit; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--ink); }
footer { margin-top: 48px; color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<main>
<header>
  <div class="eyebrow">agent-dora</div>
  <h1>${esc(r.repo)}</h1>
  <div class="meta">${esc(r.defaultBranch)} · since ${r.since.slice(0, 10)} · durability window ${r.windowDays} days · survival threshold ${pct(r.survivalThreshold)} · collected ${r.collectedAt.slice(0, 16).replace('T', ' ')} UTC</div>
</header>

${r.maturedWeeks < 1 ? `<div class="banner">Not enough history yet. PRs need ${r.windowDays} days after merging before they count toward durability, so most numbers below are still empty.</div>` : ''}

<div class="tiles">
  ${tile('Durable PRs / week', num(a.durablePerWeek), `${a.durable} of ${a.matured} matured PRs`)}
  ${tile('Durable rate', pct(a.durableRate), 'matured PRs that held up')}
  ${tile('Line churn', pct(a.churn), `added lines gone after ${r.windowDays} days`)}
  ${tile('Change failure rate', pct(a.changeFailureRate), 'reverted, reworked or caused a bug')}
  ${tile('Awaiting review', String(a.awaitingReview), a.awaitingReviewAgeP50Hours === null ? 'open PRs with no review' : `median wait ${duration(a.awaitingReviewAgeP50Hours)}`)}
</div>

<section class="card">
  <h2>Durable PRs per week</h2>
  <p class="note">Weeks whose PRs have all passed the ${r.windowDays}-day window. Recent weeks appear once they mature.</p>
  <div class="legend" id="legend"></div>
  <div class="chart" id="weekly"></div>
</section>

<section>
  <div class="grid2">
    <div class="card"><h2>Durable rate</h2><p class="note">Higher is better.</p><div class="chart" id="bar-durable"></div></div>
    <div class="card"><h2>Line churn</h2><p class="note">Lower is better.</p><div class="chart" id="bar-churn"></div></div>
    <div class="card"><h2>Change failure rate</h2><p class="note">Lower is better.</p><div class="chart" id="bar-cfr"></div></div>
  </div>
</section>

<section class="card">
  <h2>By author</h2>
  <p class="note">Agent: opened by a coding agent. Assisted: human-opened, with AI co-authored commits. Human: no AI signal.</p>
  <div class="scroll"><table>
    <thead><tr><th>Metric</th>${KEYS.map((k) => `<th class="n">${CLASS_NAMES[k]}</th>`).join('')}</tr></thead>
    <tbody>${ROWS.map((row) => `<tr><td>${esc(row.label)}<div class="hint">${esc(row.hint)}</div></td>${KEYS.map((k) => `<td class="n">${esc(row.value(r.stats[k]))}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>
</section>

<section class="card">
  <h2>Review queue</h2>
  <p class="note">Open, non-draft PRs with no review yet, oldest first.</p>
  <div class="scroll"><table id="queue"></table></div>
</section>

<section class="card">
  <h2>Pull requests</h2>
  <div class="controls">
    <label>Author <select id="filter-class"><option value="">All</option><option value="agent">Agent</option><option value="assisted">Assisted</option><option value="human">Human</option></select></label>
    <label>Status <select id="filter-status"><option value="">All</option><option value="durable">Durable</option><option value="failed">Not durable</option><option value="pending">Maturing</option><option value="unknown">Unknown</option></select></label>
    <span class="hint" id="pr-count"></span>
  </div>
  <div class="scroll"><table id="prs"></table></div>
</section>

<footer>Generated by agent-dora at ${r.generatedAt.slice(0, 16).replace('T', ' ')} UTC.</footer>
</main>
<script type="application/json" id="data">${data}</script>
<script>
${CLIENT_JS}
</script>
</body>
</html>
`;
}

/** Client-side rendering: charts, hover tooltips and PR table filters. No dependencies. */
const CLIENT_JS = String.raw`
const R = JSON.parse(document.getElementById('data').textContent);
const CLASSES = ['agent', 'assisted', 'human'];
const NAMES = { agent: 'Agent', assisted: 'Assisted', human: 'Human', all: 'All' };
const NS = 'http://www.w3.org/2000/svg';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
const pct = (x) => (x === null || x === undefined ? '—' : Math.round(x * 100) + '%');
const color = (c) => 'var(--' + c + ')';
const swatch = (c) => '<span class="swatch" style="background:' + color(c) + '"></span>';

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
      t.style.left = Math.max(0, Math.min(x + 12, hw - w)) + 'px';
      t.style.top = Math.max(0, y - t.offsetHeight - 8) + 'px';
    },
    hide() { t.style.opacity = 0; },
  };
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function lineChart(host) {
  const weeks = R.weeks.filter((w) => w.matured);
  document.getElementById('legend').innerHTML = CLASSES.map((c) => '<span>' + swatch(c) + NAMES[c] + '</span>').join('');
  if (weeks.length < 2) {
    host.innerHTML = '<p class="hint">Needs at least two matured weeks of history.</p>';
    return;
  }
  const W = host.clientWidth || 800, H = 260, m = { t: 12, r: 72, b: 28, l: 36 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = niceMax(Math.max(1, ...weeks.flatMap((w) => CLASSES.map((c) => w.durable[c]))));
  const x = (i) => m.l + (i / (weeks.length - 1)) * iw;
  const y = (v) => m.t + ih - (v / max) * ih;
  const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': 'Durable PRs per week by author' }, host);
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: i ? 'var(--grid)' : 'var(--axis)', 'stroke-width': 1 }, svg);
    el('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, svg).textContent = Math.round(v * 10) / 10;
  }
  const step = Math.max(1, Math.ceil(weeks.length / Math.max(2, Math.floor(iw / 72))));
  weeks.forEach((w, i) => {
    if (i % step === 0) el('text', { x: x(i), y: H - 8, 'text-anchor': 'middle' }, svg).textContent = w.week.slice(5);
  });
  const ends = [];
  for (const c of CLASSES) {
    const d = weeks.map((w, i) => (i ? 'L' : 'M') + x(i) + ' ' + y(w.durable[c])).join(' ');
    el('path', { d, fill: 'none', stroke: color(c), 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    ends.push({ c, y: y(weeks[weeks.length - 1].durable[c]) });
  }
  // Direct labels at line ends, nudged apart so they never overlap.
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 14);
  for (const e of ends) el('text', { x: W - m.r + 8, y: e.y + 4, class: 'direct' }, svg).textContent = NAMES[e.c];

  const cross = el('line', { y1: m.t, y2: m.t + ih, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' }, svg);
  const dots = CLASSES.map((c) => el('circle', { r: 4, fill: color(c), stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }, svg));
  const tip = tooltip(host);
  const hit = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' }, svg);
  hit.addEventListener('pointermove', (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(weeks.length - 1, Math.round(((px - m.l) / iw) * (weeks.length - 1))));
    const w = weeks[i];
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    CLASSES.forEach((c, k) => { dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(w.durable[c])); dots[k].setAttribute('visibility', 'visible'); });
    const rows = CLASSES.map((c) => '<div class="row"><span>' + swatch(c) + NAMES[c] + '</span><b>' + w.durable[c] + ' of ' + w.merged[c] + '</b></div>').join('');
    tip.show('<div class="hint">Week of ' + w.week + '</div>' + rows, (x(i) / W) * box.width, (m.t / H) * box.height + 40);
  });
  hit.addEventListener('pointerleave', () => { tip.hide(); cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); });
}

function barChart(host, field, detail) {
  const W = host.clientWidth || 320, row = 36, m = { l: 72, r: 48 };
  const H = row * CLASSES.length;
  const iw = W - m.l - m.r;
  const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img' }, host);
  const tip = tooltip(host);
  CLASSES.forEach((c, i) => {
    const s = R.stats[c], v = s[field];
    const cy = i * row + row / 2;
    el('text', { x: m.l - 10, y: cy + 4, 'text-anchor': 'end', class: 'direct' }, svg).textContent = NAMES[c];
    el('rect', { x: m.l, y: cy - 10, width: iw, height: 20, rx: 4, fill: 'var(--wash)' }, svg);
    if (v) el('rect', { x: m.l, y: cy - 10, width: Math.max(4, v * iw), height: 20, rx: 4, fill: color(c) }, svg);
    el('text', { x: m.l + (v === null ? 0 : v * iw) + 8, y: cy + 4, class: 'direct' }, svg).textContent = pct(v);
    const hit = el('rect', { x: 0, y: i * row, width: W, height: row, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', (ev) => {
      const box = host.getBoundingClientRect();
      tip.show('<div class="row"><span>' + swatch(c) + NAMES[c] + '</span><b>' + pct(v) + '</b></div><div class="hint">' + esc(detail(s)) + '</div>', ev.clientX - box.left, (cy / H) * box.height);
    });
    hit.addEventListener('pointerleave', () => tip.hide());
  });
}

const hours = (h) => (h < 48 ? Math.round(h) + 'h' : Math.round(h / 24) + 'd');
const since = (iso) => hours((Date.parse(R.collectedAt) - Date.parse(iso)) / 3.6e6);

function queue() {
  const t = document.getElementById('queue');
  const rows = R.openPrs.filter((p) => p.awaitingFirstReview).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(0, 25);
  if (!rows.length) { t.innerHTML = '<tr><td class="hint">Nothing waiting.</td></tr>'; return; }
  t.innerHTML = '<thead><tr><th>PR</th><th>Author</th><th class="n">Waiting</th></tr></thead><tbody>' +
    rows.map((p) => '<tr><td><a href="' + esc(p.url) + '">#' + p.number + '</a> ' + esc(p.title) + '</td><td><span class="badge">' + swatch(p.authorClass) + NAMES[p.authorClass] + '</span></td><td class="n">' + since(p.createdAt) + '</td></tr>').join('') + '</tbody>';
}

function status(p) {
  if (p.durable === true) return ['durable', '<span class="status-good">✓ Durable</span>'];
  if (p.durable === false) return ['failed', '<span class="status-bad">✕ Not durable</span>'];
  if (p.durability.status === 'pending') return ['pending', '<span class="hint">◷ Maturing</span>'];
  return ['unknown', '<span class="hint" title="' + esc(p.durability.reason || '') + '">? Unknown</span>'];
}

function prTable() {
  const t = document.getElementById('prs');
  const fc = document.getElementById('filter-class'), fs = document.getElementById('filter-status');
  const draw = () => {
    const rows = R.prs.filter((p) => (!fc.value || p.authorClass === fc.value) && (!fs.value || status(p)[0] === fs.value));
    document.getElementById('pr-count').textContent = rows.length + ' PRs';
    t.innerHTML = '<thead><tr><th>PR</th><th>Author</th><th>Merged</th><th class="n">Size</th><th class="n">Lines kept</th><th>Status</th><th>Rework</th></tr></thead><tbody>' +
      rows.slice(0, 500).map((p) => {
        const d = p.durability;
        const kept = d.status === 'measured' ? pct(d.surviving / d.baseline) : '—';
        const rw = p.rework.map((e) => e.kind + ' ' + esc(e.source)).join(', ');
        return '<tr><td><a href="' + esc(p.url) + '">#' + p.number + '</a> ' + esc(p.title) + '</td>' +
          '<td><span class="badge" title="' + esc(p.classReason) + '">' + swatch(p.authorClass) + NAMES[p.authorClass] + '</span></td>' +
          '<td>' + p.mergedAt.slice(0, 10) + '</td><td class="n">' + p.size + '</td><td class="n">' + kept + '</td>' +
          '<td>' + status(p)[1] + '</td><td class="hint">' + rw + '</td></tr>';
      }).join('') + '</tbody>';
  };
  fc.addEventListener('change', draw);
  fs.addEventListener('change', draw);
  draw();
}

function drawCharts() {
  for (const id of ['weekly', 'bar-durable', 'bar-churn', 'bar-cfr']) document.getElementById(id).innerHTML = '';
  lineChart(document.getElementById('weekly'));
  barChart(document.getElementById('bar-durable'), 'durableRate', (s) => s.durable + ' of ' + s.matured + ' matured PRs');
  barChart(document.getElementById('bar-churn'), 'churn', () => 'of added lines gone after ' + R.windowDays + ' days');
  barChart(document.getElementById('bar-cfr'), 'changeFailureRate', (s) => s.reverts + ' reverted');
}

drawCharts();
queue();
prTable();
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawCharts, 150); });
`;
