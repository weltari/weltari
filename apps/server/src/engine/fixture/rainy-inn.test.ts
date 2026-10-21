// The boot-time cast (main.ts wiring, factored here so it is testable): a
// fixture world plays the Rainy-Inn pair; a GM-seeded world (fixture off)
// has no fixture character anywhere — not in an untracked scene's cast, not
// in the reflection roster.
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
} from '../../http/bus.js';
import { createFakeLlmClient } from '../../llm/fake-client.js';
import type { LlmCall, LlmCallResult, LlmClient } from '../../llm/types.js';
import { createReflectionHandler } from '../../ledger/handlers/reflection.js';
import { createRootLogger } from '../../observability/logger.js';
import { openStorage, type Storage } from '../../storage/db.js';
import type { LedgerJob } from '../../storage/repositories/ledger.js';
import type { Result } from '../../errors.js';
import { createEventSink } from '../event-sink.js';
import { createTurnEngine } from '../scene-turn.js';
import { fixtureBootCast } from './rainy-inn.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

function eventBusOf(logger: ReturnType<typeof quietLogger>): EventBus {
  return new Bus(logger);
}

describe('fixtureBootCast', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function open(): Storage {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-bootcast-'));
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    return storage;
  }

  it('a fixture world seeds Elias + Mara and keeps Elias as the untracked-scene cast', () => {
    const cast = fixtureBootCast(true, 100);
    expect(cast.seedProfiles.map((p) => p.character_id)).toEqual([
      'char:elias',
      'char:mara',
    ]);
    expect(cast.untrackedSceneCast).toEqual(['char:elias']);
    expect([...cast.artSets.keys()]).toEqual(['char:elias']);
  });

  it('a GM-seeded world has no fixture cast at all', () => {
    const cast = fixtureBootCast(false, 100);
    expect(cast.seedProfiles).toEqual([]);
    expect(cast.untrackedSceneCast).toEqual([]);
    expect(cast.artSets.size).toBe(0);
  });

  it('a GM-seeded world’s untracked scene shows the Narrator no fixture character', async () => {
    const s = open();
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
    const cast = fixtureBootCast(false, 100);
    const engine = createTurnEngine({
      storage: s,
      sink: createEventSink(s, eventBus),
      streamBus,
      eventBus,
      devBus,
      llm: recording,
      logger,
      seedProfiles: cast.seedProfiles,
      presentCharacterIds: cast.untrackedSceneCast,
      artSets: cast.artSets,
      knownCharacters: [],
    });
    // A scene with NO roster events (e.g. a marker open nobody rode along).
    s.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'scene.started',
      payload: { scene_id: 's1', title: 'An empty square' },
    });
    const started = await engine.startTurn({
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's1',
      text: 'I look around.',
    });
    expect(started.ok).toBe(true);
    if (started.ok) await started.value.completion;
    const narratorCall = calls.find((c) => c.kind === 'narrator');
    expect(narratorCall?.prompt).toContain('Present characters: none');
    expect(narratorCall?.prompt).toContain('Art poses you may switch: none.');
    expect(narratorCall?.prompt).not.toContain('char:elias');
  });

  it('a fixture world reflects Mara too — the reflection roster is the full seed pair', async () => {
    const s = open();
    const logger = quietLogger();
    const handler = createReflectionHandler({
      storage: s,
      sink: createEventSink(s, eventBusOf(logger)),
      llm: createFakeLlmClient(),
      profiles: fixtureBootCast(true, 100).seedProfiles,
      logger,
    });
    const job: LedgerJob = {
      id: 1,
      idempotency_key: 'reflection:char:mara:s1',
      world_id: 'w1',
      type: 'reflection',
      payload: { scene_id: 's1', character_id: 'char:mara' },
      state: 'running',
      attempts: 1,
      max_attempts: 5,
      run_at: '2026-07-06T12:00:00.000Z',
      lease_until: '2026-07-06T12:01:00.000Z',
      worker_id: 'w',
      serial_group: null,
      last_error: null,
    };
    await handler(job);
    const committed = s.eventLog
      .readSince(0)
      .filter((e) => e.type === 'reflection.committed');
    expect(committed).toHaveLength(1);
    expect(committed[0]?.actor_id).toBe('char:mara');
  });
});
