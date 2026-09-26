import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { classify, CLASS_LABELS } from './classify.js';
import { collect } from './collect.js';
import { loadConfig, type Config } from './config.js';
import { Store } from './db.js';
import { remoteRepo } from './git.js';
import { GitHub, resolveToken } from './github.js';
import { aggregate } from './metrics.js';
import { renderHtml, renderMarkdown } from './report.js';

const HELP = `agent-dora: delivery metrics for teams shipping with AI coding agents

Usage: agent-dora [command] [options]

Commands:
  run        Collect, then write the report (default)
  collect    Fetch PRs from GitHub and measure durability from local git history
  report     Write the dashboard from the last collected snapshot
  classify   Print how a PR is classified (agent, assisted or human)
  label      Classify a PR and apply the matching ai:* label on GitHub

Options:
  --repo <owner/name>   GitHub repository (default: the origin remote)
  --path <dir>          Local clone with full history (default: .)
  --db <file>           SQLite cache (default: <path>/.agent-dora/cache.db)
  --out <dir>           Report output directory (default: agent-dora-report)
  --unit <auto|prs|commits>
                        What counts as a change: merged PRs, or commits on the
                        branch. auto picks commits when most changes skip PRs
                        (default: auto)
  --branch <name>       Branch to measure (default: the repo's default branch)
  --since <days>        How far back to collect (default: 180)
  --window <days>       Durability window (default: 21)
  --threshold <0-1>     Share of added lines that must survive (default: 0.7)
  --pr <number>         PR for classify / label
  -h, --help            Show this help

Auth: GITHUB_TOKEN or GH_TOKEN, or an existing \`gh auth login\`.
Config: optional .agent-dora.json in the repo root (see README).`;

export async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      path: { type: 'string', default: '.' },
      db: { type: 'string' },
      out: { type: 'string', default: 'agent-dora-report' },
      since: { type: 'string' },
      unit: { type: 'string' },
      branch: { type: 'string' },
      window: { type: 'string' },
      threshold: { type: 'string' },
      pr: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const command = positionals[0] ?? 'run';
  if (values.help || command === 'help') {
    console.log(HELP);
    return;
  }

  const repoPath = resolve(values.path!);
  const overrides: Partial<Config> = {};
  if (values.unit) overrides.unit = values.unit as Config['unit'];
  if (values.branch) overrides.branch = values.branch;
  if (values.since) overrides.sinceDays = positiveNumber('--since', values.since);
  if (values.window) overrides.windowDays = positiveNumber('--window', values.window);
  if (values.threshold) overrides.survivalThreshold = positiveNumber('--threshold', values.threshold);
  const cfg = loadConfig(repoPath, overrides);
  const dbPath = resolve(values.db ?? join(repoPath, '.agent-dora', 'cache.db'));
  const log = (msg: string) => console.error(msg);

  const github = async () => {
    const repo = values.repo ?? (await remoteRepo(repoPath));
    if (!repo) throw new Error('Could not detect the repository from the origin remote; pass --repo owner/name.');
    const { owner, name } = GitHub.parseRepo(repo);
    return new GitHub(await resolveToken(), owner, name);
  };

  switch (command) {
    case 'run':
    case 'collect': {
      const store = new Store(dbPath);
      try {
        const snap = await collect({ repoPath, gh: await github(), cfg, store, log });
        const noun = snap.unit === 'commits' ? 'commits' : 'merged PRs';
        log(`Collected ${snap.changes.length} ${noun} on ${snap.branch}, and ${snap.openPrs.length} open PRs.`);
        if (command === 'run') writeReport(store, snap.repo, resolve(values.out!), log);
      } finally {
        store.close();
      }
      return;
    }
    case 'report': {
      const store = new Store(dbPath);
      try {
        writeReport(store, values.repo, resolve(values.out!), log);
      } finally {
        store.close();
      }
      return;
    }
    case 'classify':
    case 'label': {
      const number = Number(values.pr);
      if (!Number.isInteger(number) || number <= 0) throw new Error(`${command} needs --pr <number>`);
      const gh = await github();
      const pr = await gh.pullRequest(number);
      let { authorClass, reason } = classify(pr, cfg);
      if (command === 'label') {
        const family = [...cfg.labels.agent, ...cfg.labels.assisted, ...cfg.labels.human];
        const existing = pr.labels.find((l) => family.some((f) => f.toLowerCase() === l.toLowerCase()));
        // A label a person applied is a correction and wins. A label a bot applied
        // (our own earlier run) is re-evaluated, since new commits may add AI trailers.
        const actor = existing ? await gh.labelActor(number, existing) : null;
        if (!existing || actor === null || actor.endsWith('[bot]')) {
          ({ authorClass, reason } = classify({ ...pr, labels: pr.labels.filter((l) => l !== existing) }, cfg));
          await gh.setLabel(number, cfg.labels[authorClass][0] ?? CLASS_LABELS[authorClass], family);
        }
      }
      console.log(JSON.stringify({ number, authorClass, reason }));
      return;
    }
    default:
      throw new Error(`Unknown command "${command}". Run agent-dora --help.`);
  }
}

function positiveNumber(flag: string, raw: string): number {
  const n = Number(raw);
  if (!(n > 0)) throw new Error(`${flag} must be a positive number, got "${raw}"`);
  return n;
}

function writeReport(store: Store, repo: string | undefined, outDir: string, log: (m: string) => void): void {
  const snap = store.loadSnapshot(repo);
  if (!snap) throw new Error('No collected data yet. Run `agent-dora collect` first.');
  const report = aggregate(snap);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), renderHtml(report));
  writeFileSync(join(outDir, 'metrics.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, 'summary.md'), renderMarkdown(report));
  log(`Wrote ${join(outDir, 'index.html')}`);
}
