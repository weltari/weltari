// The live chat roster (0.22.0): the server's roster (GET /v1/characters —
// boot seeds ∪ every character.created at fetch time) merged with every
// character.created the stream folded since, so a character minted
// mid-story or approved via a GM card is reachable the moment it exists.
// Never a hardcoded fixture constant, and never filtered by presence: a
// busy character stays listed (its reply may wait).
import { useEffect, useState } from 'react';
import type { CharacterRosterEntry } from '@weltari/protocol';
import { fetchCharacterRoster } from './commands.js';
import { useSceneStore } from './store.js';

/** Server order first, then stream-created characters not yet in it. */
export function mergeRoster(
  fetched: readonly CharacterRosterEntry[] | null,
  created: readonly CharacterRosterEntry[],
): CharacterRosterEntry[] {
  const merged = [...(fetched ?? [])];
  for (const character of created) {
    if (!merged.some((c) => c.character_id === character.character_id)) {
      merged.push(character);
    }
  }
  return merged;
}

/** One shared request per page load: the boot roster only changes through
 * character.created, which the store folds live. A failure clears it, so
 * the next mount retries. */
let rosterRequest: Promise<CharacterRosterEntry[] | null> | null = null;

async function requestRoster(): Promise<CharacterRosterEntry[] | null> {
  rosterRequest ??= fetchCharacterRoster()
    .catch(() => null) // CATCH-OK: treated like a failed answer below
    .then((roster) => {
      if (roster === null) rosterRequest = null;
      return roster;
    });
  return rosterRequest;
}

/** The roster for list surfaces (Chat, Feed names). The fetch is view
 * state, not store state (the store stays SSE-written only). */
export function useCharacterRoster(): CharacterRosterEntry[] {
  const created = useSceneStore((s) => s.createdCharacters);
  const [fetched, setFetched] = useState<CharacterRosterEntry[] | null>(null);
  useEffect(() => {
    let live = true;
    requestRoster()
      .then((roster) => {
        if (live) setFetched(roster);
      })
      .catch(() => undefined); // CATCH-OK: requestRoster never rejects
    return (): void => {
      live = false;
    };
  }, []);
  return mergeRoster(fetched, created);
}

/** Display name by id — the roster's name, else the bare id. */
export function useNameOf(): (characterId: string) => string {
  const roster = useCharacterRoster();
  return (characterId) =>
    roster.find((c) => c.character_id === characterId)?.name ??
    characterId.replace('char:', '');
}
