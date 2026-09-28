import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MS_PER_SECOND, TOOL_NAME } from './constants.js';
import type { RawIssue, RawPr } from './types.js';

const run = promisify(execFile);

// GitHub Actions sets these on GitHub Enterprise Server; github.com otherwise.
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const GRAPHQL = process.env.GITHUB_GRAPHQL_URL ?? `${API}/graphql`;

const USER_AGENT = TOOL_NAME;
const REST_MEDIA_TYPE = 'application/vnd.github+json';

/** GitHub's GraphQL `PullRequestState` values. */
const PrState = { Merged: 'MERGED', Open: 'OPEN' } as const;
type PrState = (typeof PrState)[keyof typeof PrState];

/** Issue timeline event type for a label being added. */
const EVENT_LABELED = 'labeled';

// Page sizes. PRs with more commits, reviews or labels than these are read partially.
const PR_PAGE_SIZE = 50;
const ISSUE_PAGE_SIZE = 100;
const REST_PAGE_SIZE = 100;
const MAX_PR_LABELS = 30;
const MAX_PR_COMMITS = 100;
const MAX_PR_REVIEWS = 50;

// Retry transient failures and secondary rate limits (which GitHub reports as 403).
const RETRY_STATUSES = new Set([403, 502, 503]);
const MAX_RETRIES = 3;
const BACKOFF_BASE_SECONDS = 5;
const HTTP_NOT_FOUND = 404;

/** GITHUB_TOKEN / GH_TOKEN, falling back to the GitHub CLI's login. */
export async function resolveToken(): Promise<string> {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  try {
    const { stdout } = await run('gh', ['auth', 'token']);
    if (stdout.trim()) return stdout.trim();
  } catch {
    // fall through
  }
  throw new Error('No GitHub token. Set GITHUB_TOKEN, or log in with `gh auth login`.');
}

const PR_FIELDS = `
  number title body url createdAt mergedAt isDraft headRefName baseRefName additions deletions
  author{login}
  labels(first:${MAX_PR_LABELS}){nodes{name}}
  mergeCommit{oid}
  commits(first:${MAX_PR_COMMITS}){totalCount nodes{commit{oid message authoredDate}}}
  reviews(first:${MAX_PR_REVIEWS}){nodes{submittedAt author{login}}}
`;

type PrNode = {
  number: number; title: string; body: string; url: string; createdAt: string; mergedAt: string | null;
  isDraft: boolean; headRefName: string; baseRefName: string; additions: number; deletions: number;
  author: { login: string } | null; labels: { nodes: { name: string }[] }; mergeCommit: { oid: string } | null;
  commits: { totalCount: number; nodes: { commit: { oid: string; message: string; authoredDate: string } }[] };
  reviews: { nodes: { submittedAt: string | null; author: { login: string } | null }[] };
};

function toRawPr(n: PrNode): RawPr {
  return {
    number: n.number,
    title: n.title,
    body: n.body ?? '',
    url: n.url,
    author: n.author?.login ?? null,
    createdAt: n.createdAt,
    mergedAt: n.mergedAt,
    isDraft: n.isDraft,
    headRefName: n.headRefName,
    baseRefName: n.baseRefName,
    labels: n.labels.nodes.map((l) => l.name),
    mergeCommitOid: n.mergeCommit?.oid ?? null,
    additions: n.additions,
    deletions: n.deletions,
    commitCount: n.commits.totalCount,
    commits: n.commits.nodes.map((c) => c.commit),
    reviews: n.reviews.nodes
      .filter((r): r is { submittedAt: string; author: { login: string } | null } => !!r.submittedAt)
      .map((r) => ({ submittedAt: r.submittedAt, author: r.author?.login ?? null })),
  };
}

export class GitHub {
  constructor(
    private readonly token: string,
    readonly owner: string,
    readonly name: string,
  ) {}

  private get restHeaders() {
    return { authorization: `bearer ${this.token}`, accept: REST_MEDIA_TYPE, 'user-agent': USER_AGENT };
  }

  private get restBase() {
    return `${API}/repos/${this.owner}/${this.name}`;
  }

  static parseRepo(repo: string): { owner: string; name: string } {
    const [owner, name] = repo.split('/');
    if (!owner || !name) throw new Error(`Expected owner/name, got "${repo}"`);
    return { owner, name };
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(GRAPHQL, {
        method: 'POST',
        headers: { authorization: `bearer ${this.token}`, 'content-type': 'application/json', 'user-agent': USER_AGENT },
        body: JSON.stringify({ query, variables }),
      });
      if (RETRY_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
        const retryAfterSeconds = Number(res.headers.get('retry-after')) || 2 ** attempt * BACKOFF_BASE_SECONDS;
        await new Promise((r) => setTimeout(r, retryAfterSeconds * MS_PER_SECOND));
        continue;
      }
      const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
      if (!res.ok || json.errors?.length) {
        throw new Error(`GitHub GraphQL error (${res.status}): ${json.errors?.map((e) => e.message).join('; ') ?? res.statusText}`);
      }
      return json.data as T;
    }
  }

  async defaultBranch(): Promise<string> {
    const data = await this.graphql<{ repository: { defaultBranchRef: { name: string } | null } }>(
      `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){defaultBranchRef{name}}}`,
      { owner: this.owner, name: this.name },
    );
    if (!data.repository.defaultBranchRef) throw new Error(`${this.owner}/${this.name} has no default branch`);
    return data.repository.defaultBranchRef.name;
  }

  /** Merged PRs created on or after `since`, newest first. */
  async mergedPrs(since: Date, onPage?: (n: number) => void): Promise<RawPr[]> {
    return this.pullRequests(PrState.Merged, since, onPage);
  }

  async openPrs(): Promise<RawPr[]> {
    return this.pullRequests(PrState.Open, new Date(0));
  }

  private async pullRequests(state: PrState, since: Date, onPage?: (n: number) => void): Promise<RawPr[]> {
    const query = `query($owner:String!,$name:String!,$cursor:String,$states:[PullRequestState!]){
      repository(owner:$owner,name:$name){
        pullRequests(states:$states, first:${PR_PAGE_SIZE}, after:$cursor, orderBy:{field:CREATED_AT, direction:DESC}){
          pageInfo{hasNextPage endCursor}
          nodes{${PR_FIELDS}}
        }
      }
    }`;
    const out: RawPr[] = [];
    let cursor: string | null = null;
    for (;;) {
      const data: { repository: { pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: PrNode[] } } } =
        await this.graphql(query, { owner: this.owner, name: this.name, cursor, states: [state] });
      const page = data.repository.pullRequests;
      let reachedSince = false;
      for (const n of page.nodes) {
        if (Date.parse(n.createdAt) < since.getTime()) {
          reachedSince = true;
          break;
        }
        out.push(toRawPr(n));
      }
      onPage?.(out.length);
      if (reachedSince || !page.pageInfo.hasNextPage) return out;
      cursor = page.pageInfo.endCursor;
    }
  }

  /** Issues with any of `labels`, created on or after `since`. */
  async issues(labels: string[], since: Date): Promise<RawIssue[]> {
    if (!labels.length) return [];
    const query = `query($owner:String!,$name:String!,$cursor:String,$labels:[String!]){
      repository(owner:$owner,name:$name){
        issues(labels:$labels, first:${ISSUE_PAGE_SIZE}, after:$cursor, orderBy:{field:CREATED_AT, direction:DESC}){
          pageInfo{hasNextPage endCursor}
          nodes{number title body createdAt}
        }
      }
    }`;
    const out: RawIssue[] = [];
    let cursor: string | null = null;
    for (;;) {
      const data: { repository: { issues: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: RawIssue[] } } } =
        await this.graphql(query, { owner: this.owner, name: this.name, cursor, labels });
      const page = data.repository.issues;
      for (const n of page.nodes) {
        if (Date.parse(n.createdAt) < since.getTime()) return out;
        out.push({ ...n, body: n.body ?? '' });
      }
      if (!page.pageInfo.hasNextPage) return out;
      cursor = page.pageInfo.endCursor;
    }
  }

  async pullRequest(number: number): Promise<RawPr> {
    const data = await this.graphql<{ repository: { pullRequest: PrNode | null } }>(
      `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){${PR_FIELDS}}}}`,
      { owner: this.owner, name: this.name, number },
    );
    if (!data.repository.pullRequest) throw new Error(`PR #${number} not found`);
    return toRawPr(data.repository.pullRequest);
  }

  /** Login of whoever most recently applied `label` to an issue or PR, if anyone. */
  async labelActor(number: number, label: string): Promise<string | null> {
    let actor: string | null = null;
    for (let page = 1; ; page++) {
      const res = await fetch(`${this.restBase}/issues/${number}/events?per_page=${REST_PAGE_SIZE}&page=${page}`, { headers: this.restHeaders });
      if (!res.ok) throw new Error(`Reading events of #${number} failed: ${res.status}`);
      const events = (await res.json()) as { event: string; label?: { name: string }; actor?: { login: string } | null }[];
      for (const e of events) {
        if (e.event === EVENT_LABELED && e.label?.name === label) actor = e.actor?.login ?? null;
      }
      if (events.length < REST_PAGE_SIZE) return actor;
    }
  }

  /** Replaces any existing label from `family` with `label` on an issue or PR. */
  async setLabel(number: number, label: string, family: string[]): Promise<void> {
    const base = `${this.restBase}/issues/${number}/labels`;
    const headers = this.restHeaders;
    for (const other of family.filter((f) => f !== label)) {
      const res = await fetch(`${base}/${encodeURIComponent(other)}`, { method: 'DELETE', headers });
      if (!res.ok && res.status !== HTTP_NOT_FOUND) throw new Error(`Removing label ${other} failed: ${res.status}`);
    }
    const res = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ labels: [label] }) });
    if (!res.ok) throw new Error(`Adding label ${label} failed: ${res.status} ${await res.text()}`);
  }
}
