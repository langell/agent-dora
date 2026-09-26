export type AuthorClass = 'agent' | 'assisted' | 'human';
export const AUTHOR_CLASSES: readonly AuthorClass[] = ['agent', 'assisted', 'human'];
export type ClassKey = AuthorClass | 'all';

export interface PrCommit {
  oid: string;
  message: string;
  authoredDate: string;
}

export interface PrReview {
  submittedAt: string;
  author: string | null;
}

/** A pull request as fetched from GitHub, before any analysis. */
export interface RawPr {
  number: number;
  title: string;
  body: string;
  url: string;
  author: string | null;
  createdAt: string;
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

export type ReworkKind = 'revert' | 'rework' | 'bug';

/** Evidence that a change needed fixing after it shipped. */
export interface ReworkEvent {
  /** PR number or full commit SHA of the change that needed fixing. */
  target: number | string;
  kind: ReworkKind;
  at: string;
  source: string;
}

export interface Durability {
  status: 'measured' | 'pending' | 'unavailable';
  /** Lines the PR added, as attributed by `git blame` at the merge commit. */
  baseline: number;
  /** Of those lines, how many are still attributed to the PR at merge + window. */
  surviving: number;
  reason?: string;
}

/** What counts as one change: a merged pull request, or a commit on the branch. */
export type Unit = 'prs' | 'commits';

export interface ChangeRecord {
  kind: 'pr' | 'commit';
  /** Display id: "#123" for a PR, a short SHA for a commit. */
  id: string;
  /** PR number; null for commits. */
  number: number | null;
  title: string;
  url: string;
  author: string | null;
  authorClass: AuthorClass;
  classReason: string;
  createdAt: string;
  mergedAt: string;
  firstCommitAt: string | null;
  firstReviewAt: string | null;
  leadTimeHours: number | null;
  reviewWaitHours: number | null;
  size: number;
  rework: ReworkEvent[];
  durability: Durability;
  /** null until the durability window has elapsed. */
  durable: boolean | null;
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
