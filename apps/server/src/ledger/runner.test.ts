import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BugError,
  CorruptStateError,
  OperationalError,
  type AppError,
} from '../errors.js';
import { openStorage, type Storage } from '../storage/db.js';
import { createRunner } from './runner.js';

class TestClock {
  private ms = new Date('2026-07-06T00:00:00.000Z').getTime();
  nowIso = (): string => new Date(this.ms).toISOString();
  advanceSeconds(seconds: number): void {
    this.ms += seconds * 1000;
  }
}

function setup(): { storage: Storage; clock: TestClock } {
  const dir = mkdtempSync(join(tmpdir(), 'weltari-runner-'));
  const clock = new TestClock();
  return {
    storage: openStorage({
      dbPath: join(dir, 'w.sqlite'),
      nowIso: clock.nowIso,
    }),
    clock,
  };
}

function enqueueStub(storage: Storage, type: string): number {
  const job = storage.ledger.enqueue({
    idempotency_key: `${type}:1`,
    world_id: 'w1',
    type,
    payload: null,
  });
  if (job === null) throw new Error('enqueue returned null in test setup');
  return job.id;
}

describe('runner C7 kind -> state mapping', () => {
  it('success commits the job', async () => {
    const { storage, clock } = setup();
    const id = enqueueStub(storage, 'ok');
    const runner = createRunner({
      storage,
      handlers: {
        ok: async () => {
          /* success */
        },
      },
      nowIso: clock.nowIso,
      workerId: 'w',
      onFatal: () => undefined,
    });
    expect(await runner.tick()).toBe(true);
    expect(storage.ledger.get(id)?.state).toBe('committed');
    storage.close();
  });

  it('operational failure retries with backoff and emits job.failed', async () => {
    const { storage, clock } = setup();
    const id = enqueueStub(storage, 'flaky');
    const runner = createRunner({
      storage,
      handlers: {
        flaky: async () => {
          await Promise.reject(
            new OperationalError('http_503', 'upstream down'),
          );
        },
      },
      nowIso: clock.nowIso,
      workerId: 'w',
      onFatal: () => undefined,
    });
    await runner.tick();
    const job = storage.ledger.get(id);
    expect(job?.state).toBe('failed');
    expect(job?.last_error?.kind).toBe('operational');
    expect(job !== null && job.run_at > clock.nowIso()).toBe(true); // backoff in the future
    expect(storage.eventLog.readSince(0).map((e) => e.type)).toEqual([
      'job.failed',
    ]);

    // not claimable until the backoff elapses
    expect(await runner.tick()).toBe(false);
    clock.advanceSeconds(3600);
    expect(await runner.tick()).toBe(true);
    storage.close();
  });

  it('bug failure parks immediately — deterministic bugs are never retried', async () => {
    const { storage, clock } = setup();
    const id = enqueueStub(storage, 'broken');
    const runner = createRunner({
      storage,
      handlers: {
        broken: async () => {
          await Promise.reject(new BugError('contract', 'impossible state'));
        },
      },
      nowIso: clock.nowIso,
      workerId: 'w',
      onFatal: () => undefined,
    });
    await runner.tick();
    expect(storage.ledger.get(id)?.state).toBe('parked');
    expect(storage.eventLog.readSince(0).map((e) => e.type)).toEqual([
      'job.parked',
    ]);
    storage.close();
  });

  it('an untyped throw is classified as a bug and parked', async () => {
    const { storage, clock } = setup();
    const id = enqueueStub(storage, 'untyped');
    const runner = createRunner({
      storage,
      handlers: {
        untyped: async () => {
          await Promise.reject(new Error('plain error'));
        },
      },
      nowIso: clock.nowIso,
      workerId: 'w',
      onFatal: () => undefined,
    });
    await runner.tick();
    const job = storage.ledger.get(id);
    expect(job?.state).toBe('parked');
    expect(job?.last_error?.kind).toBe('bug');
    storage.close();
  });

  it('corrupt_state calls onFatal and changes no row', async () => {
    const { storage, clock } = setup();
    const id = enqueueStub(storage, 'corrupt');
    const seen: AppError[] = [];
    const runner = createRunner({
      storage,
      handlers: {
        corrupt: async () => {
          await Promise.reject(
            new CorruptStateError('bad_rows', 'ledger contradicts log'),
          );
        },
      },
      nowIso: clock.nowIso,
      workerId: 'w',
      onFatal: (e) => {
        seen.push(e);
      },
    });
    await runner.tick();
    expect(seen.map((e) => e.kind)).toEqual(['corrupt_state']);
    expect(storage.ledger.get(id)?.state).toBe('running'); // untouched: restart recovers via sweep
    storage.close();
  });

  it('a job type with no registered handler parks as a bug', async () => {
    const { storage, clock } = setup();
    const id = enqueueStub(storage, 'ghost');
    const runner = createRunner({
      storage,
      handlers: {},
      nowIso: clock.nowIso,
      workerId: 'w',
      onFatal: () => undefined,
    });
    await runner.tick();
    expect(storage.ledger.get(id)?.state).toBe('parked');
    storage.close();
  });
});
