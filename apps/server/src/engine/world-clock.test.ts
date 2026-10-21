import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createRootLogger } from '../observability/logger.js';
import { openStorage, type Storage } from '../storage/db.js';
import { Bus, type EventBus } from '../http/bus.js';
import { createEventSink } from './event-sink.js';
import { createRunner } from '../ledger/runner.js';
import {
  createWorldCronCodeHandler,
  createWorldCronLlmHandler,
} from '../ledger/handlers/world-cron.js';
import { createFakeLlmClient } from '../llm/fake-client.js';
import { buildNarratorProfile } from './fixture/rainy-inn.js';
import {
  createWorldClock,
  describeWorldTime,
  WORLD_EPOCH,
  worldClockLine,
  worldTimeAt,
  type WorldClock,
  type WorldCronDefinition,
} from './world-clock.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

const DEFS: readonly WorldCronDefinition[] = [
  { pattern: '0 6 * * *', cronType: 'lamplighter', jobClass: 'code' },
  { pattern: '0 18 * * *', cronType: 'evening_rumor', jobClass: 'llm' },
];

describe('world clock + time-skip replay', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  interface Setup {
    storage: Storage;
    clock: WorldClock;
    eventBus: EventBus;
    kicks: number[];
  }

  function setup(llmBudgetPerSkip?: number): Setup {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-worldclock-'));
    const logger = quietLogger();
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    const eventBus: EventBus = new Bus(logger);
    const kicks: number[] = [];
    const clock = createWorldClock({
      storage,
      eventBus,
      logger,
      definitions: DEFS,
      ...(llmBudgetPerSkip === undefined ? {} : { llmBudgetPerSkip }),
      kick: () => kicks.push(1),
    });
    return { storage, clock, eventBus, kicks };
  }

  it('starts at the epoch and advances monotonically as a projection', () => {
    const ctx = setup();
    expect(ctx.clock.currentTime('w1')).toBe(WORLD_EPOCH);

    const result = ctx.clock.advanceTime({
      world_id: 'w1',
      actor_id: 'user:owner',
      minutes: 60,
    });
    expect(result.ok).toBe(true);
    expect(ctx.clock.currentTime('w1')).toBe('2000-01-01T07:00:00.000Z');
    // Another world's clock is untouched.
    expect(ctx.clock.currentTime('w2')).toBe(WORLD_EPOCH);
  });

  it('a 2-day skip enqueues every code occurrence and the time event atomically', () => {
    const ctx = setup();
    const result = ctx.clock.advanceTime({
      world_id: 'w1',
      actor_id: 'user:owner',
      minutes: 2 * 24 * 60,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // (epoch 06:00, +2d] -> lamplighter at Jan 2 + Jan 3 06:00; rumor Jan 1 + Jan 2 18:00.
      expect(result.value.codeEnqueued).toBe(2);
      expect(result.value.llmEnqueued).toBe(2);
      expect(result.value.llmSkipped).toBe(0);
    }
    const advanced = ctx.storage.eventLog
      .readSince(0)
      .find((e) => e.type === 'world.time_advanced');
    expect(advanced).toBeDefined();
    if (advanced !== undefined) {
      expect(advanced.payload.code_enqueued).toBe(2);
    }
    expect(
      ctx.storage.ledger.countByKey(
        'wcron:lamplighter:w1:2000-01-02T06:00:00.000Z',
      ),
    ).toBe(1);
    expect(ctx.kicks).toHaveLength(1);
  });

  it('code-class rows are all claimable before any llm-class row (instant vs background)', () => {
    const ctx = setup();
    expect(
      ctx.clock.advanceTime({
        world_id: 'w1',
        actor_id: 'user:owner',
        minutes: 2 * 24 * 60,
      }).ok,
    ).toBe(true);
    const claimedTypes: string[] = [];
    for (;;) {
      const job = ctx.storage.ledger.claimNext('test-worker');
      if (job === null) break;
      claimedTypes.push(job.type);
      ctx.storage.ledger.markCommitted(job.id);
    }
    expect(claimedTypes).toEqual([
      'world_cron.code',
      'world_cron.code',
      'world_cron.llm',
      'world_cron.llm',
    ]);
  });

  it('the per-skip budget keeps only the NEWEST llm occurrences (Brief §4)', () => {
    const ctx = setup(3);
    const result = ctx.clock.advanceTime({
      world_id: 'w1',
      actor_id: 'user:owner',
      minutes: 7 * 24 * 60, // 7 evening rumors due
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.llmEnqueued).toBe(3);
      expect(result.value.llmSkipped).toBe(4);
    }
    // The newest one is enqueued; the oldest is not.
    expect(
      ctx.storage.ledger.countByKey(
        'wcron:evening_rumor:w1:2000-01-07T18:00:00.000Z',
      ),
    ).toBe(1);
    expect(
      ctx.storage.ledger.countByKey(
        'wcron:evening_rumor:w1:2000-01-01T18:00:00.000Z',
      ),
    ).toBe(0);
  });

  it('replayed occurrences complete idempotently through the real runner', async () => {
    const ctx = setup();
    expect(
      ctx.clock.advanceTime({
        world_id: 'w1',
        actor_id: 'user:owner',
        minutes: 24 * 60,
      }).ok,
    ).toBe(true);

    const logger = quietLogger();
    const sink = createEventSink(ctx.storage, ctx.eventBus);
    const runner = createRunner({
      storage: ctx.storage,
      handlers: {
        'world_cron.code': createWorldCronCodeHandler({
          storage: ctx.storage,
          sink,
          logger,
        }),
        'world_cron.llm': createWorldCronLlmHandler({
          storage: ctx.storage,
          sink,
          llm: createFakeLlmClient(),
          narrator: buildNarratorProfile(100),
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
      // drain
    }

    const completed = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'world_cron.completed');
    expect(completed).toHaveLength(2); // 1 lamplighter (code) + 1 rumor (llm)
    const llmOne = completed.find((e) => e.payload.job_class === 'llm');
    expect(llmOne?.payload.note).toBeDefined();
  });
});

describe('the clock as prompts read it (Rev 4 glossary: injected into prompts)', () => {
  it('renders the Gameday convention: day N from the epoch day, HH:MM, part of day — no weather', () => {
    expect(describeWorldTime(WORLD_EPOCH)).toBe('Day 1, 06:00, dawn');
    expect(describeWorldTime('2000-01-03T14:30:00.000Z')).toBe(
      'Day 3, 14:30, afternoon',
    );
    // The day turns at midnight, not 24 h after the 06:00 epoch (the
    // Gameday page counts calendar days the same way).
    expect(describeWorldTime('2000-01-01T23:59:00.000Z')).toBe(
      'Day 1, 23:59, night',
    );
    expect(describeWorldTime('2000-01-02T00:01:00.000Z')).toBe(
      'Day 2, 00:01, night',
    );
    expect(describeWorldTime('2000-02-01T12:00:00.000Z')).toBe(
      'Day 32, 12:00, midday',
    );
    const parts = [
      '04:59',
      '05:00',
      '07:00',
      '12:00',
      '14:00',
      '18:00',
      '22:00',
    ]
      .map((hhmm) => describeWorldTime(`2000-01-01T${hhmm}:00.000Z`))
      .map((text) => text.split(', ')[2]);
    expect(parts).toEqual([
      'night',
      'dawn',
      'morning',
      'midday',
      'afternoon',
      'evening',
      'night',
    ]);
    expect(worldClockLine(WORLD_EPOCH, 'The chat has just ended.')).toBe(
      'Day 1, 06:00, dawn. The chat has just ended.',
    );
  });

  it('worldTimeAt reads the clock as it stood at a past log moment, per world', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-worldclock-at-'));
    const logger = quietLogger();
    const storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    const clock = createWorldClock({
      storage,
      eventBus: new Bus(logger),
      logger,
      definitions: [],
    });
    const advance = (worldId: string, minutes: number): void => {
      expect(
        clock.advanceTime({
          world_id: worldId,
          actor_id: 'user:owner',
          minutes,
        }).ok,
      ).toBe(true);
    };
    advance('w1', 60); // w1 → 07:00
    advance('w2', 600); // another world's skip never leaks into w1
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'scene.ended',
      payload: { scene_id: 's1', participants: [] },
    });
    advance('w1', 24 * 60); // a skip AFTER the scene ended
    expect(
      worldTimeAt(
        storage,
        'w1',
        (e) => e.type === 'scene.ended' && e.payload.scene_id === 's1',
      ),
    ).toBe('2000-01-01T07:00:00.000Z');
    // No matching moment = the current clock.
    expect(worldTimeAt(storage, 'w1', () => false)).toBe(
      '2000-01-02T07:00:00.000Z',
    );
    storage.close();
  });
});
