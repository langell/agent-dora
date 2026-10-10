import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classify } from '../src/classify.js';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { aggregate, dirOf, quantile, reviewDepth, wilson } from '../src/metrics.js';
import { renderCsv, renderMarkdown } from '../src/report.js';
import { combineSnapshots } from '../src/rollup.js';
import type { ChangeRecord, PrReview, RawPr, Snapshot } from '../src/types.js';

const cfg = DEFAULT_CONFIG;
const DAY = 86_400_000;
const NOW = Date.parse('2026-06-01T00:00:00Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function rawPr(over: Partial<RawPr> = {}): RawPr {
  return {
    number: 1, title: 't', body: '', url: 'u', author: 'alice', createdAt: ago(10), updatedAt: ago(9), mergedAt: ago(9), isDraft: false,
    headRefName: 'feature', baseRefName: 'main', labels: [], mergeCommitOid: 'm', additions: 1, deletions: 0, commitCount: 1,
    commits: [{ oid: 'c', message: 'x', authoredDate: ago(10) }], reviews: [], ...over,
  };
}

const review = (over: Partial<PrReview> = {}): PrReview => ({ author: 'bob', submittedAt: ago(9), isBot: false, state: 'APPROVED', commented: false, ...over });

/** A matured, measured change; override anything. */
function change(n: number, over: Partial<ChangeRecord> = {}): ChangeRecord {
  return {
    kind: 'pr', id: `#${n}`, number: n, oid: `oid${n}`, title: `Change ${n}`, url: `https://x/${n}`, author: 'a',
    authorClass: 'human', classSource: 'none', classReason: '', tool: null,
    createdAt: ago(61), mergedAt: ago(60), firstCommitAt: ago(61), firstReviewAt: null, leadTimeHours: 24, reviewWaitHours: null,
    reviewDepth: 'engaged', size: 10, rework: [],
    durability: { status: 'measured', baseline: 10, surviving: 10, files: [{ path: 'src/a/x.ts', baseline: 10, surviving: 10 }], curve: [{ days: 7, surviving: 10 }, { days: 14, surviving: 10 }] },
    durable: true, remedial: false, ...over,
  };
}

function snap(changes: ChangeRecord[], over: Partial<Snapshot> = {}): Snapshot {
  return {
    repo: 'o/r', defaultBranch: 'main', branch: 'main', unit: 'prs', collectedAt: new Date(NOW).toISOString(), since: ago(180),
    windowDays: 21, survivalThreshold: 0.7, minSurvivalLines: 5, changes, openPrs: [], notes: [], ...over,
  };
}

test('tools: read from the evidence that decided the class, never for human changes', () => {
  const tool = (over: Partial<RawPr>) => classify(rawPr(over), cfg).tool;
  assert.equal(tool({ author: 'Copilot' }), 'Copilot');
  assert.equal(tool({ author: 'chatgpt-codex-connector[bot]' }), 'Codex');
  assert.equal(tool({ headRefName: 'devin/fix' }), 'Devin');
  assert.equal(tool({ commits: [{ oid: 'x', message: 'x\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>', authoredDate: '' }] }), 'Claude');
  assert.equal(tool({ commits: [{ oid: 'x', message: 'x\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>', authoredDate: '' }] }), 'Cursor');
  assert.equal(tool({}), null);
  // A labelled agent PR with no tool credit anywhere is "Other", and free text isn't scanned.
  assert.equal(tool({ labels: ['ai:agent'], body: 'Fix the pagination cursor' }), 'Other');
  assert.equal(tool({ labels: ['ai:agent'], author: 'Copilot' }), 'Copilot');
  const custom = { ...cfg, agentAuthors: ['acme-bot'], tools: { ...cfg.tools, Acme: 'acme' } };
  assert.equal(classify(rawPr({ author: 'acme-bot' }), custom).tool, 'Acme');
});

test('config: unknown keys warn, wrong types and bad regexes fail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-dora-cfg-'));
  const write = (o: unknown) => writeFileSync(join(dir, '.agent-dora.json'), JSON.stringify(o));
  const warnings: string[] = [];
  write({ windowDay: 14, labels: { rework: ['oops'], bugz: ['x'] }, tools: { Acme: 'acme' } });
  const c = loadConfig(dir, {}, (m) => warnings.push(m));
  assert.deepEqual(warnings, ['.agent-dora.json: unknown key "windowDay" has no effect', '.agent-dora.json: unknown label group "bugz" has no effect']);
  assert.equal(c.tools.Acme, 'acme');
  assert.equal(c.tools.Claude, cfg.tools.Claude, 'tools merge key by key');
  write({ windowDays: '14' });
  assert.throws(() => loadConfig(dir), /"windowDays" must be a number, got string/);
  write({ ignoreFiles: 'dist/**' });
  assert.throws(() => loadConfig(dir), /"ignoreFiles" must be an array of strings/);
  write({ assistedPatterns: ['(unclosed'] });
  assert.throws(() => loadConfig(dir), /assistedPatterns\[0\] is not a valid regex/);
  write({ checkpointDays: [7, 0] });
  assert.throws(() => loadConfig(dir), /checkpointDays must be positive/);
  write([1, 2]);
  assert.throws(() => loadConfig(dir), /must hold a JSON object/);
});

test('quantile and wilson', () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75);
  assert.equal(wilson(0, 0), null);
  const [lo, hi] = wilson(8, 10)!;
  assert.ok(lo > 0.44 && lo < 0.5 && hi > 0.94 && hi < 0.97, `${lo} ${hi}`);
  const [wideLo, wideHi] = wilson(1, 2)!;
  assert.ok(wideHi - wideLo > hi - lo, 'smaller samples get wider intervals');
});

test('review depth: none, silent approval, engaged', () => {
  assert.equal(reviewDepth(rawPr(), cfg), 'none');
  assert.equal(reviewDepth(rawPr({ reviews: [review({ author: 'coderabbitai', commented: true })] }), cfg), 'none', 'bot reviews do not count');
  assert.equal(reviewDepth(rawPr({ reviews: [review()] }), cfg), 'silent');
  assert.equal(reviewDepth(rawPr({ reviews: [review(), review({ state: 'COMMENTED', commented: true })] }), cfg), 'engaged');
  assert.equal(reviewDepth(rawPr({ reviews: [review({ state: 'CHANGES_REQUESTED' })] }), cfg), 'engaged');
});

test('aggregate: tools, rubber stamps, quantiles, class sources, queue ages', () => {
  const r = aggregate(snap(
    [
      change(1, { authorClass: 'agent', tool: 'Copilot', classSource: 'author', reviewDepth: 'none', leadTimeHours: 10 }),
      change(2, { authorClass: 'agent', tool: 'Copilot', classSource: 'author', reviewDepth: 'silent', leadTimeHours: 20 }),
      change(3, { authorClass: 'assisted', tool: 'Claude', classSource: 'trailer', leadTimeHours: 30 }),
      change(4, { leadTimeHours: 40 }),
    ],
    {
      openPrs: [
        { number: 9, title: 'a', url: 'u', authorClass: 'agent', createdAt: ago(0.5), awaitingFirstReview: true },
        { number: 10, title: 'b', url: 'u', authorClass: 'human', createdAt: ago(10), awaitingFirstReview: true },
        { number: 11, title: 'c', url: 'u', authorClass: 'human', createdAt: ago(10), awaitingFirstReview: false },
      ],
    },
  ));
  assert.deepEqual(r.tools.map((t) => [t.tool, t.stats.merged]), [['Copilot', 2], ['Claude', 1]]);
  assert.equal(r.stats.agent.rubberStampRate, 1);
  assert.equal(r.stats.all.rubberStampRate, 0.5);
  assert.deepEqual(r.stats.all.reviewDepth, { none: 1, silent: 1, engaged: 2 });
  assert.equal(r.stats.all.leadTime!.p50, 25);
  assert.equal(r.stats.all.leadTime!.p10, 13);
  assert.ok(r.stats.all.durableRateCi![0] < 1 && r.stats.all.durableRateCi![1] === 1);
  assert.equal(r.classSources.agent.author, 2);
  assert.equal(r.classSources.assisted.trailer, 1);
  assert.equal(r.classSources.human.none, 1);
  assert.deepEqual(r.queueAges.map((b) => [b.maxDays, b.counts.agent, b.counts.human]), [[1, 1, 0], [3, 0, 0], [7, 0, 0], [null, 0, 1]]);
});

test('aggregate: who fixed whom, inside the window only', () => {
  const r = aggregate(snap([
    change(1, { authorClass: 'agent', durable: false, rework: [
      { target: 1, kind: 'rework', at: ago(58), from: { kind: 'pr', number: 2 }, source: '#2' },
      { target: 1, kind: 'bug', at: ago(55), from: { kind: 'issue', number: 50 }, source: 'issue #50' },
      { target: 1, kind: 'bug', at: ago(50), from: { kind: 'pr', number: 999 }, source: '#999' },
      { target: 1, kind: 'bug', at: ago(10), from: { kind: 'pr', number: 2 }, source: '#2' }, // after the window
    ] }),
    change(2, { authorClass: 'human', mergedAt: ago(58), remedial: true }),
    change(3, { authorClass: 'assisted', kind: 'commit', id: 'abc1234', number: null, oid: null, durable: false, rework: [
      { target: 'x', kind: 'revert', at: ago(59), source: 'def5678' }, // pre-0.3 event without `from`
    ] }),
  ]));
  assert.deepEqual(r.fixes.agent, { agent: 0, assisted: 0, human: 1, issue: 1, outside: 1 });
  assert.deepEqual(r.fixes.assisted, { agent: 0, assisted: 0, human: 0, issue: 0, outside: 1 });
  const failed = r.changes.find((c) => c.id === '#1')!;
  assert.deepEqual(failed.failureReasons, ['rework', 'bug']);
});

test('aggregate: failure reasons include rewritten lines', () => {
  const r = aggregate(snap([change(1, { durable: false, durability: { status: 'measured', baseline: 10, surviving: 3 } })]));
  assert.deepEqual(r.changes[0]!.failureReasons, ['churned']);
});

test('aggregate: hotspots group lost lines by directory', () => {
  assert.equal(dirOf('src/a/b/c.ts', 2), 'src/a');
  assert.equal(dirOf('src/c.ts', 2), 'src');
  assert.equal(dirOf('README.md', 2), '.');
  const files = (list: [string, number, number][]) => ({ status: 'measured' as const, baseline: 0, surviving: 0, files: list.map(([path, baseline, surviving]) => ({ path, baseline, surviving })) });
  const r = aggregate(snap([
    change(1, { authorClass: 'agent', durability: { ...files([['src/api/a.ts', 10, 2], ['src/ui/b.ts', 5, 5]]), baseline: 15, surviving: 7 } }),
    change(2, { authorClass: 'human', durability: { ...files([['src/api/c.ts', 10, 9], ['README.md', 4, 1]]), baseline: 14, surviving: 10 } }),
    change(3, { mergedAt: ago(5), durable: null, durability: { status: 'pending', baseline: 0, surviving: 0 } }),
  ]));
  assert.deepEqual(r.hotspots.map((h) => [h.dir, h.baseline, h.lost]), [['src/api', 20, 9], ['.', 4, 3]]);
  assert.deepEqual(r.hotspots[0]!.byClass.agent, { baseline: 10, lost: 8 });
});

test('aggregate: survival curve over changes measured at every checkpoint', () => {
  const curve = (s7: number | null, s14: number, final: number) => ({ status: 'measured' as const, baseline: 10, surviving: final, curve: [{ days: 7, surviving: s7 }, { days: 14, surviving: s14 }] });
  const r = aggregate(snap([
    change(1, { authorClass: 'agent', durability: curve(9, 6, 5) }),
    change(2, { authorClass: 'human', durability: curve(10, 10, 9) }),
    change(3, { authorClass: 'human', durability: curve(null, 0, 0) }), // missing a checkpoint: left out
  ]));
  assert.deepEqual(r.survivalCurve.map((row) => [row.days, row.kept.agent, row.kept.human, row.kept.all]), [
    [0, 1, 1, 1],
    [7, 0.9, 1, 0.95],
    [14, 0.6, 1, 0.8],
    [21, 0.5, 0.9, 0.7],
  ]);
  assert.deepEqual(aggregate(snap([change(1, { durability: { status: 'measured', baseline: 10, surviving: 10 } })])).survivalCurve, []);
});

test('aggregate: compares the latest matured stretch with the one before', () => {
  // Window 21 days, so changes up to 21 days ago are matured. compareDays 28.
  const r = aggregate(snap([
    change(1, { mergedAt: ago(30), durable: true }),
    change(2, { mergedAt: ago(40), durable: false }),
    change(3, { mergedAt: ago(60), durable: false }),
    change(4, { mergedAt: ago(70), durable: false }),
    change(5, { mergedAt: ago(76), durable: true }),
    change(6, { mergedAt: ago(85), durable: true }), // before both stretches: only sets how far back the data reaches
  ], { since: ago(90) }));
  const cmp = r.comparison!;
  assert.equal(cmp.days, 28);
  assert.equal(cmp.current.all.matured, 2);
  assert.equal(cmp.current.all.durableRate, 0.5);
  assert.equal(cmp.previous!.all.matured, 3);
  assert.ok(Math.abs(cmp.previous!.all.durableRate! - 1 / 3) < 1e-9);
  assert.match(renderMarkdown(r), /### Last 28 matured days vs the 28 before/);
  assert.match(renderMarkdown(r), /\| Durable rate \| — → — \| — → — \| 33% → 50% \| 33% → 50% \|/);
  // Not enough history for even one stretch.
  assert.equal(aggregate(snap([change(1, { mergedAt: ago(30) })], { since: ago(40) })).comparison, null);
});

test('csv escapes and lists every change', () => {
  const r = aggregate(snap([change(1, { title: 'Fix "quotes", commas\nand lines', authorClass: 'agent', tool: 'Claude' })]));
  const csv = renderCsv(r);
  assert.match(csv.split('\n')[0]!, /^repo,kind,id,title,url,author,author_class,tool,/);
  assert.ok(csv.includes(',#1,"Fix ""quotes"", commas\nand lines",https://x/1,a,agent,Claude,'));
  assert.ok(csv.endsWith('\n'));
});

test('rollup combines repositories and refuses mismatched settings', () => {
  const a = snap([change(1)], { repo: 'o/a', collectedAt: ago(1), notes: ['note a'] });
  const b = snap([change(1), change(2)], { repo: 'o/b', openPrs: [{ number: 3, title: 't', url: 'u', authorClass: 'agent', createdAt: ago(1), awaitingFirstReview: true }] });
  const older = { ...b, collectedAt: ago(5), changes: [] };
  const c = combineSnapshots([a, older, b]);
  assert.deepEqual(c.repos, ['o/a', 'o/b']);
  assert.equal(c.repo, '2 repositories');
  assert.equal(c.changes.length, 3, 'the older o/b snapshot is ignored');
  assert.deepEqual(c.changes.map((x) => x.repo), ['o/a', 'o/b', 'o/b']);
  assert.equal(c.openPrs[0]!.repo, 'o/b');
  assert.deepEqual(c.notes, ['o/a: note a']);
  assert.equal(c.collectedAt, ago(1));
  assert.throws(() => combineSnapshots([a, { ...b, windowDays: 14 }]), /windowDays differs/);
  assert.throws(() => combineSnapshots([]), /No collected data/);
  // Two #1s from different repositories don't collide in who-fixed-whom.
  const r = aggregate(c);
  assert.equal(r.stats.all.merged, 3);
  assert.deepEqual(r.repos, ['o/a', 'o/b']);
});

test('store keeps every repository and caches full measurements', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'agent-dora-db-')), 'cache.db');
  const store = new Store(path);
  store.saveSnapshot(snap([change(1)], { repo: 'o/a', collectedAt: ago(2) }));
  store.saveSnapshot(snap([], { repo: 'o/b', collectedAt: ago(1) }));
  assert.deepEqual(store.loadAllSnapshots().map((s) => s.repo), ['o/b', 'o/a']);
  const cache = store.durabilityCache();
  const m = { baseline: 5, surviving: 4, files: [{ path: 'a', baseline: 5, surviving: 4 }], curve: [{ days: 7, surviving: 5 }] };
  cache.set('k', m);
  assert.deepEqual(cache.get('k'), m);
  assert.equal(cache.get('missing'), undefined);
  store.close();
});
