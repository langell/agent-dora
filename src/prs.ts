import { classify } from './classify.js';
import { measureDurability } from './durability.js';
import * as g from './git.js';
import { buildPrRecord } from './metrics.js';
import type { ModeOptions } from './modes.js';
import { findRework } from './rework.js';
import type { ChangeRecord, RawPr } from './types.js';
import { progress } from './util.js';

/** PR mode: every PR merged into the branch is one change. */
export async function prChanges(prs: RawPr[], { repoPath, ref, since, cfg, now, bugIssues, cache, log = () => {} }: ModeOptions): Promise<ChangeRecord[]> {
  const reverts = await g.revertCommits(repoPath, ref, since);
  const resolve = await g.expandOids(repoPath, reverts.flatMap((r) => r.reverts));
  const rework = findRework(prs, bugIssues, reverts, resolve, cfg);

  log(`Measuring durability of ${prs.length} PRs against ${ref}...`);
  const out: ChangeRecord[] = [];
  const tick = progress(log, prs.length);
  for (const pr of prs) {
    const durability = await measureDurability(repoPath, ref, { ...pr, mergedAt: pr.mergedAt! }, cfg, now, cache);
    out.push(buildPrRecord(pr, classify(pr, cfg), rework.filter((e) => e.target === pr.number), durability, cfg));
    tick();
  }
  return out;
}
