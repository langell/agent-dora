import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuthorClass, CONFIG_FILE, UnitSetting } from './constants.js';

export { CONFIG_FILE } from './constants.js';

/** The label applied to a PR of each author class, unless configured otherwise. */
export const CLASS_LABELS: Record<AuthorClass, string> = {
  [AuthorClass.Agent]: 'ai:agent',
  [AuthorClass.Assisted]: 'ai:assisted',
  [AuthorClass.Human]: 'ai:none',
};

export interface Config {
  /**
   * What counts as one change. `prs`: merged pull requests. `commits`: each commit on the
   * branch. `auto`: commits when most changes on the branch bypass pull requests.
   */
  unit: UnitSetting;
  /** Branch to measure. Defaults to the repository's default branch. */
  branch?: string;
  /** How long a change must survive before it counts as durable. */
  windowDays: number;
  /** Minimum share of a PR's added lines that must survive the window. */
  survivalThreshold: number;
  /** How far back to collect merged PRs. */
  sinceDays: number;
  /** Labels that mark a PR's author class (the first is the one `label` applies), plus: */
  labels: Record<AuthorClass, string[]> & {
    /** Labels on a PR that fixes an earlier PR (it must reference that PR as #N). */
    rework: string[];
    /** Labels on issues that may carry a `Caused-by: #N` reference. */
    bug: string[];
  };
  /** PR author logins treated as autonomous coding agents. A `[bot]` suffix is ignored. */
  agentAuthors: string[];
  /** Head branch prefixes that mark a PR as agent-authored. */
  agentBranchPrefixes: string[];
  /** Regexes (case-insensitive) over commit messages and PR body that mark AI assistance. */
  assistedPatterns: string[];
  /** PR authors excluded from all metrics (dependency bots and other automation). */
  ignoreAuthors: string[];
  /** Globs of files excluded from durability measurement. */
  ignoreFiles: string[];
}

export const DEFAULT_CONFIG: Config = {
  unit: UnitSetting.Auto,
  windowDays: 21,
  survivalThreshold: 0.7,
  sinceDays: 180,
  labels: {
    [AuthorClass.Agent]: [CLASS_LABELS[AuthorClass.Agent]],
    [AuthorClass.Assisted]: [CLASS_LABELS[AuthorClass.Assisted]],
    [AuthorClass.Human]: [CLASS_LABELS[AuthorClass.Human]],
    rework: ['rework', 'hotfix', 'regression'],
    bug: ['bug'],
  },
  agentAuthors: [
    'Copilot',
    'copilot-swe-agent',
    'claude',
    'devin-ai-integration',
    'chatgpt-codex-connector',
    'openai-codex',
    'cursor',
    'sweep-ai',
    'openhands-agent',
    'google-labs-jules',
  ],
  agentBranchPrefixes: ['claude/', 'codex/', 'copilot/', 'cursor/', 'devin/', 'jules/', 'openhands/'],
  assistedPatterns: [
    'Co-Authored-By:.*\\b(Claude|Copilot|Cursor|Codex|Devin|Gemini|Aider|Windsurf|Cline|Amp|Jules)\\b',
    'noreply@anthropic\\.com',
    'Generated with \\[?Claude Code',
  ],
  ignoreAuthors: ['dependabot', 'renovate', 'github-actions', 'pre-commit-ci', 'snyk-bot'],
  ignoreFiles: [
    '**/package-lock.json',
    '**/pnpm-lock.yaml',
    '**/yarn.lock',
    '**/bun.lock',
    '**/bun.lockb',
    '**/Cargo.lock',
    '**/poetry.lock',
    '**/uv.lock',
    '**/go.sum',
    '**/Gemfile.lock',
    '**/*.min.js',
    '**/*.snap',
    '**/dist/**',
    '**/build/**',
    '**/vendor/**',
    '**/__generated__/**',
  ],
};

/**
 * Loads `.agent-dora.json` from the repo, if present, over the defaults.
 * Arrays replace the default arrays; `labels` merges key by key.
 */
export function loadConfig(repoPath: string, overrides: Partial<Config> = {}): Config {
  const file = join(repoPath, CONFIG_FILE);
  let fromFile: Partial<Config> = {};
  if (existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8')) as Partial<Config>;
    } catch (err) {
      throw new Error(`Could not parse ${file}: ${(err as Error).message}`);
    }
  }
  const merged: Config = {
    ...DEFAULT_CONFIG,
    ...fromFile,
    ...overrides,
    labels: { ...DEFAULT_CONFIG.labels, ...fromFile.labels, ...overrides.labels },
  };
  if (!(merged.survivalThreshold > 0 && merged.survivalThreshold <= 1)) {
    throw new Error(`survivalThreshold must be in (0, 1], got ${merged.survivalThreshold}`);
  }
  const units: readonly string[] = Object.values(UnitSetting);
  if (!units.includes(merged.unit)) {
    throw new Error(`unit must be one of ${units.join(', ')}, got "${merged.unit}"`);
  }
  if (!(merged.windowDays > 0)) throw new Error(`windowDays must be positive, got ${merged.windowDays}`);
  return merged;
}

/** Minimal glob matcher: `**` spans directories, `*` and `?` stay within one segment. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function fileMatcher(globs: string[]): (path: string) => boolean {
  const res = globs.map(globToRegExp);
  return (path) => res.some((r) => r.test(path));
}
