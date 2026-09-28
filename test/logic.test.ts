import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, isIgnoredAuthor } from '../src/classify.js';
import { DEFAULT_CONFIG, fileMatcher, globToRegExp } from '../src/config.js';
import { ClassSource, UnavailableReason } from '../src/constants.js';
import { aggregate, buildPrRecord, isDurable, median } from '../src/metrics.js';
import { renderHtml, renderMarkdown } from '../src/report.js';
import { findRework } from '../src/rework.js';
import type { RawPr, Snapshot } from '../src/types.js';

const cfg = DEFAULT_CONFIG;
const DAY = 86_400_000;

function pr(over: Partial<RawPr> & { number: number }): RawPr {
  return {
    title: `PR ${over.number}`, body: '', url: `https://github.com/o/r/pull/${over.number}`, author: 'alice',
    createdAt: '2026-01-01T00:00:00Z', mergedAt: '2026-01-02T00:00:00Z', isDraft: false,
    headRefName: 'feature', baseRefName: 'main', labels: [], mergeCommitOid: `m${over.number}`,
    additions: 10, deletions: 2, commitCount: 1, commits: [{ oid: `c${over.number}`, message: 'change', authoredDate: '2026-01-01T00:00:00Z' }],
    reviews: [], ...over,
  };
}

test('classify: labels win, then agent author/branch, then assisted trailers', () => {
  assert.equal(classify(pr({ number: 1, author: 'Copilot' }), cfg).authorClass, 'agent');
  assert.equal(classify(pr({ number: 2, author: 'claude[bot]' }), cfg).authorClass, 'agent');
  assert.equal(classify(pr({ number: 3, headRefName: 'codex/fix-login' }), cfg).authorClass, 'agent');
  const trailer = 'fix it\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
  assert.equal(classify(pr({ number: 4, commits: [{ oid: 'x', message: trailer, authoredDate: '' }] }), cfg).authorClass, 'assisted');
  assert.equal(classify(pr({ number: 5, body: '🤖 Generated with [Claude Code](https://claude.com/claude-code)' }), cfg).authorClass, 'assisted');
  assert.equal(classify(pr({ number: 6 }), cfg).authorClass, 'human');
  const labelled = classify(pr({ number: 7, author: 'Copilot', labels: ['AI:None'] }), cfg);
  assert.deepEqual(labelled, { authorClass: 'human', source: 'label', reason: 'label ai:none' });
  assert.equal(classify(pr({ number: 8, commits: [{ oid: 'x', message: 'Co-authored-by: Bob <bob@x.com>', authoredDate: '' }] }), cfg).authorClass, 'human');
});

test('classify reports which signal decided', () => {
  const src = (over: Partial<RawPr>) => classify(pr({ number: 1, ...over }), cfg).source;
  assert.equal(src({ labels: ['ai:agent'] }), 'label');
  assert.equal(src({ author: 'Copilot' }), 'author');
  assert.equal(src({ headRefName: 'claude/x' }), 'branch');
  assert.equal(src({ body: 'Generated with Claude Code' }), 'trailer');
  assert.equal(src({}), 'none');
});

test('ignored authors', () => {
  assert.ok(isIgnoredAuthor('dependabot[bot]', cfg));
  assert.ok(isIgnoredAuthor('renovate', cfg));
  assert.ok(!isIgnoredAuthor('alice', cfg));
});

test('globs', () => {
  assert.ok(globToRegExp('**/package-lock.json').test('package-lock.json'));
  assert.ok(globToRegExp('**/package-lock.json').test('apps/web/package-lock.json'));
  assert.ok(globToRegExp('**/dist/**').test('pkg/dist/a/b.js'));
  assert.ok(!globToRegExp('*.js').test('src/a.js'));
  const ignored = fileMatcher(cfg.ignoreFiles);
  assert.ok(ignored('web/app.min.js'));
  assert.ok(!ignored('src/index.ts'));
});

test('rework: git reverts, GitHub revert PRs, rework labels, caused-by', () => {
  const merged = [
    pr({ number: 1, title: 'Add login', mergeCommitOid: 'aaa111' }),
    pr({ number: 2, title: 'Add search' }),
    pr({ number: 3, title: 'Add export' }),
    pr({ number: 4, title: 'Add billing' }),
    pr({ number: 10, title: 'Revert "Add search"', body: 'Reverts o/r#2', mergedAt: '2026-01-05T00:00:00Z' }),
    pr({ number: 11, title: 'Fix export crash from #3', labels: ['hotfix'], mergedAt: '2026-01-06T00:00:00Z' }),
    pr({ number: 12, title: 'Fix unrelated', body: 'mentions #4 but no rework label', mergedAt: '2026-01-06T00:00:00Z' }),
  ];
  const reverts = [{ oid: 'rrr999', at: '2026-01-04T00:00:00Z', subject: 'Revert "Add login"', reverts: ['aaa1'] }];
  const issues = [{ number: 50, title: 'Billing broken', body: 'Caused-by: #4', createdAt: '2026-01-07T00:00:00Z' }];
  const events = findRework(merged, issues, reverts, (s) => (s === 'aaa1' ? 'aaa111' : s), cfg);
  const byTarget = (n: number) => events.filter((e) => e.target === n).map((e) => e.kind).sort();
  assert.deepEqual(byTarget(1), ['revert']);
  assert.deepEqual(byTarget(2), ['revert']); // body and title both point here; deduped per source
  assert.deepEqual(byTarget(3), ['rework']);
  assert.deepEqual(byTarget(4), ['bug']);
  assert.equal(events.filter((e) => Number(e.target) >= 10).length, 0);
});

test('rework before the target merged is ignored', () => {
  const merged = [pr({ number: 1, mergedAt: '2026-02-01T00:00:00Z' }), pr({ number: 2, labels: ['hotfix'], title: 'fix #1', mergedAt: '2026-01-15T00:00:00Z' })];
  assert.equal(findRework(merged, [], [], (s) => s, cfg).length, 0);
});

test('isDurable', () => {
  const merged = '2026-01-01T00:00:00Z';
  const measured = (b: number, s: number) => ({ status: 'measured' as const, baseline: b, surviving: s });
  assert.equal(isDurable(merged, [], measured(10, 7), cfg), true);
  assert.equal(isDurable(merged, [], measured(10, 6), cfg), false);
  assert.equal(isDurable(merged, [{ target: 1, kind: 'revert', at: '2026-01-05T00:00:00Z', source: 'x' }], measured(10, 10), cfg), false);
  // Rework after the window doesn't retroactively fail the PR.
  assert.equal(isDurable(merged, [{ target: 1, kind: 'bug', at: '2026-03-01T00:00:00Z', source: 'x' }], measured(10, 10), cfg), true);
  assert.equal(isDurable(merged, [], { status: 'pending', baseline: 0, surviving: 0 }, cfg), null);
  assert.equal(isDurable(merged, [], { status: 'unavailable', baseline: 0, surviving: 0, reason: UnavailableReason.NoMeasurableLines }, cfg), true);
  assert.equal(isDurable(merged, [], { status: 'unavailable', baseline: 0, surviving: 0, reason: UnavailableReason.NotInHistory }, cfg), null);
});

test('median', () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

function snapshot(): Snapshot {
  const now = Date.parse('2026-04-01T00:00:00Z');
  const since = new Date(now - 70 * DAY).toISOString();
  const rec = (n: number, cls: 'agent' | 'assisted' | 'human', daysAgo: number, surviving: number) => {
    const mergedAt = new Date(now - daysAgo * DAY).toISOString();
    const createdAt = new Date(now - daysAgo * DAY - 2 * DAY).toISOString();
    const raw = pr({ number: n, mergedAt, createdAt, commits: [{ oid: `c${n}`, message: 'x', authoredDate: createdAt }], reviews: [{ submittedAt: new Date(now - daysAgo * DAY - DAY).toISOString(), author: 'bob' }] });
    const d = daysAgo > 21 ? { status: 'measured' as const, baseline: 10, surviving } : { status: 'pending' as const, baseline: 0, surviving: 0 };
    return buildPrRecord(raw, { authorClass: cls, source: ClassSource.None, reason: 'test' }, [], d, cfg);
  };
  return {
    repo: 'o/r', defaultBranch: 'main', branch: 'main', unit: 'prs', notes: [], collectedAt: new Date(now).toISOString(), since, windowDays: 21, survivalThreshold: 0.7,
    changes: [rec(1, 'agent', 60, 10), rec(2, 'agent', 50, 2), rec(3, 'assisted', 40, 9), rec(4, 'human', 30, 10), rec(5, 'human', 5, 0)],
    openPrs: [{ number: 9, title: '<b>open</b>', url: 'https://x', authorClass: 'agent', createdAt: new Date(now - 3 * DAY).toISOString(), awaitingFirstReview: true }],
  };
}

test('aggregate', () => {
  const r = aggregate(snapshot());
  assert.equal(r.stats.all.merged, 5);
  assert.equal(r.stats.all.matured, 4);
  assert.equal(r.stats.all.durable, 3);
  assert.equal(r.stats.agent.durableRate, 0.5);
  assert.equal(r.stats.agent.churn, 0.4); // 8 of 20 lines gone
  assert.equal(r.stats.human.matured, 1);
  assert.equal(r.stats.all.reviewWaitP50Hours, 24);
  assert.equal(r.stats.all.leadTimeP50Hours, 48);
  assert.equal(r.stats.agent.awaitingReview, 1);
  // Period runs from the first change (60 days ago) to 21 days ago: 39 days.
  assert.ok(Math.abs(r.maturedWeeks - 39 / 7) < 1e-9);
  assert.ok(Math.abs(r.stats.all.durablePerWeek! - 3 / (39 / 7)) < 1e-9);
  assert.equal(r.weeks[0]!.week, '2026-01-26', 'weekly series starts at the first change, not at since');
  const weeklyDurable = r.weeks.reduce((s, w) => s + w.durable.all, 0);
  assert.equal(weeklyDurable, 3);
  assert.ok(r.weeks.at(-1)!.matured === false);
});

test('report renders and escapes', () => {
  const r = aggregate(snapshot());
  const html = renderHtml(r);
  assert.ok(html.includes('<title>agent-dora · o/r</title>'));
  assert.ok(!html.includes('<b>open</b>'), 'raw HTML from PR titles must be escaped in embedded JSON');
  const md = renderMarkdown(r);
  assert.match(md, /\| Durable rate \| 50% \| 100% \| 100% \| 75% \|/);
});

test('durable per week is empty, not zero, when nothing has matured', () => {
  const snap = snapshot();
  snap.changes = snap.changes.filter((c) => c.durable === null);
  const r = aggregate(snap);
  assert.equal(r.stats.all.durablePerWeek, null);
  assert.match(renderMarkdown(r), /\| Durable PRs \/ week \| — \| — \| — \| — \|/);
  assert.match(renderMarkdown(r), /Not enough history yet/);
});

test('report wording follows the unit', () => {
  const snap = snapshot();
  snap.unit = 'commits';
  snap.notes = ['Most changes bypass pull requests'];
  const md = renderMarkdown(aggregate(snap));
  assert.match(md, /counting commits/);
  assert.match(md, /\| Commits \|/);
  assert.match(md, /Durable commits \/ week/);
  assert.doesNotMatch(md, /Time to first review/);
  assert.match(md, /> Most changes bypass pull requests/);
});

test('progress logs every PROGRESS_EVERY items', async () => {
  const { progress, PROGRESS_EVERY } = await import('../src/util.js');
  const lines: string[] = [];
  const tick = progress((m) => lines.push(m), PROGRESS_EVERY * 2 + 3);
  for (let i = 0; i < PROGRESS_EVERY * 2 + 3; i++) tick();
  assert.deepEqual(lines, [`  ${PROGRESS_EVERY}/${PROGRESS_EVERY * 2 + 3}`, `  ${PROGRESS_EVERY * 2}/${PROGRESS_EVERY * 2 + 3}`]);
});

test('mapLimit keeps input order and never exceeds the limit', async () => {
  const { mapLimit } = await import('../src/util.js');
  let inFlight = 0;
  let peak = 0;
  const delays = [30, 5, 20, 1, 15, 10, 2, 25];
  const out = await mapLimit(delays, 3, async (ms) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, ms));
    inFlight--;
    return ms * 2;
  });
  assert.deepEqual(out, delays.map((ms) => ms * 2));
  assert.equal(peak, 3);
  assert.deepEqual(await mapLimit([], 4, async (x) => x), []);
});

test('weeklySeries buckets by Monday-start UTC week and marks matured weeks', async () => {
  const { period, weeklySeries } = await import('../src/metrics.js');
  const snap = snapshot();
  const now = new Date(snap.collectedAt);
  const p = period(snap, now);
  const weeks = weeklySeries(snap.changes, p, now);
  for (const w of weeks) assert.equal(new Date(w.week).getUTCDay(), 1, `${w.week} is a Monday`);
  assert.equal(weeks.reduce((n, w) => n + w.merged.all, 0), snap.changes.length);
  assert.equal(weeks.reduce((n, w) => n + w.merged.agent, 0), 2);
  // A week is matured only if it ended before the durability window began.
  for (const w of weeks) assert.equal(w.matured, Date.parse(w.week) + 7 * DAY <= p.maturedUntil);
  assert.deepEqual(weeklySeries([], period({ ...snap, changes: [] }, now), now).length > 0, true);
});

test('classStats on an empty class is empty, not zero', async () => {
  const { classStats, period } = await import('../src/metrics.js');
  const snap = snapshot();
  const now = new Date(snap.collectedAt);
  const s = classStats([], [], period(snap, now), now);
  assert.equal(s.merged, 0);
  for (const k of ['durableRate', 'durablePerWeek', 'churn', 'changeFailureRate', 'leadTimeP50Hours', 'sizeP50'] as const) assert.equal(s[k], null, k);
});
