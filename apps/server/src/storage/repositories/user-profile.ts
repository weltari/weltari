// Sole SQL site for user_profile (Brief §2.7) — the GM's profiling side
// store (M7 part 2, Rev 4 §9 Job 2 / §4.3). NOT a projection of the event
// log, deliberately: profiling text is personal data that must be truly
// erasable (GDPR); events carry counts only, and deleteAll() physically
// removes rows no replay can resurrect.
import type Database from 'better-sqlite3';

export interface ProfileEntry {
  id: number;
  actor_id: string;
  kind: 'hypothesis' | 'engagement';
  body: string;
  context_id: string;
  created_at: string;
}

export interface NewProfileEntry {
  actor_id: string;
  kind: 'hypothesis' | 'engagement';
  body: string;
  context_id: string;
}

export interface UserProfileRepository {
  append(entry: NewProfileEntry): void;
  /** Every row for the actor, oldest first — the view/export surface. */
  list(actorId: string): ProfileEntry[];
  count(actorId: string): number;
  /** True when ANY row exists for (actor, context) — the analysis job's
   * idempotency re-check (its ledger key is the eager gate). */
  hasContext(actorId: string, contextId: string): boolean;
  /** The GDPR erasure: physically removes the actor's rows; returns how
   * many were removed. */
  deleteAll(actorId: string): number;
}

function isEntry(row: unknown): row is ProfileEntry {
  return (
    row !== null &&
    typeof row === 'object' &&
    'id' in row &&
    'actor_id' in row &&
    'kind' in row &&
    'body' in row &&
    'context_id' in row &&
    'created_at' in row
  );
}

export function createUserProfileRepository(
  db: Database.Database,
  nowIso: () => string,
): UserProfileRepository {
  const insert = db.prepare(
    `INSERT INTO user_profile (actor_id, kind, body, context_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const selectAll = db.prepare(
    `SELECT id, actor_id, kind, body, context_id, created_at
     FROM user_profile WHERE actor_id = ? ORDER BY id ASC`,
  );
  const countRows = db.prepare(
    `SELECT COUNT(*) AS n FROM user_profile WHERE actor_id = ?`,
  );
  const countContext = db.prepare(
    `SELECT COUNT(*) AS n FROM user_profile WHERE actor_id = ? AND context_id = ?`,
  );
  const removeAll = db.prepare(`DELETE FROM user_profile WHERE actor_id = ?`);
  return {
    append(entry: NewProfileEntry): void {
      insert.run(
        entry.actor_id,
        entry.kind,
        entry.body,
        entry.context_id,
        nowIso(),
      );
    },
    list(actorId: string): ProfileEntry[] {
      return selectAll.all(actorId).filter(isEntry);
    },
    count(actorId: string): number {
      const row: unknown = countRows.get(actorId);
      return row !== null &&
        typeof row === 'object' &&
        'n' in row &&
        typeof row.n === 'number'
        ? row.n
        : 0;
    },
    hasContext(actorId: string, contextId: string): boolean {
      const row: unknown = countContext.get(actorId, contextId);
      return (
        row !== null &&
        typeof row === 'object' &&
        'n' in row &&
        typeof row.n === 'number' &&
        row.n > 0
      );
    },
    deleteAll(actorId: string): number {
      return removeAll.run(actorId).changes;
    },
  };
}
