import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { Bus } from '../http/bus.js';
import { createRootLogger } from '../observability/logger.js';
import { openStorage, type Storage } from '../storage/db.js';
import { createEventSink } from './event-sink.js';
import { createMapEditCommand } from './map-edit.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

// A triangle around the fixture common room (0.42, 0.55) — its centroid
// lands in explored square (3, 4).
const TRIANGLE = [
  { x: 0.4, y: 0.53 },
  { x: 0.45, y: 0.53 },
  { x: 0.42, y: 0.58 },
];

describe('map-edit command seam (Flow A)', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(): {
    storage: Storage;
    mapEdit: ReturnType<typeof createMapEditCommand>;
    kicked: () => number;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-mapedit-'));
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'scene.started',
      payload: { scene_id: 's-seed', title: 'Seed' },
    });
    let kicks = 0;
    const mapEdit = createMapEditCommand({
      storage,
      sink: createEventSink(storage, new Bus(quietLogger())),
      kick: (): void => {
        kicks += 1;
      },
    });
    return { storage, mapEdit, kicked: () => kicks };
  }

  it('appends the durable intent, enqueues one map_edit job and kicks', () => {
    const ctx = setup();
    const result = ctx.mapEdit({
      world_id: 'w1',
      actor_id: 'user:owner',
      points: TRIANGLE,
      intent: 'a mill pond with a heron',
      request_id: 'e1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.jobKey).toBe('map_edit:w1:e1');
      expect(result.value.editId).toBe('e1');
    }
    const requested = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'map_edit.requested');
    expect(requested).toHaveLength(1);
    expect(requested[0]?.actor_id).toBe('user:owner');
    const jobs = ctx.storage.ledger.listActive('w1');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.type).toBe('map_edit');
    expect(ctx.kicked()).toBe(1);
  });

  it('a duplicate request_id is a silent no-op — one event, one job (I3)', () => {
    const ctx = setup();
    const command = {
      world_id: 'w1',
      actor_id: 'user:owner',
      points: TRIANGLE,
      intent: 'a mill pond',
      request_id: 'e1',
    };
    const first = ctx.mapEdit(command);
    const second = ctx.mapEdit(command);
    expect(first.ok && second.ok).toBe(true);
    expect(
      ctx.storage.eventLog
        .readSince(0)
        .filter((e) => e.type === 'map_edit.requested'),
    ).toHaveLength(1);
    expect(ctx.storage.ledger.listActive('w1')).toHaveLength(1);
  });

  it('a fog centroid is refused — 409, zero events, zero jobs (explored ground only)', () => {
    const ctx = setup();
    const before = ctx.storage.eventLog.readSince(0).length;
    const result = ctx.mapEdit({
      world_id: 'w1',
      actor_id: 'user:owner',
      // Square (0,0) holds no fixture sublocation — unexplored fog.
      points: [
        { x: 0.01, y: 0.01 },
        { x: 0.05, y: 0.01 },
        { x: 0.03, y: 0.05 },
      ],
      intent: 'a tower',
      request_id: 'e-fog',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unexplored_ground');
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(before);
    expect(ctx.storage.ledger.listActive('w1')).toHaveLength(0);
  });

  it('an unknown world is refused (worlds appear, never vanish)', () => {
    const ctx = setup();
    const result = ctx.mapEdit({
      world_id: 'w-ghost',
      actor_id: 'user:owner',
      points: TRIANGLE,
      intent: 'a tower',
      request_id: 'e1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('world_not_found');
  });
});
