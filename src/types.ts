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

/** Evidence that a merged PR needed fixing after it shipped. */
export interface ReworkEvent {
  target: number;
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

export interface PrRecord {
  number: number;
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
  collectedAt: string;
  since: string;
  windowDays: number;
  survivalThreshold: number;
  prs: PrRecord[];
  openPrs: OpenPrRecord[];
}
