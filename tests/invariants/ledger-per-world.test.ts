// Invariant I3 (Brief §2.2): World Agent jobs serialize per world — the claim
// query itself refuses a second running job in the same serial group.
import { expect, it } from 'vitest';
import { tempStorage } from '../helpers/temp-storage.js';

it('World Agent jobs serialize per world', () => {
  const storage = tempStorage();
  storage.ledger.enqueue({
    idempotency_key: 'wa:w1:a',
    world_id: 'w1',
    type: 'world_agent',
    payload: null,
    serial_group: 'world_agent:w1',
  });
  storage.ledger.enqueue({
    idempotency_key: 'wa:w1:b',
    world_id: 'w1',
    type: 'world_agent',
    payload: null,
    serial_group: 'world_agent:w1',
  });
  storage.ledger.enqueue({
    idempotency_key: 'wa:w2:a',
    world_id: 'w2',
    type: 'world_agent',
    payload: null,
    serial_group: 'world_agent:w2',
  });

  const first = storage.ledger.claimNext('w1worker');
  expect(first).not.toBeNull();
  expect(storage.ledger.claimNext('w2worker')?.world_id).toBe('w2'); // other world unaffected
  expect(storage.ledger.claimNext('w3worker')).toBeNull(); // second w1 job blocked

  if (first !== null) storage.ledger.markCommitted(first.id);
  expect(storage.ledger.claimNext('w3worker')?.idempotency_key).toBe('wa:w1:b');
  storage.close();
});
