import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { DevEvent, StreamSentence } from '@weltari/protocol';
import { err, ok, OperationalError, type Result } from '../errors.js';
import {
  Bus,
  type DevBus,
  type EventBus,
  type StreamBus,
} from '../http/bus.js';
import { createFakeLlmClient } from '../llm/fake-client.js';
import type { LlmCall, LlmCallResult, LlmClient } from '../llm/types.js';
import { createRootLogger } from '../observability/logger.js';
import { openStorage, type Storage } from '../storage/db.js';
import { createEventSink } from './event-sink.js';
import type { FaultPoint } from './fault-points.js';
import { createTurnEngine } from './scene-turn.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sinkStream = new Writable({
    write(_c, _e, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sinkStream });
}

interface Ctx {
  storage: Storage;
  streamFrames: StreamSentence[];
  faults: FaultPoint[];
  engine: ReturnType<typeof createTurnEngine>;
  llmCalls: LlmCall[];
  devFrames: DevEvent[];
}

function setup(llmOverride?: LlmClient): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'weltari-turn-'));
  const logger = quietLogger();
  const storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
  const eventBus: EventBus = new Bus(logger);
  const streamBus: StreamBus = new Bus(logger);
  const streamFrames: StreamSentence[] = [];
  streamBus.subscribe((frame) => streamFrames.push(frame));
  const faults: FaultPoint[] = [];
  const llmCalls: LlmCall[] = [];

  const base = llmOverride ?? createFakeLlmClient();
  const recording: LlmClient = {
    async streamCall(call): Promise<Result<LlmCallResult>> {
      llmCalls.push(call);
      return base.streamCall(call);
    },
  };

  const devBus: DevBus = new Bus(logger);
  const devFrames: DevEvent[] = [];
  devBus.subscribe((frame) => devFrames.push(frame));

  const engine = createTurnEngine({
    storage,
    sink: createEventSink(storage, eventBus),
    streamBus,
    eventBus,
    devBus,
    llm: recording,
    logger,
    faultPoint: (p): void => {
      faults.push(p);
    },
  });
  return { storage, streamFrames, faults, engine, llmCalls, devFrames };
}

const COMMAND = {
  world_id: 'w1',
  actor_id: 'user:owner',
  scene_id: 's1',
  text: 'I shake out my coat.',
};

describe('scripted 3-call scene turn', () => {
  it('opens the envelope durably, streams sentences, commits three steps in order', async () => {
    const ctx = await setupAndRun();
    const events = ctx.storage.eventLog.readSince(0);
    expect(events.map((e) => e.type)).toEqual([
      'turn.started',
      'turn.committed',
    ]);

    const committed = events[1];
    if (committed?.type === 'turn.committed') {
      expect(committed.payload.steps.map((s) => s.call)).toEqual([
        'narrator',
        'character',
        'narration',
      ]);
      // B6: durable text equals the full streamed text per call
      expect(committed.payload.steps[1]?.text).toContain('Late again');
    }

    // sentence frames stream per call with restarting indexes, no SSE ids by design
    const narratorFrames = ctx.streamFrames.filter(
      (f) => f.call === 'narrator',
    );
    expect(narratorFrames.length).toBeGreaterThan(1);
    expect(narratorFrames.map((f) => f.index)).toEqual(
      narratorFrames.map((_, i) => i),
    );

    expect(ctx.faults).toEqual(['mid_stream', 'between_calls', 'pre_commit']);
  });

  it('a mid-turn provider failure voids the turn: nothing durable after turn.started', async () => {
    const fake = createFakeLlmClient();
    let calls = 0;
    const failing: LlmClient = {
      async streamCall(call): Promise<Result<LlmCallResult>> {
        calls += 1;
        if (calls === 2) {
          return err(new OperationalError('llm_call_failed', 'provider 503'));
        }
        return fake.streamCall(call);
      },
    };
    const ctx = setup(failing);
    const started = await ctx.engine.startTurn(COMMAND);
    expect(started.ok).toBe(true);
    if (started.ok) await started.value.completion;

    const events = ctx.storage.eventLog.readSince(0);
    expect(events.map((e) => e.type)).toEqual(['turn.started']); // no partial commit (B6)
    ctx.storage.close();
  });

  it('the stable prefix per character is byte-identical across turns (cache contract)', async () => {
    const ctx = setup();
    for (let i = 0; i < 2; i++) {
      const started = await ctx.engine.startTurn(COMMAND);
      expect(started.ok).toBe(true);
      if (started.ok) await started.value.completion;
    }
    const characterCalls = ctx.llmCalls.filter((c) => c.kind === 'character');
    expect(characterCalls).toHaveLength(2);
    expect(characterCalls[1]?.system).toBe(characterCalls[0]?.system);
    // the dynamic tail differs (turn 2 sees turn 1's transcript) — prefix does not
    expect(characterCalls[1]?.prompt).not.toBe(characterCalls[0]?.prompt);
    ctx.storage.close();
  });

  async function setupAndRun(): Promise<Ctx> {
    const ctx = setup();
    const started = await ctx.engine.startTurn(COMMAND);
    expect(started.ok).toBe(true);
    if (started.ok) await started.value.completion;
    return ctx;
  }
});

describe('interrupt-anywhere (criterion c: nothing after the point is durable)', () => {
  /** A narrator call that streams two sentences, then BLOCKS until released —
   * the test interrupts inside that window, deterministically. */
  function gatedClient(): {
    client: LlmClient;
    narratorStreamed: Promise<void>;
    release: () => void;
  } {
    let signalStreamed = (): void => undefined;
    const narratorStreamed = new Promise<void>((resolve) => {
      signalStreamed = resolve;
    });
    let releaseGate = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const fake = createFakeLlmClient();
    const client: LlmClient = {
      async streamCall(call): Promise<Result<LlmCallResult>> {
        if (call.kind !== 'narrator') return fake.streamCall(call);
        call.onTextDelta('First beat lands. Second beat follows. ');
        signalStreamed();
        await gate;
        call.onTextDelta('Third beat never displays.');
        return ok({
          text: 'First beat lands. Second beat follows. Third beat never displays.',
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          model: 'fake/gated',
          durationMs: 0,
          // The narrator ALSO tries a world change — the interrupt must void it.
          toolCalls: [
            {
              tool: 'change_sublocation',
              input: { sublocation_id: 'subloc:cellar' },
            },
          ],
        });
      },
    };
    return { client, narratorStreamed, release: releaseGate };
  }

  it('closes the envelope at the seen sentence; later text and tool effects never persist', async () => {
    const gated = gatedClient();
    const ctx = setup(gated.client);
    const started = await ctx.engine.startTurn(COMMAND);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await gated.narratorStreamed;
    const interrupt = ctx.engine.interruptTurn({
      world_id: 'w1',
      actor_id: 'user:owner',
      turn_id: started.value.turnId,
      seen: { call: 'narrator', sentence_index: 0 },
    });
    expect(interrupt.ok).toBe(true);
    if (interrupt.ok) expect(interrupt.value.committed).toBe(true);

    gated.release();
    await started.value.completion;

    const events = ctx.storage.eventLog.readSince(0);
    expect(events.map((e) => e.type)).toEqual([
      'turn.started',
      'turn.committed',
    ]);
    const committed = events[1];
    if (committed?.type === 'turn.committed') {
      expect(committed.payload.interrupted).toBe(true);
      // Only the sentence the user saw — sentence 1+ and later calls are gone.
      expect(committed.payload.steps).toEqual([
        { call: 'narrator', speaker: 'Narrator', text: 'First beat lands.' },
      ]);
    }
    // The staged change_sublocation was discarded: no durable world change.
    expect(events.some((e) => e.type === 'sublocation.changed')).toBe(false);
    // No stream frames for calls that never displayed.
    expect(ctx.streamFrames.filter((f) => f.call !== 'narrator')).toHaveLength(
      0,
    );
    ctx.storage.close();
  });

  it('interrupt before anything displayed voids the turn (committed: false)', async () => {
    const gated = gatedClient();
    const ctx = setup(gated.client);
    const started = await ctx.engine.startTurn(COMMAND);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await gated.narratorStreamed;
    const interrupt = ctx.engine.interruptTurn({
      world_id: 'w1',
      actor_id: 'user:owner',
      turn_id: started.value.turnId,
      // no `seen`: the user typed before reading anything
    });
    expect(interrupt.ok).toBe(true);
    if (interrupt.ok) expect(interrupt.value.committed).toBe(false);

    gated.release();
    await started.value.completion;
    const events = ctx.storage.eventLog.readSince(0);
    expect(events.map((e) => e.type)).toEqual(['turn.started']); // void (B6)
    ctx.storage.close();
  });

  it('a finished or unknown turn refuses interruption', async () => {
    const ctx = setup();
    const started = await ctx.engine.startTurn(COMMAND);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await started.value.completion; // turn is closed now

    const late = ctx.engine.interruptTurn({
      world_id: 'w1',
      actor_id: 'user:owner',
      turn_id: started.value.turnId,
      seen: { call: 'narrator', sentence_index: 0 },
    });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.code).toBe('turn_not_running');

    const unknown = ctx.engine.interruptTurn({
      world_id: 'w1',
      actor_id: 'user:owner',
      turn_id: 'no-such-turn',
    });
    expect(unknown.ok).toBe(false);
    ctx.storage.close();
  });
});

describe('narrator tool pipeline (B6 two gates)', () => {
  async function runTurn(ctx: Ctx, text: string): Promise<void> {
    const started = await ctx.engine.startTurn({ ...COMMAND, text });
    expect(started.ok).toBe(true);
    if (started.ok) await started.value.completion;
  }

  function seedSceneStarted(ctx: Ctx): void {
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'scene.started',
      payload: { scene_id: 's1', title: 'The Rainy Inn' },
    });
  }

  it('change_sublocation commits sublocation.changed atomically after turn.committed', async () => {
    const ctx = setup();
    await runTurn(ctx, '!move subloc:cellar');
    const events = ctx.storage.eventLog.readSince(0);
    expect(events.map((e) => e.type)).toEqual([
      'turn.started',
      'turn.committed',
      'sublocation.changed',
    ]);
    const moved = events[2];
    if (moved?.type === 'sublocation.changed') {
      expect(moved.payload.sublocation_id).toBe('subloc:cellar');
      expect(moved.payload.name).toBe('The Flooded Cellar');
      expect(moved.actor_id).toBe('char:narrator');
    }
    expect(
      ctx.devFrames.filter((f) => f.type === 'dev.tool_call'),
    ).toHaveLength(1);
    ctx.storage.close();
  });

  it('switch_art commits a durable art.switched event', async () => {
    const ctx = setup();
    await runTurn(ctx, '!art char:elias smile');
    const events = ctx.storage.eventLog.readSince(0);
    const art = events.find((e) => e.type === 'art.switched');
    expect(art).toBeDefined();
    if (art?.type === 'art.switched') {
      expect(art.payload).toMatchObject({
        scene_id: 's1',
        character_id: 'char:elias',
        art_id: 'smile',
      });
    }
    ctx.storage.close();
  });

  it('end_scene commits scene.ended LAST with end_type + fan-out jobs in one transaction', async () => {
    const ctx = setup();
    seedSceneStarted(ctx);
    await runTurn(ctx, '!end continuation');
    const events = ctx.storage.eventLog.readSince(0);
    expect(events.map((e) => e.type)).toEqual([
      'scene.started',
      'turn.started',
      'turn.committed',
      'scene.ended',
    ]);
    const ended = events[3];
    if (ended?.type === 'scene.ended') {
      expect(ended.payload.end_type).toBe('continuation');
      expect(ended.payload.divider_text).toBe('— the rain eases —');
      // Elias spoke in THIS turn's committed steps — the fan-out sees it
      // because turn.committed and scene.ended share one transaction.
      expect(ended.payload.participants).toEqual(['char:elias']);
    }
    expect(ctx.storage.ledger.countByKey('reflection:char:elias:s1')).toBe(1);
    expect(ctx.storage.ledger.countByKey('world_agent:s1')).toBe(1);
    ctx.storage.close();
  });

  it('a second change_sublocation in one turn moves again; same target is state-rejected', async () => {
    const ctx = setup();
    await runTurn(ctx, '!move subloc:cellar');
    await runTurn(ctx, '!move subloc:cellar'); // already there now — gate 2 rejects
    const events = ctx.storage.eventLog.readSince(0);
    expect(events.filter((e) => e.type === 'sublocation.changed')).toHaveLength(
      1,
    );
    const rejected = ctx.devFrames.find((f) => f.type === 'dev.tool_rejected');
    expect(rejected).toBeDefined();
    if (rejected?.type === 'dev.tool_rejected') {
      expect(rejected.gate).toBe('state');
    }
    ctx.storage.close();
  });
});
