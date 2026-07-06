// Invariant I3 (Brief §2.2): an expired lease returns the job to claimable —
// this is also the startup sweep, so kill -9 mid-job recovers (fake clock, no sleeps).
import { expect, it } from 'vitest';
import { FakeClock } from '../fakes/clock.js';
import { tempStorage } from '../helpers/temp-storage.js';

it('expired lease returns the job to claimable', () => {
  const clock = new FakeClock();
  const storage = tempStorage(clock.nowIso);
  const enqueued = storage.ledger.enqueue({
    idempotency_key: 'job:1',
    world_id: 'w1',
    type: 'stub',
    payload: null,
  });
  expect(enqueued).not.toBeNull();

  const claimed = storage.ledger.claimNext('workerA', 60);
  expect(claimed).not.toBeNull();
  expect(storage.ledger.claimNext('workerB', 60)).toBeNull(); // still leased

  clock.advanceSeconds(61);
  expect(storage.ledger.sweepExpiredLeases()).toBe(1);

  const reclaimed = storage.ledger.claimNext('workerB', 60);
  expect(reclaimed?.id).toBe(claimed?.id);
  expect(reclaimed?.attempts).toBe(2); // each claim burns an attempt (crash-loop cap)
  storage.close();
});
