// Each world's Narrator-class profile (Rev 4 §6/§9): the scene Narrator,
// the World Agent, materialize, map edits, map clicks and world-cron all
// speak with it. An UNSEEDED world (fixture/dev/test worlds — no
// world.seeded event) keeps the configured fixture profile byte-for-byte; a
// GM-built world gets a profile built from its OWN seed — its name and
// language plus the founding places of its approved seed form — and nothing
// from another world. Folded LIVE per call, so a world seeded after boot
// speaks with its own prefix without a restart (the week-19 folds-live
// principle, de5d2a4).
//
// I5: the seed is immutable once present (the apply gate refuses a second
// seed_world; the form is the proposal.submitted record itself), so one seed
// renders the same bytes on every call of the world's life. Nothing dynamic
// may ever be added here — the clock, cast and goals ride the dynamic tail.
//
// No padding: the fixture pads its Narrator toward WELTARI_PREFIX_TOKENS with
// generated Rainy-Inn notes for the cache-measurement runs; a seeded world's
// prefix carries its own content only (repeating it would be noise the model
// reads on every call, and the Narrator call's tool schemas already sit in
// the provider's cached prefix — docs/engine.md).
import type { ProposalPlaceDiff } from '@weltari/protocol';
import type { Storage } from '../storage/db.js';
import type { CharacterProfile } from './context-assembler.js';

/** The Narrator's world-agnostic role — every world's Narrator shares these
 * lines (the fixture profile reads them too, so its bytes never moved). */
export const NARRATOR_SKILLS: readonly string[] = [
  'Scene-setting: establishes place, weather and mood in two sentences.',
  'Pacing: ends every beat on a hook that invites a reply.',
];
export const NARRATOR_PERSONALITY =
  'Third-person, present tense, concrete sensory detail. Never speaks for player characters.';
export const NARRATOR_GOALS: readonly string[] = [
  'Keep the scene moving; hand the spotlight to a character each turn.',
];

/** What a seeded world's Narrator knows about the world itself. */
interface WorldSeed {
  world_name: string;
  language: string;
  /** The approved seed form's founding places, in form order — empty when
   * the world.seeded event names no recorded form (dev/test seeds). */
  places: readonly ProposalPlaceDiff[];
}

/** The world's seed: the FIRST world.seeded (immutable once present) plus
 * the seed_world form its proposal_id points at. Undefined = unseeded. */
function worldSeedOf(storage: Storage, worldId: string): WorldSeed | undefined {
  const forms = new Map<string, readonly ProposalPlaceDiff[]>();
  for (const event of storage.eventLog.readAllSince(0)) {
    if (event.world_id !== worldId) continue;
    if (
      event.type === 'proposal.submitted' &&
      event.payload.action === 'seed_world'
    ) {
      forms.set(event.payload.proposal_id, event.payload.diff.places);
    } else if (event.type === 'world.seeded') {
      const formId = event.payload.proposal_id;
      return {
        world_name: event.payload.world_name,
        language: event.payload.language,
        places: (formId === undefined ? undefined : forms.get(formId)) ?? [],
      };
    }
  }
  return undefined;
}

/** A seeded world's Narrator: the shared role + the world's own seed. Seed
 * text is consent-approved authoring content (the user approved the whole
 * card) — the same provenance class as a created character's personality,
 * so it may sit unwrapped in the stable prefix (B14). */
function seededNarratorProfile(seed: WorldSeed): CharacterProfile {
  return {
    character_id: 'char:narrator',
    name: 'Narrator',
    skills: NARRATOR_SKILLS,
    personality: NARRATOR_PERSONALITY,
    memory_core: [
      `This world is ${seed.world_name}. Language of play: ${seed.language}.`,
      ...seed.places.map(
        (place) =>
          `Founding place ${place.name} (${place.space}): ${place.description}`,
      ),
    ],
    goals: NARRATOR_GOALS,
  };
}

/**
 * The Narrator-class profile for `worldId`, resolved at CALL time: the
 * world's own seed-built profile once it is seeded, else `unseeded` (the
 * configured fixture Narrator — today's behaviour for unseeded worlds).
 */
export function narratorProfileOf(
  storage: Storage,
  worldId: string,
  unseeded: CharacterProfile,
): CharacterProfile {
  const seed = worldSeedOf(storage, worldId);
  return seed === undefined ? unseeded : seededNarratorProfile(seed);
}
