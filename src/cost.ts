import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Config } from './config.js';
import { CostSource, EnvVar, isoDate, MS_PER_DAY, OTHER_TOOL } from './constants.js';
import { fetchJson } from './http.js';
import type { CostEntry } from './types.js';
import { mapLimit } from './util.js';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/organizations/usage_report/claude_code';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_PAGE_SIZE = 1000;
/** Days fetched at once from the Anthropic API (it serves one day per request). */
const ANTHROPIC_CONCURRENCY = 4;
const CENTS_PER_DOLLAR = 100;
/** What Anthropic's Claude Code usage is called when matching it to a configured tool. */
const CLAUDE_CODE_TOOL = 'Claude Code';
/** Claude Code's OpenTelemetry metric for spend, in USD. */
const OTEL_COST_METRIC = 'claude_code.cost.usage';
const OTEL_EMAIL_ATTRIBUTE = 'user.email';
/** OTLP `AggregationTemporality`: cumulative sums need differencing, delta sums don't. */
const OTEL_CUMULATIVE = new Set<unknown>([2, 'AGGREGATION_TEMPORALITY_CUMULATIVE']);
const NANOS_PER_MS = 1_000_000n;
/** Currency symbols and thousands separators to drop from amounts. */
const CURRENCY_FORMATTING = /[$,\s]/g;
/** Columns a cost CSV must have; `actor` is optional. */
const CsvColumn = { Date: 'date', Tool: 'tool', Usd: 'usd', Actor: 'actor' } as const;

/** Spend for days that are over: stored once, never fetched again. */
export interface CostCache {
  get(source: string, date: string): CostEntry[] | undefined;
  set(source: string, date: string, entries: CostEntry[]): void;
}

/** The configured tool name a source's own name matches, e.g. "Claude Code" -> "Claude". */
export function toolName(name: string, cfg: Config): string {
  return Object.entries(cfg.tools).find(([, p]) => new RegExp(p, 'i').test(name))?.[0] ?? OTHER_TOOL;
}

/** UTC days from `since` through `now`, as "YYYY-MM-DD". */
function days(since: Date, now: Date): string[] {
  const out: string[] = [];
  for (let t = Date.parse(isoDate(since.toISOString())); t <= now.getTime(); t += MS_PER_DAY) out.push(isoDate(new Date(t).toISOString()));
  return out;
}

// ---- Anthropic Admin API: Claude Code usage ---------------------------------------

type ClaudeCodeRecord = {
  date: string;
  actor: { type: string; email_address?: string; api_key_name?: string };
  model_breakdown?: { estimated_cost?: { amount: number | string } }[];
};

/** Claude Code spend per person per day, from the Anthropic Admin API. Finished days come from `cache`. */
export async function claudeCodeCosts(adminKey: string, since: Date, now: Date, cfg: Config, cache?: CostCache): Promise<CostEntry[]> {
  const today = isoDate(now.toISOString());
  const tool = toolName(CLAUDE_CODE_TOOL, cfg);
  const perDay = await mapLimit(days(since, now), ANTHROPIC_CONCURRENCY, async (date): Promise<CostEntry[]> => {
    const cached = cache?.get(CostSource.ClaudeCode, date);
    if (cached) return cached;
    const entries: CostEntry[] = [];
    let page: string | null = null;
    do {
      const params = new URLSearchParams({ starting_at: date, limit: String(ANTHROPIC_PAGE_SIZE) });
      if (page) params.set('page', page);
      const res: { data: ClaudeCodeRecord[]; has_more: boolean; next_page: string | null } = await fetchJson(
        `${ANTHROPIC_API}?${params}`,
        { headers: { 'x-api-key': adminKey, 'anthropic-version': ANTHROPIC_VERSION } },
        'Anthropic',
      );
      for (const r of res.data) {
        // Estimated cost is reported in cents.
        const cents = (r.model_breakdown ?? []).reduce((n, m) => n + Number(m.estimated_cost?.amount ?? 0), 0);
        if (cents) entries.push({ source: CostSource.ClaudeCode, date, tool, actor: r.actor.email_address ?? r.actor.api_key_name ?? null, usd: cents / CENTS_PER_DOLLAR });
      }
      page = res.has_more ? res.next_page : null;
    } while (page);
    // Today is still accumulating, so only finished days are cached.
    if (date < today) cache?.set(CostSource.ClaudeCode, date, entries);
    return entries;
  });
  return perDay.flat();
}

// ---- Files: Claude Code OpenTelemetry (OTLP JSON) and CSV --------------------------

type OtlpAttribute = { key: string; value: { stringValue?: string } };
type OtlpPoint = { attributes?: OtlpAttribute[]; asDouble?: number; asInt?: string | number; timeUnixNano: string };
type OtlpMetric = { name: string; sum?: { dataPoints: OtlpPoint[]; aggregationTemporality?: unknown } };
type OtlpRequest = { resourceMetrics?: { resource?: { attributes?: OtlpAttribute[] }; scopeMetrics?: { metrics?: OtlpMetric[] }[] }[] };

const attr = (attrs: OtlpAttribute[] | undefined, key: string) => attrs?.find((a) => a.key === key)?.value.stringValue;

/**
 * Claude Code spend per person per day from an OTLP JSON export of its telemetry
 * (one request per line, as a collector's file exporter writes, or a single request).
 * Delta sums are added up; cumulative ones are differenced per series.
 */
export function otlpCosts(content: string, cfg: Config): CostEntry[] {
  const tool = toolName(CLAUDE_CODE_TOOL, cfg);
  const requests: OtlpRequest[] = content.trim().startsWith('[')
    ? (JSON.parse(content) as OtlpRequest[])
    : content.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as OtlpRequest);
  const totals = new Map<string, CostEntry>();
  const lastCumulative = new Map<string, number>();
  const points: { series: string; cumulative: boolean; ms: number; value: number; actor: string | null }[] = [];
  for (const req of requests) {
    for (const rm of req.resourceMetrics ?? []) {
      for (const sm of rm.scopeMetrics ?? []) {
        for (const m of sm.metrics ?? []) {
          if (m.name !== OTEL_COST_METRIC || !m.sum) continue;
          const cumulative = OTEL_CUMULATIVE.has(m.sum.aggregationTemporality);
          for (const p of m.sum.dataPoints) {
            const all = [...(rm.resource?.attributes ?? []), ...(p.attributes ?? [])];
            points.push({
              series: JSON.stringify(all.map((a) => [a.key, a.value.stringValue]).sort()),
              cumulative,
              ms: Number(BigInt(p.timeUnixNano) / NANOS_PER_MS),
              value: Number(p.asDouble ?? p.asInt ?? 0),
              actor: attr(all, OTEL_EMAIL_ATTRIBUTE) ?? null,
            });
          }
        }
      }
    }
  }
  for (const p of points.sort((a, b) => a.ms - b.ms)) {
    let spent = p.value;
    if (p.cumulative) {
      const prev = lastCumulative.get(p.series);
      lastCumulative.set(p.series, p.value);
      // The first point of a cumulative series has no baseline; a drop means the counter reset.
      spent = prev === undefined ? 0 : p.value >= prev ? p.value - prev : p.value;
    }
    if (!spent) continue;
    const date = isoDate(new Date(p.ms).toISOString());
    const key = `${date}\n${p.actor ?? ''}`;
    const e = totals.get(key) ?? { source: CostSource.File, date, tool, actor: p.actor, usd: 0 };
    e.usd += spent;
    totals.set(key, e);
  }
  return [...totals.values()];
}

/** Splits one CSV line, honouring double-quoted fields. */
function csvFields(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') out.push(cur), (cur = '');
    else cur += ch;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

/** Spend rows from a CSV with a `date,tool,usd[,actor]` header, in any column order. */
export function csvCosts(content: string, file: string): CostEntry[] {
  const [head, ...rows] = content.split(/\r?\n/).filter((l) => l.trim());
  const cols = csvFields(head ?? '').map((c) => c.toLowerCase());
  const at = (name: string) => cols.indexOf(name);
  for (const required of [CsvColumn.Date, CsvColumn.Tool, CsvColumn.Usd]) {
    if (at(required) === -1) throw new Error(`${file}: the header needs a "${required}" column (date,tool,usd[,actor])`);
  }
  return rows.map((row, i) => {
    const f = csvFields(row);
    // Spreadsheet exports often format amounts as "$1,000.50".
    const usd = Number((f[at(CsvColumn.Usd)] ?? '').replace(CURRENCY_FORMATTING, ''));
    const date = f[at(CsvColumn.Date)] ?? '';
    if (!Number.isFinite(usd) || Number.isNaN(Date.parse(date))) throw new Error(`${file}: row ${i + 2} needs a date and a number in usd`);
    return { source: CostSource.File, date: isoDate(new Date(date).toISOString()), tool: f[at(CsvColumn.Tool)] ?? OTHER_TOOL, actor: f[at(CsvColumn.Actor)] || null, usd };
  });
}

/** Reads a cost file: OTLP JSON if it parses as telemetry, CSV otherwise. */
export function fileCosts(path: string, cfg: Config): CostEntry[] {
  const content = readFileSync(path, 'utf8');
  const first = content.trimStart()[0];
  return first === '{' || first === '[' ? otlpCosts(content, cfg) : csvCosts(content, path);
}

// ---- All sources ----------------------------------------------------------------------

/**
 * AI spend from every configured source, from `since` on, limited to `cost.actors` if set;
 * null if no source is set up. A source that fails adds a note instead of stopping the run.
 */
export async function loadCosts(cfg: Config, repoPath: string, since: Date, now: Date, cache: CostCache | undefined, note: (msg: string) => void, log: (msg: string) => void): Promise<CostEntry[] | null> {
  const adminKey = process.env[EnvVar.AnthropicAdminKey];
  if (!adminKey && !cfg.cost.files.length) return null;
  const out: CostEntry[] = [];
  if (adminKey) {
    log('Fetching Claude Code spend from the Anthropic Admin API...');
    try {
      out.push(...(await claudeCodeCosts(adminKey, since, now, cfg, cache)));
    } catch (err) {
      note(`Couldn't read Claude Code spend from the Anthropic Admin API: ${(err as Error).message}`);
    }
  }
  for (const file of cfg.cost.files) {
    try {
      out.push(...fileCosts(isAbsolute(file) ? file : join(repoPath, file), cfg));
    } catch (err) {
      note(`Couldn't read cost file ${file}: ${(err as Error).message}`);
    }
  }
  const actors = new Set(cfg.cost.actors.map((a) => a.toLowerCase()));
  const sinceDay = isoDate(since.toISOString());
  return out.filter((e) => e.date >= sinceDay && (!actors.size || (e.actor !== null && actors.has(e.actor.toLowerCase()))));
}
