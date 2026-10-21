import { z } from 'zod';

// GET /v1/characters wire shape (0.22.0): the world's character roster as
// clients list it — the engine's boot seeds (the fixture pair on a fixture
// world, none on a GM-seeded one) ∪ every character.created, folded live
// per request. Presence-independent: a character busy in a scene stays
// listed (a message to it may wait; the roster never shrinks with
// presence). Clients fold later character.created events from the stream
// on top, so a character minted mid-story is reachable at once.

export const CharacterRosterEntrySchema = z.strictObject({
  character_id: z.string().min(1),
  name: z.string().min(1).max(120),
});
export type CharacterRosterEntry = z.infer<typeof CharacterRosterEntrySchema>;

/** GET /v1/characters?world_id=… response. */
export const CharacterRosterSchema = z.strictObject({
  characters: z.array(CharacterRosterEntrySchema),
});
export type CharacterRoster = z.infer<typeof CharacterRosterSchema>;
