// Gate 2 for the agentic-scene cast tools (0.21.0, Rev 4 §6): every
// make_character / character_leave / move_character / update_goals call is
// validated against live scene + presence state before staging; the
// determine_who_next executor enforces the V1 one-at-a-time policy on the
// set-typed contract. Rejections stage nothing (I8).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../storage/db.js';
import { presenceOf } from './chat.js';
import { createToolStage, type SceneToolsOptions } from './scene-tools.js';
import type { SublocationDefinition } from './fixture/rainy-inn.js';

const SUBLOCATIONS: SublocationDefinition[] = [
  {
    sublocation_id: 'subloc:common_room',
    name: 'The Common Room',
    description: 'The heart of the inn.',
    map_position: { x: 0.5, y: 0.5 },
  },
  {
    sublocation_id: 'subloc:market',
    name: 'The Market Square',
    description: 'Stalls and rain.',
    map_position: { x: 0.3, y: 0.4 },
  },
];

function openWorld(): Storage {
  const dir = mkdtempSync(join(tmpdir(), 'weltari-cast-'));
  const storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
  storage.eventLog.append({
    world_id: 'w1',
    actor_id: 'user:owner',
    type: 'scene.started',
    payload: { scene_id: 's1', title: 'A scene' },
  });
  return storage;
}

function stageFor(
  storage: Storage,
  overrides: Partial<SceneToolsOptions> = {},
): ReturnType<typeof createToolStage> {
  return createToolStage(
    {
      storage,
      worldId: 'w1',
      sublocations: SUBLOCATIONS,
      startSublocationId: 'subloc:common_room',
      artSets: new Map([['char:elias', ['neutral', 'smile']]]),
      presentCharacterIds: ['char:elias'],
      worldCharacters: [
        { character_id: 'char:elias', name: 'Elias' },
        { character_id: 'char:mara', name: 'Mara' },
      ],
      presence: () => ({ state: 'available' }),
      ...overrides,
    },
    's1',
  );
}

describe('make_character gate 2 (0.21.0)', () => {
  it('an existing available character joins; a second join of the same id is refused', () => {
    const storage = openWorld();
    const stage = stageFor(storage);
    const joined = stage.apply({
      tool: 'make_character',
      input: { character: 'char:mara', presence: 'present' },
    });
    expect(joined.ok).toBe(true);
    if (joined.ok) {
      expect(joined.value).toMatchObject({
        kind: 'character_join',
        characterId: 'char:mara',
        name: 'Mara',
      });
    }
    expect(stage.presentCharacters()).toContain('char:mara');
    const twice = stage.apply({
      tool: 'make_character',
      input: { character: 'Mara', presence: 'present' },
    });
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.error.code).toBe('already_present');
    storage.close();
  });

  it('a character reserved by ANOTHER scene cannot join (the presence gate)', () => {
    const storage = openWorld();
    const stage = stageFor(storage, {
      presence: (id) =>
        id === 'char:mara'
          ? { state: 'in_scene', scene_id: 's-other' }
          : { state: 'available' },
    });
    const refused = stage.apply({
      tool: 'make_character',
      input: { character: 'char:mara', presence: 'present' },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('character_reserved');
    expect(stage.staged()).toHaveLength(0);
    storage.close();
  });

  it('minting a new character requires personality + goals; a full mint stages created+joined', () => {
    const storage = openWorld();
    const stage = stageFor(storage);
    const bare = stage.apply({
      tool: 'make_character',
      input: { character: 'Odo the Ferryman', presence: 'present' },
    });
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error.code).toBe('mint_needs_profile');
    const minted = stage.apply({
      tool: 'make_character',
      input: {
        character: 'Odo the Ferryman',
        presence: 'present',
        personality: 'Slow-spoken, superstitious, remembers every crossing.',
        goals: ['See the ferry through storm season.'],
      },
    });
    expect(minted.ok).toBe(true);
    if (minted.ok) {
      expect(minted.value).toMatchObject({
        kind: 'character_mint',
        characterId: 'char:odo-the-ferryman',
        present: true,
      });
    }
    expect(stage.presentCharacters()).toContain('char:odo-the-ferryman');
    // The mint is resolvable in the SAME turn — a re-mint of the same name
    // is an existing character now (already present → refused).
    const again = stage.apply({
      tool: 'make_character',
      input: { character: 'odo the ferryman', presence: 'present' },
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('already_present');
    storage.close();
  });

  it('presence absent on an EXISTING character is refused (nothing durable)', () => {
    const storage = openWorld();
    const stage = stageFor(storage);
    const refused = stage.apply({
      tool: 'make_character',
      input: { character: 'char:mara', presence: 'absent' },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('character_exists');
    storage.close();
  });

  it('an absent mint creates the character offstage — not in the cast', () => {
    const storage = openWorld();
    const stage = stageFor(storage);
    const minted = stage.apply({
      tool: 'make_character',
      input: {
        character: 'Senna',
        presence: 'absent',
        personality: 'Sharp-eyed, dry-humored.',
        goals: ['Keep the loom house independent.'],
      },
    });
    expect(minted.ok).toBe(true);
    if (minted.ok) {
      expect(minted.value).toMatchObject({
        kind: 'character_mint',
        present: false,
      });
    }
    expect(stage.presentCharacters()).not.toContain('char:senna');
    storage.close();
  });
});

describe('character_leave gate 2 (0.21.0)', () => {
  it('a present character leaves (cast shrinks); an absent one is refused', () => {
    const storage = openWorld();
    const stage = stageFor(storage);
    const left = stage.apply({
      tool: 'character_leave',
      input: { character_id: 'char:elias', reason: 'closing the workshop' },
    });
    expect(left.ok).toBe(true);
    expect(stage.presentCharacters()).not.toContain('char:elias');
    const again = stage.apply({
      tool: 'character_leave',
      input: { character_id: 'char:elias' },
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('character_not_present');
    storage.close();
  });

  it('a staged leave frees switch_art no more — the pose gate reads the live cast', () => {
    const storage = openWorld();
    const stage = stageFor(storage);
    stage.apply({
      tool: 'character_leave',
      input: { character_id: 'char:elias' },
    });
    const art = stage.apply({
      tool: 'switch_art',
      input: { character_id: 'char:elias', art_id: 'smile' },
    });
    expect(art.ok).toBe(false);
    if (!art.ok) expect(art.error.code).toBe('character_not_present');
    storage.close();
  });
});

describe('move_character gate 2 (0.21.0)', () => {
  it('moves an offstage character; refuses a present one with the leave-first teaching', () => {
    const storage = openWorld();
    const stage = stageFor(storage);
    const moved = stage.apply({
      tool: 'move_character',
      input: { character_id: 'char:mara', to_sublocation_id: 'subloc:market' },
    });
    expect(moved.ok).toBe(true);
    if (moved.ok) {
      expect(moved.value).toMatchObject({
        kind: 'character_move',
        characterId: 'char:mara',
        toSublocationId: 'subloc:market',
      });
    }
    const present = stage.apply({
      tool: 'move_character',
      input: { character_id: 'char:elias', to_sublocation_id: 'subloc:market' },
    });
    expect(present.ok).toBe(false);
    if (!present.ok) {
      expect(present.error.code).toBe('character_present');
      expect(present.error.message).toContain('character_leave');
    }
    storage.close();
  });

  it('refuses a character reserved elsewhere and an unknown sublocation', () => {
    const storage = openWorld();
    const stage = stageFor(storage, {
      presence: (id) =>
        id === 'char:mara'
          ? { state: 'in_scene', scene_id: 's-other' }
          : { state: 'available' },
    });
    const reserved = stage.apply({
      tool: 'move_character',
      input: { character_id: 'char:mara', to_sublocation_id: 'subloc:market' },
    });
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) expect(reserved.error.code).toBe('character_reserved');
    const stage2 = stageFor(storage);
    const nowhere = stage2.apply({
      tool: 'move_character',
      input: { character_id: 'char:mara', to_sublocation_id: 'subloc:nope' },
    });
    expect(nowhere.ok).toBe(false);
    if (!nowhere.ok) expect(nowhere.error.code).toBe('unknown_sublocation');
    storage.close();
  });
});

describe('update_goals gate 2 (0.21.0)', () => {
  it('stages the snapshot; a later call in the same turn replaces it whole', () => {
    const storage = openWorld();
    const stage = stageFor(storage);
    const first = stage.apply({
      tool: 'update_goals',
      input: {
        goals: [{ id: 'g1', text: 'Open the storm night.', status: 'active' }],
      },
    });
    expect(first.ok).toBe(true);
    const second = stage.apply({
      tool: 'update_goals',
      input: {
        goals: [
          { id: 'g1', text: 'Open the storm night.', status: 'done' },
          { id: 'g2', text: 'Seed the ferry rumor.', status: 'active' },
        ],
      },
    });
    expect(second.ok).toBe(true);
    const goals = stage.staged().filter((e) => e.kind === 'goals');
    expect(goals).toHaveLength(1);
    if (goals[0]?.kind === 'goals') {
      expect(goals[0].goals).toHaveLength(2);
      expect(goals[0].goals[0]?.status).toBe('done');
    }
    storage.close();
  });
});

describe('determine_who_next / consumeDeclared (the V1 one-at-a-time policy)', () => {
  it('declares exactly one PRESENT character; a set of two is policy-refused', () => {
    const storage = openWorld();
    const stage = stageFor(storage);
    expect(stage.declareNext({ character_ids: ['char:elias'] })).toContain(
      'declared: char:elias',
    );
    expect(
      stage.declareNext({ character_ids: ['char:elias', 'char:mara'] }),
    ).toContain('exactly ONE');
    expect(stage.declareNext({ character_ids: ['char:mara'] })).toContain(
      'not in this scene',
    );
    expect(stage.declareNext({ nonsense: true })).toContain('malformed');
    storage.close();
  });

  it('consumeDeclared takes the declared id once; undeclared ids are refused', () => {
    const storage = openWorld();
    const stage = stageFor(storage);
    stage.declareNext({ character_ids: ['char:elias'] });
    expect(stage.consumeDeclared('char:elias').ok).toBe(true);
    // Consumed — a second charactercall without a fresh declaration refuses.
    const again = stage.consumeDeclared('char:elias');
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('not_declared');
    const never = stage.consumeDeclared('char:mara');
    expect(never.ok).toBe(false);
    storage.close();
  });
});

describe('end_scene gate 2 additions (0.21.0)', () => {
  it('context_limit_reached is refused unless the engine warning stands', () => {
    const storage = openWorld();
    const cold = stageFor(storage);
    const refused = cold.apply({
      tool: 'end_scene',
      input: { type: 'context_limit_reached' },
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('no_context_warning');
    const warned = stageFor(storage, { contextWarned: true });
    const legal = warned.apply({
      tool: 'end_scene',
      input: { type: 'context_limit_reached' },
    });
    expect(legal.ok).toBe(true);
    storage.close();
  });

  it('a continuation naming an unknown expected participant is refused; a staged mint counts', () => {
    const storage = openWorld();
    const stage = stageFor(storage);
    const registration = {
      sublocation_id: 'subloc:market',
      time_offset_hours: 16,
      brief_history: 'They agreed to meet at the market at dawn.',
      carried_goals: [],
    };
    const unknown = stage.apply({
      tool: 'end_scene',
      input: {
        type: 'continuation',
        next_scene: { ...registration, expected_participants: ['char:ghost'] },
      },
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('unknown_character');
    stage.apply({
      tool: 'make_character',
      input: {
        character: 'Odo',
        presence: 'absent',
        personality: 'Slow-spoken.',
        goals: ['Cross the river.'],
      },
    });
    const withMint = stage.apply({
      tool: 'end_scene',
      input: {
        type: 'continuation',
        next_scene: { ...registration, expected_participants: ['char:odo'] },
      },
    });
    expect(withMint.ok).toBe(true);
    storage.close();
  });

  it('character.left releases presence for THAT scene only (the projection)', () => {
    const storage = openWorld();
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'character.joined',
      payload: { scene_id: 's1', character_id: 'char:mara', name: 'Mara' },
    });
    expect(presenceOf(storage, 'w1', 'char:mara')).toEqual({
      state: 'in_scene',
      scene_id: 's1',
    });
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:narrator',
      type: 'character.left',
      payload: { scene_id: 's1', character_id: 'char:mara' },
    });
    expect(presenceOf(storage, 'w1', 'char:mara')).toEqual({
      state: 'available',
    });
    storage.close();
  });

  it('discard rolls the cast and declarations back to turn start', () => {
    const storage = openWorld();
    const stage = stageFor(storage);
    stage.apply({
      tool: 'make_character',
      input: { character: 'char:mara', presence: 'present' },
    });
    stage.apply({
      tool: 'character_leave',
      input: { character_id: 'char:elias' },
    });
    stage.declareNext({ character_ids: ['char:mara'] });
    stage.discard();
    expect([...stage.presentCharacters()].sort()).toEqual(['char:elias']);
    expect(stage.consumeDeclared('char:mara').ok).toBe(false);
    expect(stage.staged()).toHaveLength(0);
    storage.close();
  });
});
