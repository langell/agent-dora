import type { Config } from './config.js';
import { AUTHOR_CLASSES, AuthorClass, BOT_SUFFIX, ClassSource } from './constants.js';

export interface Classifiable {
  author: string | null;
  labels: string[];
  headRefName: string;
  body: string;
  commits: { message: string }[];
}

export interface Classification {
  authorClass: AuthorClass;
  /** Which signal decided it; use this, not `reason`, to branch on. */
  source: ClassSource;
  /** Human-readable detail, e.g. which label or pattern matched. */
  reason: string;
}

/** Lowercased login without GitHub's bot suffix, so `claude[bot]` matches `claude`. */
export function normLogin(login: string): string {
  const lower = login.toLowerCase();
  return lower.endsWith(BOT_SUFFIX) ? lower.slice(0, -BOT_SUFFIX.length) : lower;
}

export function isBotLogin(login: string): boolean {
  return login.toLowerCase().endsWith(BOT_SUFFIX);
}

export function isIgnoredAuthor(author: string | null, cfg: Config): boolean {
  if (!author) return false;
  const a = normLogin(author);
  return cfg.ignoreAuthors.some((x) => normLogin(x) === a);
}

/**
 * Decides who wrote a PR, in precedence order:
 * 1. an explicit label (`ai:agent`, `ai:assisted`, `ai:none`) always wins;
 * 2. an agent login or agent branch prefix means the agent opened the PR -> agent;
 * 3. an AI co-author trailer or tool marker in commits or body -> assisted;
 * 4. otherwise -> human.
 */
export function classify(pr: Classifiable, cfg: Config): Classification {
  const labels = new Set(pr.labels.map((l) => l.toLowerCase()));
  for (const cls of AUTHOR_CLASSES) {
    const hit = cfg.labels[cls].find((l) => labels.has(l.toLowerCase()));
    if (hit) return { authorClass: cls, source: ClassSource.Label, reason: `label ${hit}` };
  }

  if (pr.author) {
    const a = normLogin(pr.author);
    if (cfg.agentAuthors.some((x) => normLogin(x) === a)) {
      return { authorClass: AuthorClass.Agent, source: ClassSource.Author, reason: `author ${pr.author}` };
    }
  }
  const prefix = cfg.agentBranchPrefixes.find((p) => pr.headRefName.startsWith(p));
  if (prefix) return { authorClass: AuthorClass.Agent, source: ClassSource.Branch, reason: `branch ${prefix}*` };

  const patterns = cfg.assistedPatterns.map((p) => new RegExp(p, 'im'));
  const texts = [pr.body, ...pr.commits.map((c) => c.message)];
  for (const re of patterns) {
    if (texts.some((t) => re.test(t))) {
      return { authorClass: AuthorClass.Assisted, source: ClassSource.Trailer, reason: `matched /${re.source}/` };
    }
  }

  return { authorClass: AuthorClass.Human, source: ClassSource.None, reason: 'no AI signal' };
}
