/**
 * Client-side rendering: charts, hover tooltips and the change table. No dependencies.
 * Everything it shares with the server (ids, class names, wording) comes from `UI`.
 */
export const CLIENT_JS = String.raw`
const NS = 'http://www.w3.org/2000/svg';
const PERCENT = 100;
const RESIZE_DEBOUNCE_MS = 150;
// Chart geometry, in px.
const LINE = { height: 260, margin: { t: 12, r: 72, b: 28, l: 40 }, gridLines: 4, minLabelGap: 72, labelNudge: 14, dot: 4, columnGap: 2 };
const BAR = { rowHeight: 40, barHeight: 8, bandHeight: 18, radius: 4, minWidth: 4, margin: { l: 72, r: 96 }, labelGap: 12, band: 0.28, faded: 0.4 };
const CURVE = { height: 240, margin: { t: 12, r: 72, b: 28, l: 40 }, dot: 4 };
const SCATTER = { height: 320, margin: { t: 12, r: 16, b: 32, l: 44 }, dot: 4, hitRadius: 24 };
const BOX = { rowHeight: 44, boxHeight: 18, margin: { l: 72, r: 16, b: 24 }, tick: 6 };
const DEPTH = { rowHeight: 40, barHeight: 20, margin: { l: 72, r: 8 }, gap: 2, minLabelWidth: 36 };
const TOOLTIP_OFFSET = { x: 12, y: 8, lineChart: 40 };
// Query keys for the change table's state in the URL hash.
const HASH = { cls: 'author', status: 'status', tool: 'tool', q: 'q', sort: 'sort' };
const SORT_SEP = ':';
const DESC = 'desc';
const DEFAULT_SORT = 'date';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
const pct = (x) => (x === null || x === undefined ? UI.empty : Math.round(x * PERCENT) + '%');
const color = (c) => UI.seriesVars[c];
const swatch = (c) => '<span class="swatch" style="background:' + color(c) + '"></span>';
const byId = (id) => document.getElementById(id);
const tipRow = (c, value) => '<div class="row"><span>' + swatch(c) + UI.classNames[c] + '</span><b>' + value + '</b></div>';

function el(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

function text(parent, x, y, value, attrs) {
  const t = el('text', Object.assign({ x, y }, attrs || {}), parent);
  t.textContent = value;
  return t;
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

function empty(host, message) {
  host.innerHTML = '<p class="hint">' + esc(message) + '</p>';
}

/** Smallest "round" number (1, 2, 2.5, 5 x 10^n) at or above v, for the y-axis top. */
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Horizontal gridlines with labels down the left. */
function yGrid(svg, m, W, y, max, lines, format) {
  for (let i = 0; i <= lines; i++) {
    const v = (max / lines) * i;
    el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: i ? 'var(--grid)' : 'var(--axis)', 'stroke-width': 1 }, svg);
    text(svg, m.l - 8, y(v) + 4, format(v), { 'text-anchor': 'end' });
  }
}

/** An SVG path through points, broken wherever a value is null. */
function linePath(points) {
  let d = '', pen = false;
  for (const p of points) {
    if (p.y === null) { pen = false; continue; }
    d += (pen ? 'L' : 'M') + p.x + ' ' + p.y + ' ';
    pen = true;
  }
  return d;
}

/** Labels at the end of each line, nudged apart so they never overlap. */
function directLabels(svg, ends, x) {
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + LINE.labelNudge);
  for (const e of ends) text(svg, x, e.y + 4, UI.classNames[e.c], { class: 'direct' });
}

// ---- Weekly chart -------------------------------------------------------------

let weeklyMode = UI.weeklyModes.Count;

function weeklyValue(w, c) {
  if (weeklyMode === UI.weeklyModes.Rate) return w.merged[c] ? w.durable[c] / w.merged[c] : null;
  if (weeklyMode === UI.weeklyModes.Share) return w.durable.all ? w.durable[c] / w.durable.all : null;
  return w.durable[c];
}

function weeklyTip(w, c) {
  if (weeklyMode === UI.weeklyModes.Count) return w.durable[c] + ' of ' + w.merged[c];
  return pct(weeklyValue(w, c)) + ' <span class="hint">(' + (weeklyMode === UI.weeklyModes.Rate ? w.durable[c] + ' of ' + w.merged[c] : w.durable[c] + ' of ' + w.durable.all) + ')</span>';
}

function weeklyChart(host) {
  byId(UI.ids.Legend).innerHTML = UI.classes.map((c) => '<span>' + swatch(c) + UI.classNames[c] + '</span>').join('');
  const weeks = R.weeks;
  const matured = weeks.filter((w) => w.matured).length;
  if (matured < 2) return empty(host, 'Needs at least two matured weeks of history.');
  const W = host.clientWidth || 800, H = LINE.height, m = LINE.margin;
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const share = weeklyMode === UI.weeklyModes.Share;
  const ratio = weeklyMode !== UI.weeklyModes.Count;
  const max = ratio ? 1 : niceMax(Math.max(1, ...weeks.filter((w) => w.matured).flatMap((w) => UI.classes.map((c) => w.durable[c]))));
  const slot = iw / weeks.length;
  const x = (i) => m.l + slot * (i + 0.5);
  const y = (v) => m.t + ih - (v / max) * ih;
  const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': 'Durable ' + UI.nouns.plural + ' per week by author' }, host);
  yGrid(svg, m, W, y, max, LINE.gridLines, (v) => (ratio ? pct(v) : Math.round(v * 10) / 10));
  // Weeks still inside the window: shaded, and not plotted, since their numbers are still growing.
  const firstOpen = weeks.findIndex((w) => !w.matured);
  if (firstOpen !== -1) {
    const x0 = m.l + slot * firstOpen;
    el('rect', { x: x0, y: m.t, width: m.l + iw - x0, height: ih, fill: 'var(--wash)' }, svg);
    text(svg, x0 + 6, m.t + 14, 'Maturing', {});
  }
  const step = Math.max(1, Math.ceil(weeks.length / Math.max(2, Math.floor(iw / LINE.minLabelGap))));
  weeks.forEach((w, i) => {
    // "MM-DD" of the week's Monday.
    if (i % step === 0) text(svg, x(i), H - 8, w.week.slice(UI.monthDayOffset), { 'text-anchor': 'middle' });
  });
  const visible = (i) => weeks[i].matured;
  if (share) {
    // 100% stacked columns, with a surface gap between segments.
    const bw = Math.max(2, slot - LINE.columnGap * 2);
    weeks.forEach((w, i) => {
      if (!visible(i) || !w.durable.all) return;
      let acc = 0;
      for (const c of UI.classes) {
        const v = weeklyValue(w, c);
        if (!v) continue;
        const top = y(acc + v), bottom = y(acc);
        el('rect', { x: x(i) - bw / 2, y: top, width: bw, height: Math.max(0, bottom - top - LINE.columnGap), fill: color(c) }, svg);
        acc += v;
      }
    });
  } else {
    const ends = [];
    for (const c of UI.classes) {
      const pts = weeks.map((w, i) => ({ x: x(i), y: visible(i) && weeklyValue(w, c) !== null ? y(weeklyValue(w, c)) : null }));
      el('path', { d: linePath(pts), fill: 'none', stroke: color(c), 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
      const last = pts.filter((p) => p.y !== null).pop();
      if (last) ends.push({ c, y: last.y });
    }
    directLabels(svg, ends, W - m.r + 8);
  }

  const cross = el('line', { y1: m.t, y2: m.t + ih, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' }, svg);
  const dots = UI.classes.map((c) => el('circle', { r: LINE.dot, fill: color(c), stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }, svg));
  const tip = tooltip(host);
  const hit = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' }, svg);
  hit.addEventListener('pointermove', (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(weeks.length - 1, Math.floor((px - m.l) / slot)));
    const w = weeks[i];
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    UI.classes.forEach((c, k) => {
      const v = weeklyValue(w, c);
      const show = !share && w.matured && v !== null;
      dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', show ? y(v) : 0); dots[k].setAttribute('visibility', show ? 'visible' : 'hidden');
    });
    const head = '<div class="hint">Week of ' + w.week + (w.matured ? '' : ' · maturing') + '</div>';
    tip.show(head + UI.classes.map((c) => tipRow(c, weeklyTip(w, c))).join(''), (x(i) / W) * box.width, (m.t / H) * box.height + TOOLTIP_OFFSET.lineChart);
  });
  hit.addEventListener('pointerleave', () => { tip.hide(); cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); });
}

function weeklyModes() {
  const group = byId(UI.ids.WeeklyModes);
  group.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-mode]');
    if (!b) return;
    weeklyMode = b.dataset.mode;
    for (const other of group.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === b));
    const host = byId(UI.ids.Weekly);
    host.innerHTML = '';
    weeklyChart(host);
  });
}

// ---- Per-author bars, with 95% range bands -----------------------------------

function barChart(host, bar) {
  const W = host.clientWidth || 320, m = BAR.margin, rowH = BAR.rowHeight;
  const H = rowH * UI.classes.length;
  const iw = W - m.l - m.r;
  const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img' }, host);
  const tip = tooltip(host);
  UI.classes.forEach((c, i) => {
    const s = R.stats[c];
    const v = s[bar.field];
    const ci = bar.ci ? s[bar.ci] : null;
    const small = s.matured < UI.minSample;
    const cy = i * rowH + rowH / 2;
    text(svg, m.l - 10, cy + 4, UI.classNames[c], { 'text-anchor': 'end', class: 'direct' });
    el('rect', { x: m.l, y: cy - BAR.barHeight / 2, width: iw, height: BAR.barHeight, rx: BAR.barHeight / 2, fill: 'var(--wash)' }, svg);
    // The 95% range as a pale band behind a thinner bar, so both ends of the range stay visible.
    if (ci) el('rect', { x: m.l + ci[0] * iw, y: cy - BAR.bandHeight / 2, width: Math.max(BAR.minWidth, (ci[1] - ci[0]) * iw), height: BAR.bandHeight, rx: BAR.radius, fill: color(c), opacity: BAR.band }, svg);
    if (v) el('rect', { x: m.l, y: cy - BAR.barHeight / 2, width: Math.max(BAR.minWidth, v * iw), height: BAR.barHeight, rx: BAR.barHeight / 2, fill: color(c), opacity: small ? BAR.faded : 1 }, svg);
    // Values sit in their own column past the track, so they never collide with the bar or band.
    const label = text(svg, m.l + iw + BAR.labelGap, cy + 4, pct(v), { class: 'value' });
    if (v !== null) {
      const n = el('tspan', { class: 'hint-text', dx: 6 }, label);
      n.textContent = 'n=' + s.matured;
    }
    const hit = el('rect', { x: 0, y: i * rowH, width: W, height: rowH, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', (ev) => {
      const box = host.getBoundingClientRect();
      const range = ci ? '<div class="hint">95% range ' + pct(ci[0]) + '–' + pct(ci[1]) + '</div>' : '';
      const note = small && v !== null ? '<div class="hint">Small sample: fewer than ' + UI.minSample + ' matured ' + UI.nouns.plural + '</div>' : '';
      tip.show(tipRow(c, pct(v)) + '<div class="hint">' + esc(bar.detail[c]) + '</div>' + range + note, ev.clientX - box.left, (cy / H) * box.height);
    });
    hit.addEventListener('pointerleave', () => tip.hide());
  });
}

// ---- Survival curve --------------------------------------------------------------

function curveChart(host) {
  const rows = R.survivalCurve;
  if (!rows.length) return empty(host, 'No matured ' + UI.nouns.plural + ' measured at every checkpoint yet.');
  const W = host.clientWidth || 480, H = CURVE.height, m = CURVE.margin;
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const values = rows.flatMap((r) => UI.classes.map((c) => r.kept[c])).filter((v) => v !== null);
  // Zoom in on the band the data uses, from a round floor up to 100%.
  const floor = Math.max(0, Math.floor(Math.min(...values) * 10) / 10 - 0.1);
  const lastDay = rows[rows.length - 1].days;
  const x = (d) => m.l + (d / lastDay) * iw;
  const y = (v) => m.t + ih - ((v - floor) / (1 - floor)) * ih;
  const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': 'Share of lines kept over time by author' }, host);
  const lines = 4;
  for (let i = 0; i <= lines; i++) {
    const v = floor + ((1 - floor) / lines) * i;
    el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: i ? 'var(--grid)' : 'var(--axis)', 'stroke-width': 1 }, svg);
    text(svg, m.l - 8, y(v) + 4, pct(v), { 'text-anchor': 'end' });
  }
  for (const r of rows) text(svg, x(r.days), H - 8, 'day ' + r.days, { 'text-anchor': 'middle' });
  const ends = [];
  for (const c of UI.classes) {
    const pts = rows.map((r) => ({ x: x(r.days), y: r.kept[c] === null ? null : y(r.kept[c]) }));
    if (!pts.some((p) => p.y !== null)) continue;
    el('path', { d: linePath(pts), fill: 'none', stroke: color(c), 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
    for (const p of pts) if (p.y !== null) el('circle', { cx: p.x, cy: p.y, r: CURVE.dot, fill: color(c), stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
    ends.push({ c, y: pts[pts.length - 1].y });
  }
  directLabels(svg, ends.filter((e) => e.y !== null), W - m.r + 8);
  const tip = tooltip(host);
  const hit = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' }, svg);
  hit.addEventListener('pointermove', (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    const r = rows.reduce((best, row) => (Math.abs(x(row.days) - px) < Math.abs(x(best.days) - px) ? row : best));
    tip.show('<div class="hint">Day ' + r.days + '</div>' + UI.classes.map((c) => tipRow(c, pct(r.kept[c]))).join(''), (x(r.days) / W) * box.width, (m.t / H) * box.height + TOOLTIP_OFFSET.lineChart);
  });
  hit.addEventListener('pointerleave', () => tip.hide());
}

// ---- Size vs lines kept ------------------------------------------------------------

function scatterChart(host) {
  const pts = R.changes
    .filter((c) => c.status !== UI.remedial && c.durable !== null && c.durability.status === UI.measured && c.size > 0)
    .slice(0, UI.maxScatter);
  if (!pts.length) return empty(host, 'No matured, measured ' + UI.nouns.plural + ' yet.');
  const W = host.clientWidth || 800, H = SCATTER.height, m = SCATTER.margin;
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const lo = Math.floor(Math.log10(Math.min(...pts.map((p) => p.size))));
  const hi = Math.max(lo + 1, Math.ceil(Math.log10(Math.max(...pts.map((p) => p.size)))));
  const x = (size) => m.l + ((Math.log10(size) - lo) / (hi - lo)) * iw;
  const y = (v) => m.t + ih - v * ih;
  const kept = (c) => c.durability.surviving / c.durability.baseline;
  const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': 'Change size against share of lines kept' }, host);
  yGrid(svg, m, W, y, 1, 4, pct);
  for (let e = lo; e <= hi; e++) {
    el('line', { x1: x(Math.pow(10, e)), x2: x(Math.pow(10, e)), y1: m.t, y2: m.t + ih, stroke: 'var(--grid)', 'stroke-width': 1 }, svg);
    text(svg, x(Math.pow(10, e)), H - 12, String(Math.pow(10, e)), { 'text-anchor': 'middle' });
  }
  text(svg, m.l + iw, H - 0, 'lines changed', { 'text-anchor': 'end' });
  const ty = y(R.survivalThreshold);
  el('line', { x1: m.l, x2: m.l + iw, y1: ty, y2: ty, stroke: 'var(--ink-2)', 'stroke-width': 1 }, svg);
  const placed = pts.map((c) => ({ c, px: x(c.size), py: y(Math.min(1, kept(c))) }));
  for (const p of placed) el('circle', { cx: p.px, cy: p.py, r: SCATTER.dot, fill: color(p.c.authorClass), stroke: 'var(--surface)', 'stroke-width': 2, 'fill-opacity': 0.85 }, svg);
  // Drawn after the dots, with a halo, so they never hide it.
  text(svg, m.l + iw - 4, ty + 14, 'threshold ' + pct(R.survivalThreshold), { 'text-anchor': 'end', class: 'direct halo' });
  const ring = el('circle', { r: SCATTER.dot + 3, fill: 'none', stroke: 'var(--ink)', 'stroke-width': 1.5, visibility: 'hidden' }, svg);
  const tip = tooltip(host);
  const hit = el('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent' }, svg);
  let hovered = null;
  hit.addEventListener('pointermove', (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W, py = ((ev.clientY - box.top) / box.height) * H;
    let best = null, bestD = SCATTER.hitRadius * SCATTER.hitRadius;
    for (const p of placed) {
      const d = (p.px - px) * (p.px - px) + (p.py - py) * (p.py - py);
      if (d < bestD) { best = p; bestD = d; }
    }
    hovered = best;
    hit.style.cursor = best ? 'pointer' : '';
    if (!best) { tip.hide(); ring.setAttribute('visibility', 'hidden'); return; }
    ring.setAttribute('cx', best.px); ring.setAttribute('cy', best.py); ring.setAttribute('visibility', 'visible');
    const c = best.c;
    tip.show('<div><b>' + esc(c.id) + '</b> ' + esc(c.title) + '</div>' + tipRow(c.authorClass, pct(kept(c)) + ' kept') + '<div class="hint">' + c.size + ' lines changed · ' + UI.statusNames[c.status] + '</div>', (best.px / W) * box.width, (best.py / H) * box.height);
  });
  hit.addEventListener('pointerleave', () => { hovered = null; tip.hide(); ring.setAttribute('visibility', 'hidden'); });
  hit.addEventListener('click', () => { if (hovered) window.open(hovered.c.url, '_blank', 'noopener'); });
}

// ---- Lead time spread ----------------------------------------------------------

function leadTimeChart(host) {
  const rows = UI.classes.filter((c) => R.stats[c].leadTime);
  if (!rows.length) return empty(host, 'No lead times yet.');
  const W = host.clientWidth || 480, m = BOX.margin, rowH = BOX.rowHeight;
  const H = rowH * rows.length + m.b;
  const iw = W - m.l - m.r;
  // Log scale: lead times span minutes to weeks.
  const qs = rows.map((c) => R.stats[c].leadTime);
  const floor = 1 / 60;
  const lo = Math.log10(Math.max(floor, Math.min(...qs.map((q) => q.p10), UI.leadTicks[0].hours)));
  const hi = Math.log10(Math.max(...qs.map((q) => q.p90), UI.leadTicks[1].hours));
  const x = (h) => m.l + ((Math.log10(Math.max(floor, h)) - lo) / (hi - lo || 1)) * iw;
  const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': 'Lead time spread by author' }, host);
  for (const t of UI.leadTicks) {
    if (Math.log10(t.hours) < lo || Math.log10(t.hours) > hi) continue;
    el('line', { x1: x(t.hours), x2: x(t.hours), y1: 0, y2: rowH * rows.length, stroke: 'var(--grid)', 'stroke-width': 1 }, svg);
    text(svg, x(t.hours), H - 6, t.label, { 'text-anchor': 'middle' });
  }
  const tip = tooltip(host);
  rows.forEach((c, i) => {
    const q = R.stats[c].leadTime;
    const cy = i * rowH + rowH / 2, half = BOX.boxHeight / 2;
    text(svg, m.l - 10, cy + 4, UI.classNames[c], { 'text-anchor': 'end', class: 'direct' });
    el('line', { x1: x(q.p10), x2: x(q.p90), y1: cy, y2: cy, stroke: color(c), 'stroke-width': 2 }, svg);
    for (const v of [q.p10, q.p90]) el('line', { x1: x(v), x2: x(v), y1: cy - BOX.tick, y2: cy + BOX.tick, stroke: color(c), 'stroke-width': 2 }, svg);
    el('rect', { x: x(q.p25), y: cy - half, width: Math.max(2, x(q.p75) - x(q.p25)), height: BOX.boxHeight, rx: 4, fill: color(c), 'fill-opacity': 0.3, stroke: color(c), 'stroke-width': 2 }, svg);
    el('line', { x1: x(q.p50), x2: x(q.p50), y1: cy - half, y2: cy + half, stroke: 'var(--ink)', 'stroke-width': 2 }, svg);
    const hit = el('rect', { x: 0, y: i * rowH, width: W, height: rowH, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', (ev) => {
      const box = host.getBoundingClientRect();
      tip.show(tipRow(c, '') + '<div class="hint">' + esc(UI.leadLabels[c]) + '</div>', ev.clientX - box.left, (cy / H) * box.height);
    });
    hit.addEventListener('pointerleave', () => tip.hide());
  });
}

// ---- Review depth ------------------------------------------------------------

function reviewDepthChart(host) {
  const rows = UI.classes.filter((c) => UI.reviewDepths.some((d) => R.stats[c].reviewDepth[d]));
  if (!rows.length) return empty(host, 'No merged PRs yet.');
  const W = host.clientWidth || 480, m = DEPTH.margin, rowH = DEPTH.rowHeight;
  const H = rowH * rows.length;
  const iw = W - m.l - m.r;
  const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': 'Review depth by author' }, host);
  const tip = tooltip(host);
  rows.forEach((c, i) => {
    const counts = R.stats[c].reviewDepth;
    const total = UI.reviewDepths.reduce((n, d) => n + counts[d], 0);
    const cy = i * rowH + rowH / 2;
    text(svg, m.l - 10, cy + 4, UI.classNames[c], { 'text-anchor': 'end', class: 'direct' });
    let acc = 0;
    UI.reviewDepths.forEach((d, k) => {
      const w = (counts[d] / total) * iw;
      if (!w) return;
      el('rect', { x: m.l + acc, y: cy - DEPTH.barHeight / 2, width: Math.max(1, w - DEPTH.gap), height: DEPTH.barHeight, rx: 3, class: 'depth-' + k }, svg);
      if (w >= DEPTH.minLabelWidth) text(svg, m.l + acc + w / 2, cy + 4, pct(counts[d] / total), { 'text-anchor': 'middle', class: 'on-depth-' + k });
      acc += w;
    });
    const hit = el('rect', { x: 0, y: i * rowH, width: W, height: rowH, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', (ev) => {
      const box = host.getBoundingClientRect();
      const lines = UI.reviewDepths.map((d) => '<div class="row"><span>' + esc(UI.reviewDepthNames[d]) + '</span><b>' + counts[d] + ' · ' + pct(counts[d] / total) + '</b></div>').join('');
      tip.show('<div class="hint">' + UI.classNames[c] + ', ' + total + ' PRs</div>' + lines, ev.clientX - box.left, (cy / H) * box.height);
    });
    hit.addEventListener('pointerleave', () => tip.hide());
  });
}

// ---- Change table ----------------------------------------------------------------

/** Sortable columns: what each sorts by. Missing values sort last. */
const SORTS = {
  date: (p) => Date.parse(p.mergedAt),
  size: (p) => p.size,
  kept: (p) => (p.durability.status === UI.measured ? p.durability.surviving / p.durability.baseline : null),
};

function statusCell(p) {
  const style = UI.statusStyle[p.status];
  const reason = p.durability.reason && (UI.reasonNames[p.durability.reason] || p.durability.reason);
  const title = reason ? ' title="' + esc(reason) + '"' : '';
  const chips = (p.failureReasons || []).map((f) => '<span class="chip">' + esc(UI.failureNames[f]) + '</span>').join('');
  return '<span class="' + style.className + '"' + title + '>' + style.icon + ' ' + UI.statusNames[p.status] + '</span>' + (chips ? '<div>' + chips + '</div>' : '');
}

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const sort = (h.get(HASH.sort) || '').split(SORT_SEP);
  return { cls: h.get(HASH.cls) || '', status: h.get(HASH.status) || '', tool: h.get(HASH.tool) || '', q: h.get(HASH.q) || '', sort: SORTS[sort[0]] ? sort[0] : DEFAULT_SORT, desc: sort[0] ? sort[1] === DESC : true };
}

function writeHash(s) {
  const h = new URLSearchParams();
  for (const k of ['cls', 'status', 'tool', 'q']) if (s[k]) h.set(HASH[k], s[k]);
  if (s.sort !== DEFAULT_SORT || !s.desc) h.set(HASH.sort, s.sort + (s.desc ? SORT_SEP + DESC : ''));
  const next = h.toString();
  history.replaceState(null, '', next ? '#' + next : location.pathname + location.search);
}

function changeTable() {
  const t = byId(UI.ids.Changes);
  const controls = { cls: byId(UI.ids.FilterClass), status: byId(UI.ids.FilterStatus), tool: byId(UI.ids.FilterTool), q: byId(UI.ids.Search) };
  const state = readHash();
  for (const k in controls) if (controls[k]) controls[k].value = state[k];
  const indexed = R.changes.map((p, i) => ({ p, i }));
  let current = [];

  const draw = () => {
    for (const k in controls) state[k] = controls[k] ? controls[k].value.trim() : '';
    writeHash(state);
    const q = state.q.toLowerCase();
    const key = SORTS[state.sort];
    current = indexed
      .filter(({ p }) => (!state.cls || p.authorClass === state.cls) && (!state.status || p.status === state.status) && (!state.tool || p.tool === state.tool))
      .filter(({ p }) => !q || [p.title, p.id, p.author, p.tool, p.repo].some((v) => v && String(v).toLowerCase().includes(q)))
      .sort((a, b) => {
        const va = key(a.p), vb = key(b.p);
        if (va === null || vb === null) return va === null ? (vb === null ? 0 : 1) : -1;
        return state.desc ? vb - va : va - vb;
      });
    const unknown = current.filter(({ p }) => p.status === UI.unknown).length;
    byId(UI.ids.ChangeCount).textContent = current.length + ' of ' + R.changes.length + ' ' + UI.nouns.plural + (unknown ? ' · ' + unknown + ' not measurable' : '') + (current.length > UI.maxRows ? ' · showing the first ' + UI.maxRows : '');
    const sortable = (k, label) => '<th class="n"' + (state.sort === k ? ' aria-sort="' + (state.desc ? 'descending' : 'ascending') + '"' : '') + '><button type="button" class="sort" data-sort="' + k + '">' + label + (state.sort === k ? (state.desc ? ' ↓' : ' ↑') : '') + '</button></th>';
    t.innerHTML = '<thead><tr>' + (UI.multiRepo ? '<th>Repository</th>' : '') + '<th>' + UI.nouns.column + '</th><th>Author</th>' + sortable(DEFAULT_SORT, UI.nouns.date) + sortable('size', 'Size') + sortable('kept', 'Lines kept') + '<th>Status</th><th>Rework</th></tr></thead><tbody>' +
      current.slice(0, UI.maxRows).map(({ p }) => {
        const d = p.durability;
        const kept = d.status === UI.measured ? pct(d.surviving / d.baseline) : UI.empty;
        const rw = p.rework.map((e) => e.kind + ' ' + esc(e.source)).join(', ');
        const tool = p.tool ? ' <span class="hint">' + esc(p.tool) + '</span>' : '';
        return '<tr>' + (UI.multiRepo ? '<td class="nw hint">' + esc(p.repo || '') + '</td>' : '') +
          '<td><a href="' + esc(p.url) + '">' + esc(p.id) + '</a> ' + esc(p.title) + '</td>' +
          '<td><span class="badge" title="' + esc(p.classReason) + '">' + swatch(p.authorClass) + UI.classNames[p.authorClass] + '</span>' + tool + '</td>' +
          '<td class="n nw">' + p.mergedAt.slice(0, UI.isoDateLength) + '</td><td class="n">' + p.size + '</td><td class="n">' + kept + '</td>' +
          '<td>' + statusCell(p) + '</td><td class="hint">' + rw + '</td></tr>';
      }).join('') + '</tbody>';
  };
  for (const k in controls) if (controls[k]) controls[k].addEventListener(k === 'q' ? 'input' : 'change', draw);
  t.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-sort]');
    if (!b) return;
    const k = b.dataset.sort;
    state.desc = state.sort === k ? !state.desc : true;
    state.sort = k;
    draw();
  });
  byId(UI.ids.Download).addEventListener('click', () => {
    const csv = [UI.csv.header, ...current.map(({ i }) => UI.csv.rows[i])].join('\n') + '\n';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = UI.csv.file;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  draw();
}

// ---- Wiring ------------------------------------------------------------------

function drawCharts() {
  const charts = [[UI.ids.Weekly, weeklyChart], [UI.ids.Curve, curveChart], [UI.ids.Scatter, scatterChart], [UI.ids.LeadTime, leadTimeChart], [UI.ids.ReviewDepth, reviewDepthChart]];
  for (const [id, draw] of charts) {
    const host = byId(id);
    if (!host) continue;
    host.innerHTML = '';
    draw(host);
  }
  for (const bar of UI.bars) {
    const host = byId(bar.id);
    host.innerHTML = '';
    barChart(host, bar);
  }
}

weeklyModes();
drawCharts();
changeTable();
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawCharts, RESIZE_DEBOUNCE_MS); });
`;
