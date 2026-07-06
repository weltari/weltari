// Invariant I1 (Brief §2.1): the events table is append-only, enforced by the
// database itself. Raw driver access is sanctioned in tests/ only (Guide A11).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { openStorage } from '../../apps/server/src/storage/db.js';

function seededDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weltari-inv-'));
  const dbPath = join(dir, 'w.sqlite');
  const storage = openStorage({ dbPath });
  storage.eventLog.append({
    world_id: 'w1',
    actor_id: 'user:owner',
    type: 'turn.started',
    payload: { scene_id: 's1', turn_id: 't1' },
  });
  storage.close();
  return dbPath;
}

it('raw UPDATE and DELETE on events abort', () => {
  const db = new Database(seededDbPath());
  expect(() =>
    db.prepare("UPDATE events SET type='x' WHERE id=1").run(),
  ).toThrow(/append-only/);
  expect(() => db.prepare('DELETE FROM events WHERE id=1').run()).toThrow(
    /append-only/,
  );
  db.close();
});
