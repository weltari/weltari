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

  it('readAllSince pages through the whole log: every event once, in id order', () => {
    // Page size 3 over 10 rows in two worlds (the table is shared by all
    // worlds): four internal pages, the last one short.
    const dir = mkdtempSync(join(tmpdir(), 'weltari-evlog-'));
    const storage = openStorage({
      dbPath: join(dir, 'w.sqlite'),
      eventPageSize: 3,
    });
    for (let i = 0; i < 10; i++) {
      storage.eventLog.append({
        world_id: i % 2 === 0 ? 'w1' : 'w2',
        actor_id: 'user:owner',
        type: 'turn.started',
        payload: { scene_id: 's1', turn_id: `t${String(i)}` },
      });
    }
    const all = storage.eventLog.readAllSince(0);
    expect(all.map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(all.map((e) => e.world_id)).toEqual([
      'w1',
      'w2',
      'w1',
      'w2',
      'w1',
      'w2',
      'w1',
      'w2',
      'w1',
      'w2',
    ]);
    // The same rows the single unpaged read returns, validated alike.
    expect(all).toEqual(storage.eventLog.readSince(0, 1000));
    // A cursor mid-log; an exact multiple of the page (9 rows = 3 full
    // pages, then an empty read); a cursor at the head.
    expect(storage.eventLog.readAllSince(4).map((e) => e.id)).toEqual([
      5, 6, 7, 8, 9, 10,
    ]);
    expect(storage.eventLog.readAllSince(1)).toHaveLength(9);
    expect(storage.eventLog.readAllSince(10)).toEqual([]);
    // The bounded read stays ONE page — the reason folds must not use it.
    expect(storage.eventLog.readSince(0, 3).map((e) => e.id)).toEqual([
      1, 2, 3,
    ]);
    storage.close();
  });

  it('readAllSince validates every row on every page: a corrupt row past the first page throws', () => {
    const { storage, dbPath } = tempStorage();
    for (let i = 0; i < 4; i++) {
      storage.eventLog.append({
        world_id: 'w1',
        actor_id: 'user:owner',
        type: 'turn.started',
        payload: { scene_id: 's1', turn_id: `t${String(i)}` },
      });
    }
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
    const reopened = openStorage({ dbPath, eventPageSize: 2 });
    expect(reopened.eventLog.readSince(0, 2)).toHaveLength(2); // page 1 is clean
    expect(() => reopened.eventLog.readAllSince(0)).toThrow(
      /event 5 does not validate/,
    );
    reopened.close();
  });

  it('a page size that is not a positive integer is a BugError at open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-evlog-'));
    const dbPath = join(dir, 'w.sqlite');
    expect(() => openStorage({ dbPath, eventPageSize: 0 })).toThrow(
      /page size must be a positive integer/,
    );
    expect(() => openStorage({ dbPath, eventPageSize: 2.5 })).toThrow(
      /page size must be a positive integer/,
    );
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
