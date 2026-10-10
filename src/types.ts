import type { AuthorClass, ChangeKind, ClassSource, DurabilityStatus, ReviewState, ReworkKind, ReworkSourceKind, UnavailableReason, Unit } from './constants.js';

export type { AuthorClass, ClassKey, ReworkKind, Unit } from './constants.js';

export interface PrCommit {
  oid: string;
  message: string;
  authoredDate: string;
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

/** What showed that a change needed fixing: a PR, a commit, or a bug issue. */
export type ReworkSource =
  | { kind: typeof ReworkSourceKind.Pr; number: number }
  | { kind: typeof ReworkSourceKind.Commit; oid: string }
  | { kind: typeof ReworkSourceKind.Issue; number: number };

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

export interface Durability {
  status: DurabilityStatus;
  /** Lines the PR added, as attributed by `git blame` at the merge commit. */
  baseline: number;
  /** Of those lines, how many are still attributed to the PR at merge + window. */
  surviving: number;
  reason?: UnavailableReason;
}

export interface ChangeRecord {
  kind: ChangeKind;
  /** Display id: "#123" for a PR, a short SHA for a commit. */
  id: string;
  /** PR number; null for commits. */
  number: number | null;
  title: string;
  url: string;
  author: string | null;
  authorClass: AuthorClass;
  classSource: ClassSource;
  classReason: string;
  createdAt: string;
  mergedAt: string;
  firstCommitAt: string | null;
  /** First review by a person other than the author; bot reviews don't count. */
  firstReviewAt: string | null;
  leadTimeHours: number | null;
  reviewWaitHours: number | null;
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
  changes: ChangeRecord[];
  openPrs: OpenPrRecord[];
  /** Things the reader should know about how this data was collected. */
  notes: string[];
}
