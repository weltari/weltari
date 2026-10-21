import { describe, expect, it } from 'vitest';
import { CharacterRosterSchema } from './characters.js';

describe('character roster (GET /v1/characters, 0.22.0)', () => {
  it('accepts the live roster and an empty one (a GM-seeded world before its first character)', () => {
    const roster: unknown = {
      characters: [
        { character_id: 'char:elias', name: 'Elias the Clockmender' },
        { character_id: 'char:minted-1', name: 'Wren' },
      ],
    };
    expect(CharacterRosterSchema.safeParse(roster).success).toBe(true);
    const empty: unknown = { characters: [] };
    expect(CharacterRosterSchema.safeParse(empty).success).toBe(true);
  });

  it('rejects unknown keys and empty ids or names (strictObject, B5)', () => {
    const extra: unknown = {
      characters: [{ character_id: 'char:a', name: 'A', presence: 'busy' }],
    };
    expect(CharacterRosterSchema.safeParse(extra).success).toBe(false);
    const emptyName: unknown = {
      characters: [{ character_id: 'char:a', name: '' }],
    };
    expect(CharacterRosterSchema.safeParse(emptyName).success).toBe(false);
  });
});
