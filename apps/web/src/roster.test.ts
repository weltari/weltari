// The live chat roster (0.22.0): the server's boot roster (GET
// /v1/characters) ∪ every character.created the stream delivered — never
// a hardcoded fixture constant, never filtered by presence.
import { describe, expect, it } from 'vitest';
import { mergeRoster } from './roster.js';

describe('mergeRoster', () => {
  it('keeps the server order, appends stream-created characters, dedupes by id', () => {
    const merged = mergeRoster(
      [
        { character_id: 'char:elias', name: 'Elias' },
        { character_id: 'char:mara', name: 'Mara' },
      ],
      [
        { character_id: 'char:mara', name: 'Mara' },
        { character_id: 'char:minted-1', name: 'Wren' },
      ],
    );
    expect(merged.map((c) => c.character_id)).toEqual([
      'char:elias',
      'char:mara',
      'char:minted-1',
    ]);
  });

  it('a GM-seeded world before the fetch lands still lists what the stream created', () => {
    expect(
      mergeRoster(null, [{ character_id: 'char:minted-1', name: 'Wren' }]),
    ).toEqual([{ character_id: 'char:minted-1', name: 'Wren' }]);
  });
});
