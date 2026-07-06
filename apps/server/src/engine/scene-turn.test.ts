import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { StreamSentence } from '@weltari/protocol';
import { err, OperationalError, type Result } from '../errors.js';
import { Bus, type EventBus, type StreamBus } from '../http/bus.js';
import { createFakeLlmClient } from '../llm/fake-client.js';
import type { LlmCall, LlmCallResult, LlmClient } from '../llm/types.js';
import { createRootLogger } from '../observability/logger.js';
import { openStorage, type Storage } from '../storage/db.js';
import { createEventSink } from './event-sink.js';
import { createTurnEngine, type FaultPoint } from './scene-turn.js';

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

  const engine = createTurnEngine({
    storage,
    sink: createEventSink(storage, eventBus),
    streamBus,
    llm: recording,
    logger,
    faultPoint: (p) => faults.push(p),
  });
  return { storage, streamFrames, faults, engine, llmCalls };
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
