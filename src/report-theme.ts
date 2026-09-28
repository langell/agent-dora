/** Dashboard design tokens and stylesheet. */
import { AUTHOR_CLASSES, AuthorClass } from './constants.js';

/** Design tokens, emitted as CSS custom properties. Series colors are validated for colorblind safety. */
export const THEME = {
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

export const SERIES_COLORS: Record<AuthorClass, { light: string; dark: string }> = {
  [AuthorClass.Agent]: { light: '#2a78d6', dark: '#3987e5' },
  [AuthorClass.Assisted]: { light: '#eb6834', dark: '#d95926' },
  [AuthorClass.Human]: { light: '#1baf7a', dark: '#199e70' },
};

/** CSS custom property holding an author class's series color. */
export const seriesVar = (c: AuthorClass) => `--series-${c}`;

export function cssVars(mode: keyof typeof THEME): string {
  const tokens = Object.entries(THEME[mode]).map(([k, v]) => `--${k}: ${v};`);
  const series = AUTHOR_CLASSES.map((c) => `${seriesVar(c)}: ${SERIES_COLORS[c][mode]};`);
  return [`color-scheme: ${mode};`, ...tokens, ...series].join(' ');
}

/** The dashboard stylesheet; colors come from the custom properties `cssVars` defines. */
export const STYLES = `* { box-sizing: border-box; }
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

