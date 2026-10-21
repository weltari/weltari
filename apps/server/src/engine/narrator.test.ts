// Each world's own Narrator (engine/narrator.ts): an unseeded world keeps the
// fixture profile byte-for-byte; a GM-seeded world's Narrator-class prefix is
// built from its own seed — nothing from another world — and stays
// byte-stable for one seed (I5).
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../storage/db.js';
import { assembleContext } from './context-assembler.js';
import { buildNarratorProfile } from './fixture/rainy-inn.js';
import { narratorProfileOf } from './narrator.js';

const FIXTURE_NARRATOR = buildNarratorProfile(800);

/** Text only the Rainy-Inn fixture world carries. */
const FIXTURE_MARKERS = [
  'Rainy Inn',
  'Recorded note',
  'Elias',
  'wet wool',
  'Storm season',
  'ferry',
];

/** The approved seed card of a GM-built world, as the apply path logs it:
 * the proposal.submitted form, then the world.seeded pointing back at it. */
function seedBrackwater(
  storage: Storage,
  worldId = 'w1',
  withForm = true,
): void {
  if (withForm) {
    storage.eventLog.append({
      world_id: worldId,
      actor_id: 'char:gm',
      type: 'proposal.submitted',
      payload: {
        proposal_id: 'prop-seed1',
        rationale: 'The interview is complete.',
        proposer: 'char:gm',
        approvers: ['user:owner'],
        action: 'seed_world',
        diff: {
          world_name: 'Brackwater',
          language: 'en',
          chapter_seed: 'A town between two storms.',
          places: [
            {
              name: 'The Salt Market',
              description: 'Stalls of brine-cured fish under patched canvas.',
              space: 'public',
            },
            {
              name: 'The Chandler Loft',
              description: 'A narrow attic room above the candle shop.',
              space: 'private',
            },
          ],
          characters: [
            {
              name: 'Ada Vell',
              personality: 'Sharp and restless.',
              goals: ['Find the missing tide ledger.'],
              core: [],
              skills: [],
            },
          ],
        },
      },
    });
  }
  storage.eventLog.append({
    world_id: worldId,
    actor_id: 'user:owner',
    type: 'world.seeded',
    payload: {
      world_name: 'Brackwater',
      language: 'en',
      chapter_seed: 'A town between two storms.',
      place_count: 2,
      character_count: 1,
      ...(withForm ? { proposal_id: 'prop-seed1' } : {}),
    },
  });
}

function prefixOf(storage: Storage, worldId: string): string {
  return assembleContext(
    narratorProfileOf(storage, worldId, FIXTURE_NARRATOR),
    {
      scene_id: 's1',
      world_clock_text: 'Day 1, 06:00, dawn',
      latest_turns: [],
      wiki: [],
    },
  ).stablePrefix;
}

describe("each world's own Narrator profile", () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function open(): Storage {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-narrator-'));
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    return storage;
  }

  it('an unseeded world keeps the fixture Narrator — the same profile, the same bytes as before', () => {
    const s = open();
    expect(narratorProfileOf(s, 'w1', FIXTURE_NARRATOR)).toBe(FIXTURE_NARRATOR);
    // The fixture's bytes are pinned: the shared role lines moved into
    // engine/narrator.ts without changing a single byte of the profile.
    expect(
      createHash('sha256')
        .update(JSON.stringify(FIXTURE_NARRATOR))
        .digest('hex'),
    ).toBe('2031709851bec834c622bb59084173d42c8789bb6debff516564b56872039710');
  });

  it('a seeded world speaks from its own seed form — and carries no fixture text', () => {
    const s = open();
    seedBrackwater(s);
    const profile = narratorProfileOf(s, 'w1', FIXTURE_NARRATOR);
    expect(profile.character_id).toBe('char:narrator');
    expect(profile.memory_core).toEqual([
      'This world is Brackwater. Language of play: en.',
      'Founding place The Salt Market (public): Stalls of brine-cured fish under patched canvas.',
      'Founding place The Chandler Loft (private): A narrow attic room above the candle shop.',
    ]);
    const prefix = prefixOf(s, 'w1');
    for (const marker of FIXTURE_MARKERS) {
      expect(prefix).not.toContain(marker);
    }
  });

  it('one seed renders the same prefix bytes on every call, whatever else the log gains (I5)', () => {
    const s = open();
    seedBrackwater(s);
    const first = prefixOf(s, 'w1');
    // Later life of the world: a skip, a new place, a turn — none of it is
    // seed content, so none of it may move the prefix.
    s.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'world.time_advanced',
      payload: {
        from: '2000-01-01T06:00:00.000Z',
        to: '2000-01-02T09:00:00.000Z',
        code_enqueued: 0,
        llm_enqueued: 0,
        llm_skipped: 0,
      },
    });
    s.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'sublocation.materialized',
      payload: {
        sublocation_id: 'subloc:sq-1-1',
        name: 'The Breakwater',
        description: 'A long stone arm into the grey sea.',
        square: { col: 1, row: 1 },
        map_position: { x: 0.19, y: 0.19 },
      },
    });
    const second = prefixOf(s, 'w1');
    expect(Buffer.compare(Buffer.from(first), Buffer.from(second))).toBe(0);
  });

  it('a seed without a recorded form still names the world, and nothing else', () => {
    const s = open();
    seedBrackwater(s, 'w1', false);
    expect(narratorProfileOf(s, 'w1', FIXTURE_NARRATOR).memory_core).toEqual([
      'This world is Brackwater. Language of play: en.',
    ]);
  });

  it("one world's seed never reaches another world's Narrator", () => {
    const s = open();
    seedBrackwater(s, 'w2');
    expect(narratorProfileOf(s, 'w1', FIXTURE_NARRATOR)).toBe(FIXTURE_NARRATOR);
    expect(prefixOf(s, 'w2')).toContain('Brackwater');
  });
});
