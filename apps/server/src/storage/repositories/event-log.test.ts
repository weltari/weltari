import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../db.js';

function tempStorage(nowIso?: () => string): {
  storage: Storage;
  dbPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'weltari-evlog-'));
  const dbPath = join(dir, 'w.sqlite');
  const options = nowIso === undefined ? { dbPath } : { dbPath, nowIso };
  return { storage: openStorage(options), dbPath };
}

describe('EventLogRepository', () => {
  it('append assigns strictly increasing ids and the injected timestamp', () => {
    const { storage } = tempStorage(() => '2026-07-06T12:00:00.000Z');
    const a = storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'scene.started',
      payload: { scene_id: 's1', title: 'The Rainy Inn' },
    });
    const b = storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'turn.started',
      payload: { scene_id: 's1', turn_id: 't1' },
    });
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(a.ts).toBe('2026-07-06T12:00:00.000Z');
    expect(storage.eventLog.lastId()).toBe(2);
    storage.close();
  });

  it('readSince returns only events after the cursor, in order', () => {
    const { storage } = tempStorage();
    for (let i = 0; i < 5; i++) {
      storage.eventLog.append({
        world_id: 'w1',
        actor_id: 'user:owner',
        type: 'turn.started',
        payload: { scene_id: 's1', turn_id: `t${String(i)}` },
      });
    }
    const tail = storage.eventLog.readSince(3);
    expect(tail.map((e) => e.id)).toEqual([4, 5]);
    expect(storage.eventLog.readSince(5)).toEqual([]);
    expect(storage.eventLog.readSince(0)).toHaveLength(5);
    storage.close();
  });

  it('a stored row that fails protocol validation throws CorruptStateError on read', () => {
    const { storage, dbPath } = tempStorage();
    storage.close();
    const raw = new Database(dbPath);
    raw
      .prepare(
        'INSERT INTO events (world_id, actor_id, type, payload, ts) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        'w1',
        'user:owner',
        'not.a.real.type',
        '{}',
        '2026-07-06T12:00:00.000Z',
      );
    raw.close();
    const reopened = openStorage({ dbPath });
    expect(() => reopened.eventLog.readSince(0)).toThrow(/does not validate/);
    reopened.close();
  });

  it('a payload that is not JSON throws CorruptStateError on read', () => {
    const { storage, dbPath } = tempStorage();
    storage.close();
    const raw = new Database(dbPath);
    raw
      .prepare(
        'INSERT INTO events (world_id, actor_id, type, payload, ts) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        'w1',
        'user:owner',
        'turn.started',
        'not json',
        '2026-07-06T12:00:00.000Z',
      );
    raw.close();
    const reopened = openStorage({ dbPath });
    expect(() => reopened.eventLog.readSince(0)).toThrow(/not JSON/);
    reopened.close();
  });
});
