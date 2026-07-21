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
  appendSceneOpen,
  createSceneLifecycle,
  sceneRosterOf,
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
    // Per-character reflection + World Agent + the object GC sweep (M7 part 3).
    if (result.ok) expect(result.value.jobsEnqueued).toBe(3);

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
    expect(ctx.storage.ledger.countByKey('object_gc:w1:s1')).toBe(1);
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

  it('open-scene appends character.joined per KNOWN participant with scene.started (roster projection, M4)', () => {
    const ctx = setup();

    const published: string[] = [];
    ctx.eventBus.subscribe((event) => {
      published.push(event.type);
    });

    const opened = ctx.lifecycle.openScene({
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's-roster',
      title: 'The Rainy Inn',
      participants: [ELIAS.character_id, 'char:nobody'],
    });
    expect(opened.ok).toBe(true);

    const events = ctx.storage.eventLog
      .readSince(0)
      .filter(
        (e) => 'scene_id' in e.payload && e.payload.scene_id === 's-roster',
      );
    // scene.started first, then exactly one roster row — the unknown id is
    // skipped (an event may only name a character the engine knows, B6 ethos).
    expect(events.map((e) => e.type)).toEqual([
      'scene.started',
      'character.joined',
    ]);
    const joined = events[1];
    if (joined?.type === 'character.joined') {
      expect(joined.payload.character_id).toBe(ELIAS.character_id);
      expect(joined.payload.name).toBe(ELIAS.name);
    } else {
      expect.unreachable('character.joined missing');
    }
    // Published on the bus AFTER commit, in append order.
    expect(published).toEqual(['scene.started', 'character.joined']);
  });

  it('open-scene AT a known sublocation appends sublocation.changed atomically (0.8.0)', () => {
    const ctx = setup();
    const opened = ctx.lifecycle.openScene({
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's-at',
      title: 'The Old Shrine',
      participants: [ELIAS.character_id],
      sublocation_id: 'subloc:shrine',
    });
    expect(opened.ok).toBe(true);
    const events = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => 'scene_id' in e.payload && e.payload.scene_id === 's-at');
    expect(events.map((e) => e.type)).toEqual([
      'scene.started',
      'character.joined',
      'sublocation.changed',
    ]);
    const moved = events[2];
    if (moved?.type === 'sublocation.changed') {
      expect(moved.payload.sublocation_id).toBe('subloc:shrine');
      expect(moved.payload.name).toBe('The Old Shrine');
      expect(moved.payload.map_position).toEqual({ x: 0.61, y: 0.33 });
    } else {
      expect.unreachable('sublocation.changed missing');
    }
  });

  it('open-scene AT an unknown sublocation is refused — zero rows (engine-state gate)', () => {
    const ctx = setup();
    const before = ctx.storage.eventLog.readSince(0).length;
    const refused = ctx.lifecycle.openScene({
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's-ghost',
      title: 'Nowhere',
      participants: [ELIAS.character_id],
      sublocation_id: 'subloc:ghost',
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('unknown_sublocation');
    expect(ctx.storage.eventLog.readSince(0)).toHaveLength(before);
  });

  it('open-scene AT a materialized sublocation works (registry, not the trio)', () => {
    const ctx = setup();
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'sublocation.materialized',
      payload: {
        sublocation_id: 'subloc:sq-5-1',
        name: 'The Mill Pond',
        description: 'A quiet pond.',
        square: { col: 5, row: 1 },
        map_position: { x: 0.6875, y: 0.1875 },
      },
    });
    const opened = ctx.lifecycle.openScene({
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's-pond',
      title: 'The Mill Pond',
      participants: [ELIAS.character_id],
      sublocation_id: 'subloc:sq-5-1',
    });
    expect(opened.ok).toBe(true);
    const moved = ctx.storage.eventLog
      .readSince(0)
      .find(
        (e) =>
          e.type === 'sublocation.changed' && e.payload.scene_id === 's-pond',
      );
    expect(moved).toBeDefined();
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

describe('the consumed continuation registration (0.21.0, Rev 4 §6)', () => {
  function freshStorage(): Storage {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-continuation-'));
    return openStorage({ dbPath: join(dir, 'w.sqlite') });
  }

  function endWithRegistration(s: Storage): void {
    s.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'scene.started',
      payload: { scene_id: 's1', title: 'The evening before' },
    });
    s.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:narrator',
      type: 'scene.ended',
      payload: {
        scene_id: 's1',
        participants: ['char:elias'],
        end_type: 'continuation',
        next_scene: {
          sublocation_id: 'subloc:cellar',
          premise_seed: 'Dawn finds the cellar door ajar.',
          time_offset_hours: 8,
          expected_participants: ['char:elias'],
          brief_history: 'They agreed to inspect the flooded cellar at dawn.',
          carried_goals: ['Find who silences the bell.'],
        },
      },
    });
  }

  const OPEN_AT = {
    sublocation_id: 'subloc:cellar',
    name: 'The Flooded Cellar',
  };

  it('opening AT the registered sublocation folds the registration into scene.started + the cast', () => {
    const s = freshStorage();
    endWithRegistration(s);
    const events = s.transact(() =>
      appendSceneOpen(
        s,
        [{ character_id: 'char:elias', name: 'Elias' }],
        {
          world_id: 'w1',
          actor_id: 'user:owner',
          scene_id: 's2',
          title: 'The next scene',
          participants: [],
        },
        OPEN_AT,
      ),
    );
    const started = events.find((e) => e.type === 'scene.started');
    expect(started).toBeDefined();
    if (started?.type === 'scene.started') {
      expect(started.payload.premise).toBe('Dawn finds the cellar door ajar.');
      expect(started.payload.brief_history).toContain('flooded cellar at dawn');
      expect(started.payload.carried_goals).toEqual([
        'Find who silences the bell.',
      ]);
    }
    // The expected participant joined the cast without being in the command.
    expect(
      events.some(
        (e) =>
          e.type === 'character.joined' &&
          e.payload.character_id === 'char:elias' &&
          e.payload.scene_id === 's2',
      ),
    ).toBe(true);
    s.close();
  });

  it('a LATER open at the same place is a fresh visit — the registration is consumed once', () => {
    const s = freshStorage();
    endWithRegistration(s);
    s.transact(() =>
      appendSceneOpen(
        s,
        [{ character_id: 'char:elias', name: 'Elias' }],
        {
          world_id: 'w1',
          actor_id: 'user:owner',
          scene_id: 's2',
          title: 'The continuation',
          participants: [],
        },
        OPEN_AT,
      ),
    );
    const events = s.transact(() =>
      appendSceneOpen(
        s,
        [{ character_id: 'char:elias', name: 'Elias' }],
        {
          world_id: 'w1',
          actor_id: 'user:owner',
          scene_id: 's3',
          title: 'A later visit',
          participants: [],
        },
        OPEN_AT,
      ),
    );
    const started = events.find((e) => e.type === 'scene.started');
    if (started?.type === 'scene.started') {
      expect(started.payload.premise).toBeUndefined();
      expect(started.payload.brief_history).toBeUndefined();
      expect(started.payload.carried_goals).toBeUndefined();
    }
    expect(events.some((e) => e.type === 'character.joined')).toBe(false);
    s.close();
  });

  it('opening at a DIFFERENT sublocation never consumes the registration', () => {
    const s = freshStorage();
    endWithRegistration(s);
    const events = s.transact(() =>
      appendSceneOpen(
        s,
        [{ character_id: 'char:elias', name: 'Elias' }],
        {
          world_id: 'w1',
          actor_id: 'user:owner',
          scene_id: 's2',
          title: 'Somewhere else entirely',
          participants: [],
        },
        { sublocation_id: 'subloc:shrine', name: 'The Shrine' },
      ),
    );
    const started = events.find((e) => e.type === 'scene.started');
    if (started?.type === 'scene.started') {
      expect(started.payload.brief_history).toBeUndefined();
    }
    s.close();
  });

  it('the roster fold distinguishes an emptied cast from an untracked scene', () => {
    const s = freshStorage();
    s.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'scene.started',
      payload: { scene_id: 's1', title: 'A scene' },
    });
    expect(sceneRosterOf(s, 's1')).toEqual({ cast: [], tracked: false });
    s.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'character.joined',
      payload: { scene_id: 's1', character_id: 'char:elias', name: 'Elias' },
    });
    expect(sceneRosterOf(s, 's1')).toEqual({
      cast: [{ character_id: 'char:elias', name: 'Elias' }],
      tracked: true,
    });
    s.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:narrator',
      type: 'character.left',
      payload: { scene_id: 's1', character_id: 'char:elias' },
    });
    expect(sceneRosterOf(s, 's1')).toEqual({ cast: [], tracked: true });
    s.close();
  });
});
