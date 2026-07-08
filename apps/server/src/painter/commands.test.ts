// The image lease (week-7 fix): painter jobs CHAIN composites per image, so
// two paints for one image must never run concurrently — same region or not.
// M2's per-region lease let three concurrent real generations read the same
// base and drop each other's tiles (caught by the first real-backend run).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../storage/db.js';
import { createPaintRegionCommand, enqueueSquarePaint } from './commands.js';

describe('painter image lease (serial_group per image)', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(): Storage {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-paintcmd-'));
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    return storage;
  }

  it('two squares of one image never run concurrently (the chain is safe)', () => {
    const db = setup();
    enqueueSquarePaint(db, 'w1', { col: 0, row: 0 });
    enqueueSquarePaint(db, 'w1', { col: 5, row: 1 }); // different region!

    const first = db.ledger.claimNext('worker-a');
    expect(first?.idempotency_key).toBe('painter:map:w1:sq-0-0');
    // The second square is due but its image has a running paint — skipped.
    expect(db.ledger.claimNext('worker-b')).toBeNull();
  });

  it('different images stay independent', () => {
    const db = setup();
    enqueueSquarePaint(db, 'w1', { col: 0, row: 0 });
    const command = createPaintRegionCommand(db);
    command({
      world_id: 'w2',
      actor_id: 'user:owner',
      image_id: 'map:w2',
      request_id: 'r1',
      region: { x: 0, y: 0, width: 64, height: 64 },
    });

    expect(db.ledger.claimNext('worker-a')?.world_id).toBe('w1');
    expect(db.ledger.claimNext('worker-b')?.world_id).toBe('w2');
  });

  it('a duplicate square enqueue is a silent no-op (I3)', () => {
    const db = setup();
    enqueueSquarePaint(db, 'w1', { col: 2, row: 2 });
    enqueueSquarePaint(db, 'w1', { col: 2, row: 2 });
    expect(db.ledger.claimNext('worker-a')).not.toBeNull();
    expect(db.ledger.claimNext('worker-b')).toBeNull();
  });
});
