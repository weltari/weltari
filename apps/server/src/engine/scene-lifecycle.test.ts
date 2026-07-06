import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createRootLogger } from '../observability/logger.js';
import { openStorage, type Storage } from '../storage/db.js';
import { Bus, type EventBus } from '../http/bus.js';
import { createEventSink } from './event-sink.js';
import {
  createSceneLifecycle,
  type SceneLifecycle,
} from './scene-lifecycle.js';
import { createRunner } from '../ledger/runner.js';
import { createReflectionHandler } from '../ledger/handlers/reflection.js';
import { createWorldAgentHandler } from '../ledger/handlers/world-agent.js';
import { createFakeLlmClient } from '../llm/fake-client.js';
import {
  buildEliasProfile,
  buildNarratorProfile,
} from './fixture/rainy-inn.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

const ELIAS = buildEliasProfile(100);
const NARRATOR = buildNarratorProfile(100);

describe('scene lifecycle (reflection fan-out + scoped open blocking)', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  interface Setup {
    storage: Storage;
    lifecycle: SceneLifecycle;
    eventBus: EventBus;
  }

  function setup(): Setup {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-lifecycle-'));
    const logger = quietLogger();
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    const eventBus: EventBus = new Bus(logger);
    const lifecycle = createSceneLifecycle({
      storage,
      eventBus,
      logger,
      knownCharacters: [{ character_id: ELIAS.character_id, name: ELIAS.name }],
    });
    return { storage, lifecycle, eventBus };
  }

  /** Seed a started scene with one committed turn in which Elias spoke. */
  function seedScene(s: Storage, sceneId = 's1', worldId = 'w1'): void {
    s.eventLog.append({
      world_id: worldId,
      actor_id: 'user:owner',
      type: 'scene.started',
      payload: { scene_id: sceneId, title: 'The Rainy Inn' },
    });
    s.eventLog.append({
      world_id: worldId,
      actor_id: 'user:owner',
      type: 'turn.committed',
      payload: {
        scene_id: sceneId,
        turn_id: 't1',
        steps: [
          { call: 'narrator', speaker: 'Narrator', text: 'Rain falls.' },
          { call: 'character', speaker: ELIAS.name, text: '"Late again."' },
        ],
      },
    });
  }

  it('end-scene appends scene.ended + enqueues per-character and World Agent jobs together', () => {
    const ctx = setup();
    seedScene(ctx.storage);

    const result = ctx.lifecycle.endScene({
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.jobsEnqueued).toBe(2);

    const ended = ctx.storage.eventLog
      .readSince(0)
      .find((e) => e.type === 'scene.ended');
    expect(ended).toBeDefined();
    if (ended !== undefined) {
      expect(ended.payload.participants).toEqual([ELIAS.character_id]);
    }
    expect(
      ctx.storage.ledger.countByKey(`reflection:${ELIAS.character_id}:s1`),
    ).toBe(1);
    expect(ctx.storage.ledger.countByKey('world_agent:s1')).toBe(1);
    const worldAgentJobs = ctx.storage.ledger
      .listActive('w1')
      .filter((j) => j.type === 'world_agent');
    expect(worldAgentJobs[0]?.serial_group).toBe('world_agent:w1');
  });

  it('end-scene is rejected twice: already-ended and unknown scenes', () => {
    const ctx = setup();
    seedScene(ctx.storage);
    const first = ctx.lifecycle.endScene({
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's1',
    });
    expect(first.ok).toBe(true);

    const again = ctx.lifecycle.endScene({
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's1',
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('scene_already_ended');

    const unknown = ctx.lifecycle.endScene({
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 'nope',
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('scene_not_found');

    // No duplicate fan-out from the rejected retry (I3 idempotency).
    expect(
      ctx.storage.ledger.countByKey(`reflection:${ELIAS.character_id}:s1`),
    ).toBe(1);
  });

  it('open-scene blocks only on this world + involved characters (criterion b)', () => {
    const ctx = setup();
    seedScene(ctx.storage);
    const ended = ctx.lifecycle.endScene({
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's1',
    });
    expect(ended.ok).toBe(true);

    // Same world, Elias involved -> blocked by his pending reflection.
    const blocked = ctx.lifecycle.openScene({
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's2',
      title: 'Morning After',
      participants: [ELIAS.character_id],
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('blocked_on_pending_jobs');

    // Same world, nobody involved -> still blocked by the World Agent job
    // (world-scoped by definition).
    const blockedByWorldAgent = ctx.lifecycle.openScene({
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's3',
      title: 'Elsewhere in Town',
      participants: [],
    });
    expect(blockedByWorldAgent.ok).toBe(false);

    // A DIFFERENT world with pending w1 jobs opens immediately.
    const otherWorld = ctx.lifecycle.openScene({
      world_id: 'w2',
      actor_id: 'user:owner',
      scene_id: 'w2-s1',
      title: 'Another World',
      participants: [ELIAS.character_id],
    });
    expect(otherWorld.ok).toBe(true);
  });

  it('open-scene unblocks after the fan-out jobs commit (via the real runner + FakeLLM)', async () => {
    const ctx = setup();
    seedScene(ctx.storage);
    expect(
      ctx.lifecycle.endScene({
        world_id: 'w1',
        actor_id: 'user:owner',
        scene_id: 's1',
      }).ok,
    ).toBe(true);

    const logger = quietLogger();
    const sink = createEventSink(ctx.storage, ctx.eventBus);
    const llm = createFakeLlmClient();
    const runner = createRunner({
      storage: ctx.storage,
      handlers: {
        reflection: createReflectionHandler({
          storage: ctx.storage,
          sink,
          llm,
          profiles: [ELIAS],
          logger,
        }),
        world_agent: createWorldAgentHandler({
          storage: ctx.storage,
          sink,
          llm,
          narrator: NARRATOR,
          logger,
        }),
      },
      nowIso: (): string => new Date().toISOString(),
      workerId: 'test-worker',
      onFatal: (error): void => {
        throw error;
      },
    });
    while (await runner.tick()) {
      // drain the ledger
    }

    const events = ctx.storage.eventLog.readSince(0);
    const reflection = events.find((e) => e.type === 'reflection.committed');
    expect(reflection).toBeDefined();
    if (reflection !== undefined) {
      expect(reflection.actor_id).toBe(ELIAS.character_id);
      expect(reflection.payload.summary.length).toBeGreaterThan(0);
    }
    expect(events.some((e) => e.type === 'world_agent.committed')).toBe(true);

    const opened = ctx.lifecycle.openScene({
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's2',
      title: 'Morning After',
      participants: [ELIAS.character_id],
    });
    expect(opened.ok).toBe(true);
    expect(
      ctx.storage.eventLog
        .readSince(0)
        .some((e) => e.type === 'scene.started' && e.payload.scene_id === 's2'),
    ).toBe(true);
  });
});
