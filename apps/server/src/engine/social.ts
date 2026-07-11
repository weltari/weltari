// The Feed's engine-side folds (M6 part 5, Rev 4 §12). Everything here is a
// pure fold of the event log — no clock reads (A16), no LLM: the same log
// always yields the same answer, so a kill-retry re-evaluates the SAME
// delivery set and the post's natural key stays safe.
import type { Storage } from '../storage/db.js';
import { pickIndex } from './outreach.js';

/** The hard ceiling per time skip (Rev 4 §12): at most 10 posts, the
 * freshest cadence boundaries surviving — no endless backlog to scroll. */
export const SOCIAL_POST_SKIP_CAP = 10;

/**
 * The feed conduct skill (M6 part 5, Rev 4 §12; owner rulings 2026-07-11).
 * Appended to the character's skills for social calls only — a stable
 * constant, so the social stable prefix stays byte-identical across calls
 * (I5). It teaches the medium (a small feed read by people who know you),
 * the V1 limits (comments are isolated; the feed cannot arrange anything —
 * no startscene tool exists here, so never promise meetings or actions from
 * the feed), and the CACHE duty.
 */
export const SOCIAL_CONDUCT_SKILL =
  'The Feed: you are on a small social feed on your phone, read by people who know you. Posts and comments are short and public to your acquaintances. You can only write here — you cannot meet, hand over, or arrange anything from the feed and you have no tool to do so: never promise actions like "let\'s meet tomorrow" in a post, comment, or reply; if something needs doing, say you will bring it up when you next see or text them. Comments do not thread between characters — you cannot reply to another character\'s comment. After you write anything on the feed, call the cache tool with a private 1-2 line recap.';

/**
 * Which recipients get the ONE reaction decision (owner ruling 2026-07-11:
 * env cap, default 4; picked "randomly" in V1 — no relationship system).
 * Deterministic: recipients ranked by a salted FNV hash, first `cap` win —
 * a kill-retry re-derives the SAME picks, and different posts (different
 * salt) rotate through different subsets.
 */
export function pickReactionCandidates(
  recipients: readonly string[],
  cap: number,
  salt: string,
): string[] {
  if (cap <= 0) return [];
  return [...recipients]
    .sort(
      (a, b) =>
        pickIndex(`${salt}:${a}`, 0x7fffffff) -
          pickIndex(`${salt}:${b}`, 0x7fffffff) || a.localeCompare(b),
    )
    .slice(0, cap);
}

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
