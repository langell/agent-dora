import type { Config } from './config.js';
import type { AuthorClass } from './types.js';

export interface Classifiable {
  author: string | null;
  labels: string[];
  headRefName: string;
  body: string;
  commits: { message: string }[];
}

export interface Classification {
  authorClass: AuthorClass;
  reason: string;
}

const normLogin = (login: string) => login.toLowerCase().replace(/\[bot\]$/, '');

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
  for (const cls of ['agent', 'assisted', 'human'] as const) {
    const hit = cfg.labels[cls].find((l) => labels.has(l.toLowerCase()));
    if (hit) return { authorClass: cls, reason: `label ${hit}` };
  }

  if (pr.author) {
    const a = normLogin(pr.author);
    if (cfg.agentAuthors.some((x) => normLogin(x) === a)) {
      return { authorClass: 'agent', reason: `author ${pr.author}` };
    }
  }
  const prefix = cfg.agentBranchPrefixes.find((p) => pr.headRefName.startsWith(p));
  if (prefix) return { authorClass: 'agent', reason: `branch ${prefix}*` };

  const patterns = cfg.assistedPatterns.map((p) => new RegExp(p, 'im'));
  const texts = [pr.body, ...pr.commits.map((c) => c.message)];
  for (const re of patterns) {
    if (texts.some((t) => re.test(t))) return { authorClass: 'assisted', reason: `matched /${re.source}/` };
  }

  return { authorClass: 'human', reason: 'no AI signal' };
}

export const CLASS_LABELS: Record<AuthorClass, string> = {
  agent: 'ai:agent',
  assisted: 'ai:assisted',
  human: 'ai:none',
};
