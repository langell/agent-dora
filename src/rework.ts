import type { Config } from './config.js';
import { prId, ReworkKind, ReworkSourceKind, shortSha } from './constants.js';
import { REVERT_MARKER, subject, type RevertCommit } from './git.js';
import type { RawIssue, RawPr, ReworkEvent, ReworkSource } from './types.js';

const CAUSED_BY_SHA = /\b(?:caused[- ]by|regressed[- ]by|regression (?:from|in|introduced (?:by|in)))[:\s]+([0-9a-f]{7,40})\b/gi;

const CAUSED_BY = /\b(?:caused[- ]by|regressed[- ]by|regression (?:from|in|introduced (?:by|in)))[:\s]+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi;
const GITHUB_REVERT_BODY = /\bReverts [\w.-]+\/[\w.-]+#(\d+)/g;
const REVERT_TITLE = /^Revert "(.+)"$/;
const PR_REF = /(?:^|[^\w/])#(\d+)\b/g;

const refs = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => Number(m[1]));
/** Whether `re` matches anywhere in `text`; `search` ignores a global regex's `lastIndex`. */
const has = (text: string, re: RegExp) => text.search(re) !== -1;

/** The text of an issue that may reference the change that caused it. */
const issueText = (issue: RawIssue) => `${issue.title}\n${issue.body}`;

/** How a rework source is shown to users. */
export function sourceLabel(from: ReworkSource): string {
  switch (from.kind) {
    case ReworkSourceKind.Pr:
      return prId(from.number);
    case ReworkSourceKind.Commit:
      return shortSha(from.oid);
    case ReworkSourceKind.Issue:
      return `issue ${prId(from.number)}`;
  }
}

const sourceKey = (from: ReworkSource) => `${from.kind}:${from.kind === ReworkSourceKind.Commit ? from.oid : from.number}`;

/**
 * Accumulates rework events. Drops fixes dated before the change they fix
 * landed, and keeps one event per (target, kind, source).
 */
function reworkLog() {
  const events = new Map<string, ReworkEvent>();
  return {
    add(target: ReworkEvent['target'], landedAt: string, kind: ReworkEvent['kind'], at: string, from: ReworkSource) {
      if (Date.parse(at) < Date.parse(landedAt)) return;
      const key = `${target}:${kind}:${sourceKey(from)}`;
      if (!events.has(key)) events.set(key, { target, kind, at, from, source: sourceLabel(from) });
    },
    events: () => [...events.values()],
  };
}

/**
 * Whether a commit message or PR text shows the change is itself a revert or a fix
 * for an earlier change, whether or not that earlier change is in the collected set.
 */
export function looksRemedial(text: string): boolean {
  return REVERT_TITLE.test(subject(text)) || text.includes(REVERT_MARKER) || has(text, GITHUB_REVERT_BODY) || has(text, CAUSED_BY) || has(text, CAUSED_BY_SHA);
}

/** PRs that revert or fix earlier changes: sources of rework, rework-labelled, or revert-shaped. */
export function remedialPrs(merged: RawPr[], events: ReworkEvent[], cfg: Config): Set<number> {
  const reworkLabels = new Set(cfg.labels.rework.map((l) => l.toLowerCase()));
  const out = new Set(events.flatMap((e) => (e.from?.kind === ReworkSourceKind.Pr ? [e.from.number] : [])));
  for (const p of merged) {
    const texts = [`${p.title}\n\n${p.body}`, ...p.commits.map((c) => c.message)];
    if (p.labels.some((l) => reworkLabels.has(l.toLowerCase())) || texts.some(looksRemedial)) out.add(p.number);
  }
  return out;
}

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

  const log = reworkLog();
  const add = (target: number, kind: ReworkEvent['kind'], at: string, from: ReworkSource) => {
    const t = byNumber.get(target);
    // A PR never counts as fixing itself.
    if (t?.mergedAt && !(from.kind === ReworkSourceKind.Pr && from.number === target)) log.add(target, t.mergedAt, kind, at, from);
  };
  const pr = (number: number): ReworkSource => ({ kind: ReworkSourceKind.Pr, number });

  for (const r of reverts) {
    // A revert commit that landed through a PR is credited to that PR.
    const viaPr = byOid.get(r.oid);
    const from: ReworkSource = viaPr !== undefined ? pr(viaPr) : { kind: ReworkSourceKind.Commit, oid: r.oid };
    for (const short of r.reverts) {
      const n = byOid.get(resolveOid(short));
      if (n !== undefined) add(n, ReworkKind.Revert, r.at, from);
    }
  }

  for (const p of merged) {
    if (!p.mergedAt) continue;
    const src = pr(p.number);
    for (const n of refs(p.body, GITHUB_REVERT_BODY)) add(n, ReworkKind.Revert, p.mergedAt, src);
    const title = REVERT_TITLE.exec(p.title)?.[1];
    const reverted = title !== undefined ? byTitle.get(title) : undefined;
    if (reverted !== undefined) add(reverted, ReworkKind.Revert, p.mergedAt, src);

    if (p.labels.some((l) => reworkLabels.has(l.toLowerCase()))) {
      for (const n of refs(`${p.title}\n${p.body}`, PR_REF)) add(n, ReworkKind.Rework, p.mergedAt, src);
    }
    for (const n of refs(p.body, CAUSED_BY)) add(n, ReworkKind.Bug, p.mergedAt, src);
  }

  for (const issue of bugIssues) {
    for (const n of refs(issueText(issue), CAUSED_BY)) add(n, ReworkKind.Bug, issue.createdAt, { kind: ReworkSourceKind.Issue, number: issue.number });
  }

  return log.events();
}

export interface CommitChange {
  oid: string;
  committedAt: string;
  message: string;
  /** Every commit whose lines this change carries (itself, plus merged commits for a merge). */
  owners: Set<string>;
}

/** Short SHAs referenced by `Caused-by: <sha>` in the given texts, for resolving up front. */
export function causedByShas(texts: string[]): string[] {
  return texts.flatMap((t) => [...t.matchAll(CAUSED_BY_SHA)].map((m) => m[1]!));
}

/**
 * Commit-mode rework: git reverts of any commit a change carries, and
 * `Caused-by: <sha>` in later commit messages or in bug issues.
 */
export function findCommitRework(
  changes: CommitChange[],
  bugIssues: RawIssue[],
  reverts: RevertCommit[],
  resolveOid: (short: string) => string,
): ReworkEvent[] {
  const byOwner = new Map<string, CommitChange>();
  for (const c of changes) for (const o of c.owners) byOwner.set(o, c);

  const log = reworkLog();
  const add = (short: string, kind: ReworkEvent['kind'], at: string, from: ReworkSource) => {
    const t = byOwner.get(resolveOid(short));
    // A change never counts as fixing itself, including via a commit it merged.
    if (t && !(from.kind === ReworkSourceKind.Commit && t.owners.has(from.oid))) log.add(t.oid, t.committedAt, kind, at, from);
  };
  // A revert or fix commit is credited to the change that carried it onto the branch.
  const commit = (oid: string): ReworkSource => ({ kind: ReworkSourceKind.Commit, oid: byOwner.get(oid)?.oid ?? oid });

  for (const r of reverts) for (const short of r.reverts) add(short, ReworkKind.Revert, r.at, commit(r.oid));
  for (const c of changes) {
    for (const m of c.message.matchAll(CAUSED_BY_SHA)) add(m[1]!, ReworkKind.Bug, c.committedAt, commit(c.oid));
  }
  for (const issue of bugIssues) {
    for (const m of issueText(issue).matchAll(CAUSED_BY_SHA)) add(m[1]!, ReworkKind.Bug, issue.createdAt, { kind: ReworkSourceKind.Issue, number: issue.number });
  }
  return log.events();
}
