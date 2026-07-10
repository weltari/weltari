import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStorage } from '../storage/db.js';
import { createScheduler, intervalOccurrencesBetween } from './scheduler.js';

const NOW = '2026-07-06T12:00:30.000Z';

describe('intervalOccurrencesBetween (M6 part 4: game-time proactive cadence)', () => {
  it('epoch-aligned boundaries in (from, to]: every replay derives the same set', () => {
    // 12:00:30 → 12:11 with a 5-minute cadence: the 12:05 and 12:10 boundaries.
    expect(
      intervalOccurrencesBetween(
        '2026-07-06T12:00:30.000Z',
        '2026-07-06T12:11:00.000Z',
        5,
      ),
    ).toEqual(['2026-07-06T12:05:00.000Z', '2026-07-06T12:10:00.000Z']);
    // Exactly ON a boundary: from is exclusive, to is inclusive.
    expect(
      intervalOccurrencesBetween(
        '2026-07-06T12:05:00.000Z',
        '2026-07-06T12:10:00.000Z',
        5,
      ),
    ).toEqual(['2026-07-06T12:10:00.000Z']);
    // A skip crossing no boundary enqueues nothing (a paused world
    // that never advances can never fire — owner ruling 2026-07-10).
    expect(
      intervalOccurrencesBetween(
        '2000-01-01T06:00:00.000Z',
        '2000-01-01T18:00:00.000Z',
        1440,
      ),
    ).toEqual([]);
    // A daily cadence across one fictional day fires once, at the boundary.
    expect(
      intervalOccurrencesBetween(
        '2000-01-01T06:00:00.000Z',
        '2000-01-02T06:00:00.000Z',
        1440,
      ),
    ).toEqual(['2000-01-02T00:00:00.000Z']);
    // Fractional minutes work (the harness cadence): 0.02 = 1.2 s windows.
    expect(
      intervalOccurrencesBetween(
        '2026-07-06T12:00:00.000Z',
        '2026-07-06T12:00:02.400Z',
        0.02,
      ),
    ).toHaveLength(2);
  });
});

describe('croner scheduler', () => {
  it('writes the next occurrence as a ledger row and never duplicates it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-sched-'));
    const storage = openStorage({
      dbPath: join(dir, 'w.sqlite'),
      nowIso: () => NOW,
    });
    const scheduler = createScheduler(
      storage,
      [{ pattern: '*/5 * * * *', jobType: 'cron.heartbeat', worldId: 'w1' }],
      () => NOW,
    );

    scheduler.tick();
    scheduler.tick(); // idempotent: same occurrence, same key, no duplicate

    const expectedRunAt = '2026-07-06T12:05:00.000Z';
    const key = `cron:cron.heartbeat:w1:${expectedRunAt}`;
    expect(storage.ledger.countByKey(key)).toBe(1);

    const job = storage.ledger.claimNext('w');
    expect(job).toBeNull(); // future-dated: not claimable before run_at
    storage.close();
  });

  it('a due cron row is claimable and the next occurrence gets its own key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-sched2-'));
    let now = '2026-07-06T12:04:59.000Z';
    const nowIso = (): string => now;
    const storage = openStorage({ dbPath: join(dir, 'w.sqlite'), nowIso });
    const scheduler = createScheduler(
      storage,
      [{ pattern: '*/5 * * * *', jobType: 'cron.heartbeat', worldId: 'w1' }],
      nowIso,
    );

    scheduler.tick(); // schedules 12:05:00
    now = '2026-07-06T12:05:01.000Z';
    const due = storage.ledger.claimNext('w');
    expect(due?.type).toBe('cron.heartbeat');

    scheduler.tick(); // now schedules 12:10:00 — a different idempotency key
    expect(
      storage.ledger.countByKey(
        'cron:cron.heartbeat:w1:2026-07-06T12:10:00.000Z',
      ),
    ).toBe(1);
    storage.close();
  });
});
