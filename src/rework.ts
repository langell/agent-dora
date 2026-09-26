import type { Config } from './config.js';
import type { RevertCommit } from './git.js';
import type { RawIssue, RawPr, ReworkEvent } from './types.js';

const CAUSED_BY_SHA = /\b(?:caused[- ]by|regressed[- ]by|regression (?:from|in|introduced (?:by|in)))[:\s]+([0-9a-f]{7,40})\b/gi;

const CAUSED_BY = /\b(?:caused[- ]by|regressed[- ]by|regression (?:from|in|introduced (?:by|in)))[:\s]+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi;
const GITHUB_REVERT_BODY = /\bReverts [\w.-]+\/[\w.-]+#(\d+)/g;
const REVERT_TITLE = /^Revert "(.+)"$/;
const PR_REF = /(?:^|[^\w/])#(\d+)\b/g;

const refs = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => Number(m[1]));

/**
 * Finds evidence that a merged PR needed fixing after it shipped:
 * - revert: a git revert of its commits, GitHub's "Revert" button, or a `Revert "<title>"` PR;
 * - rework: a PR with a rework label (hotfix, regression...) that references it as #N;
 * - bug: an issue or PR saying `Caused-by: #N` (or "regression from #N").
 */
export function findRework(
  merged: RawPr[],
  bugIssues: RawIssue[],
  reverts: RevertCommit[],
  resolveOid: (short: string) => string,
  cfg: Config,
): ReworkEvent[] {
  const byNumber = new Map(merged.map((p) => [p.number, p]));
  const byOid = new Map<string, number>();
  for (const p of merged) {
    if (p.mergeCommitOid) byOid.set(p.mergeCommitOid, p.number);
    for (const c of p.commits) byOid.set(c.oid, p.number);
  }
  const byTitle = new Map(merged.map((p) => [p.title, p.number]));
  const reworkLabels = new Set(cfg.labels.rework.map((l) => l.toLowerCase()));

  const events = new Map<string, ReworkEvent>();
  const add = (target: number, kind: ReworkEvent['kind'], at: string, source: string) => {
    const t = byNumber.get(target);
    // Only count fixes that happened after the target merged, and never self-references.
    if (!t?.mergedAt || source === `#${target}` || Date.parse(at) < Date.parse(t.mergedAt)) return;
    const key = `${target}:${kind}:${source}`;
    if (!events.has(key)) events.set(key, { target, kind, at, source });
  };

  for (const r of reverts) {
    for (const short of r.reverts) {
      const n = byOid.get(resolveOid(short));
      if (n !== undefined) add(n, 'revert', r.at, r.oid.slice(0, 7));
    }
  }

  for (const p of merged) {
    if (!p.mergedAt) continue;
    const src = `#${p.number}`;
    for (const n of refs(p.body, GITHUB_REVERT_BODY)) add(n, 'revert', p.mergedAt, src);
    const title = REVERT_TITLE.exec(p.title)?.[1];
    const reverted = title !== undefined ? byTitle.get(title) : undefined;
    if (reverted !== undefined) add(reverted, 'revert', p.mergedAt, src);

    if (p.labels.some((l) => reworkLabels.has(l.toLowerCase()))) {
      for (const n of refs(`${p.title}\n${p.body}`, PR_REF)) add(n, 'rework', p.mergedAt, src);
    }
    for (const n of refs(p.body, CAUSED_BY)) add(n, 'bug', p.mergedAt, src);
  }

  for (const issue of bugIssues) {
    for (const n of refs(`${issue.title}\n${issue.body}`, CAUSED_BY)) add(n, 'bug', issue.createdAt, `issue #${issue.number}`);
  }

  return [...events.values()];
}

export interface CommitChange {
  oid: string;
  committedAt: string;
  message: string;
  /** Every commit whose lines this change carries (itself, plus merged commits for a merge). */
  owners: Set<string>;
}

/**
 * Commit-mode rework: git reverts of any commit a change carries, and
 * `Caused-by: <sha>` in later commit messages or in bug issues.
 */
/** Short SHAs referenced by `Caused-by: <sha>` in the given texts, for resolving up front. */
export function causedByShas(texts: string[]): string[] {
  return texts.flatMap((t) => [...t.matchAll(CAUSED_BY_SHA)].map((m) => m[1]!));
}

export function findCommitRework(
  changes: CommitChange[],
  bugIssues: RawIssue[],
  reverts: RevertCommit[],
  resolveOid: (short: string) => string,
): ReworkEvent[] {
  const byOwner = new Map<string, CommitChange>();
  for (const c of changes) for (const o of c.owners) byOwner.set(o, c);

  const events = new Map<string, ReworkEvent>();
  const add = (short: string, kind: ReworkEvent['kind'], at: string, source: string, sourceOid?: string) => {
    const t = byOwner.get(resolveOid(short));
    if (!t || (sourceOid && t.owners.has(sourceOid)) || Date.parse(at) < Date.parse(t.committedAt)) return;
    const key = `${t.oid}:${kind}:${source}`;
    if (!events.has(key)) events.set(key, { target: t.oid, kind, at, source });
  };

  for (const r of reverts) for (const short of r.reverts) add(short, 'revert', r.at, r.oid.slice(0, 7), r.oid);
  for (const c of changes) {
    for (const m of c.message.matchAll(CAUSED_BY_SHA)) add(m[1]!, 'bug', c.committedAt, c.oid.slice(0, 7), c.oid);
  }
  for (const issue of bugIssues) {
    for (const m of `${issue.title}\n${issue.body}`.matchAll(CAUSED_BY_SHA)) add(m[1]!, 'bug', issue.createdAt, `issue #${issue.number}`);
  }
  return [...events.values()];
}
