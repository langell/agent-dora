import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, isHumanReview, isIgnoredAuthor } from '../src/classify.js';
import { DEFAULT_CONFIG, fileMatcher, globToRegExp } from '../src/config.js';
import { ClassSource, UnavailableReason } from '../src/constants.js';
import { aggregate, buildPrRecord, changeStatus, isDurable, median } from '../src/metrics.js';
import { renderHtml } from '../src/report-html.js';
import { renderMarkdown } from '../src/report.js';
import { findRework, looksRemedial, remedialPrs } from '../src/rework.js';
import type { PrReview, RawPr, Snapshot } from '../src/types.js';

const cfg = DEFAULT_CONFIG;
const DAY = 86_400_000;

const review = (author: string | null, submittedAt: string, over: Partial<PrReview> = {}): PrReview =>
  ({ author, submittedAt, isBot: false, state: 'APPROVED', commented: false, ...over });

function pr(over: Partial<RawPr> & { number: number }): RawPr {
  return {
    title: `PR ${over.number}`, body: '', url: `https://github.com/o/r/pull/${over.number}`, author: 'alice',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', mergedAt: '2026-01-02T00:00:00Z', isDraft: false,
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
  assert.deepEqual(labelled, { authorClass: 'human', source: 'label', reason: 'label ai:none', tool: null });
  assert.equal(classify(pr({ number: 8, commits: [{ oid: 'x', message: 'Co-authored-by: Bob <bob@x.com>', authoredDate: '' }] }), cfg).authorClass, 'human');
});

test('classify reports which signal decided', () => {
  const src = (over: Partial<RawPr>) => classify(pr({ number: 1, ...over }), cfg).source;
  assert.equal(src({ labels: ['ai:agent'] }), 'label');
  assert.equal(src({ author: 'Copilot' }), 'author');
  assert.equal(src({ headRefName: 'codex/x' }), 'branch');
  assert.equal(src({ body: 'Generated with Claude Code' }), 'trailer');
  assert.equal(src({}), 'none');
});

test('classify: person-named agents need their address, interactive branch prefixes are not agents', () => {
  const coAuthor = (line: string) => classify(pr({ number: 1, commits: [{ oid: 'x', message: `fix\n\n${line}`, authoredDate: '' }] }), cfg).authorClass;
  assert.equal(coAuthor('Co-authored-by: Devin Smith <devin@example.com>'), 'human');
  assert.equal(coAuthor('Co-authored-by: Claude Dupont <claude@example.fr>'), 'human');
  assert.equal(coAuthor('Co-authored-by: Devin AI <158243242+devin-ai-integration[bot]@users.noreply.github.com>'), 'assisted');
  assert.equal(coAuthor('Co-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>'), 'assisted');
  assert.equal(classify(pr({ number: 2, headRefName: 'claude/eager-fox' }), cfg).authorClass, 'human');
});

test('classify: conflicting class labels are ignored, not resolved by order', () => {
  const c = classify(pr({ number: 1, labels: ['ai:agent', 'ai:none'], body: 'Generated with Claude Code' }), cfg);
  assert.equal(c.authorClass, 'assisted');
  assert.equal(c.source, 'trailer');
  assert.match(c.reason, /ignored conflicting labels ai:agent, ai:none/);
});

test('human reviews exclude the author, bots and AI reviewers', () => {
  const at = '2026-01-01T00:00:00Z';
  assert.ok(isHumanReview(review('bob', at), 'alice', cfg));
  assert.ok(!isHumanReview(review('alice', at), 'alice', cfg));
  assert.ok(!isHumanReview(review('Alice', at), 'alice', cfg));
  assert.ok(!isHumanReview(review(null, at), 'alice', cfg));
  assert.ok(!isHumanReview(review('copilot-pull-request-reviewer', at, { isBot: true }), 'alice', cfg));
  assert.ok(!isHumanReview(review('coderabbitai', at), 'alice', cfg), 'listed in botReviewers');
  assert.ok(!isHumanReview(review('some-app[bot]', at), 'alice', cfg));
  assert.ok(!isHumanReview(review('claude', at), 'alice', cfg), 'agent accounts are not human reviewers');
});

test('time to first review skips bot reviews', () => {
  const raw = pr({
    number: 1, createdAt: '2026-01-01T00:00:00Z', mergedAt: '2026-01-03T00:00:00Z',
    reviews: [review('copilot-pull-request-reviewer', '2026-01-01T00:05:00Z', { isBot: true }), review('bob', '2026-01-02T00:00:00Z')],
  });
  const rec = buildPrRecord(raw, { authorClass: 'human', source: ClassSource.None, reason: '', tool: null }, [], { status: 'pending', baseline: 0, surviving: 0 }, cfg);
  assert.equal(rec.firstReviewAt, '2026-01-02T00:00:00.000Z');
  assert.equal(rec.reviewWaitHours, 24);
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
  const sources = events.map((e) => `${e.target}<-${e.source}`).sort();
  assert.deepEqual(sources, ['1<-rrr999', '2<-#10', '3<-#11', '4<-issue #50']);
  assert.deepEqual(events.find((e) => e.target === 4)!.from, { kind: 'issue', number: 50 });

  // Reverts and fixes are remedial: they don't count as durable output.
  assert.deepEqual([...remedialPrs(merged, events, cfg)].sort((a, b) => a - b), [10, 11]);
});

test('a revert commit that landed through a PR is credited to that PR', () => {
  const merged = [pr({ number: 1, mergeCommitOid: 'aaa111' }), pr({ number: 2, mergeCommitOid: 'bbb222', title: 'Undo it', mergedAt: '2026-01-04T00:00:00Z' })];
  const reverts = [{ oid: 'bbb222', at: '2026-01-04T00:00:00Z', subject: 'Undo it', reverts: ['aaa111'] }];
  const events = findRework(merged, [], reverts, (s) => s, cfg);
  assert.deepEqual(events.map((e) => [e.target, e.from, e.source]), [[1, { kind: 'pr', number: 2 }, '#2']]);
  // ...and a PR reverting its own commit is not rework.
  assert.equal(findRework(merged, [], [{ ...reverts[0]!, reverts: ['bbb222'] }], (s) => s, cfg).length, 0);
});

test('looksRemedial recognises reverts and fixes without a known target', () => {
  assert.ok(looksRemedial('Revert "Add search"\n\nThis reverts commit abc1234.'));
  assert.ok(looksRemedial('Revert "Add search"'));
  assert.ok(looksRemedial('Fix crash\n\nCaused-by: 1a2b3c4'));
  assert.ok(looksRemedial('Fix crash\n\nCaused-by: #12'));
  assert.ok(looksRemedial('Undo\n\nReverts o/r#12'));
  assert.ok(!looksRemedial('Add search'));
  // Global regexes must not carry state between calls.
  assert.ok(looksRemedial('Fix\n\nCaused-by: #12') && looksRemedial('Fix\n\nCaused-by: #12'));
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
  // A revert inside the window fails a change at once, before the window ends.
  assert.equal(isDurable(merged, [{ target: 1, kind: 'revert', at: '2026-01-03T00:00:00Z', source: 'x' }], { status: 'pending', baseline: 0, surviving: 0 }, cfg), false);
  // Below minSurvivalLines, survival is too noisy to judge on.
  assert.equal(isDurable(merged, [], measured(3, 1), cfg), true);
  assert.equal(isDurable(merged, [], measured(3, 1), { ...cfg, minSurvivalLines: 0 }), false);
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
    const raw = pr({ number: n, mergedAt, createdAt, commits: [{ oid: `c${n}`, message: 'x', authoredDate: createdAt }], reviews: [review('bob', new Date(now - daysAgo * DAY - DAY).toISOString())] });
    const d = daysAgo > 21 ? { status: 'measured' as const, baseline: 10, surviving } : { status: 'pending' as const, baseline: 0, surviving: 0 };
    return buildPrRecord(raw, { authorClass: cls, source: ClassSource.None, reason: 'test', tool: cls === 'human' ? null : 'Claude' }, [], d, cfg);
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

test('early failures, fixes and reverts are kept out of rates', () => {
  const snap = snapshot();
  const now = Date.parse(snap.collectedAt);
  const failedEarly = buildPrRecord(
    pr({ number: 20, mergedAt: new Date(now - 3 * DAY).toISOString(), createdAt: new Date(now - 4 * DAY).toISOString() }),
    { authorClass: 'agent', source: ClassSource.None, reason: '', tool: null },
    [{ target: 20, kind: 'revert', at: new Date(now - 2 * DAY).toISOString(), source: '#21' }],
    { status: 'pending', baseline: 0, surviving: 0 }, cfg,
  );
  const revertPr = buildPrRecord(
    pr({ number: 21, mergedAt: new Date(now - 30 * DAY).toISOString() }),
    { authorClass: 'human', source: ClassSource.None, reason: '', tool: null }, [],
    { status: 'unavailable', baseline: 0, surviving: 0, reason: UnavailableReason.NoMeasurableLines }, cfg, { remedial: true },
  );
  assert.equal(failedEarly.durable, false);
  assert.equal(changeStatus(failedEarly), 'failed');
  assert.equal(changeStatus(revertPr), 'remedial');
  snap.changes.push(failedEarly, revertPr);
  const r = aggregate(snap);
  assert.equal(r.stats.all.merged, 7);
  assert.equal(r.stats.all.remedial, 1);
  assert.equal(r.stats.all.matured, 4, 'neither the early failure nor the revert is matured');
  assert.equal(r.stats.all.durable, 3);
  assert.equal(r.stats.agent.failingEarly, 1);
  assert.equal(r.stats.agent.changeFailureRate, 0);
  assert.equal(r.weeks.reduce((s, w) => s + w.merged.all, 0), 6, 'weekly series skips remedial changes');
});

test('stats: kept p50, surviving lines and windowed reverts', () => {
  const snap = snapshot();
  const r = aggregate(snap);
  // Matured agent changes kept 10/10 and 2/10.
  assert.equal(r.stats.agent.keptP50, 0.6);
  assert.ok(Math.abs(r.stats.all.survivingLinesPerWeek! - 31 / r.maturedWeeks) < 1e-9);
  const late = snap.changes[0]!;
  late.rework = [{ target: 1, kind: 'revert', at: new Date(Date.parse(late.mergedAt) + 40 * DAY).toISOString(), source: 'x' }];
  assert.equal(aggregate(snap).stats.agent.reverts, 0, 'a revert after the window is not counted');
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

test('findCommitRework: attributes to the carrying change, skips self-fixes, early fixes and duplicates', async () => {
  const { findCommitRework } = await import('../src/rework.js');
  const change = (oid: string, committedAt: string, message: string, owners: string[] = []) =>
    ({ oid, committedAt, message, owners: new Set([oid, ...owners]) });
  const merge = change('m1', '2026-01-10T00:00:00Z', 'Merge feature', ['f1', 'f2']);
  const later = change('c2', '2026-01-12T00:00:00Z', 'Fix it\n\nCaused-by: f2abcde');
  const selfRef = change('c3', '2026-01-13T00:00:00Z', 'Tidy\n\nCaused-by: c3');
  const reverts = [
    { oid: 'r1', at: '2026-01-11T00:00:00Z', subject: 'Revert', reverts: ['f1'] },
    { oid: 'r1', at: '2026-01-11T00:00:00Z', subject: 'Revert', reverts: ['f1'] }, // duplicate
    { oid: 'r0', at: '2026-01-09T00:00:00Z', subject: 'Revert', reverts: ['f2'] }, // before m1 landed
  ];
  const full = (s: string) => (s === 'f2abcde' ? 'f2' : s);
  const events = findCommitRework([merge, later, selfRef], [], reverts, full);
  assert.deepEqual(
    events.map((e) => `${e.target}:${e.kind}:${e.source}`).sort(),
    ['m1:bug:c2', 'm1:revert:r1'],
  );
});
