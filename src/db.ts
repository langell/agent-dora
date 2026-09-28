import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChangeKind, ClassSource, prId, Unit } from './constants.js';
import type { DurabilityCache } from './durability.js';
import type { ChangeRecord, Snapshot } from './types.js';

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
      CREATE TABLE IF NOT EXISTS durability (key TEXT PRIMARY KEY, baseline INTEGER NOT NULL, surviving INTEGER NOT NULL);
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
    if (!row) return null;
    const snap = JSON.parse(String(row.data)) as Snapshot & { prs?: Omit<ChangeRecord, 'kind' | 'id' | 'classSource'>[] };
    // Snapshots from 0.1.x stored PRs under `prs`, before commit mode existed.
    if (snap.prs && !snap.changes) {
      // 0.1.x didn't record which signal classified a PR; only live labelling reads it.
      snap.changes = snap.prs.map((p) => ({ ...p, kind: ChangeKind.Pr, id: prId(p.number!), classSource: ClassSource.None }));
      snap.branch ??= snap.defaultBranch;
      snap.unit ??= Unit.Prs;
      snap.notes ??= [];
      delete snap.prs;
    }
    return snap;
  }

  durabilityCache(): DurabilityCache {
    const get = this.db.prepare('SELECT baseline, surviving FROM durability WHERE key = ?');
    const set = this.db.prepare('INSERT OR REPLACE INTO durability (key, baseline, surviving) VALUES (?, ?, ?)');
    return {
      get: (key) => {
        const row = get.get(key);
        return row ? { baseline: Number(row.baseline), surviving: Number(row.surviving) } : undefined;
      },
      set: (key, v) => void set.run(key, v.baseline, v.surviving),
    };
  }

  close(): void {
    this.db.close();
  }
}
