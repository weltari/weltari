// Invariant I3 (Brief §2.2): max attempts parks the job — dead-letter is never
// auto-retried; only an explicit owner action could revive it.
import { expect, it } from 'vitest';
import { createRunner } from '../../apps/server/src/ledger/runner.js';
import { OperationalError } from '../../apps/server/src/errors.js';
import { FakeClock } from '../fakes/clock.js';
import { tempStorage } from '../helpers/temp-storage.js';

it('max attempts parks the job (dead-letter), which is never claimable again', async () => {
  const clock = new FakeClock();
  const storage = tempStorage(clock.nowIso);
  const job = storage.ledger.enqueue({
    idempotency_key: 'flaky:1',
    world_id: 'w1',
    type: 'flaky',
    payload: null,
    max_attempts: 3,
  });
  expect(job).not.toBeNull();
  if (job === null) return;

  const runner = createRunner({
    storage,
    handlers: {
      flaky: async () => {
        await Promise.reject(
          new OperationalError('llm_timeout', 'provider timed out'),
        );
      },
    },
    nowIso: clock.nowIso,
    workerId: 'w-test',
    onFatal: () => undefined,
  });

  for (let i = 0; i < 3; i++) {
    clock.advanceSeconds(3600); // clear any backoff
    expect(await runner.tick()).toBe(true);
  }
  expect(storage.ledger.get(job.id)?.state).toBe('parked');

  clock.advanceSeconds(24 * 3600);
  storage.ledger.sweepExpiredLeases();
  expect(storage.ledger.claimNext('w-test')).toBeNull(); // never auto-retried

  const parkedEvents = storage.eventLog
    .readSince(0)
    .filter((e) => e.type === 'job.parked');
  expect(parkedEvents).toHaveLength(1);
  storage.close();
});
