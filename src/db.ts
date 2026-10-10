import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChangeKind, ClassSource, prId, UnavailableReason, Unit } from './constants.js';
import type { CostCache } from './cost.js';
import type { DurabilityCache, Measurement } from './durability.js';
import type { ChangeRecord, CostEntry, Snapshot } from './types.js';

/** Snapshots before 0.3 stored the user-facing wording of an unavailable reason, not its code. */
const LEGACY_REASONS: Record<string, UnavailableReason> = {
  'no merge commit': UnavailableReason.NoMergeCommit,
  'merge commit not in local history (use fetch-depth: 0)': UnavailableReason.NotInHistory,
  'not merged into the default branch': UnavailableReason.NotOnBranch,
  'no measurable added lines': UnavailableReason.NoMeasurableLines,
};

/**
 * Durability measurements, as JSON. Replaces the 0.2 `durability` table, whose rows held
 * only line counts under a narrower key; it's left alone and simply no longer read.
 */
const DURABILITY_TABLE = 'durability_v2';

/**
 * SQLite store: the latest snapshot per repo, plus a durability cache.
 * Durability is immutable once a PR's window has elapsed, so caching it
 * keeps nightly runs fast on repos with long histories.
 */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (repo TEXT PRIMARY KEY, collected_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ${DURABILITY_TABLE} (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS costs (source TEXT NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (source, date));
    `);
  }

  saveSnapshot(snap: Snapshot): void {
    this.db
      .prepare('INSERT INTO snapshots (repo, collected_at, data) VALUES (?, ?, ?) ON CONFLICT(repo) DO UPDATE SET collected_at = excluded.collected_at, data = excluded.data')
      .run(snap.repo, snap.collectedAt, JSON.stringify(snap));
  }

  /** The snapshot for `repo`, or the most recent one if `repo` is omitted. */
  loadSnapshot(repo?: string): Snapshot | null {
    const row = repo
      ? this.db.prepare('SELECT data FROM snapshots WHERE repo = ?').get(repo)
      : this.db.prepare('SELECT data FROM snapshots ORDER BY collected_at DESC LIMIT 1').get();
    return row ? migrate(String(row.data)) : null;
  }

  /** Every repository's latest snapshot, most recent first. */
  loadAllSnapshots(): Snapshot[] {
    return this.db.prepare('SELECT data FROM snapshots ORDER BY collected_at DESC').all().map((row) => migrate(String(row.data)));
  }

  durabilityCache(): DurabilityCache {
    const get = this.db.prepare(`SELECT data FROM ${DURABILITY_TABLE} WHERE key = ?`);
    const set = this.db.prepare(`INSERT OR REPLACE INTO ${DURABILITY_TABLE} (key, data) VALUES (?, ?)`);
    return {
      get: (key) => {
        const row = get.get(key);
        return row ? (JSON.parse(String(row.data)) as Measurement) : undefined;
      },
      set: (key, v) => void set.run(key, JSON.stringify(v)),
    };
  }

  /** AI spend for finished days, so each day is fetched once. */
  costCache(): CostCache {
    const get = this.db.prepare('SELECT data FROM costs WHERE source = ? AND date = ?');
    const set = this.db.prepare('INSERT OR REPLACE INTO costs (source, date, data) VALUES (?, ?, ?)');
    return {
      get: (source, date) => {
        const row = get.get(source, date);
        return row ? (JSON.parse(String(row.data)) as CostEntry[]) : undefined;
      },
      set: (source, date, entries) => void set.run(source, date, JSON.stringify(entries)),
    };
  }

  close(): void {
    this.db.close();
  }
}

/** Parses a stored snapshot, filling in what older versions didn't record. */
function migrate(data: string): Snapshot {
  const snap = JSON.parse(data) as Snapshot & { prs?: Omit<ChangeRecord, 'kind' | 'id' | 'classSource'>[] };
  // Snapshots from 0.1.x stored PRs under `prs`, before commit mode existed.
  if (snap.prs && !snap.changes) {
    // 0.1.x didn't record which signal classified a PR; only live labelling reads it.
    snap.changes = snap.prs.map((p) => ({ ...p, kind: ChangeKind.Pr, id: prId(p.number!), classSource: ClassSource.None }));
    snap.branch ??= snap.defaultBranch;
    snap.unit ??= Unit.Prs;
    snap.notes ??= [];
    delete snap.prs;
  }
  for (const c of snap.changes) {
    c.remedial ??= false;
    c.oid ??= null;
    c.tool ??= null;
    c.reviewDepth ??= null;
    c.deployedAt ??= null;
    c.deployLeadTimeHours ??= null;
    const reason = c.durability?.reason as string | undefined;
    if (reason !== undefined && reason in LEGACY_REASONS) c.durability.reason = LEGACY_REASONS[reason];
  }
  return snap;
}
