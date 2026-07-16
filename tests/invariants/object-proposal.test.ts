// GM-authored objects through the Proposal pipeline (M7 part 3, Rev 4
// §7/§16): consent is real for objects too. I8 — a rejected create_object
// leaves ZERO object rows; an approved one applies exactly one object.created
// (proposal_id provenance, NO scene_id — never a GC candidate); the (name,
// holder) dedup gate refuses twins at submit AND at apply. Asserted through
// public seams (event-log reads, the objects repository) — never internals.
import { describe, expect, it } from 'vitest';
import { createEventSink } from '../../apps/server/src/engine/event-sink.js';
import {
  buildEliasProfile,
  buildMaraProfile,
} from '../../apps/server/src/engine/fixture/rainy-inn.js';
import {
  createProposalEngine,
  type ProposalEngine,
} from '../../apps/server/src/engine/proposals.js';
import { Bus } from '../../apps/server/src/http/bus.js';
import type { Storage } from '../../apps/server/src/storage/db.js';
import { captureLogger } from '../helpers/capture-logger.js';
import { tempStorage } from '../helpers/temp-storage.js';

const WORLD = 'w1';
const GM = 'char:gm';
const OWNER = 'user:owner';

function setup(): { storage: Storage; engine: ProposalEngine } {
  const { logger } = captureLogger();
  const storage = tempStorage();
  const engine = createProposalEngine({
    storage,
    sink: createEventSink(storage, new Bus(logger)),
    logger,
    seedProfiles: [buildEliasProfile(100), buildMaraProfile()],
  });
  return { storage, engine };
}

const OBJECT = {
  name: 'a tide-worn locket',
  holder_sublocation_id: 'subloc:common_room',
  object_payload: 'Inside: a miniature of a woman facing away from the sea.',
};

function submitObject(
  engine: ProposalEngine,
  diff: unknown = OBJECT,
): ReturnType<ProposalEngine['submit']> {
  return engine.submit({
    world_id: WORLD,
    proposer: GM,
    approvers: [OWNER],
    action: 'create_object',
    diff,
    rationale: 'The story needs something findable at the inn.',
  });
}

describe('create_object proposals (M7 part 3, Rev 4 §7/§16)', () => {
  it('reject = zero object rows (I8); the resolved event is the only trace', async () => {
    const { storage, engine } = setup();
    const submitted = submitObject(engine);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const resolved = await engine.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: submitted.value.proposalId,
      resolution: 'rejected',
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.applied).toBe(0);
    expect(storage.objects.heldAt(WORLD, OBJECT.holder_sublocation_id)).toEqual(
      [],
    );
    expect(
      storage.eventLog.readSince(0).filter((e) => e.type.startsWith('object.')),
    ).toEqual([]);
    storage.close();
  });

  it('approve applies exactly one object.created with proposal provenance and NO creating scene (GC-exempt)', async () => {
    const { storage, engine } = setup();
    const submitted = submitObject(engine);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    const resolved = await engine.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: submitted.value.proposalId,
      resolution: 'approved',
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.applied).toBe(1);

    const created = storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'object.created');
    expect(created).toHaveLength(1);
    if (created[0]?.type === 'object.created') {
      expect(created[0].actor_id).toBe(GM);
      expect(created[0].payload.proposal_id).toBe(submitted.value.proposalId);
      expect(created[0].payload.scene_id).toBeUndefined();
    }
    const rows = storage.objects.heldAt(WORLD, OBJECT.holder_sublocation_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toContain('facing away from the sea');
    // Never a GC candidate: no creating scene — even an EMPTY GM object
    // stays (asserted below with the empty carrier).
    expect(storage.objects.strayCandidates(WORLD)).toEqual([]);
    storage.close();
  });

  it('an approved EMPTY carrier is still GC-exempt (no creating scene)', async () => {
    const { storage, engine } = setup();
    const submitted = submitObject(engine, {
      name: 'a storm lamp',
      holder_sublocation_id: 'subloc:common_room',
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const resolved = await engine.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: submitted.value.proposalId,
      resolution: 'approved',
    });
    expect(resolved.ok).toBe(true);
    expect(storage.objects.strayCandidates(WORLD)).toEqual([]);
    storage.close();
  });

  it('the dedup gate refuses a twin at submit; an unknown holder refuses outright', async () => {
    const { storage, engine } = setup();
    const first = submitObject(engine);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await engine.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: first.value.proposalId,
      resolution: 'approved',
    });

    const twin = submitObject(engine, {
      name: 'A Tide-Worn  LOCKET',
      holder_sublocation_id: OBJECT.holder_sublocation_id,
    });
    expect(twin.ok).toBe(false);
    if (!twin.ok) expect(twin.error.code).toBe('object_exists');

    const nowhere = submitObject(engine, {
      name: 'a ghost coin',
      holder_sublocation_id: 'subloc:nowhere',
    });
    expect(nowhere.ok).toBe(false);
    if (!nowhere.ok) expect(nowhere.error.code).toBe('unknown_sublocation');
    storage.close();
  });

  it('the pending twin loses at apply: gate 2 re-runs against CURRENT state', async () => {
    const { storage, engine } = setup();
    // Two proposals for the same (name, holder) may both sit pending —
    // submit-time state allowed both. The FIRST approval applies; the
    // second approval must refuse against the new world state.
    const first = submitObject(engine);
    const second = submitObject(engine);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const approvedFirst = await engine.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: first.value.proposalId,
      resolution: 'approved',
    });
    expect(approvedFirst.ok).toBe(true);
    const approvedSecond = await engine.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: second.value.proposalId,
      resolution: 'approved',
    });
    expect(approvedSecond.ok).toBe(false);
    if (!approvedSecond.ok) {
      expect(approvedSecond.error.code).toBe('object_exists');
    }
    expect(
      storage.objects.heldAt(WORLD, OBJECT.holder_sublocation_id),
    ).toHaveLength(1);
    storage.close();
  });
});
