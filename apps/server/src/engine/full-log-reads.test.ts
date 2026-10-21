// Whole-log folds read the WHOLE log, however long it is. They used to read
// `readSince(0, 100000)` — the OLDEST 100k rows of the events table every
// world shares — and the scene window `readSince(0, 10000)`, so past those
// sizes the world clock froze and the current scene's lines left the prompt.
// Inserting 100k rows per test is too slow; `scaledCaps` scales every bounded
// page read down instead: one test row stands for SCALE log rows, so a capped
// read of the old sizes sees as many of the oldest rows here as it saw of a
// log SCALE times longer. Folds read through readAllSince, which pages the
// real log (with a tiny page size here, so the paging itself runs too).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Bus,
  type DevBus,
  type EventBus,
  type StreamBus,
} from '../http/bus.js';
import { createFakeLlmClient } from '../llm/fake-client.js';
import type { LlmCall, LlmCallResult, LlmClient } from '../llm/types.js';
import { createRootLogger } from '../observability/logger.js';
import type { Result } from '../errors.js';
import { openStorage, type Storage } from '../storage/db.js';
import { createEventSink } from './event-sink.js';
import { createTurnEngine } from './scene-turn.js';
import { worldTimeOf } from './world-clock.js';

/** The old caps over SCALE: readSince(0, 100000) sees 10 rows, (0, 10000) 1. */
const SCALE = 10_000;

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

/** The same storage, with every bounded readSince page scaled down by
 * `scale` — the stand-in for a log `scale` times longer than the test's. */
function scaledCaps(storage: Storage, scale: number): Storage {
  const real = storage.eventLog;
  return {
    ...storage,
    eventLog: {
      append: (event) => real.append(event),
      readSince: (sinceId, limit = 1000) =>
        real.readSince(sinceId, Math.ceil(limit / scale)),
      readAllSince: (sinceId) => real.readAllSince(sinceId),
      lastId: () => real.lastId(),
    },
  };
}

const opened: Storage[] = [];

/** Real storage whose readAllSince pages every 4 rows. */
function pagedStorage(): Storage {
  const dir = mkdtempSync(join(tmpdir(), 'weltari-fulllog-'));
  const storage = openStorage({
    dbPath: join(dir, 'w.sqlite'),
    eventPageSize: 4,
  });
  opened.push(storage);
  return storage;
}

function hourIso(hour: number): string {
  return `2026-03-01T${String(hour).padStart(2, '0')}:00:00.000Z`;
}

function appendSkip(storage: Storage, worldId: string, hour: number): void {
  storage.eventLog.append({
    world_id: worldId,
    actor_id: 'user:owner',
    type: 'world.time_advanced',
    payload: {
      from: hourIso(hour),
      to: hourIso(hour + 1),
      code_enqueued: 0,
      llm_enqueued: 0,
      llm_skipped: 0,
    },
  });
}

function appendTurn(
  storage: Storage,
  sceneId: string,
  turnId: string,
  text: string,
): void {
  storage.eventLog.append({
    world_id: 'w1',
    actor_id: 'user:owner',
    type: 'turn.committed',
    payload: {
      scene_id: sceneId,
      turn_id: turnId,
      steps: [{ call: 'narrator', speaker: 'Narrator', text }],
    },
  });
}

describe('whole-log folds past the old read caps', () => {
  afterEach(() => {
    for (const storage of opened.splice(0)) storage.close();
  });

  it('the world clock fold sees the latest skip of a log longer than the old 100k cap', () => {
    const storage = scaledCaps(pagedStorage(), SCALE);
    // Older traffic from another world first — the table is shared ...
    for (let hour = 0; hour < 6; hour++) appendSkip(storage, 'w-other', hour);
    // ... then this world's clock advances hour by hour.
    for (let hour = 0; hour < 8; hour++) appendSkip(storage, 'w1', hour);

    // 14 rows stand for 140k: the capped fold froze at the 4th skip (10 rows).
    expect(worldTimeOf(storage, 'w1')).toBe(hourIso(8));
    expect(worldTimeOf(storage, 'w-other')).toBe(hourIso(6));
  });

  it("the scene prompt carries the current scene's latest lines when older events exceed the old 10k window", async () => {
    const storage = scaledCaps(pagedStorage(), SCALE);
    // A long older history in another scene ...
    for (let i = 0; i < 5; i++) {
      appendTurn(
        storage,
        's-old',
        `t-old-${String(i)}`,
        `Old line ${String(i)}.`,
      );
    }
    // ... then the current scene's latest committed turn.
    appendTurn(
      storage,
      's1',
      't-latest',
      'The ferry bell rings twice across the water.',
    );

    const logger = quietLogger();
    const eventBus: EventBus = new Bus(logger);
    const streamBus: StreamBus = new Bus(logger);
    const devBus: DevBus = new Bus(logger);
    const calls: LlmCall[] = [];
    const fake = createFakeLlmClient();
    const recording: LlmClient = {
      async streamCall(call): Promise<Result<LlmCallResult>> {
        calls.push(call);
        return fake.streamCall(call);
      },
    };
    const engine = createTurnEngine({
      storage,
      sink: createEventSink(storage, eventBus),
      streamBus,
      eventBus,
      devBus,
      llm: recording,
      logger,
    });
    const started = await engine.startTurn({
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's1',
      text: 'I listen.',
    });
    expect(started.ok).toBe(true);
    if (started.ok) await started.value.completion;

    const narrator = calls.find((c) => c.kind === 'narrator');
    // 6 rows stand for 60k: the capped window held only the oldest one.
    expect(narrator?.prompt).toContain(
      'The ferry bell rings twice across the water.',
    );
    // Still scene-scoped: the other scene's lines never enter this prompt.
    expect(narrator?.prompt).not.toContain('Old line');
  });
});
