// The Proposal pipeline invariants (M7 part 2, Rev 4 §16): consent is real.
// I8 — a rejected proposal leaves ZERO domain rows (the resolved event is the
// only durable trace); an approved one applies its diff ATOMICALLY with
// proposal.resolved, exactly once per proposal_id, and only a listed approver
// may resolve. Asserted through public seams (event-log reads, the registry
// and character folds) — never engine internals.
import { describe, expect, it } from 'vitest';
import { characterProfilesOf } from '../../apps/server/src/engine/characters.js';
import { createEventSink } from '../../apps/server/src/engine/event-sink.js';
import {
  buildEliasProfile,
  buildMaraProfile,
} from '../../apps/server/src/engine/fixture/rainy-inn.js';
import {
  createProposalEngine,
  pendingProposalsOf,
  worldSeeded,
  type ProposalEngine,
} from '../../apps/server/src/engine/proposals.js';
import { knownSublocations } from '../../apps/server/src/engine/sublocations.js';
import { Bus } from '../../apps/server/src/http/bus.js';
import type { Storage } from '../../apps/server/src/storage/db.js';
import { captureLogger } from '../helpers/capture-logger.js';
import { tempStorage } from '../helpers/temp-storage.js';

const WORLD = 'w1';
const GM = 'char:gm';
const OWNER = 'user:owner';

function setup(faultPoint?: () => Promise<void>): {
  storage: Storage;
  engine: ProposalEngine;
} {
  const { logger } = captureLogger();
  const storage = tempStorage();
  const engine = createProposalEngine({
    storage,
    sink: createEventSink(storage, new Bus(logger)),
    logger,
    seedProfiles: [buildEliasProfile(100), buildMaraProfile()],
    ...(faultPoint === undefined
      ? {}
      : { faultPoint: async (): Promise<void> => faultPoint() }),
  });
  return { storage, engine };
}

const PLACE = {
  name: 'The Mossy Court',
  description: 'A small walled yard behind the chandlery.',
  space: 'public' as const,
  wiki_entry: 'A walled yard; the moss never dries.',
};

const CHARACTER = {
  name: 'Odo the Chandler',
  personality: 'Careful, waxy-fingered, counts candles twice.',
  goals: ['Sell through the winter stock.'],
  core: ['Odo has kept the chandlery for eleven years.'],
  skills: ['Candle craft: reads a wick like a ledger.'],
};

function submitPlace(engine: ProposalEngine): string {
  const submitted = engine.submit({
    world_id: WORLD,
    proposer: GM,
    approvers: [OWNER],
    action: 'create_place',
    diff: PLACE,
    rationale: 'The town needs a quiet spot.',
  });
  if (!submitted.ok) throw new Error(submitted.error.code);
  return submitted.value.proposalId;
}

describe('I8 — reject writes zero domain rows', () => {
  it('a rejected create_place leaves the registry, wiki and ledger untouched', async () => {
    const { storage, engine } = setup();
    const proposalId = submitPlace(engine);
    const placesBefore = knownSublocations(storage, WORLD).length;
    const eventsBefore = storage.eventLog.readSince(0, 100000).length;

    const resolved = await engine.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
      resolution: 'rejected',
    });
    expect(resolved.ok && resolved.value.applied === 0).toBe(true);

    const events = storage.eventLog.readSince(0, 100000);
    // Exactly ONE new event: proposal.resolved. No rows, no jobs.
    expect(events).toHaveLength(eventsBefore + 1);
    expect(events.at(-1)?.type).toBe('proposal.resolved');
    expect(knownSublocations(storage, WORLD)).toHaveLength(placesBefore);
    expect(
      storage.ledger.countByKey(
        'painter:backdrop:subloc:gm-the-mossy-court:initial',
      ),
    ).toBe(0);
    expect(pendingProposalsOf(storage, WORLD)).toHaveLength(0);
  });

  it('gate 2 refuses a submit whose place name collides — zero rows', () => {
    const { storage, engine } = setup();
    const eventsBefore = storage.eventLog.readSince(0, 100000).length;
    const submitted = engine.submit({
      world_id: WORLD,
      proposer: GM,
      approvers: [OWNER],
      action: 'create_place',
      diff: { ...PLACE, name: 'The Common Room' }, // fixture name
      rationale: 'x',
    });
    expect(submitted.ok).toBe(false);
    expect(storage.eventLog.readSince(0, 100000)).toHaveLength(eventsBefore);
  });

  it('gate 1 refuses a mismatched action↔diff pairing — zero rows', () => {
    const { storage, engine } = setup();
    const eventsBefore = storage.eventLog.readSince(0, 100000).length;
    const submitted = engine.submit({
      world_id: WORLD,
      proposer: GM,
      approvers: [OWNER],
      action: 'create_character',
      diff: PLACE, // place diff under a character action
      rationale: 'x',
    });
    expect(submitted.ok).toBe(false);
    expect(storage.eventLog.readSince(0, 100000)).toHaveLength(eventsBefore);
  });
});

describe('approve applies atomically, exactly once', () => {
  it('an approved create_place lands the row, the wiki entry and the backdrop job in one transaction', async () => {
    const { storage, engine } = setup();
    const proposalId = submitPlace(engine);

    const resolved = await engine.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
      resolution: 'approved',
    });
    expect(resolved.ok && resolved.value.applied === 2).toBe(true);

    const events = storage.eventLog.readSince(0, 100000);
    const materialized = events.filter(
      (e) =>
        e.type === 'sublocation.materialized' &&
        e.payload.proposal_id === proposalId,
    );
    expect(materialized).toHaveLength(1);
    const first = materialized[0];
    if (first?.type !== 'sublocation.materialized') throw new Error('shape');
    expect(first.payload.space).toBe('public');
    const wiki = events.filter(
      (e) =>
        e.type === 'subwiki.edited' && e.payload.proposal_id === proposalId,
    );
    expect(wiki).toHaveLength(1);
    expect(
      knownSublocations(storage, WORLD).some(
        (s) => s.name === 'The Mossy Court',
      ),
    ).toBe(true);
    // The backdrop paint intent rides the apply's own transaction.
    expect(
      storage.ledger.countByKey(
        'painter:backdrop:subloc:gm-the-mossy-court:initial',
      ),
    ).toBe(1);
  });

  it('a second resolve of the same proposal 409s — exactly once ever', async () => {
    const { engine } = setup();
    const proposalId = submitPlace(engine);
    const first = await engine.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
      resolution: 'approved',
    });
    expect(first.ok).toBe(true);
    const second = await engine.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
      resolution: 'rejected',
    });
    expect(!second.ok && second.error.code === 'already_resolved').toBe(true);
  });

  it('two overlapped approves converge to one application (the fused re-check)', async () => {
    // Both calls pass the eager gate, then park on the fault line; the
    // second to wake finds the first's resolved row and loses cleanly.
    let release: (() => void) | undefined;
    const gateHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holds = 0;
    const { storage, engine } = setup(async () => {
      holds += 1;
      if (holds === 2) release?.();
      await gateHold;
    });
    const proposalId = submitPlace(engine);
    const command = {
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
      resolution: 'approved' as const,
    };
    const [a, b] = await Promise.all([
      engine.resolve(command),
      engine.resolve(command),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const applied = storage.eventLog
      .readSince(0, 100000)
      .filter(
        (e) =>
          e.type === 'sublocation.materialized' &&
          e.payload.proposal_id === proposalId,
      );
    expect(applied).toHaveLength(1);
  });

  it('only a listed approver may resolve', async () => {
    const { engine } = setup();
    const proposalId = submitPlace(engine);
    const stranger = await engine.resolve({
      world_id: WORLD,
      actor_id: 'user:stranger',
      proposal_id: proposalId,
      resolution: 'approved',
    });
    expect(!stranger.ok && stranger.error.code === 'not_an_approver').toBe(
      true,
    );
  });

  it('an unknown proposal 409s', async () => {
    const { engine } = setup();
    const ghost = await engine.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: 'prop-ghost',
      resolution: 'approved',
    });
    expect(!ghost.ok && ghost.error.code === 'unknown_proposal').toBe(true);
  });

  it('an approved create_character enters the roster fold', async () => {
    const { storage, engine } = setup();
    const submitted = engine.submit({
      world_id: WORLD,
      proposer: GM,
      approvers: [OWNER],
      action: 'create_character',
      diff: CHARACTER,
      rationale: 'The chandlery needs a keeper.',
    });
    if (!submitted.ok) throw new Error(submitted.error.code);
    const resolved = await engine.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: submitted.value.proposalId,
      resolution: 'approved',
    });
    expect(resolved.ok).toBe(true);
    const roster = characterProfilesOf(storage, WORLD, [
      buildEliasProfile(100),
    ]);
    const odo = roster.find((p) => p.character_id === 'char:odo-the-chandler');
    expect(odo?.personality).toBe(CHARACTER.personality);
    expect(odo?.memory_core).toEqual(CHARACTER.core);
  });
});

describe('seed_world (Rev 4 §9 cold boot)', () => {
  const SEED = {
    world_name: 'Saltmarsh',
    language: 'en',
    chapter_seed: 'A harbor town that lies about its tides.',
    places: [
      PLACE,
      {
        name: 'The Low House',
        description: 'A narrow private house by the sea wall.',
        space: 'private' as const,
      },
      {
        name: 'The Salt Market',
        description: 'Stalls under sailcloth; everything smells of brine.',
        space: 'public' as const,
      },
    ],
    characters: [CHARACTER],
  };

  it('gate 2 refuses a seed without the public+private mix', () => {
    const { engine } = setup();
    const submitted = engine.submit({
      world_id: WORLD,
      proposer: GM,
      approvers: [OWNER],
      action: 'seed_world',
      diff: {
        ...SEED,
        places: SEED.places.filter((p) => p.space === 'public'),
      },
      rationale: 'x',
    });
    expect(!submitted.ok && submitted.error.code === 'seed_space_mix').toBe(
      true,
    );
  });

  it('an approved seed materializes every named place on distinct squares, creates the characters, and stamps world.seeded', async () => {
    const { storage, engine } = setup();
    const submitted = engine.submit({
      world_id: WORLD,
      proposer: GM,
      approvers: [OWNER],
      action: 'seed_world',
      diff: SEED,
      rationale: 'The interview is complete.',
    });
    if (!submitted.ok) throw new Error(submitted.error.code);
    const resolved = await engine.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: submitted.value.proposalId,
      resolution: 'approved',
    });
    // 3 places + 1 opening wiki entry + 1 character + world.seeded = 6.
    expect(resolved.ok && resolved.value.applied === 6).toBe(true);

    const events = storage.eventLog.readSince(0, 100000);
    const rows = events.filter(
      (e) =>
        e.type === 'sublocation.materialized' &&
        e.payload.proposal_id === submitted.value.proposalId,
    );
    expect(rows).toHaveLength(3);
    const squares = new Set(
      rows.map((e) =>
        e.type === 'sublocation.materialized'
          ? `${String(e.payload.square.col)}:${String(e.payload.square.row)}`
          : '',
      ),
    );
    expect(squares.size).toBe(3);
    expect(worldSeeded(storage, WORLD)).toBe(true);
    // One backdrop job per seeded place, in the same transaction.
    for (const key of [
      'painter:backdrop:subloc:gm-the-mossy-court:initial',
      'painter:backdrop:subloc:gm-the-low-house:initial',
      'painter:backdrop:subloc:gm-the-salt-market:initial',
    ]) {
      expect(storage.ledger.countByKey(key)).toBe(1);
    }

    // A second seed can never land: the world is seeded now.
    const again = engine.submit({
      world_id: WORLD,
      proposer: GM,
      approvers: [OWNER],
      action: 'seed_world',
      diff: SEED,
      rationale: 'x',
    });
    expect(!again.ok && again.error.code === 'already_seeded').toBe(true);
  });
});
