/**
 * Client-side rendering: charts, hover tooltips and table filters. No dependencies.
 * Everything it shares with the server (ids, class names, wording) comes from `UI`.
 */
export const CLIENT_JS = String.raw`
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
