import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, ...args], {
    maxBuffer: 512 * 1024 * 1024,
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
  for (const ref of [`origin/${branch}`, branch]) {
    if ((await tryGit(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) !== null) return ref;
  }
  throw new Error(`Branch "${branch}" not found in ${repoPath}. Fetch it (and full history: fetch-depth: 0) first.`);
}

export async function isShallow(repoPath: string): Promise<boolean> {
  return (await git(repoPath, ['rev-parse', '--is-shallow-repository'])).trim() === 'true';
}

export async function remoteRepo(repoPath: string): Promise<string | null> {
  const url = (await tryGit(repoPath, ['remote', 'get-url', 'origin']))?.trim();
  const m = url?.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export async function parents(repoPath: string, oid: string): Promise<string[]> {
  const out = await git(repoPath, ['rev-list', '--parents', '-n', '1', oid]);
  return out.trim().split(/\s+/).slice(1);
}

export async function firstParentSubjects(repoPath: string, oid: string, n: number): Promise<{ oid: string; subject: string }[]> {
  const out = await git(repoPath, ['log', '--first-parent', `-n${n}`, '--format=%H%x1f%s', oid]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [h, s] = line.split('\x1f');
      return { oid: h!, subject: s ?? '' };
    });
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

/** Files with added lines between two commits; binary files are dropped. */
export async function addedFiles(repoPath: string, from: string, to: string): Promise<string[]> {
  const out = await git(repoPath, ['diff', '--numstat', '--no-renames', from, to]);
  const files: string[] = [];
  for (const line of out.split('\n')) {
    const [added, , path] = line.split('\t');
    if (!path || added === '-' || added === '0') continue;
    files.push(path);
  }
  return files;
}

/** Map of path -> new path (renamed) or null (deleted) between two commits. */
export async function movedFiles(repoPath: string, from: string, to: string): Promise<Map<string, string | null>> {
  const out = await git(repoPath, ['diff', '-M', '--name-status', '--diff-filter=RD', from, to]);
  const moved = new Map<string, string | null>();
  for (const line of out.split('\n')) {
    const [status, a, b] = line.split('\t');
    if (!status || !a) continue;
    if (status.startsWith('R') && b) moved.set(a, b);
    else if (status === 'D') moved.set(a, null);
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
  const out = await git(repoPath, ['log', ref, `--since=${since.toISOString()}`, '--grep=This reverts commit', '--format=%H%x1f%cI%x1f%s%x1f%B%x1e']);
  return out
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [oid, at, subject, body] = r.split('\x1f');
      const reverts = [...(body ?? '').matchAll(/This reverts commit ([0-9a-f]{7,40})/g)].map((m) => m[1]!);
      return { oid: oid!, at: at!, subject: subject ?? '', reverts };
    });
}

export async function expandOid(repoPath: string, short: string): Promise<string | null> {
  return (await tryGit(repoPath, ['rev-parse', '--verify', '--quiet', `${short}^{commit}`]))?.trim() || null;
}
