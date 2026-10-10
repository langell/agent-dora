import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/config.js';
import { claudeCodeCosts, csvCosts, loadCosts, otlpCosts, type CostCache } from '../src/cost.js';
import { attachDeployments, loadDeployments, vercelDeployments } from '../src/deployments.js';
import { GitHub } from '../src/github.js';
import { adfText, jiraIncidents, linearIncidents, loadIncidents, pagerDutyIncidents } from '../src/incidents.js';
import { aggregate } from '../src/metrics.js';
import { renderHtml } from '../src/report-html.js';
import { renderMarkdown } from '../src/report.js';
import { findCommitRework, findRework, incidentReport } from '../src/rework.js';
import { combineSnapshots } from '../src/rollup.js';
import type { ChangeRecord, CostEntry, Deployment, Incident, RawPr, Snapshot } from '../src/types.js';
import { DAY, lines, T0, TempRepo } from './helpers.js';

const cfg = DEFAULT_CONFIG;
const realFetch = globalThis.fetch;
const realEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...realEnv };
});

type Call = { url: string; headers: Record<string, string>; body: unknown };

/** Replaces fetch with `handler`, recording each request. */
function stubFetch(handler: (url: string, body: any) => unknown, status = 200) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body });
    return new Response(JSON.stringify(handler(url, body)), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

const iso = (ms: number) => new Date(ms).toISOString();

// ---- Deployments ----------------------------------------------------------------

test('GitHub deployments: production environments only, success time from statuses, oldest first', async () => {
  const node = (env: string, sha: string, createdAt: string, statuses: [string, string][], latest = statuses.at(-1)?.[0] ?? 'PENDING') => ({
    createdAt, environment: env, commitOid: sha, latestStatus: { state: latest, environmentUrl: `https://${sha}.example` },
    statuses: { nodes: statuses.map(([state, at]) => ({ state, createdAt: at })) },
  });
  stubFetch(() => ({
    data: { repository: { deployments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      node('Preview', 'p1', '2026-03-05T00:00:00Z', [['SUCCESS', '2026-03-05T00:01:00Z']]),
      node('Production – api', 'b2', '2026-03-04T00:00:00Z', [['FAILURE', '2026-03-04T00:02:00Z']]),
      node('Production', 'a1', '2026-03-03T00:00:00Z', [['PENDING', '2026-03-03T00:00:00Z'], ['SUCCESS', '2026-03-03T00:04:00Z']], 'INACTIVE'),
      node('Production', 'old', '2026-02-01T00:00:00Z', [['SUCCESS', '2026-02-01T00:01:00Z']]),
    ] } } },
  }));
  const deploys = await new GitHub('t', 'o', 'r').deployments(new Date('2026-03-01T00:00:00Z'), cfg.deployments.environment);
  assert.deepEqual(deploys.map((d) => [d.environment, d.sha, d.status, d.readyAt]), [
    ['Production', 'a1', 'success', '2026-03-03T00:04:00Z'],
    ['Production – api', 'b2', 'failure', null],
  ]);
  assert.equal(deploys[0]!.url, 'https://a1.example');
});

test('Vercel deployments: production target, commit from meta, pages by until', async () => {
  const calls = stubFetch((url) => {
    const until = new URL(url).searchParams.get('until');
    return until
      ? { deployments: [{ uid: 'd1', url: 'app-1.vercel.app', created: Date.parse('2026-03-02T00:00:00Z'), ready: Date.parse('2026-03-02T00:03:00Z'), readyState: 'READY', target: 'production', meta: { githubCommitSha: 'aaa' } }], pagination: { next: null } }
      : { deployments: [
          { uid: 'd2', url: null, created: Date.parse('2026-03-03T00:00:00Z'), readyState: 'ERROR', target: 'production', meta: { githubCommitSha: 'bbb' } },
          { uid: 'd3', url: 'x', created: Date.parse('2026-03-04T00:00:00Z'), readyState: 'READY', target: 'production', meta: {} },
        ], pagination: { next: 12345 } };
  });
  const deploys = await vercelDeployments('tok', ['web'], 'team_1', new Date('2026-03-01T00:00:00Z'));
  assert.deepEqual(deploys.map((d) => [d.sha, d.status, d.readyAt, d.url]), [
    ['aaa', 'success', '2026-03-02T00:03:00.000Z', 'https://app-1.vercel.app'],
    ['bbb', 'failure', null, null],
  ]);
  const first = new URL(calls[0]!.url);
  assert.equal(first.pathname, '/v7/deployments');
  assert.equal(first.searchParams.get('target'), 'production');
  assert.equal(first.searchParams.get('teamId'), 'team_1');
  assert.equal(first.searchParams.get('since'), String(Date.parse('2026-03-01T00:00:00Z')));
  assert.equal(new URL(calls[1]!.url).searchParams.get('until'), '12345');
  assert.equal(calls[0]!.headers.authorization, 'Bearer tok');
});

test('loadDeployments: a missing permission becomes a note, not a failure', async () => {
  stubFetch(() => ({ errors: [{ message: 'Resource not accessible by integration' }] }));
  const notes: string[] = [];
  const result = await loadDeployments(cfg, new GitHub('t', 'o', 'r'), new Date(0), (n) => notes.push(n), () => {});
  assert.equal(result, null);
  assert.match(notes[0]!, /deployments: read/);
  // Vercel configured but no token: say so.
  const vercelCfg = { ...cfg, deployments: { ...cfg.deployments, source: 'vercel' as const, vercelProjects: ['web'] } };
  delete process.env.VERCEL_TOKEN;
  notes.length = 0;
  assert.equal(await loadDeployments(vercelCfg, new GitHub('t', 'o', 'r'), new Date(0), (n) => notes.push(n), () => {}), null);
  assert.match(notes[0]!, /VERCEL_TOKEN/);
  assert.equal(await loadDeployments({ ...cfg, deployments: { ...cfg.deployments, source: 'none' } }, new GitHub('t', 'o', 'r'), new Date(0), () => {}, () => {}), null);
});

test('attachDeployments: first live deployment containing each change, ignoring rollbacks and unknown commits', async () => {
  const r = new TempRepo();
  r.write('a.txt', lines('a', 2));
  const c1 = r.commit(T0, 'one');
  r.write('b.txt', lines('b', 2));
  const c2 = r.commit(T0 + DAY, 'two');
  r.write('c.txt', lines('c', 2));
  const c3 = r.commit(T0 + 2 * DAY, 'three');
  const deploy = (sha: string, day: number, status: Deployment['status'] = 'success'): Deployment => ({
    source: 'github', environment: 'Production', sha, createdAt: iso(T0 + day * DAY), readyAt: status === 'success' ? iso(T0 + day * DAY) : null, status, url: null,
  });
  const deploys = [
    deploy(c1, 0.5),
    deploy(c3, 2.5, 'failure'), // never went live
    deploy('f'.repeat(40), 2.6), // not in local history
    deploy(c3, 3),
    deploy(c1, 4), // a rollback: adds nothing new
  ];
  const change = (oid: string, day: number) => ({ oid, mergedAt: iso(T0 + day * DAY), leadTimeHours: 12, deployedAt: null, deployLeadTimeHours: null }) as unknown as ChangeRecord;
  const changes = [change(c1, 0), change(c2, 1), change(c3, 2), change('e'.repeat(40), 2)];
  await attachDeployments(r.dir, changes, deploys, new Date(T0 - DAY));
  assert.deepEqual(changes.map((c) => c.deployedAt), [iso(T0 + 0.5 * DAY), iso(T0 + 3 * DAY), iso(T0 + 3 * DAY), null]);
  // Lead time to production runs from the change's own start (merge minus its lead time).
  assert.equal(changes[1]!.deployLeadTimeHours, 2 * 24 + 12);
});

// ---- Incidents ------------------------------------------------------------------

test('Linear: label and team filter, API key without Bearer, paging', async () => {
  const calls = stubFetch((_, body) => ({
    data: { issues: body.variables.after
      ? { nodes: [{ identifier: 'ENG-2', title: 'Checkout down', description: null, url: 'https://linear.app/x/ENG-2', createdAt: '2026-03-03T00:00:00Z', completedAt: null }], pageInfo: { hasNextPage: false, endCursor: null } }
      : { nodes: [{ identifier: 'ENG-1', title: 'Login loop', description: 'Caused-by: #12', url: 'https://linear.app/x/ENG-1', createdAt: '2026-03-02T00:00:00Z', completedAt: '2026-03-02T05:00:00Z' }], pageInfo: { hasNextPage: true, endCursor: 'c1' } } },
  }));
  const out = await linearIncidents('lin_key', ['Bug'], ['ENG'], new Date('2026-03-01T00:00:00Z'));
  assert.deepEqual(out.map((i) => [i.id, i.resolvedAt]), [['ENG-1', '2026-03-02T05:00:00Z'], ['ENG-2', null]]);
  assert.equal(out[0]!.text, 'Login loop\nCaused-by: #12');
  assert.equal(calls[0]!.headers.authorization, 'lin_key');
  assert.deepEqual((calls[0]!.body as any).variables.filter, {
    createdAt: { gte: '2026-03-01T00:00:00.000Z' }, labels: { some: { name: { in: ['Bug'] } } }, team: { key: { in: ['ENG'] } },
  });
});

test('Jira: bounded JQL, token paging, ADF text with links', async () => {
  assert.equal(
    adfText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Caused-by:' }, { type: 'inlineCard', attrs: { url: 'https://github.com/o/r/pull/7' } }] }] }),
    'Caused-by: https://github.com/o/r/pull/7',
  );
  const calls = stubFetch((url) => {
    const token = new URL(url).searchParams.get('nextPageToken');
    const issue = (key: string) => ({ key, fields: { summary: `Bug ${key}`, description: null, created: '2026-03-02T10:00:00.000+0000', resolutiondate: null } });
    return token ? { issues: [issue('P-2')], nextPageToken: 'same', isLast: false } : { issues: [issue('P-1')], nextPageToken: 'same', isLast: false };
  });
  const out = await jiraIncidents('https://acme.atlassian.net/', 'me@x.com', 'tok', 'issuetype = Bug', new Date('2026-03-01T00:00:00Z'));
  assert.deepEqual(out.map((i) => [i.id, i.url, i.createdAt]), [
    ['P-1', 'https://acme.atlassian.net/browse/P-1', '2026-03-02T10:00:00.000Z'],
    ['P-2', 'https://acme.atlassian.net/browse/P-2', '2026-03-02T10:00:00.000Z'],
  ]);
  assert.equal(calls.length, 2, 'a repeated page token stops the loop');
  const first = new URL(calls[0]!.url);
  assert.equal(first.pathname, '/rest/api/3/search/jql');
  assert.equal(first.searchParams.get('jql'), '(issuetype = Bug) AND created >= "2026-03-01" ORDER BY created DESC');
  assert.equal(calls[0]!.headers.authorization, `Basic ${Buffer.from('me@x.com:tok').toString('base64')}`);
});

test('PagerDuty: token header, services, offset paging and stretches within the date-range limit', async () => {
  const calls = stubFetch((url) => {
    const p = new URL(url).searchParams;
    const n = Number(p.get('offset'));
    return { incidents: [{ incident_number: n + 1, title: 'High error rate', created_at: p.get('since'), resolved_at: null, html_url: 'https://pd/x' }], more: n === 0 };
  });
  const since = new Date('2026-01-01T00:00:00Z');
  const out = await pagerDutyIncidents('pd_tok', ['SVC1'], since, new Date(since.getTime() + 100 * DAY));
  assert.equal(calls.length, 4, 'two stretches of up to 90 days, two pages each');
  assert.deepEqual(out.map((i) => i.id), ['PD-1', 'PD-101', 'PD-1', 'PD-101']);
  assert.equal(calls[0]!.headers.authorization, 'Token token=pd_tok');
  assert.match(calls[0]!.headers.accept!, /version=2/);
  assert.deepEqual(new URL(calls[0]!.url).searchParams.getAll('service_ids[]'), ['SVC1']);
});

test('loadIncidents: only trackers with credentials; failures become notes', async () => {
  delete process.env.LINEAR_API_KEY;
  delete process.env.PAGERDUTY_TOKEN;
  delete process.env.JIRA_EMAIL;
  assert.equal(await loadIncidents(cfg, new Date(0), new Date(), () => {}, () => {}), null);
  process.env.LINEAR_API_KEY = 'k';
  stubFetch(() => ({ message: 'nope' }), 401);
  const notes: string[] = [];
  assert.deepEqual(await loadIncidents({ ...cfg, incidents: { ...cfg.incidents, jiraSite: 'acme.atlassian.net' } }, new Date(0), new Date(), (n) => notes.push(n), () => {}), []);
  assert.equal(notes.length, 2);
  assert.match(notes[0]!, /JIRA_EMAIL/);
  assert.match(notes[1]!, /Couldn't read incidents from Linear: .*401/);
});

test('incidents blame changes by #N, PR URL or commit URL', () => {
  const incident = (id: string, text: string): Incident => ({ source: 'linear', id, title: id, url: 'u', createdAt: '2026-01-05T00:00:00Z', resolvedAt: null, text });
  const pr = (number: number) => ({ number, title: `PR ${number}`, body: '', mergedAt: '2026-01-02T00:00:00Z', mergeCommitOid: `m${number}`, commits: [], labels: [] }) as unknown as RawPr;
  const reports = [
    incident('ENG-1', 'Caused-by: #1'),
    incident('ENG-2', 'Regression from https://github.com/o/r/pull/2 last week'),
    incident('ENG-3', 'Caused-by: https://github.com/other/repo/pull/1'), // another repository
  ].map(incidentReport);
  const events = findRework([pr(1), pr(2)], reports, [], (s) => s, cfg, 'o/r');
  assert.deepEqual(events.map((e) => [e.target, e.kind, e.source]), [[1, 'incident', 'ENG-1'], [2, 'incident', 'ENG-2']]);

  const commit = { oid: 'abcdef1234567', committedAt: '2026-01-02T00:00:00Z', message: 'x', owners: new Set(['abcdef1234567']) };
  const byUrl = findCommitRework([commit], [incidentReport(incident('PD-9', 'Caused-by: https://github.com/o/r/commit/abcdef1'))], [], (s) => (s === 'abcdef1' ? 'abcdef1234567' : s));
  assert.deepEqual(byUrl.map((e) => [e.target, e.kind]), [['abcdef1234567', 'incident']]);
});

// ---- AI cost --------------------------------------------------------------------

test('Claude Code spend from the Admin API: cents to dollars, one day per request, finished days cached', async () => {
  const calls = stubFetch((url) => {
    const p = new URL(url).searchParams;
    return p.get('page')
      ? { data: [{ date: `${p.get('starting_at')}T00:00:00Z`, actor: { type: 'api_actor', api_key_name: 'ci-key' }, model_breakdown: [{ estimated_cost: { amount: 50 } }] }], has_more: false, next_page: null }
      : { data: [{ date: `${p.get('starting_at')}T00:00:00Z`, actor: { type: 'user_actor', email_address: 'a@x.com' }, model_breakdown: [{ estimated_cost: { amount: 113 } }, { estimated_cost: { amount: '7' } }] }], has_more: true, next_page: 'p2' };
  });
  const store = new Map<string, CostEntry[]>();
  const cache: CostCache = { get: (s, d) => store.get(`${s}:${d}`), set: (s, d, e) => void store.set(`${s}:${d}`, e) };
  const now = new Date('2026-03-03T12:00:00Z');
  const out = await claudeCodeCosts('admin', new Date('2026-03-02T08:00:00Z'), now, cfg, cache);
  assert.deepEqual(out.map((e) => [e.date, e.actor, e.usd, e.tool]), [
    ['2026-03-02', 'a@x.com', 1.2, 'Claude'], ['2026-03-02', 'ci-key', 0.5, 'Claude'],
    ['2026-03-03', 'a@x.com', 1.2, 'Claude'], ['2026-03-03', 'ci-key', 0.5, 'Claude'],
  ]);
  assert.equal(calls[0]!.headers['x-api-key'], 'admin');
  assert.equal(calls[0]!.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual([...store.keys()], ['claude-code:2026-03-02'], 'today is not cached');
  calls.length = 0;
  await claudeCodeCosts('admin', new Date('2026-03-02T08:00:00Z'), now, cfg, cache);
  assert.ok(calls.every((c) => new URL(c.url).searchParams.get('starting_at') === '2026-03-03'), 'cached days are not fetched again');
});

test('Claude Code OpenTelemetry export: delta sums add up, cumulative sums are differenced', () => {
  const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
  const point = (ms: number, v: number, email = 'a@x.com') => ({ attributes: [{ key: 'user.email', value: { stringValue: email } }], asDouble: v, timeUnixNano: ns(ms) });
  const request = (temporality: number, points: unknown[]) => JSON.stringify({ resourceMetrics: [{ scopeMetrics: [{ metrics: [
    { name: 'claude_code.cost.usage', sum: { aggregationTemporality: temporality, dataPoints: points } },
    { name: 'claude_code.token.usage', sum: { aggregationTemporality: 1, dataPoints: [point(T0, 999)] } },
  ] }] }] });
  const delta = otlpCosts([request(1, [point(T0, 0.5), point(T0 + 1000, 0.25)]), request(1, [point(T0 + DAY, 1, 'b@x.com')])].join('\n'), cfg);
  assert.deepEqual(delta.map((e) => [e.date, e.actor, e.usd, e.tool]), [['2026-01-05', 'a@x.com', 0.75, 'Claude'], ['2026-01-06', 'b@x.com', 1, 'Claude']]);
  const cumulative = otlpCosts(request(2, [point(T0, 1), point(T0 + 1000, 1.5), point(T0 + 2000, 0.25)]), cfg);
  assert.deepEqual(cumulative.map((e) => e.usd), [0.75], '0.5 more, then a reset to 0.25');
});

test('cost CSV, file sniffing and the actors filter', async () => {
  assert.deepEqual(csvCosts('Tool,Date,USD,Actor\nCursor,2026-03-01,"$1,000.50",\nCopilot,2026-03-02,19,bob', 'c.csv').map((e) => [e.tool, e.date, e.usd, e.actor]), [
    ['Cursor', '2026-03-01', 1000.5, null],
    ['Copilot', '2026-03-02', 19, 'bob'],
  ]);
  assert.throws(() => csvCosts('when,cost\n2026-01-01,1', 'c.csv'), /needs a "date" column/);
  assert.throws(() => csvCosts('date,tool,usd\nsoon,Cursor,1', 'c.csv'), /row 2 needs a date/);

  const dir = mkdtempSync(join(tmpdir(), 'agent-dora-cost-'));
  writeFileSync(join(dir, 'spend.csv'), 'date,tool,usd,actor\n2026-03-01,Cursor,10,alice@x.com\n2026-03-01,Cursor,5,bob@x.com\n2020-01-01,Cursor,99,alice@x.com\n');
  delete process.env.ANTHROPIC_ADMIN_KEY;
  const costCfg = { ...cfg, cost: { files: ['spend.csv', 'missing.csv'], actors: ['Alice@x.com'] } };
  const notes: string[] = [];
  const out = await loadCosts(costCfg, dir, new Date('2026-02-01T00:00:00Z'), new Date('2026-03-10T00:00:00Z'), undefined, (n) => notes.push(n), () => {});
  assert.deepEqual(out!.map((e) => [e.actor, e.usd]), [['alice@x.com', 10]], 'filtered to actors and to since');
  assert.match(notes[0]!, /missing.csv/);
  assert.equal(await loadCosts(cfg, dir, new Date(0), new Date(), undefined, () => {}, () => {}), null);
});

// ---- Report -----------------------------------------------------------------------

const NOW = Date.parse('2026-06-01T00:00:00Z');
const ago = (days: number) => iso(NOW - days * DAY);

function change(n: number, over: Partial<ChangeRecord> = {}): ChangeRecord {
  return {
    kind: 'pr', id: `#${n}`, number: n, oid: `oid${n}`, title: `Change ${n}`, url: `https://x/${n}`, author: 'a',
    authorClass: 'agent', classSource: 'author', classReason: '', tool: 'Claude',
    createdAt: ago(61), mergedAt: ago(60), firstCommitAt: ago(61), deployedAt: ago(59), deployLeadTimeHours: 48, firstReviewAt: null, leadTimeHours: 24, reviewWaitHours: null,
    reviewDepth: 'engaged', size: 10, rework: [],
    durability: { status: 'measured', baseline: 100, surviving: 80 },
    durable: true, remedial: false, ...over,
  };
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    repo: 'o/r', defaultBranch: 'main', branch: 'main', unit: 'prs', collectedAt: iso(NOW), since: ago(90),
    windowDays: 21, survivalThreshold: 0.7, minSurvivalLines: 5, openPrs: [], notes: [],
    changes: [
      change(1),
      change(2, { durable: false, deployLeadTimeHours: 10, rework: [{ target: 2, kind: 'incident', at: ago(55), from: { kind: 'incident', source: 'pagerduty', id: 'PD-1' }, source: 'PD-1' }] }),
      change(3, { authorClass: 'human', tool: null, deployedAt: null, deployLeadTimeHours: null }),
    ],
    ...over,
  };
}

const deploy = (daysAgo: number, status: Deployment['status'] = 'success'): Deployment => ({
  source: 'github', environment: 'Production', sha: `s${daysAgo}`, createdAt: ago(daysAgo), readyAt: status === 'success' ? ago(daysAgo) : null, status, url: null,
});
const incident = (id: string, daysAgo: number, hoursToResolve: number | null, source: Incident['source'] = 'pagerduty'): Incident => ({
  source, id, title: id, url: `https://pd/${id}`, createdAt: ago(daysAgo), resolvedAt: hoursToResolve === null ? null : iso(NOW - daysAgo * DAY + hoursToResolve * 3_600_000), text: id,
});

test('delivery: deploy frequency, failure by incident, time to restore, lead time to production', () => {
  const r = aggregate(snap({
    deployments: [deploy(70), deploy(60), deploy(50, 'failure'), deploy(40), deploy(5)],
    // PD-1 opens 12h after the deploy 60 days ago; PD-2 opens 5 days after the one 40 days ago (too late).
    incidents: [incident('PD-1', 59.5, 4), incident('PD-2', 35, 2), incident('ENG-9', 10, null, 'linear')],
  }));
  const d = r.delivery!;
  assert.equal(d.deploySource, 'github');
  // The period starts at the first change (60 days ago), so the deploy 70 days ago is outside it.
  assert.equal(d.deploys, 3);
  assert.ok(Math.abs(d.deploysPerWeek! - 3 / (60 / 7)) < 1e-9);
  assert.equal(d.failedDeploys, 1);
  assert.equal(d.undeployed, 1);
  assert.equal(d.incidents, 3);
  assert.deepEqual(d.incidentsBySource, { pagerduty: 2, linear: 1 });
  assert.equal(d.deploysWithIncident, 1);
  assert.equal(d.deployFailureRate, 1 / 3);
  assert.equal(d.timeToRestoreP50Hours, 3);
  assert.equal(d.linkedIncidents, 1);
  assert.equal(r.stats.agent.deployLeadTimeP50Hours, 29);
  assert.equal(r.stats.agent.escapedDefects, 1);
  assert.equal(r.weeks.reduce((n, w) => n + w.deploys, 0), 3);
  assert.equal(r.weeks.reduce((n, w) => n + w.incidents, 0), 3);
  assert.equal(r.changes.find((c) => c.id === '#2')!.failureReasons.join(), 'incident');

  const md = renderMarkdown(r);
  assert.match(md, /\| Lead time to production \(p50\) \| 29h \| — \| — \| 29h \|/);
  assert.match(md, /\| Escaped defects \| 1 \| 0 \| 0 \| 1 \|/);
  assert.match(md, /\| Deploys followed by an incident \| 33% \|/);
  const html = renderHtml(r);
  assert.ok(html.includes('<h2>Delivery</h2>'));
  assert.ok(html.includes('Week with an incident'));
  assert.ok(html.includes('>PD-1</a>'));

  const none = aggregate(snap());
  assert.equal(none.delivery, null);
  assert.doesNotMatch(renderMarkdown(none), /Lead time to production|Escaped defects/);
  assert.ok(!renderHtml(none).includes('<h2>Delivery</h2>'));
});

test('AI cost per durable change, per tool, over the matured period only', () => {
  const costs: CostEntry[] = [
    { source: 'claude-code', date: ago(60).slice(0, 10), tool: 'Claude', actor: 'a@x.com', usd: 30 },
    { source: 'file', date: ago(50).slice(0, 10), tool: 'Cursor', actor: null, usd: 12 },
    { source: 'claude-code', date: ago(3).slice(0, 10), tool: 'Claude', actor: 'a@x.com', usd: 7 }, // still maturing
  ];
  const r = aggregate(snap({ costs }));
  const c = r.cost!;
  assert.equal(c.usd, 42);
  assert.equal(c.durable, 1, 'only #1 is a durable AI change');
  assert.equal(c.perDurableChange, 42);
  assert.equal(c.perThousandSurvivingLines, (42 / 160) * 1000, 'both matured agent changes kept 80 lines');
  assert.equal(c.maturingUsd, 7);
  assert.equal(c.actors, 1);
  assert.deepEqual(c.byTool.map((t) => [t.tool, t.usd, t.durable, t.perDurableChange]), [['Claude', 30, 1, 30], ['Cursor', 12, 0, null]]);
  assert.match(renderMarkdown(r), /\| \*\*All\*\* \| \*\*\$42\.00\*\* \| \*\*1\*\* \| \*\*\$42\.00\*\* \|/);
  const html = renderHtml(r);
  assert.ok(html.includes('<h2>AI spend</h2>'));
  assert.ok(html.includes('AI spend / durable change'));
  assert.equal(aggregate(snap()).cost, null);
});

test('a commit deployed to several projects is one release', () => {
  const multi = [deploy(40), { ...deploy(40), environment: 'Production – api', readyAt: ago(39.9) }, deploy(30)];
  const d = aggregate(snap({ deployments: multi })).delivery!;
  assert.equal(d.deploys, 2);
  assert.deepEqual(d.environments, ['Production', 'Production – api']);
});

test('rollup counts shared incidents and spend once', () => {
  const shared = { incidents: [incident('ENG-1', 10, 1, 'linear')], costs: [{ source: 'claude-code' as const, date: '2026-05-01', tool: 'Claude', actor: 'a@x.com', usd: 5 }] };
  const c = combineSnapshots([snap({ repo: 'o/a', ...shared, deployments: [deploy(5)] }), snap({ repo: 'o/b', ...shared })]);
  assert.equal(c.incidents!.length, 1);
  assert.equal(c.costs!.length, 1);
  assert.equal(c.deployments!.length, 1);
  assert.equal(combineSnapshots([snap({ repo: 'o/a' }), snap({ repo: 'o/b' })]).costs, undefined);
});
