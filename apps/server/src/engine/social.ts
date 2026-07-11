// The Feed's engine-side folds (M6 part 5, Rev 4 §12). Everything here is a
// pure fold of the event log — no clock reads (A16), no LLM: the same log
// always yields the same answer, so a kill-retry re-evaluates the SAME
// delivery set and the post's natural key stays safe.
import type { Storage } from '../storage/db.js';

/** The hard ceiling per time skip (Rev 4 §12): at most 10 posts, the
 * freshest cadence boundaries surviving — no endless backlog to scroll. */
export const SOCIAL_POST_SKIP_CAP = 10;

/**
 * Who already knows `characterId` in-fiction (Rev 4 §12 delivery rule;
 * owner ruling 2026-07-11: a shared GROUP CHAT counts as having met, not
 * only a shared scene session — the character can still decide not to
 * react, so the open reading costs nothing). Two co-presence sources:
 * - scene sessions: everyone whose character.joined named the same scene;
 * - group chats: everyone listed together in a chat.group_started.
 * The user is not a character — only `char:*` co-presence matters here.
 * Returns a sorted array (deterministic pick order for the reaction cap).
 */
export function acquaintancesOf(
  storage: Storage,
  worldId: string,
  characterId: string,
): string[] {
  const bySceneOrGroup = new Map<string, Set<string>>();
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (event.world_id !== worldId) continue;
    if (event.type === 'character.joined') {
      const key = `scene:${event.payload.scene_id}`;
      const members = bySceneOrGroup.get(key) ?? new Set<string>();
      members.add(event.payload.character_id);
      bySceneOrGroup.set(key, members);
    } else if (event.type === 'chat.group_started') {
      const key = `group:${event.payload.conversation_id}`;
      const members = bySceneOrGroup.get(key) ?? new Set<string>();
      for (const id of event.payload.member_ids) members.add(id);
      bySceneOrGroup.set(key, members);
    }
  }
  const acquainted = new Set<string>();
  for (const members of bySceneOrGroup.values()) {
    if (!members.has(characterId)) continue;
    for (const id of members) {
      if (id !== characterId) acquainted.add(id);
    }
  }
  return [...acquainted].sort();
}
