// Invariant I8 (Brief §2.10, Guide B6): LLM output is never directly durable.
// Every narrator tool passes TWO gates in series — Zod shape, then engine
// state — and a rejected call is logged ONLY as a trail frame on the dev
// channel: ZERO rows written. Asserted through public seams (event-log reads,
// ledger reads, dev bus) — never engine internals (Guide E5).
import { describe, expect, it } from 'vitest';
import type { DevEvent } from '@weltari/protocol';
import {
  Bus,
  type DevBus,
  type EventBus,
  type StreamBus,
} from '../../apps/server/src/http/bus.js';
import { createEventSink } from '../../apps/server/src/engine/event-sink.js';
import { createTurnEngine } from '../../apps/server/src/engine/scene-turn.js';
import { createFakeLlmClient } from '../../apps/server/src/llm/fake-client.js';
import type { Storage } from '../../apps/server/src/storage/db.js';
import { captureLogger } from '../helpers/capture-logger.js';
import { tempStorage } from '../helpers/temp-storage.js';

interface Ctx {
  storage: Storage;
  devFrames: DevEvent[];
  runTurn: (text: string) => Promise<void>;
}

function setup(): Ctx {
  const { logger } = captureLogger();
  const storage = tempStorage();
  const eventBus: EventBus = new Bus(logger);
  const streamBus: StreamBus = new Bus(logger);
  const devBus: DevBus = new Bus(logger);
  const devFrames: DevEvent[] = [];
  devBus.subscribe((frame) => devFrames.push(frame));

  const engine = createTurnEngine({
    storage,
    sink: createEventSink(storage, eventBus),
    streamBus,
    eventBus,
    devBus,
    llm: createFakeLlmClient(),
    logger,
  });

  return {
    storage,
    devFrames,
    async runTurn(text: string): Promise<void> {
      const started = await engine.startTurn({
        world_id: 'w1',
        actor_id: 'user:owner',
        scene_id: 's1',
        text,
      });
      expect(started.ok).toBe(true);
      if (started.ok) await started.value.completion;
    },
  };
}

/** Row-zero assertion: only the turn's own two events exist — no tool effect rows. */
function expectOnlyTurnRows(storage: Storage): void {
  const types = storage.eventLog.readSince(0).map((e) => e.type);
  expect(types).toEqual(['turn.started', 'turn.committed']);
}

function rejectionsOf(
  frames: readonly DevEvent[],
): { tool: string; gate: 'schema' | 'state' }[] {
  const out: { tool: string; gate: 'schema' | 'state' }[] = [];
  for (const f of frames) {
    if (f.type === 'dev.tool_rejected')
      out.push({ tool: f.tool, gate: f.gate });
  }
  return out;
}

describe('I8 — the B6 double gate writes zero rows for rejected tool calls', () => {
  it('gate 1 (shape): a malformed switch_art is a trail rejection, zero rows', async () => {
    const ctx = setup();
    await ctx.runTurn('!badshape');
    expectOnlyTurnRows(ctx.storage);
    expect(rejectionsOf(ctx.devFrames)).toEqual([
      { tool: 'switch_art', gate: 'schema' },
    ]);
    ctx.storage.close();
  });

  it('gate 1 (shape): an unknown tool name is a trail rejection, zero rows', async () => {
    const ctx = setup();
    await ctx.runTurn('!ghosttool');
    expectOnlyTurnRows(ctx.storage);
    expect(rejectionsOf(ctx.devFrames)).toEqual([
      { tool: 'summon_dragon', gate: 'schema' },
    ]);
    ctx.storage.close();
  });

  it('gate 2 (state): change_sublocation to an unknown place writes zero rows', async () => {
    const ctx = setup();
    await ctx.runTurn('!move subloc:moon');
    expectOnlyTurnRows(ctx.storage);
    expect(rejectionsOf(ctx.devFrames)).toEqual([
      { tool: 'change_sublocation', gate: 'state' },
    ]);
    ctx.storage.close();
  });

  it('gate 2 (state): switch_art for an absent character writes zero rows', async () => {
    const ctx = setup();
    await ctx.runTurn('!art char:ghost neutral');
    expectOnlyTurnRows(ctx.storage);
    expect(rejectionsOf(ctx.devFrames)).toEqual([
      { tool: 'switch_art', gate: 'state' },
    ]);
    ctx.storage.close();
  });

  it('gate 2 (state): switch_art to a pose outside the art set writes zero rows', async () => {
    const ctx = setup();
    await ctx.runTurn('!art char:elias moonwalk');
    expectOnlyTurnRows(ctx.storage);
    expect(rejectionsOf(ctx.devFrames)).toEqual([
      { tool: 'switch_art', gate: 'state' },
    ]);
    ctx.storage.close();
  });

  it('gate 2 (state): end_scene on a scene that is not open writes zero rows and enqueues zero jobs', async () => {
    const ctx = setup();
    // no scene.started seeded — the scene is not open
    await ctx.runTurn('!end rest');
    expectOnlyTurnRows(ctx.storage);
    expect(rejectionsOf(ctx.devFrames)).toEqual([
      { tool: 'end_scene', gate: 'state' },
    ]);
    expect(ctx.storage.ledger.countByKey('world_agent:s1')).toBe(0);
    ctx.storage.close();
  });

  it('a valid call still passes both gates (the pipeline is not reject-everything)', async () => {
    const ctx = setup();
    await ctx.runTurn('!move subloc:cellar');
    const types = ctx.storage.eventLog.readSince(0).map((e) => e.type);
    expect(types).toContain('sublocation.changed');
    expect(rejectionsOf(ctx.devFrames)).toEqual([]);
    ctx.storage.close();
  });
});
