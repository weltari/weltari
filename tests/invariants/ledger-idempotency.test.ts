// Invariant I3 (Brief §2.2): the idempotency key makes duplicate enqueue a no-op.
import { expect, it } from 'vitest';
import { tempStorage } from '../helpers/temp-storage.js';

it('idempotency key is unique — duplicate enqueue is a silent no-op', () => {
  const storage = tempStorage();
  const first = storage.ledger.enqueue({
    idempotency_key: 'reflect:c1:s9',
    world_id: 'w1',
    type: 'reflect',
    payload: { character_id: 'c1', scene_id: 's9' },
  });
  const second = storage.ledger.enqueue({
    idempotency_key: 'reflect:c1:s9',
    world_id: 'w1',
    type: 'reflect',
    payload: { character_id: 'c1', scene_id: 's9' },
  });
  expect(first).not.toBeNull();
  expect(second).toBeNull();
  expect(storage.ledger.countByKey('reflect:c1:s9')).toBe(1);
  storage.close();
});
