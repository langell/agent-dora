import type { Config } from './config.js';
import type { DurabilityCache } from './durability.js';
import type { RawIssue } from './types.js';

/** What each unit mode (`prs.ts`, `commits.ts`) needs to turn raw changes into records. */
export interface ModeOptions {
  repoPath: string;
  /** Git ref of the measured branch, e.g. `origin/main`. */
  ref: string;
  /** `owner/name` */
  repo: string;
  since: Date;
  cfg: Config;
  now: Date;
  bugIssues: RawIssue[];
  cache?: DurabilityCache;
  log?: (msg: string) => void;
}
