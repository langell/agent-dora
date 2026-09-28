import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { classify, isBotLogin } from './classify.js';
import { collect } from './collect.js';
import { CLASS_LABELS, DEFAULT_CONFIG, loadConfig, type Config } from './config.js';
import {
  AUTHOR_CLASSES,
  CACHE_DIR,
  CACHE_FILE,
  Command,
  CONFIG_FILE,
  DEFAULT_OUT_DIR,
  GIT_REMOTE,
  ReportFile,
  TOOL_NAME,
  UnitSetting,
} from './constants.js';
import { Store } from './db.js';
import { remoteRepo } from './git.js';
import { GitHub, resolveToken } from './github.js';
import { aggregate } from './metrics.js';
import { renderHtml } from './report-html.js';
import { nouns, renderMarkdown } from './report.js';

const unitChoices = Object.values(UnitSetting).join('|');

const HELP = `${TOOL_NAME}: delivery metrics for teams shipping with AI coding agents

Usage: ${TOOL_NAME} [command] [options]

Commands:
  ${Command.Run.padEnd(10)} Collect, then write the report (default)
  ${Command.Collect.padEnd(10)} Fetch changes and measure durability from local git history
  ${Command.Report.padEnd(10)} Write the dashboard from the last collected snapshot
  ${Command.Classify.padEnd(10)} Print how a PR is classified (${AUTHOR_CLASSES.join(', ')})
  ${Command.Label.padEnd(10)} Classify a PR and apply the matching label on GitHub

Options:
  --repo <owner/name>   GitHub repository (default: the ${GIT_REMOTE} remote)
  --path <dir>          Local clone with full history (default: .)
  --db <file>           SQLite cache (default: <path>/${CACHE_DIR}/${CACHE_FILE})
  --out <dir>           Report output directory (default: ${DEFAULT_OUT_DIR})
  --unit <${unitChoices}>
                        What counts as a change: merged PRs, or commits on the
                        branch. ${UnitSetting.Auto} picks commits when most changes skip PRs
                        (default: ${DEFAULT_CONFIG.unit})
  --branch <name>       Branch to measure (default: the repo's default branch)
  --since <days>        How far back to collect (default: ${DEFAULT_CONFIG.sinceDays})
  --window <days>       Durability window (default: ${DEFAULT_CONFIG.windowDays})
  --threshold <0-1>     Share of added lines that must survive (default: ${DEFAULT_CONFIG.survivalThreshold})
  --pr <number>         PR for ${Command.Classify} / ${Command.Label}
  -h, --help            Show this help

Auth: GITHUB_TOKEN or GH_TOKEN, or an existing \`gh auth login\`.
Config: optional ${CONFIG_FILE} in the repo root (see README).`;

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      path: { type: 'string', default: '.' },
      db: { type: 'string' },
      out: { type: 'string', default: DEFAULT_OUT_DIR },
      since: { type: 'string' },
      unit: { type: 'string' },
      branch: { type: 'string' },
      window: { type: 'string' },
      threshold: { type: 'string' },
      pr: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const command = positionals[0] ?? Command.Run;
  if (values.help || command === Command.Help) {
    console.log(HELP);
    return;
  }

  const repoPath = resolve(values.path!);
  const overrides: Partial<Config> = {};
  if (values.unit) overrides.unit = values.unit as UnitSetting; // validated by loadConfig
  if (values.branch) overrides.branch = values.branch;
  if (values.since) overrides.sinceDays = positiveNumber('--since', values.since);
  if (values.window) overrides.windowDays = positiveNumber('--window', values.window);
  if (values.threshold) overrides.survivalThreshold = positiveNumber('--threshold', values.threshold);
  const cfg = loadConfig(repoPath, overrides);
  const dbPath = resolve(values.db ?? join(repoPath, CACHE_DIR, CACHE_FILE));
  const log = (msg: string) => console.error(msg);

  const github = async () => {
    const repo = values.repo ?? (await remoteRepo(repoPath));
    if (!repo) throw new Error(`Could not detect the repository from the ${GIT_REMOTE} remote; pass --repo owner/name.`);
    const { owner, name } = GitHub.parseRepo(repo);
    return new GitHub(await resolveToken(), owner, name);
  };

  switch (command) {
    case Command.Run:
    case Command.Collect:
      return withStore(dbPath, async (store) => {
        const snap = await collect({ repoPath, gh: await github(), cfg, store, log });
        log(`Collected ${snap.changes.length} ${nouns(snap.unit).plural} on ${snap.branch}, and ${snap.openPrs.length} open PRs.`);
        if (command === Command.Run) writeReport(store, snap.repo, resolve(values.out!), log);
      });
    case Command.Report:
      return withStore(dbPath, (store) => writeReport(store, values.repo, resolve(values.out!), log));
    case Command.Classify:
    case Command.Label: {
      const number = Number(values.pr);
      if (!Number.isInteger(number) || number <= 0) throw new Error(`${command} needs --pr <number>`);
      const gh = await github();
      const pr = await gh.pullRequest(number);
      let cls = classify(pr, cfg);
      if (command === Command.Label) {
        const family = AUTHOR_CLASSES.flatMap((c) => cfg.labels[c]);
        const existing = pr.labels.find((l) => family.some((f) => f.toLowerCase() === l.toLowerCase()));
        // A label a person applied is a correction and wins. A label a bot applied
        // (our own earlier run) is re-evaluated, since new commits may add AI trailers.
        const actor = existing ? await gh.labelActor(number, existing) : null;
        if (!existing || actor === null || isBotLogin(actor)) {
          cls = classify({ ...pr, labels: pr.labels.filter((l) => l !== existing) }, cfg);
          await gh.setLabel(number, cfg.labels[cls.authorClass][0] ?? CLASS_LABELS[cls.authorClass], family);
        }
      }
      console.log(JSON.stringify({ number, authorClass: cls.authorClass, source: cls.source, reason: cls.reason }));
      return;
    }
    default:
      throw new Error(`Unknown command "${command}". Run ${TOOL_NAME} --help.`);
  }
}

/** Opens the cache, runs `fn`, and always closes it. */
async function withStore<T>(dbPath: string, fn: (store: Store) => T | Promise<T>): Promise<T> {
  const store = new Store(dbPath);
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

function positiveNumber(flag: string, raw: string): number {
  const n = Number(raw);
  if (!(n > 0)) throw new Error(`${flag} must be a positive number, got "${raw}"`);
  return n;
}

function writeReport(store: Store, repo: string | undefined, outDir: string, log: (m: string) => void): void {
  const snap = store.loadSnapshot(repo);
  if (!snap) throw new Error(`No collected data yet. Run \`${TOOL_NAME} ${Command.Collect}\` first.`);
  const report = aggregate(snap);
  const summary = renderMarkdown(report);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, ReportFile.Html), renderHtml(report));
  writeFileSync(join(outDir, ReportFile.Json), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, ReportFile.Summary), summary);
  // Inside GitHub Actions, publish the summary and report location directly,
  // so the action doesn't need to know our file names.
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `report-dir=${outDir}\n`);
  log(`Wrote ${join(outDir, ReportFile.Html)}`);
}
