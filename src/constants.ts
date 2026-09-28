/**
 * Shared constants. Any string or number that means something to more than one
 * place in the code lives here, so there is one spelling of it and one place to change it.
 *
 * Domain values are `as const` objects with a type of the same name derived from them:
 * `AuthorClass.Agent` is the value, `AuthorClass` is the union of all values.
 */

type ValueOf<T> = T[keyof T];

export const TOOL_NAME = 'agent-dora';

// ---- Domain values ---------------------------------------------------------

/** Who wrote a change. */
export const AuthorClass = { Agent: 'agent', Assisted: 'assisted', Human: 'human' } as const;
export type AuthorClass = ValueOf<typeof AuthorClass>;
export const AUTHOR_CLASSES: readonly AuthorClass[] = Object.values(AuthorClass);

/** Stats are also reported across every author class. */
export const ALL_CLASSES = 'all';
export type ClassKey = AuthorClass | typeof ALL_CLASSES;
export const CLASS_KEYS: readonly ClassKey[] = [...AUTHOR_CLASSES, ALL_CLASSES];

export const CLASS_NAMES: Record<ClassKey, string> = {
  [AuthorClass.Agent]: 'Agent',
  [AuthorClass.Assisted]: 'Assisted',
  [AuthorClass.Human]: 'Human',
  [ALL_CLASSES]: 'All',
};

/** Which signal decided a change's author class. */
export const ClassSource = { Label: 'label', Author: 'author', Branch: 'branch', Trailer: 'trailer', None: 'none' } as const;
export type ClassSource = ValueOf<typeof ClassSource>;

/** What counts as one change. */
export const Unit = { Prs: 'prs', Commits: 'commits' } as const;
export type Unit = ValueOf<typeof Unit>;

/** The unit setting: a unit, or let the data decide. */
export const UnitSetting = { ...Unit, Auto: 'auto' } as const;
export type UnitSetting = ValueOf<typeof UnitSetting>;

export const ChangeKind = { Pr: 'pr', Commit: 'commit' } as const;
export type ChangeKind = ValueOf<typeof ChangeKind>;

export const DurabilityStatus = { Measured: 'measured', Pending: 'pending', Unavailable: 'unavailable' } as const;
export type DurabilityStatus = ValueOf<typeof DurabilityStatus>;

/** Why durability couldn't be measured. Shown to users as-is. */
export const UnavailableReason = {
  NoMergeCommit: 'no merge commit',
  NotInHistory: 'merge commit not in local history (use fetch-depth: 0)',
  NotOnBranch: 'not merged into the default branch',
  NoMeasurableLines: 'no measurable added lines',
} as const;
export type UnavailableReason = ValueOf<typeof UnavailableReason>;

export const ReworkKind = { Revert: 'revert', Rework: 'rework', Bug: 'bug' } as const;
export type ReworkKind = ValueOf<typeof ReworkKind>;

/** A change's standing in the report, derived from its durability. */
export const ChangeStatus = { Durable: 'durable', Failed: 'failed', Pending: 'pending', Unknown: 'unknown' } as const;
export type ChangeStatus = ValueOf<typeof ChangeStatus>;

export const CHANGE_STATUS_NAMES: Record<ChangeStatus, string> = {
  [ChangeStatus.Durable]: 'Durable',
  [ChangeStatus.Failed]: 'Not durable',
  [ChangeStatus.Pending]: 'Maturing',
  [ChangeStatus.Unknown]: 'Unknown',
};

// ---- CLI --------------------------------------------------------------------

export const Command = { Run: 'run', Collect: 'collect', Report: 'report', Classify: 'classify', Label: 'label', Help: 'help' } as const;
export type Command = ValueOf<typeof Command>;

/** The repo-root config file. */
export const CONFIG_FILE = `.${TOOL_NAME}.json`;
/** Cache directory, relative to the repo. */
export const CACHE_DIR = `.${TOOL_NAME}`;
export const CACHE_FILE = 'cache.db';
export const DEFAULT_OUT_DIR = `${TOOL_NAME}-report`;

export const ReportFile = { Html: 'index.html', Json: 'metrics.json', Summary: 'summary.md' } as const;

// ---- Time -------------------------------------------------------------------

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;
export const MS_PER_WEEK = 7 * MS_PER_DAY;

// ---- Git & GitHub -----------------------------------------------------------

export const GIT_REMOTE = 'origin';
/** Length of the abbreviated commit SHAs shown to users. */
export const SHORT_SHA_LENGTH = 7;
/** GitHub web host; GitHub Actions sets GITHUB_SERVER_URL on GitHub Enterprise Server. */
export const GITHUB_WEB_URL = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
export const githubCommitUrl = (repo: string, oid: string) => `${GITHUB_WEB_URL}/${repo}/commit/${oid}`;

/** GitHub appends this to bot account logins. */
export const BOT_SUFFIX = '[bot]';

/** How changes are identified to users: "#123" for a PR, a short SHA for a commit. */
export const prId = (number: number) => `#${number}`;
export const shortSha = (oid: string) => oid.slice(0, SHORT_SHA_LENGTH);

/** "2026-09-28" from an ISO timestamp. */
export const isoDate = (iso: string) => iso.slice(0, 'YYYY-MM-DD'.length);
/** "2026-09-28 14:21" from an ISO timestamp. */
export const isoMinute = (iso: string) => iso.slice(0, 'YYYY-MM-DDTHH:MM'.length).replace('T', ' ');
