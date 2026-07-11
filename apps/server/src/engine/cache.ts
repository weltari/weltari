// The CACHE store, first slice (M6 part 2, Rev 4 §11): per-character,
// append-only, mandatory-per-trigger recaps. The STORE is a projection of
// cache.appended events — "latest" is a view, never a slot; all structured
// fields are engine-written, the character authors only the one-liner.
// Retention (M7 part 1) is a WATERMARK, never a deletion: the cache_prune
// job appends cache.pruned and every view ignores entries at or below the
// watermark — replay rebuilds the identical pruned view. Safe by
// construction: reflection reads session history, never CACHE history.
import type { Storage } from '../storage/db.js';

export interface CacheEntry {
  origin: 'scene' | 'chat' | 'social';
  /** The scene id, conversation id, or post id the entry points back into. */
  context_id: string;
  sublocation_id?: string;
  line: string;
  /** Wall-clock append time (event envelope ts). */
  ts: string;
}

/** The wire cap on a CACHE one-liner (protocol cache.appended). */
export const CACHE_LINE_MAX = 300;

/** Rev 4 §11 retention default: keep the last N entries per character
 * (env WELTARI_CACHE_KEEP overrides). */
export const CACHE_KEEP_DEFAULT = 50;

/**
 * Engine-side normalization for character-authored one-liners: whitespace
 * collapsed, hard-capped so any healthy line fits the wire schema. Returns
 * undefined for an effectively empty line — the caller skips the entry (a
 * character that produced nothing has nothing to recap).
 */
export function capCacheLine(text: string): string | undefined {
  const line = text.trim().replaceAll(/\s+/g, ' ');
  if (line.length === 0) return undefined;
  return line.length <= CACHE_LINE_MAX
    ? line
    : `${line.slice(0, CACHE_LINE_MAX - 1)}…`;
}

export interface CacheView {
  scene?: CacheEntry;
  chat?: CacheEntry;
  social?: CacheEntry;
}

/**
 * The latest-per-origin view (Rev 4 §11) — the cross-context catch-up read:
 * a DM injects the latest SCENE line, the latest CHAT line and the latest
 * SOCIAL line as separate lanes, so a chat recap or a feed comment (M6 part
 * 5) can never shadow a scene experience. Entries are per-character and
 * private; each character reads only its own.
 */
export function latestPerOrigin(
  storage: Storage,
  characterId: string,
): CacheView {
  let scene: (CacheEntry & { event_id: number }) | undefined;
  let chat: (CacheEntry & { event_id: number }) | undefined;
  let social: (CacheEntry & { event_id: number }) | undefined;
  let watermark = 0;
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (
      event.type === 'cache.pruned' &&
      event.payload.character_id === characterId
    ) {
      watermark = Math.max(watermark, event.payload.watermark_id);
      continue;
    }
    if (
      event.type !== 'cache.appended' ||
      event.payload.character_id !== characterId
    ) {
      continue;
    }
    const entry: CacheEntry & { event_id: number } = {
      event_id: event.id,
      origin: event.payload.origin,
      context_id: event.payload.context_id,
      ...(event.payload.sublocation_id === undefined
        ? {}
        : { sublocation_id: event.payload.sublocation_id }),
      line: event.payload.line,
      ts: event.ts,
    };
    if (entry.origin === 'scene') scene = entry;
    else if (entry.origin === 'chat') chat = entry;
    else social = entry;
  }
  // Retention is a view rule (M7 part 1): a pruned entry leaves EVERY view,
  // even a lane whose only entry was ancient — that is what pruning means.
  const surviving = (
    entry: (CacheEntry & { event_id: number }) | undefined,
  ): CacheEntry | undefined => {
    if (entry === undefined || entry.event_id <= watermark) return undefined;
    const rest: CacheEntry & { event_id?: number } = { ...entry };
    delete rest.event_id;
    return rest;
  };
  const prunedScene = surviving(scene);
  const prunedChat = surviving(chat);
  const prunedSocial = surviving(social);
  return {
    ...(prunedScene === undefined ? {} : { scene: prunedScene }),
    ...(prunedChat === undefined ? {} : { chat: prunedChat }),
    ...(prunedSocial === undefined ? {} : { social: prunedSocial }),
  };
}

/**
 * Is a retention pass due (Rev 4 §11: keep the last N entries per
 * character)? Counts entries above the current watermark; when more than
 * `keep` survive, returns the watermark that keeps exactly the newest
 * `keep`. Checked when CACHE grows (the chat/reflection paths) and at boot.
 */
export function cachePruneDue(
  storage: Storage,
  characterId: string,
  keep: number,
): { watermark_id: number; kept: number } | undefined {
  let watermark = 0;
  const visibleIds: number[] = [];
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (
      event.type === 'cache.pruned' &&
      event.payload.character_id === characterId
    ) {
      watermark = Math.max(watermark, event.payload.watermark_id);
    } else if (
      event.type === 'cache.appended' &&
      event.payload.character_id === characterId
    ) {
      visibleIds.push(event.id);
    }
  }
  const surviving = visibleIds.filter((id) => id > watermark);
  if (surviving.length <= keep) return undefined;
  const cutoff = surviving.at(-(keep + 1));
  return cutoff === undefined
    ? undefined
    : { watermark_id: cutoff, kept: keep };
}

/**
 * Enqueue the retention pass when due (no-op otherwise). Like compaction,
 * deliberately outside any commit transaction: retention is world-inert
 * maintenance with zero correctness impact (reflection reads session
 * history, never CACHE history) — a delayed pass costs nothing.
 */
export function enqueueCachePruneIfDue(
  storage: Storage,
  worldId: string,
  characterId: string,
  keep: number,
): void {
  const due = cachePruneDue(storage, characterId, keep);
  if (due === undefined) return;
  storage.ledger.enqueue({
    idempotency_key: `cache_prune:${characterId}:${String(due.watermark_id)}`,
    world_id: worldId,
    type: 'cache_prune',
    payload: { character_id: characterId, keep },
    serial_group: `memory:${worldId}:${characterId}`,
  });
}

/**
 * Render the catch-up recap block for a chat prompt's dynamic tail — FRESH
 * every turn (owner decision 2026-07-09): the caller re-reads the view per
 * call, nothing is cached across turns. Empty view = empty string (a fresh
 * character has nothing to catch up on).
 */
export function cacheRecapText(view: CacheView): string {
  const lines: string[] = [];
  if (view.scene !== undefined) {
    const where =
      view.scene.sublocation_id === undefined
        ? ''
        : ` (at ${view.scene.sublocation_id})`;
    lines.push(`Last scene experience${where}: ${view.scene.line}`);
  }
  if (view.chat !== undefined) {
    lines.push(`Last chat note: ${view.chat.line}`);
  }
  if (view.social !== undefined) {
    lines.push(`Last feed note: ${view.social.line}`);
  }
  return lines.join('\n');
}
