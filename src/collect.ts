import { classify, isIgnoredAuthor } from './classify.js';
import { commitChanges, directCommitCount } from './commits.js';
import type { Config } from './config.js';
import { isoDate, MS_PER_DAY, Unit, UnitSetting } from './constants.js';
import type { Store } from './db.js';
import * as g from './git.js';
import type { GitHub } from './github.js';
import type { ModeOptions } from './modes.js';
import { prChanges } from './prs.js';
import type { OpenPrRecord, Snapshot } from './types.js';

export interface CollectOptions {
  repoPath: string;
  gh: GitHub;
  cfg: Config;
  store: Store;
  now?: Date;
  log?: (msg: string) => void;
}

/**
 * `auto` picks commits when more changes land directly on the branch than
 * through merged PRs, which is typical of solo, push-to-branch repos.
 */
export function chooseUnit(requested: UnitSetting, mergedPrs: number, directCommits: number): Unit {
  if (requested !== UnitSetting.Auto) return requested;
  return directCommits > mergedPrs ? Unit.Commits : Unit.Prs;
}

export async function collect({ repoPath, gh, cfg, store, now = new Date(), log = () => {} }: CollectOptions): Promise<Snapshot> {
  const repo = `${gh.owner}/${gh.name}`;
  const since = new Date(now.getTime() - cfg.sinceDays * MS_PER_DAY);

  if (await g.isShallow(repoPath)) {
    throw new Error('This is a shallow clone, so durability cannot be measured. Run `git fetch --unshallow`, or use `fetch-depth: 0` in actions/checkout.');
  }
  const defaultBranch = await gh.defaultBranch();
  const branch = cfg.branch ?? defaultBranch;
  const ref = await g.resolveRef(repoPath, branch);

  log(`Fetching merged PRs for ${repo} since ${isoDate(since.toISOString())}...`);
  const merged = (await gh.mergedPrs(since, (n) => log(`  ${n} PRs`)))
    .filter((p) => p.mergedAt && p.baseRefName === branch && !isIgnoredAuthor(p.author, cfg));
  const open = (await gh.openPrs()).filter((p) => !p.isDraft && p.baseRefName === branch && !isIgnoredAuthor(p.author, cfg));
  const bugs = await gh.issues(cfg.labels.bug, since);

  const branchCommits = (await g.firstParentCommits(repoPath, ref, since)).filter((c) => !isIgnoredAuthor(c.authorName, cfg));
  const direct = directCommitCount(branchCommits, merged);
  const unit = chooseUnit(cfg.unit, merged.length, direct);
  const notes: string[] = [];
  if (unit === Unit.Commits && cfg.unit === UnitSetting.Auto) {
    notes.push(`Most changes on ${branch} bypass pull requests (${direct} direct commits vs ${merged.length} merged PRs), so each commit counts as a change. Use --unit ${Unit.Prs} to count pull requests instead.`);
  } else if (unit === Unit.Prs && direct > 0) {
    notes.push(`${direct} commits landed on ${branch} without a pull request and aren't counted. Use --unit ${Unit.Commits} to include them.`);
  }
  if (unit === Unit.Commits) notes.push('Commit mode: review time is not available, and lead time is first commit to landing on the branch.');
  for (const n of notes) log(`Note: ${n}`);

  const mode: ModeOptions = { repoPath, ref, repo, since, cfg, now, bugIssues: bugs, cache: store.durabilityCache(), log };
  // Commit mode reuses the branch history already read to choose the unit.
  const changes = unit === Unit.Commits ? await commitChanges(branchCommits, mode) : await prChanges(merged, mode);

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
    branch,
    unit,
    collectedAt: now.toISOString(),
    since: since.toISOString(),
    windowDays: cfg.windowDays,
    survivalThreshold: cfg.survivalThreshold,
    changes,
    openPrs,
    notes,
  };
  store.saveSnapshot(snap);
  return snap;
}
