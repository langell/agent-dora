import { classify } from './classify.js';
import { fileMatcher } from './config.js';
import { ChangeKind } from './constants.js';
import { measureDurability, prLines, type ChangeLines } from './durability.js';
import * as g from './git.js';
import { buildPrRecord } from './metrics.js';
import type { ModeOptions } from './modes.js';
import { findRework, remedialPrs } from './rework.js';
import type { ChangeRecord, RawPr } from './types.js';
import { GIT_CONCURRENCY, mapLimit, progress } from './util.js';

/** PR mode: every PR merged into the branch is one change. */
export async function prChanges(prs: RawPr[], { repoPath, ref, since, cfg, now, bugIssues, cache, log = () => {} }: ModeOptions): Promise<ChangeRecord[]> {
  const reverts = await g.revertCommits(repoPath, ref, since);
  const resolve = await g.expandOids(repoPath, reverts.flatMap((r) => r.reverts));
  const rework = findRework(prs, bugIssues, reverts, resolve, cfg);
  const remedial = remedialPrs(prs, rework, cfg);
  const ignored = fileMatcher(cfg.ignoreFiles);

  log(`Measuring durability of ${prs.length} PRs against ${ref}...`);
  const tick = progress(log, prs.length);
  return mapLimit(prs, GIT_CONCURRENCY, async (pr): Promise<ChangeRecord> => {
    const oid = pr.mergeCommitOid;
    const local = oid !== null && (await g.hasCommit(repoPath, oid));
    // Looked up at most once, and only if durability or size needs it.
    let lines: Promise<ChangeLines> | undefined;
    const linesOf = (o: string) => (lines ??= prLines(repoPath, pr, o));
    const landed = { kind: ChangeKind.Pr, oid, landedAt: pr.mergedAt! };
    const durability = await measureDurability(repoPath, ref, landed, linesOf, cfg, now, cache);
    // Size from git skips lockfiles and other ignored files, like durability does.
    const size = local ? await g.diffSize(repoPath, (await linesOf(oid)).base, oid, ignored) : undefined;
    tick();
    return buildPrRecord(pr, classify(pr, cfg), rework.filter((e) => e.target === pr.number), durability, cfg, {
      size,
      remedial: remedial.has(pr.number),
    });
  });
}
