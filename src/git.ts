import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GIT_REMOTE } from './constants.js';

const run = promisify(execFile);

/** SHA of git's empty tree: the "parent" to diff a root commit against. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Large enough for `git blame` / `git log` on big repos. */
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

/** The message `git revert` writes, followed by the reverted SHA. */
const REVERT_MARKER = 'This reverts commit';
const REVERTED_SHA = new RegExp(`${REVERT_MARKER} ([0-9a-f]{7,40})`, 'g');

// `git log --format` output is split on ASCII unit/record separators, which can't appear in
// commit metadata. `%x1f` / `%x1e` are how the format string spells those same bytes.
const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';
const FORMAT_FIELD_SEP = '%x1f';
const FORMAT_RECORD_SEP = '%x1e';

/** First line of a commit message. */
export function subject(message: string): string {
  return (message.split('\n')[0] ?? '').trim();
}

/** `--format=` for the given placeholders (e.g. `%H`), one record per commit. */
function logFormat(...placeholders: string[]): string {
  return `--format=${placeholders.join(FORMAT_FIELD_SEP)}${FORMAT_RECORD_SEP}`;
}

/** Splits `git log` output written with `logFormat` into records of fields. */
function parseLog(out: string): string[][] {
  return out
    .split(RECORD_SEP)
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => r.split(FIELD_SEP));
}

export async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, ...args], {
    maxBuffer: MAX_OUTPUT_BYTES,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
}

async function tryGit(repoPath: string, args: string[]): Promise<string | null> {
  try {
    return await git(repoPath, args);
  } catch {
    return null;
  }
}

export async function hasCommit(repoPath: string, oid: string): Promise<boolean> {
  return (await tryGit(repoPath, ['cat-file', '-e', `${oid}^{commit}`])) !== null;
}

/** Prefers the remote-tracking branch, since CI checkouts often lack a local one. */
export async function resolveRef(repoPath: string, branch: string): Promise<string> {
  for (const ref of [`${GIT_REMOTE}/${branch}`, branch]) {
    if ((await tryGit(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) !== null) return ref;
  }
  throw new Error(`Branch "${branch}" not found in ${repoPath}. Fetch it (and full history: fetch-depth: 0) first.`);
}

export async function isShallow(repoPath: string): Promise<boolean> {
  return (await git(repoPath, ['rev-parse', '--is-shallow-repository'])).trim() === 'true';
}

export async function remoteRepo(repoPath: string): Promise<string | null> {
  const url = (await tryGit(repoPath, ['remote', 'get-url', GIT_REMOTE]))?.trim();
  const m = url?.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export async function parents(repoPath: string, oid: string): Promise<string[]> {
  const out = await git(repoPath, ['rev-list', '--parents', '-n', '1', oid]);
  return out.trim().split(/\s+/).slice(1);
}

export async function firstParentSubjects(repoPath: string, oid: string, n: number): Promise<{ oid: string; subject: string }[]> {
  const out = await git(repoPath, ['log', '--first-parent', `-n${n}`, logFormat('%H', '%s'), oid]);
  return parseLog(out).map(([h, s]) => ({ oid: h!, subject: s ?? '' }));
}

export async function revList(repoPath: string, range: string): Promise<string[]> {
  return (await git(repoPath, ['rev-list', range])).split('\n').filter(Boolean);
}

export async function isAncestor(repoPath: string, a: string, b: string): Promise<boolean> {
  return (await tryGit(repoPath, ['merge-base', '--is-ancestor', a, b])) !== null;
}

/** Last commit on the first-parent chain of `ref` at or before `date`. */
export async function commitAt(repoPath: string, ref: string, date: Date): Promise<string | null> {
  const out = await git(repoPath, ['rev-list', '-1', '--first-parent', `--before=${date.toISOString()}`, ref]);
  return out.trim() || null;
}

/** `git diff --numstat` writes this instead of line counts for binary files. */
const NUMSTAT_BINARY = '-';

/** Per-file added/deleted line counts between two commits, skipping binary files. */
async function numstat(repoPath: string, from: string, to: string): Promise<{ path: string; added: number; deleted: number }[]> {
  const out = await git(repoPath, ['diff', '--numstat', '--no-renames', from, to]);
  return out.split('\n').flatMap((line) => {
    const [added, deleted, path] = line.split('\t');
    if (!path || added === NUMSTAT_BINARY) return [];
    return [{ path, added: Number(added), deleted: Number(deleted) }];
  });
}

/** Files with added lines between two commits; binary files are dropped. */
export async function addedFiles(repoPath: string, from: string, to: string): Promise<string[]> {
  return (await numstat(repoPath, from, to)).filter((f) => f.added > 0).map((f) => f.path);
}

/** `git diff --name-status` codes. */
const NameStatus = { Renamed: 'R', Deleted: 'D' } as const;

/** Map of path -> new path (renamed) or null (deleted) between two commits. */
export async function movedFiles(repoPath: string, from: string, to: string): Promise<Map<string, string | null>> {
  const out = await git(repoPath, ['diff', '-M', '--name-status', `--diff-filter=${NameStatus.Renamed}${NameStatus.Deleted}`, from, to]);
  const moved = new Map<string, string | null>();
  for (const line of out.split('\n')) {
    const [status, a, b] = line.split('\t');
    if (!status || !a) continue;
    // Renames carry a similarity score, e.g. "R087".
    if (status.startsWith(NameStatus.Renamed) && b) moved.set(a, b);
    else if (status === NameStatus.Deleted) moved.set(a, null);
  }
  return moved;
}

/**
 * Counts lines of `file` at `rev` that `git blame` attributes to any commit in `owners`.
 * Whitespace-only changes are ignored (`-w`) so reformatting doesn't count as churn.
 * Returns null if the file doesn't exist at `rev`.
 */
export async function blameCount(repoPath: string, rev: string, file: string, owners: Set<string>): Promise<number | null> {
  const out = await tryGit(repoPath, ['blame', '-w', '--porcelain', rev, '--', file]);
  if (out === null) return null;
  let n = 0;
  for (const line of out.split('\n')) {
    // Every line of source gets a header "<sha> <orig-line> <final-line>[ <group-size>]".
    const m = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (m && owners.has(m[1]!)) n++;
  }
  return n;
}

export interface RevertCommit {
  oid: string;
  at: string;
  subject: string;
  reverts: string[];
}

/** Commits on `ref` whose message contains git's standard "This reverts commit <sha>." */
export async function revertCommits(repoPath: string, ref: string, since: Date): Promise<RevertCommit[]> {
  const out = await git(repoPath, ['log', ref, `--since=${since.toISOString()}`, `--grep=${REVERT_MARKER}`, logFormat('%H', '%cI', '%s', '%B')]);
  return parseLog(out).map(([oid, at, subject, body]) => ({
    oid: oid!,
    at: at!,
    subject: subject ?? '',
    reverts: [...(body ?? '').matchAll(REVERTED_SHA)].map((m) => m[1]!),
  }));
}

async function expandOid(repoPath: string, short: string): Promise<string | null> {
  return (await tryGit(repoPath, ['rev-parse', '--verify', '--quiet', `${short}^{commit}`]))?.trim() || null;
}

/**
 * Resolves abbreviated SHAs up front and returns a lookup from short to full SHA.
 * Unknown SHAs map to themselves, so they simply match nothing.
 */
export async function expandOids(repoPath: string, shorts: Iterable<string>): Promise<(short: string) => string> {
  const full = new Map<string, string>();
  for (const s of new Set(shorts)) full.set(s, (await expandOid(repoPath, s)) ?? s);
  return (s) => full.get(s) ?? s;
}

export interface BranchCommit {
  oid: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committedAt: string;
  message: string;
}

/** Commits on the first-parent chain of `ref` committed on or after `since`, newest first. */
export async function firstParentCommits(repoPath: string, ref: string, since: Date): Promise<BranchCommit[]> {
  const out = await git(repoPath, ['log', '--first-parent', `--since=${since.toISOString()}`, logFormat('%H', '%P', '%an', '%ae', '%aI', '%cI', '%B'), ref]);
  return parseLog(out).map(([oid, parents, authorName, authorEmail, authoredAt, committedAt, message]) => ({
    oid: oid!,
    parents: (parents ?? '').split(' ').filter(Boolean),
    authorName: authorName ?? '',
    authorEmail: authorEmail ?? '',
    authoredAt: authoredAt!,
    committedAt: committedAt!,
    message: (message ?? '').trim(),
  }));
}

/** Full messages and author dates of the commits in `range` (e.g. "a..b"). */
export async function commitsIn(repoPath: string, range: string): Promise<{ oid: string; authoredAt: string; message: string }[]> {
  const out = await git(repoPath, ['log', logFormat('%H', '%aI', '%B'), range]);
  return parseLog(out).map(([oid, authoredAt, message]) => ({ oid: oid!, authoredAt: authoredAt!, message: (message ?? '').trim() }));
}

/** Lines added plus deleted between two commits, ignoring binary files. */
export async function diffSize(repoPath: string, from: string, to: string): Promise<number> {
  return (await numstat(repoPath, from, to)).reduce((n, f) => n + f.added + f.deleted, 0);
}
