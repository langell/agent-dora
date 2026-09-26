import { classify, isIgnoredAuthor } from './classify.js';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { measureDurability } from './durability.js';
import * as g from './git.js';
import type { GitHub } from './github.js';
import { buildRecord } from './metrics.js';
import { findRework } from './rework.js';
import type { OpenPrRecord, PrRecord, Snapshot } from './types.js';

const DAY = 86_400_000;

export interface CollectOptions {
  repoPath: string;
  gh: GitHub;
  cfg: Config;
  store: Store;
  now?: Date;
  log?: (msg: string) => void;
}

export async function collect({ repoPath, gh, cfg, store, now = new Date(), log = () => {} }: CollectOptions): Promise<Snapshot> {
  const repo = `${gh.owner}/${gh.name}`;
  const since = new Date(now.getTime() - cfg.sinceDays * DAY);

  if (await g.isShallow(repoPath)) {
    throw new Error('This is a shallow clone, so durability cannot be measured. Run `git fetch --unshallow`, or use `fetch-depth: 0` in actions/checkout.');
  }
  const defaultBranch = await gh.defaultBranch();
  const ref = await g.resolveRef(repoPath, defaultBranch);

  log(`Fetching merged PRs for ${repo} since ${since.toISOString().slice(0, 10)}...`);
  const merged = (await gh.mergedPrs(since, (n) => log(`  ${n} PRs`)))
    .filter((p) => p.mergedAt && p.baseRefName === defaultBranch && !isIgnoredAuthor(p.author, cfg));
  const open = (await gh.openPrs()).filter((p) => !p.isDraft && p.baseRefName === defaultBranch && !isIgnoredAuthor(p.author, cfg));
  const bugs = await gh.issues(cfg.labels.bug, since);

  const reverts = await g.revertCommits(repoPath, ref, since);
  const oidCache = new Map<string, string>();
  for (const short of reverts.flatMap((r) => r.reverts)) {
    oidCache.set(short, (await g.expandOid(repoPath, short)) ?? short);
  }
  const rework = findRework(merged, bugs, reverts, (s) => oidCache.get(s) ?? s, cfg);

  log(`Measuring durability of ${merged.length} PRs against ${ref}...`);
  const cache = store.durabilityCache();
  const prs: PrRecord[] = [];
  for (const [i, pr] of merged.entries()) {
    const { authorClass, reason } = classify(pr, cfg);
    const durability = await measureDurability(repoPath, ref, { ...pr, mergedAt: pr.mergedAt! }, cfg, now, cache);
    prs.push(buildRecord(pr, authorClass, reason, rework.filter((e) => e.target === pr.number), durability, cfg));
    if ((i + 1) % 25 === 0) log(`  ${i + 1}/${merged.length}`);
  }

  const openPrs: OpenPrRecord[] = open.map((pr) => ({
    number: pr.number,
    title: pr.title,
    url: pr.url,
    authorClass: classify(pr, cfg).authorClass,
    createdAt: pr.createdAt,
    awaitingFirstReview: !pr.reviews.some((r) => r.author !== pr.author),
  }));

  const snap: Snapshot = {
    repo,
    defaultBranch,
    collectedAt: now.toISOString(),
    since: since.toISOString(),
    windowDays: cfg.windowDays,
    survivalThreshold: cfg.survivalThreshold,
    prs,
    openPrs,
  };
  store.saveSnapshot(snap);
  return snap;
}
