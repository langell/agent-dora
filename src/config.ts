import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuthorClass, CONFIG_FILE, DeploySourceSetting, UnitSetting } from './constants.js';

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
  /**
   * Changes adding fewer measurable lines than this are judged on reverts and rework
   * alone, since one later edit would swing their survival share wildly.
   */
  minSurvivalLines: number;
  /** How far back to collect merged PRs. */
  sinceDays: number;
  /**
   * Days after landing, before the window ends, at which to also measure how many lines
   * are left. They draw the survival curve; each one adds a `git blame` per changed file.
   */
  checkpointDays: number[];
  /** Length of the two periods the report compares (the latest matured one and the one before). */
  compareDays: number;
  /** How many leading path segments group files into a hotspot directory. */
  hotspotDepth: number;
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
  /**
   * AI tool names, each with a regex (case-insensitive) that recognises it in whatever
   * marked a change as AI-written: the agent login, branch prefix or matched trailer.
   * Merged key by key with the defaults; the first match in order wins.
   */
  tools: Record<string, string>;
  /** PR authors excluded from all metrics (dependency bots and other automation). */
  ignoreAuthors: string[];
  /**
   * Reviewer logins that are automated (AI review bots). Their reviews don't count as a
   * first review. Accounts GitHub reports as bots, and `agentAuthors`, are always excluded.
   */
  botReviewers: string[];
  /** Globs of files excluded from durability measurement. */
  ignoreFiles: string[];
  /** Production deployments, for deploy-based lead time and deployment frequency. */
  deployments: {
    /** `auto` uses GitHub Deployments when the repo has production ones, else Vercel when configured. */
    source: DeploySourceSetting;
    /** Regex (case-insensitive) matching production environment names. */
    environment: string;
    /** Vercel project ids or names, for the Vercel source (needs VERCEL_TOKEN). */
    vercelProjects: string[];
    /** Vercel team id, when the projects belong to a team. */
    vercelTeamId: string;
  };
  /** Incident and bug trackers, each used when its credentials are set. */
  incidents: {
    /** Linear team keys to read (empty: every team). Needs LINEAR_API_KEY. */
    linearTeams: string[];
    /** Linear labels that mark an incident or production bug. */
    linearLabels: string[];
    /** Jira site, e.g. "acme.atlassian.net". Needs JIRA_EMAIL and JIRA_API_TOKEN. */
    jiraSite: string;
    /** JQL selecting incidents or production bugs; a date bound is added. */
    jiraJql: string;
    /** PagerDuty service ids (empty: every service). Needs PAGERDUTY_TOKEN. */
    pagerdutyServices: string[];
    /** An incident with no `Caused-by` link counts against the last production deploy this many hours before it. */
    attributionHours: number;
  };
  /** AI spend. The Anthropic Admin API is read when ANTHROPIC_ADMIN_KEY is set. */
  cost: {
    /** CSV (`date,tool,usd[,actor]`) or Claude Code OpenTelemetry (OTLP JSON) files, relative to the repo. */
    files: string[];
    /**
     * Only count spend by these people (emails or API key names). Spend is reported for the whole
     * organization, so set this to the people working on this repository, or use `rollup`.
     */
    actors: string[];
  };
}

export const DEFAULT_CONFIG: Config = {
  unit: UnitSetting.Auto,
  windowDays: 21,
  survivalThreshold: 0.7,
  minSurvivalLines: 5,
  sinceDays: 180,
  checkpointDays: [7, 14],
  compareDays: 28,
  hotspotDepth: 2,
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
  // Not `claude/` or `cursor/`: interactive, person-driven tools also create branches with
  // those prefixes, so they'd mark assisted work as agent work. Add them if your team only
  // uses them for autonomous runs.
  agentBranchPrefixes: ['codex/', 'copilot/', 'devin/', 'jules/', 'openhands/'],
  assistedPatterns: [
    // Tool names that are never a person's name...
    'Co-Authored-By:.*\\b(Copilot|Cursor|Codex|Gemini|Aider|Windsurf)\\b',
    // ...and, for agents named like people (Claude, Devin, Jules, Amp), their addresses.
    'noreply@anthropic\\.com',
    'Co-Authored-By:.*<[^>]*(devin-ai-integration|google-labs-jules|@ampcode\\.com)',
    'Generated with \\[?Claude Code',
  ],
  tools: {
    Claude: 'claude|anthropic',
    Copilot: 'copilot',
    Codex: 'codex|openai|chatgpt',
    Cursor: 'cursor',
    Devin: 'devin',
    Jules: 'jules',
    Gemini: 'gemini',
    Aider: 'aider',
    Windsurf: 'windsurf',
    OpenHands: 'openhands',
    Amp: 'ampcode',
  },
  ignoreAuthors: ['dependabot', 'renovate', 'github-actions', 'pre-commit-ci', 'snyk-bot'],
  botReviewers: [
    'copilot-pull-request-reviewer',
    'coderabbitai',
    'gemini-code-assist',
    'sourcery-ai',
    'greptile-apps',
    'ellipsis-dev',
    'qodo-merge-pro',
    'cubic-dev-ai',
  ],
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
  deployments: {
    source: DeploySourceSetting.Auto,
    environment: '^production',
    vercelProjects: [],
    vercelTeamId: '',
  },
  incidents: {
    linearTeams: [],
    linearLabels: ['Bug', 'Incident'],
    jiraSite: '',
    jiraJql: 'issuetype in (Bug, Incident)',
    pagerdutyServices: [],
    attributionHours: 24,
  },
  cost: {
    files: [],
    actors: [],
  },
};

/** Config keys with no default value. */
const OPTIONAL_KEYS: readonly string[] = ['branch'] satisfies (keyof Config)[];
/** Config keys holding an object merged key by key with the default. */
const MERGED_KEYS = ['labels', 'tools', 'deployments', 'incidents', 'cost'] as const satisfies readonly (keyof Config)[];
type MergedKey = (typeof MERGED_KEYS)[number];
/** Merged objects whose keys are the user's to name (tool names), not a fixed set. */
const OPEN_KEYS: readonly MergedKey[] = ['tools'];

const describe = (v: unknown) => (Array.isArray(v) ? 'an array' : v === null ? 'null' : typeof v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks `value` against the shape of `def`; returns what's wrong, or null. */
function mismatch(value: unknown, def: unknown): string | null {
  if (Array.isArray(def)) {
    // An empty default array holds strings.
    const type = def.length ? typeof def[0] : 'string';
    return Array.isArray(value) && value.every((x) => typeof x === type) ? null : `an array of ${type}s`;
  }
  return typeof value === typeof def ? null : `a ${typeof def}`;
}

/**
 * Checks a parsed config file against the shape of `DEFAULT_CONFIG`. Wrong types are
 * errors; unknown keys only warn, since they're usually typos that silently do nothing.
 */
function validate(raw: unknown, file: string, warn: (msg: string) => void): Partial<Config> {
  if (!isObject(raw)) throw new Error(`${file} must hold a JSON object`);
  const defaults: Record<string, unknown> = DEFAULT_CONFIG as unknown as Record<string, unknown>;
  const check = (path: string, value: unknown, def: unknown) => {
    const wrong = mismatch(value, def);
    if (wrong) throw new Error(`${file}: "${path}" must be ${wrong}, got ${describe(value)}`);
  };
  for (const [key, value] of Object.entries(raw)) {
    if (OPTIONAL_KEYS.includes(key)) {
      check(key, value, '');
    } else if (!(key in defaults)) {
      warn(`${file}: unknown key "${key}" has no effect`);
    } else if ((MERGED_KEYS as readonly string[]).includes(key)) {
      if (!isObject(value)) throw new Error(`${file}: "${key}" must be an object, got ${describe(value)}`);
      const inner = defaults[key] as Record<string, unknown>;
      const open = (OPEN_KEYS as readonly string[]).includes(key);
      for (const [k, v] of Object.entries(value)) {
        if (open) check(`${key}.${k}`, v, Object.values(inner)[0]);
        else if (!(k in inner)) warn(`${file}: unknown key "${key}.${k}" has no effect`);
        else check(`${key}.${k}`, v, inner[k]);
      }
    } else {
      check(key, value, defaults[key]);
    }
  }
  return raw as Partial<Config>;
}

function checkRegex(source: string, where: string): void {
  try {
    new RegExp(source);
  } catch (err) {
    throw new Error(`${where} is not a valid regex: ${(err as Error).message}`);
  }
}

/**
 * Loads `.agent-dora.json` from the repo, if present, over the defaults.
 * Arrays replace the default arrays; `labels` and `tools` merge key by key.
 */
export function loadConfig(repoPath: string, overrides: Partial<Config> = {}, warn: (msg: string) => void = () => {}): Config {
  const file = join(repoPath, CONFIG_FILE);
  let fromFile: Partial<Config> = {};
  if (existsSync(file)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Could not parse ${file}: ${(err as Error).message}`);
    }
    fromFile = validate(raw, CONFIG_FILE, warn);
  }
  const merged: Config = {
    ...DEFAULT_CONFIG,
    ...fromFile,
    ...overrides,
    labels: { ...DEFAULT_CONFIG.labels, ...fromFile.labels, ...overrides.labels },
    tools: { ...DEFAULT_CONFIG.tools, ...fromFile.tools, ...overrides.tools },
    deployments: { ...DEFAULT_CONFIG.deployments, ...fromFile.deployments, ...overrides.deployments },
    incidents: { ...DEFAULT_CONFIG.incidents, ...fromFile.incidents, ...overrides.incidents },
    cost: { ...DEFAULT_CONFIG.cost, ...fromFile.cost, ...overrides.cost },
  };
  checkRegex(merged.deployments.environment, 'deployments.environment');
  const sources: readonly string[] = Object.values(DeploySourceSetting);
  if (!sources.includes(merged.deployments.source)) {
    throw new Error(`deployments.source must be one of ${sources.join(', ')}, got "${merged.deployments.source}"`);
  }
  if (!(merged.incidents.attributionHours > 0)) throw new Error(`incidents.attributionHours must be positive, got ${merged.incidents.attributionHours}`);
  merged.assistedPatterns.forEach((p, i) => checkRegex(p, `assistedPatterns[${i}]`));
  for (const [name, p] of Object.entries(merged.tools)) checkRegex(p, `tools.${name}`);
  if (!merged.checkpointDays.every((d) => d > 0)) throw new Error(`checkpointDays must be positive, got ${merged.checkpointDays.join(', ')}`);
  if (!(merged.compareDays > 0)) throw new Error(`compareDays must be positive, got ${merged.compareDays}`);
  if (!(Number.isInteger(merged.hotspotDepth) && merged.hotspotDepth > 0)) throw new Error(`hotspotDepth must be a positive whole number, got ${merged.hotspotDepth}`);
  if (!(merged.survivalThreshold > 0 && merged.survivalThreshold <= 1)) {
    throw new Error(`survivalThreshold must be in (0, 1], got ${merged.survivalThreshold}`);
  }
  const units: readonly string[] = Object.values(UnitSetting);
  if (!units.includes(merged.unit)) {
    throw new Error(`unit must be one of ${units.join(', ')}, got "${merged.unit}"`);
  }
  if (!(merged.windowDays > 0)) throw new Error(`windowDays must be positive, got ${merged.windowDays}`);
  if (!(Number.isInteger(merged.minSurvivalLines) && merged.minSurvivalLines >= 0)) {
    throw new Error(`minSurvivalLines must be a whole number, got ${merged.minSurvivalLines}`);
  }
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
