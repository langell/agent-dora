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
export const CLASS_SOURCES: readonly ClassSource[] = Object.values(ClassSource);

export const CLASS_SOURCE_NAMES: Record<ClassSource, string> = {
  [ClassSource.Label]: 'Label',
  [ClassSource.Author]: 'Agent account',
  [ClassSource.Branch]: 'Branch prefix',
  [ClassSource.Trailer]: 'Commit trailer or marker',
  [ClassSource.None]: 'No AI signal',
};

/** The tool name for AI-written changes no configured tool pattern recognises. */
export const OTHER_TOOL = 'Other';

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

/** Why durability couldn't be measured. Stored in snapshots, so these codes must stay stable. */
export const UnavailableReason = {
  NoMergeCommit: 'no-merge-commit',
  NotInHistory: 'not-in-history',
  NotOnBranch: 'not-on-branch',
  NoMeasurableLines: 'no-measurable-lines',
} as const;
export type UnavailableReason = ValueOf<typeof UnavailableReason>;

export const UNAVAILABLE_REASON_NAMES: Record<UnavailableReason, string> = {
  [UnavailableReason.NoMergeCommit]: 'no merge commit',
  [UnavailableReason.NotInHistory]: 'merge commit not in local history (use fetch-depth: 0)',
  [UnavailableReason.NotOnBranch]: 'not merged into the measured branch',
  [UnavailableReason.NoMeasurableLines]: 'no measurable added lines',
};

/** Kinds of evidence that a change needed fixing. An incident is a defect that escaped to production. */
export const ReworkKind = { Revert: 'revert', Rework: 'rework', Bug: 'bug', Incident: 'incident' } as const;
export type ReworkKind = ValueOf<typeof ReworkKind>;

/** What kind of thing showed that a change needed fixing. */
export const ReworkSourceKind = { Pr: 'pr', Commit: 'commit', Issue: 'issue', Incident: 'incident' } as const;
export type ReworkSourceKind = ValueOf<typeof ReworkSourceKind>;

/** A change's standing in the report, derived from its durability. */
export const ChangeStatus = { Durable: 'durable', Failed: 'failed', Pending: 'pending', Unknown: 'unknown', Remedial: 'remedial' } as const;
export type ChangeStatus = ValueOf<typeof ChangeStatus>;

export const CHANGE_STATUS_NAMES: Record<ChangeStatus, string> = {
  [ChangeStatus.Durable]: 'Durable',
  [ChangeStatus.Failed]: 'Not durable',
  [ChangeStatus.Pending]: 'Maturing',
  [ChangeStatus.Unknown]: 'Unknown',
  [ChangeStatus.Remedial]: 'Fix or revert',
};

/** Why a change wasn't durable: the kinds of rework, or too many of its lines rewritten. */
export const FailureReason = { ...ReworkKind, Churned: 'churned' } as const;
export type FailureReason = ValueOf<typeof FailureReason>;

export const FAILURE_REASON_NAMES: Record<FailureReason, string> = {
  [FailureReason.Revert]: 'Reverted',
  [FailureReason.Rework]: 'Reworked',
  [FailureReason.Bug]: 'Caused a bug',
  [FailureReason.Incident]: 'Caused an incident',
  [FailureReason.Churned]: 'Lines rewritten',
};

/** Who fixed a change: an author class, a bug report, or a change outside the collected data. */
export const FIXER_ISSUE = 'issue';
export const FIXER_OUTSIDE = 'outside';
export type FixerKey = AuthorClass | typeof FIXER_ISSUE | typeof FIXER_OUTSIDE;
export const FIXER_KEYS: readonly FixerKey[] = [...AUTHOR_CLASSES, FIXER_ISSUE, FIXER_OUTSIDE];
export const FIXER_NAMES: Record<FixerKey, string> = {
  [AuthorClass.Agent]: CLASS_NAMES[AuthorClass.Agent],
  [AuthorClass.Assisted]: CLASS_NAMES[AuthorClass.Assisted],
  [AuthorClass.Human]: CLASS_NAMES[AuthorClass.Human],
  [FIXER_ISSUE]: 'Bug report',
  [FIXER_OUTSIDE]: 'Not in this data',
};

/** How closely a person reviewed a PR before it merged. */
export const ReviewDepth = { None: 'none', Silent: 'silent', Engaged: 'engaged' } as const;
export type ReviewDepth = ValueOf<typeof ReviewDepth>;
export const REVIEW_DEPTHS: readonly ReviewDepth[] = Object.values(ReviewDepth);

export const REVIEW_DEPTH_NAMES: Record<ReviewDepth, string> = {
  [ReviewDepth.None]: 'No human review',
  [ReviewDepth.Silent]: 'Approved without comment',
  [ReviewDepth.Engaged]: 'Commented or requested changes',
};

// ---- Deployments, incidents and AI cost ---------------------------------------

/** Where production deployments come from. */
export const DeploySource = { GitHub: 'github', Vercel: 'vercel' } as const;
export type DeploySource = ValueOf<typeof DeploySource>;

/** The deployments setting: a source, the first available one, or none. */
export const DeploySourceSetting = { ...DeploySource, Auto: 'auto', None: 'none' } as const;
export type DeploySourceSetting = ValueOf<typeof DeploySourceSetting>;

/** How a deployment ended. */
export const DeployStatus = { Success: 'success', Failure: 'failure', Pending: 'pending' } as const;
export type DeployStatus = ValueOf<typeof DeployStatus>;

/** Incident and bug trackers. */
export const IncidentSource = { Linear: 'linear', Jira: 'jira', PagerDuty: 'pagerduty' } as const;
export type IncidentSource = ValueOf<typeof IncidentSource>;

export const INCIDENT_SOURCE_NAMES: Record<IncidentSource, string> = {
  [IncidentSource.Linear]: 'Linear',
  [IncidentSource.Jira]: 'Jira',
  [IncidentSource.PagerDuty]: 'PagerDuty',
};

/** Identifies an incident across trackers, e.g. "linear:ENG-12". */
export const incidentKey = (source: IncidentSource, id: string) => `${source}:${id}`;

/** Where AI spend comes from. */
export const CostSource = { ClaudeCode: 'claude-code', File: 'file' } as const;
export type CostSource = ValueOf<typeof CostSource>;

/** Environment variables holding credentials for the optional integrations. */
export const EnvVar = {
  AnthropicAdminKey: 'ANTHROPIC_ADMIN_KEY',
  VercelToken: 'VERCEL_TOKEN',
  LinearApiKey: 'LINEAR_API_KEY',
  JiraEmail: 'JIRA_EMAIL',
  JiraApiToken: 'JIRA_API_TOKEN',
  PagerDutyToken: 'PAGERDUTY_TOKEN',
} as const;

/** GitHub's `PullRequestReviewState` values. */
export const ReviewState = {
  Approved: 'APPROVED',
  ChangesRequested: 'CHANGES_REQUESTED',
  Commented: 'COMMENTED',
  Dismissed: 'DISMISSED',
  Pending: 'PENDING',
} as const;
export type ReviewState = ValueOf<typeof ReviewState>;

// ---- CLI --------------------------------------------------------------------

export const Command = { Run: 'run', Collect: 'collect', Report: 'report', Rollup: 'rollup', Classify: 'classify', Label: 'label', Help: 'help' } as const;
export type Command = ValueOf<typeof Command>;

/** The repo-root config file. */
export const CONFIG_FILE = `.${TOOL_NAME}.json`;
/** Cache directory, relative to the repo. */
export const CACHE_DIR = `.${TOOL_NAME}`;
export const CACHE_FILE = 'cache.db';
export const DEFAULT_OUT_DIR = `${TOOL_NAME}-report`;

export const ReportFile = { Html: 'index.html', Json: 'metrics.json', Summary: 'summary.md', Csv: 'changes.csv' } as const;

// ---- Time -------------------------------------------------------------------

export const SECONDS_PER_MINUTE = 60;
export const MINUTES_PER_HOUR = 60;
export const HOURS_PER_DAY = 24;
export const DAYS_PER_WEEK = 7;
export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
export const MS_PER_HOUR = MINUTES_PER_HOUR * MS_PER_MINUTE;
export const MS_PER_DAY = HOURS_PER_DAY * MS_PER_HOUR;
export const MS_PER_WEEK = DAYS_PER_WEEK * MS_PER_DAY;

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

/** Lengths of the leading parts of an ISO timestamp, by the shape of the part. */
export const ISO_DATE_LENGTH = 'YYYY-MM-DD'.length;
export const ISO_MINUTE_LENGTH = 'YYYY-MM-DDTHH:MM'.length;
/** Where "MM-DD" starts in an ISO date. */
export const ISO_MONTH_DAY_OFFSET = 'YYYY-'.length;

/** "2026-09-28" from an ISO timestamp. */
export const isoDate = (iso: string) => iso.slice(0, ISO_DATE_LENGTH);
/** "2026-09-28 14:21" from an ISO timestamp. */
export const isoMinute = (iso: string) => iso.slice(0, ISO_MINUTE_LENGTH).replace('T', ' ');
