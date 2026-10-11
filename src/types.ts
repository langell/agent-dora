import type {
  AuthorClass,
  ChangeKind,
  ClassSource,
  CostSource,
  DeploySource,
  DeployStatus,
  DurabilityStatus,
  IncidentSource,
  ReviewDepth,
  ReviewState,
  ReworkKind,
  ReworkSourceKind,
  UnavailableReason,
  Unit,
} from './constants.js';

export type { AuthorClass, ClassKey, ReworkKind, Unit } from './constants.js';

export interface PrCommit {
  oid: string;
  message: string;
  authoredDate: string;
  /** Git author, which some agents and tools mark (`Cursor Agent`, `Jane (aider)`). */
  authorName?: string;
  authorEmail?: string;
}

export interface PrReview {
  submittedAt: string;
  author: string | null;
  /** GitHub reports the reviewer as a bot account (Copilot review, CodeRabbit...). */
  isBot: boolean;
  state: ReviewState;
  /** The review left a written body or inline comments. */
  commented: boolean;
}

/** A pull request as fetched from GitHub, before any analysis. */
export interface RawPr {
  number: number;
  title: string;
  body: string;
  url: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  labels: string[];
  mergeCommitOid: string | null;
  additions: number;
  deletions: number;
  commitCount: number;
  commits: PrCommit[];
  reviews: PrReview[];
}

export interface RawIssue {
  number: number;
  title: string;
  body: string;
  createdAt: string;
}

/** What showed that a change needed fixing: a PR, a commit, a GitHub bug issue, or a tracker incident. */
export type ReworkSource =
  | { kind: typeof ReworkSourceKind.Pr; number: number }
  | { kind: typeof ReworkSourceKind.Commit; oid: string }
  | { kind: typeof ReworkSourceKind.Issue; number: number }
  | { kind: typeof ReworkSourceKind.Incident; source: IncidentSource; id: string };

/** A deployment to production. */
export interface Deployment {
  source: DeploySource;
  /** Environment name as the source reports it, e.g. "Production". */
  environment: string;
  sha: string;
  createdAt: string;
  /** When it went live; null unless it succeeded. */
  readyAt: string | null;
  status: DeployStatus;
  url: string | null;
}

/** An incident or production bug from a tracker. */
export interface Incident {
  source: IncidentSource;
  /** The tracker's own id, e.g. "ENG-123", "PROJ-45" or PagerDuty's incident number. */
  id: string;
  title: string;
  url: string;
  createdAt: string;
  /** When it was resolved, if it has been. */
  resolvedAt: string | null;
  /** Title and description, searched for `Caused-by` references. */
  text: string;
}

/** AI spend for one day, from one source. */
export interface CostEntry {
  source: CostSource;
  /** "YYYY-MM-DD" (UTC). */
  date: string;
  /** Tool name matching `Config.tools`, e.g. "Claude". */
  tool: string;
  /** Who spent it (an email or login), when the source says. */
  actor: string | null;
  usd: number;
}

/** Evidence that a change needed fixing after it shipped. */
export interface ReworkEvent {
  /** PR number or full commit SHA of the change that needed fixing. */
  target: number | string;
  kind: ReworkKind;
  at: string;
  /** Where the evidence came from. Missing in snapshots from before 0.3. */
  from?: ReworkSource;
  /** `from` as shown to users: "#12", a short SHA, or "issue #5". */
  source: string;
}

/** One file's share of a measured change. */
export interface FileSurvival {
  /** Path at the time the change landed. */
  path: string;
  baseline: number;
  surviving: number;
}

/** How many of a change's lines were left some days after it landed. */
export interface CurvePoint {
  days: number;
  /** null when the branch history doesn't reach that day. */
  surviving: number | null;
}

export interface Durability {
  status: DurabilityStatus;
  /** Lines the PR added, as attributed by `git blame` at the merge commit. */
  baseline: number;
  /** Of those lines, how many are still attributed to the PR at merge + window. */
  surviving: number;
  reason?: UnavailableReason;
  /** Per-file breakdown of a measured change. */
  files?: FileSurvival[];
  /** Survival at each of the configured checkpoints before the window ends. */
  curve?: CurvePoint[];
}

export interface ChangeRecord {
  kind: ChangeKind;
  /** Display id: "#123" for a PR, a short SHA for a commit. */
  id: string;
  /** PR number; null for commits. */
  number: number | null;
  /** The commit that landed the change (a PR's merge commit), if known. */
  oid: string | null;
  /** `owner/name`, set when changes from several repositories are combined. */
  repo?: string;
  title: string;
  url: string;
  author: string | null;
  authorClass: AuthorClass;
  classSource: ClassSource;
  classReason: string;
  /** The AI tool behind an agent or assisted change ("Claude", "Copilot"...); null for human ones. */
  tool: string | null;
  createdAt: string;
  mergedAt: string;
  firstCommitAt: string | null;
  /** When the change first went live in production; null if not yet, or no deployment data. */
  deployedAt: string | null;
  /** First commit to production. */
  deployLeadTimeHours: number | null;
  /** First review by a person other than the author; bot reviews don't count. */
  firstReviewAt: string | null;
  leadTimeHours: number | null;
  reviewWaitHours: number | null;
  /** How closely a person reviewed the PR; null in commit mode. */
  reviewDepth: ReviewDepth | null;
  size: number;
  rework: ReworkEvent[];
  durability: Durability;
  /**
   * false as soon as the change is reverted or reworked, even inside its window;
   * true only once the window has elapsed; null while it can't be known yet.
   */
  durable: boolean | null;
  /** The change reverts or fixes an earlier one, so it doesn't count as durable output. */
  remedial: boolean;
}

export interface OpenPrRecord {
  /** `owner/name`, set when changes from several repositories are combined. */
  repo?: string;
  number: number;
  title: string;
  url: string;
  authorClass: AuthorClass;
  createdAt: string;
  awaitingFirstReview: boolean;
}

export interface Snapshot {
  repo: string;
  defaultBranch: string;
  /** Branch the changes landed on. */
  branch: string;
  unit: Unit;
  collectedAt: string;
  since: string;
  windowDays: number;
  survivalThreshold: number;
  /** Missing in snapshots from before 0.3, which used the default. */
  minSurvivalLines?: number;
  /** The repositories combined into this snapshot by `rollup`. */
  repos?: string[];
  /** Production deployments in the period, oldest first. Missing when no deployment source is set up. */
  deployments?: Deployment[];
  /** Incidents from trackers in the period. */
  incidents?: Incident[];
  /** Daily AI spend in the period. */
  costs?: CostEntry[];
  changes: ChangeRecord[];
  openPrs: OpenPrRecord[];
  /** Things the reader should know about how this data was collected. */
  notes: string[];
}
