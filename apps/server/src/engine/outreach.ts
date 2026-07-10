// Proactive-DM projections (M6 part 3, Rev 4 §8). Everything here is a pure
// fold of the event log — no clock reads (A16): the fire time arrives as the
// scheduler occurrence in the job payload, so a kill-retry re-evaluates the
// SAME decision. The counter semantics are Rev 4's: an outreach is
// "unanswered" while no user line follows it, so a user reply resets the
// count (and thaws a frozen thread) by construction — no reset event exists
// because none is needed.
import type { Storage } from '../storage/db.js';
import { addMinutesIso } from '../ledger/scheduler.js';

/** The hard cap (Rev 4 §8/§13): the third unanswered outreach freezes the
 * thread — no further proactive sends until the user replies. */
export const OUTREACH_FREEZE_CAP = 3;

export interface OutreachState {
  /** Proactive DMs sent after the user's last line (0 = answered thread). */
  unanswered: number;
  /** Fire time of the newest unanswered outreach ('' when none). */
  lastOccurrenceIso: string;
  /** unanswered ≥ cap — the thread receives no proactive sends. */
  frozen: boolean;
  /** Messages in the conversation's OPEN range (0 = quiet: fresh thread or
   * every range closed by exit/idle/startscene). */
  openMessages: number;
}

/** Fold the log into one thread's outreach state. */
export function outreachState(
  storage: Storage,
  conversationId: string,
): OutreachState {
  let lastUserLineId = 0;
  let lastEndedAt = 0;
  const messageIds: number[] = [];
  const outreaches: { id: number; occurrenceIso: string }[] = [];
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (
      event.type === 'chat.message_committed' &&
      event.payload.conversation_id === conversationId
    ) {
      messageIds.push(event.id);
      if (event.payload.sender === 'user') lastUserLineId = event.id;
    } else if (
      event.type === 'chat.ended' &&
      event.payload.conversation_id === conversationId
    ) {
      lastEndedAt = event.id;
    } else if (
      event.type === 'chat.outreach_recorded' &&
      event.payload.conversation_id === conversationId
    ) {
      outreaches.push({
        id: event.id,
        occurrenceIso: event.payload.occurrence_iso,
      });
    }
  }
  const unansweredList = outreaches.filter((o) => o.id > lastUserLineId);
  return {
    unanswered: unansweredList.length,
    lastOccurrenceIso: unansweredList.at(-1)?.occurrenceIso ?? '',
    frozen: unansweredList.length >= OUTREACH_FREEZE_CAP,
    openMessages: messageIds.filter((id) => id > lastEndedAt).length,
  };
}

/**
 * May this occurrence reach out on this thread? The three rules (owner
 * rulings 2026-07-10):
 * - frozen → never (until the user replies, which resets the projection);
 * - answered thread → only when it is QUIET (no open range — don't barge
 *   into a running conversation; the idle sweep is what makes threads quiet);
 * - unanswered thread → growing backoff: the nth re-ask waits base × 2^n
 *   after the previous outreach (base ×2 ×4, then the cap freezes it).
 * Zulu ISO strings compare lexicographically, so string >= is exact.
 */
export function outreachEligible(
  state: OutreachState,
  occurrenceIso: string,
  cadenceMinutes: number,
): boolean {
  if (state.frozen) return false;
  if (state.unanswered === 0) return state.openMessages === 0;
  return (
    occurrenceIso >=
    addMinutesIso(
      state.lastOccurrenceIso,
      cadenceMinutes * 2 ** state.unanswered,
    )
  );
}

/** Deterministic "random in V1" pick (Rev 4 §8): the same occurrence always
 * picks the same character, so a kill-retry can never switch targets and
 * break the fire's natural key. FNV-1a over the occurrence string. */
export function pickIndex(seed: string, length: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash) % Math.max(1, length);
}
