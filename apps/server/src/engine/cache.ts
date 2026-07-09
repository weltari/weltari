// The CACHE store, first slice (M6 part 2, Rev 4 §11): per-character,
// append-only, mandatory-per-trigger recaps. The STORE is a projection of
// cache.appended events — "latest" is a view, never a slot; all structured
// fields are engine-written, the character authors only the one-liner.
// Retention/compaction is a later ledger job: pruning is safe by construction
// because reflection reads session history, never CACHE history.
import type { Storage } from '../storage/db.js';

export interface CacheEntry {
  origin: 'scene' | 'chat';
  /** The scene id or conversation id the entry points back into. */
  context_id: string;
  sublocation_id?: string;
  line: string;
  /** Wall-clock append time (event envelope ts). */
  ts: string;
}

/** The wire cap on a CACHE one-liner (protocol cache.appended). */
export const CACHE_LINE_MAX = 300;

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
}

/**
 * The latest-per-origin view (Rev 4 §11) — the cross-context catch-up read:
 * a DM injects the latest SCENE line and the latest CHAT line, so a chat
 * recap can never shadow a scene experience. Entries are per-character and
 * private; each character reads only its own.
 */
export function latestPerOrigin(
  storage: Storage,
  characterId: string,
): CacheView {
  let scene: CacheEntry | undefined;
  let chat: CacheEntry | undefined;
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (
      event.type !== 'cache.appended' ||
      event.payload.character_id !== characterId
    ) {
      continue;
    }
    const entry: CacheEntry = {
      origin: event.payload.origin,
      context_id: event.payload.context_id,
      ...(event.payload.sublocation_id === undefined
        ? {}
        : { sublocation_id: event.payload.sublocation_id }),
      line: event.payload.line,
      ts: event.ts,
    };
    if (entry.origin === 'scene') scene = entry;
    else chat = entry;
  }
  return {
    ...(scene === undefined ? {} : { scene }),
    ...(chat === undefined ? {} : { chat }),
  };
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
  return lines.join('\n');
}
