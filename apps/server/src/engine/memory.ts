// The character memory fold (M7 part 1, Rev 4 §11/§17): every durable memory
// artifact is a projection of the event log — the fixture/config profile is
// the immutable SEED, and this module lays the durable state on top:
//   memory core   = seed lines + the latest memory.core_updated snapshot
//   personality   = latest character.evolved personality (unless none)
//   goals         = latest character.evolved goals snapshot (unless none)
//   archive       = latest memory.compacted summary + every delta after it
// The fold is deterministic from the log, so the assembled stable prefix
// stays byte-identical between calls until a reflection-class job commits a
// memory event (I5: the core changes only BETWEEN calls, never within one).
import type { Storage } from '../storage/db.js';
import type { CharacterProfile } from './context-assembler.js';

export interface MemoryDelta {
  /** The memory.delta_committed event's log id (the Search Index key). */
  event_id: number;
  origin: 'scene' | 'chat';
  context_id: string;
  content: string;
}

export interface MemoryCompaction {
  /** Newest delta event id the summary covers (cumulative range). */
  up_to_id: number;
  delta_count: number;
  summary: string;
}

export interface MemoryState {
  /** Latest durable core snapshot — absent until the first core update. */
  core?: readonly string[];
  /** Latest evolved personality — absent until the first evolution. */
  personality?: string;
  /** Latest evolved goals snapshot — absent until the first evolution. */
  goals?: readonly string[];
  /** Latest compaction record (highest up_to_id; later event wins a tie). */
  compaction?: MemoryCompaction;
  /** Every delta, ascending by log id — deltas are never removed. */
  deltas: readonly MemoryDelta[];
}

/** Fold one character's durable memory state out of the log. */
export function memoryStateOf(
  storage: Storage,
  characterId: string,
): MemoryState {
  let core: readonly string[] | undefined;
  let personality: string | undefined;
  let goals: readonly string[] | undefined;
  let compaction: MemoryCompaction | undefined;
  const deltas: MemoryDelta[] = [];
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (
      event.type === 'memory.delta_committed' &&
      event.payload.character_id === characterId
    ) {
      deltas.push({
        event_id: event.id,
        origin: event.payload.origin,
        context_id: event.payload.context_id,
        content: event.payload.content,
      });
    } else if (
      event.type === 'memory.core_updated' &&
      event.payload.character_id === characterId
    ) {
      core = event.payload.core;
    } else if (
      event.type === 'character.evolved' &&
      event.payload.character_id === characterId
    ) {
      if (event.payload.personality !== undefined) {
        personality = event.payload.personality;
      }
      if (event.payload.goals !== undefined) {
        goals = event.payload.goals;
      }
    } else if (
      event.type === 'memory.compacted' &&
      event.payload.character_id === characterId
    ) {
      // Ascending scan: a later record with up_to_id >= the current one
      // supersedes it (same range re-run = repair; wider range = progress).
      if (
        compaction === undefined ||
        event.payload.up_to_id >= compaction.up_to_id
      ) {
        compaction = {
          up_to_id: event.payload.up_to_id,
          delta_count: event.payload.delta_count,
          summary: event.payload.summary,
        };
      }
    }
  }
  return {
    ...(core === undefined ? {} : { core }),
    ...(personality === undefined ? {} : { personality }),
    ...(goals === undefined ? {} : { goals }),
    ...(compaction === undefined ? {} : { compaction }),
    deltas,
  };
}

/**
 * The archive read path (Rev 4 §11): the latest compaction summary stands in
 * for every delta it covers; raw deltas newer than it lay on top. Deltas
 * behind the summary stay in the log (and in the Search Index — memoryquery
 * deep-dives them regardless: the summary is a reading convenience, never a
 * loss).
 */
export function archiveView(
  storage: Storage,
  characterId: string,
): { summary?: string; deltas: readonly MemoryDelta[] } {
  const state = memoryStateOf(storage, characterId);
  if (state.compaction === undefined) return { deltas: state.deltas };
  const upTo = state.compaction.up_to_id;
  return {
    summary: state.compaction.summary,
    deltas: state.deltas.filter((d) => d.event_id > upTo),
  };
}

/**
 * The live profile: the seed profile with the durable memory state laid on
 * top — memory core = seed + latest snapshot; personality/goals replaced by
 * their latest evolution. EVERY character-class call site assembles from
 * this, so criterion (b) holds by construction: the next call after a core
 * update injects it. Deterministic per log state (I5).
 */
export function liveProfile(
  storage: Storage,
  profile: CharacterProfile,
): CharacterProfile {
  const state = memoryStateOf(storage, profile.character_id);
  return {
    ...profile,
    memory_core: [...profile.memory_core, ...(state.core ?? [])],
    personality: state.personality ?? profile.personality,
    goals: state.goals ?? profile.goals,
  };
}
