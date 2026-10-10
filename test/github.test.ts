import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { GitHub } from '../src/github.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Handler = (url: string, body: { query: string; variables: Record<string, unknown> } | null) => unknown;

/** Replaces fetch with `handler`, recording each call's URL and GraphQL variables. */
function stubFetch(handler: Handler) {
  const calls: { url: string; variables: Record<string, unknown> | null }[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> }) : null;
    calls.push({ url, variables: body?.variables ?? null });
    return new Response(JSON.stringify(handler(url, body)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

const prNode = (number: number, createdAt: string, mergedAt = createdAt) => ({
  number, title: `PR ${number}`, body: null, url: `https://x/${number}`, createdAt, updatedAt: mergedAt, mergedAt, isDraft: false,
  headRefName: 'f', baseRefName: 'main', additions: 1, deletions: 0, author: { login: 'a' },
  labels: { nodes: [] }, mergeCommit: { oid: `m${number}` },
  commits: { totalCount: 0, nodes: [] }, reviews: { nodes: [{ submittedAt: null, author: null }] },
});

const connection = (nodes: unknown[], next: string | null) => ({ pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes });

test('mergedPrs pages through results and stops at the first PR older than since', async () => {
  const pages: Record<string, unknown[]> = {
    start: [prNode(5, '2026-03-05T00:00:00Z'), prNode(4, '2026-03-04T00:00:00Z')],
    p2: [prNode(3, '2026-03-03T00:00:00Z'), prNode(2, '2026-02-20T00:00:00Z'), prNode(1, '2026-02-10T00:00:00Z')],
  };
  const calls = stubFetch((_, body) => {
    const cursor = (body!.variables.cursor as string | null) ?? 'start';
    return { data: { repository: { pullRequests: connection(pages[cursor]!, cursor === 'start' ? 'p2' : 'p3') } } };
  });
  const seen: number[] = [];
  const prs = await new GitHub('t', 'o', 'r').mergedPrs(new Date('2026-03-01T00:00:00Z'), (n) => seen.push(n));
  assert.deepEqual(prs.map((p) => p.number), [5, 4, 3]);
  assert.equal(calls.length, 2, 'no request after reaching since');
  assert.deepEqual(calls.map((c) => c.variables!.states), [['MERGED'], ['MERGED']]);
  assert.deepEqual(seen, [2, 3]);
  assert.equal(prs[0]!.body, '');
  assert.deepEqual(prs[0]!.reviews, [], 'reviews without submittedAt are dropped');
});

test('mergedPrs pages by update time, so long-running PRs merged recently are included', async () => {
  const calls = stubFetch(() => ({
    data: { repository: { pullRequests: connection([
      prNode(7, '2025-06-01T00:00:00Z', '2026-03-10T00:00:00Z'), // opened long before since, merged after
      { ...prNode(6, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'), updatedAt: '2026-03-08T00:00:00Z' }, // updated recently, merged before since
      prNode(5, '2026-01-01T00:00:00Z', '2026-02-15T00:00:00Z'),
    ], 'more') } },
  }));
  const prs = await new GitHub('t', 'o', 'r').mergedPrs(new Date('2026-03-01T00:00:00Z'));
  assert.deepEqual(prs.map((p) => p.number), [7]);
  assert.equal(calls.length, 1);
});

test('reviews record bot reviewers, state and whether they commented', async () => {
  stubFetch(() => ({
    data: { repository: { pullRequests: connection([{
      ...prNode(1, '2026-03-05T00:00:00Z'),
      reviews: { nodes: [
        { submittedAt: '2026-03-05T01:00:00Z', state: 'COMMENTED', body: 'Looks fine', author: { __typename: 'Bot', login: 'copilot-pull-request-reviewer' }, comments: { totalCount: 3 } },
        { submittedAt: '2026-03-05T02:00:00Z', state: 'APPROVED', body: '', author: { __typename: 'User', login: 'bob' }, comments: { totalCount: 0 } },
      ] },
    }], null) } },
  }));
  const [p] = await new GitHub('t', 'o', 'r').mergedPrs(new Date('2026-03-01T00:00:00Z'));
  assert.deepEqual(p!.reviews, [
    { submittedAt: '2026-03-05T01:00:00Z', author: 'copilot-pull-request-reviewer', isBot: true, state: 'COMMENTED', commented: true },
    { submittedAt: '2026-03-05T02:00:00Z', author: 'bob', isBot: false, state: 'APPROVED', commented: false },
  ]);
});

test('openPrs reads every page', async () => {
  stubFetch((_, body) => {
    const cursor = body!.variables.cursor as string | null;
    return { data: { repository: { pullRequests: cursor ? connection([prNode(1, '2020-01-01T00:00:00Z')], null) : connection([prNode(2, '2021-01-01T00:00:00Z')], 'c') } } };
  });
  assert.deepEqual((await new GitHub('t', 'o', 'r').openPrs()).map((p) => p.number), [2, 1]);
});

test('issues stops at since and skips the request with no labels', async () => {
  const calls = stubFetch(() => ({
    data: { repository: { issues: connection([
      { number: 9, title: 't', body: null, createdAt: '2026-03-05T00:00:00Z' },
      { number: 8, title: 't', body: 'b', createdAt: '2026-01-01T00:00:00Z' },
    ], 'more') } },
  }));
  const gh = new GitHub('t', 'o', 'r');
  const issues = await gh.issues(['bug'], new Date('2026-03-01T00:00:00Z'));
  assert.deepEqual(issues, [{ number: 9, title: 't', body: '', createdAt: '2026-03-05T00:00:00Z' }]);
  assert.equal(calls.length, 1);
  assert.deepEqual(await gh.issues([], new Date(0)), []);
  assert.equal(calls.length, 1);
});

test('labelActor reads every page of events and returns the latest labeller', async () => {
  const FULL_PAGE = 100;
  const filler = Array.from({ length: FULL_PAGE - 1 }, () => ({ event: 'commented' }));
  const calls = stubFetch((url) =>
    url.endsWith('&page=1')
      ? [{ event: 'labeled', label: { name: 'ai:agent' }, actor: { login: 'github-actions[bot]' } }, ...filler]
      : [{ event: 'labeled', label: { name: 'ai:agent' }, actor: { login: 'alice' } }, { event: 'labeled', label: { name: 'other' }, actor: { login: 'bob' } }],
  );
  assert.equal(await new GitHub('t', 'o', 'r').labelActor(7, 'ai:agent'), 'alice');
  assert.equal(calls.length, 2);
  assert.match(calls[0]!.url, /\/repos\/o\/r\/issues\/7\/events\?per_page=100&page=1$/);
});
