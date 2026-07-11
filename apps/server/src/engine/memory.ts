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
import type { Logger } from '../observability/logger.js';
import type { ValidatedReflectionToolCall } from '../llm/tools.js';
import type { Storage } from '../storage/db.js';
import type { NewEvent } from '../storage/repositories/event-log.js';
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

/** Rev 4 §11: "1–3 memory deltas" per reflection — the engine-gate cap. */
export const MEMORY_DELTA_CAP = 3;

/**
 * Engine-side normalization for reflection-authored memory text: whitespace
 * collapsed, angle brackets neutralized (core/personality/goals enter the
 * STABLE PREFIX un-wrapped — B14 hygiene: curated memory must not be able to
 * fake an <external> wrapper or a prompt heading), hard length cap. Returns
 * undefined for an effectively empty line.
 */
export function sanitizeMemoryText(
  text: string,
  max: number,
): string | undefined {
  const line = text
    .trim()
    .replaceAll(/\s+/g, ' ')
    .replaceAll('<', '‹')
    .replaceAll('>', '›');
  if (line.length === 0) return undefined;
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

export interface ReflectionMemoryOutput {
  /** ≤ MEMORY_DELTA_CAP sanitized delta notes, in call order. */
  deltas: readonly string[];
  /** The sanitized full core snapshot — at most one per reflection. */
  core?: readonly string[];
  /** Evolution — absent for locked characters or empty calls. */
  evolution?: { personality?: string; goals?: readonly string[] };
}

/**
 * Gate 2 for the reflection memory outputs (M7 part 1, B6): shape-valid
 * calls checked against character state — the delta cap, one core snapshot
 * (last wins), the per-character `locked` flag (a locked character's evolve
 * is refused whole — zero rows, I8), and the at-least-one-field rule for
 * evolve. Rejections log and drop the call; everything accepted is
 * sanitized for prefix hygiene.
 */
export function gateReflectionMemory(
  calls: readonly ValidatedReflectionToolCall[],
  profile: Pick<CharacterProfile, 'character_id' | 'locked'>,
  logger: Logger,
): ReflectionMemoryOutput {
  const deltas: string[] = [];
  let core: readonly string[] | undefined;
  let evolution: ReflectionMemoryOutput['evolution'];
  for (const call of calls) {
    if (call.tool === 'memory_delta') {
      const content = sanitizeMemoryText(call.input.content, 1000);
      if (content === undefined) continue;
      if (deltas.length >= MEMORY_DELTA_CAP) {
        logger.warn(
          { character_id: profile.character_id },
          `reflection produced more than ${String(MEMORY_DELTA_CAP)} memory deltas — extras dropped (Rev 4 §11 cap)`,
        );
        continue;
      }
      deltas.push(content);
    } else if (call.tool === 'update_core') {
      const lines = call.input.core
        .map((l) => sanitizeMemoryText(l, 300))
        .filter((l): l is string => l !== undefined);
      if (lines.length === 0) continue;
      if (core !== undefined) {
        logger.warn(
          { character_id: profile.character_id },
          'reflection called update_core twice — the last snapshot wins',
        );
      }
      core = lines;
    } else {
      if (profile.locked === true) {
        logger.warn(
          { character_id: profile.character_id },
          'evolve refused: this character is locked (owner ruling 2026-07-11) — personality/goals untouched',
        );
        continue;
      }
      const personality =
        call.input.personality === undefined
          ? undefined
          : sanitizeMemoryText(call.input.personality, 1000);
      const goals = call.input.goals
        ?.map((g) => sanitizeMemoryText(g, 300))
        .filter((g): g is string => g !== undefined);
      if (
        personality === undefined &&
        (goals === undefined || goals.length === 0)
      ) {
        logger.warn(
          { character_id: profile.character_id },
          'evolve refused: neither personality nor goals present',
        );
        continue;
      }
      evolution = {
        ...(personality === undefined ? {} : { personality }),
        ...(goals === undefined || goals.length === 0 ? {} : { goals }),
      };
    }
  }
  return {
    deltas,
    ...(core === undefined ? {} : { core }),
    ...(evolution === undefined ? {} : { evolution }),
  };
}

/**
 * The gated memory outputs as durable events (M7 part 1): appended by the
 * reflection handlers ATOMICALLY with their committed events, through the
 * character's memory mailbox (the enqueue sites set serial_group
 * `memory:<world>:<character>`).
 */
export function memoryEventsFrom(
  output: ReflectionMemoryOutput,
  meta: {
    world_id: string;
    character_id: string;
    origin: 'scene' | 'chat';
    context_id: string;
  },
): NewEvent[] {
  const base = {
    world_id: meta.world_id,
    actor_id: meta.character_id,
  };
  return [
    ...output.deltas.map((content): NewEvent => ({
      ...base,
      type: 'memory.delta_committed',
      payload: {
        character_id: meta.character_id,
        origin: meta.origin,
        context_id: meta.context_id,
        content,
      },
    })),
    ...(output.core === undefined
      ? []
      : [
          {
            ...base,
            type: 'memory.core_updated' as const,
            payload: {
              character_id: meta.character_id,
              core: [...output.core],
              origin: meta.origin,
              context_id: meta.context_id,
            },
          },
        ]),
    ...(output.evolution === undefined
      ? []
      : [
          {
            ...base,
            type: 'character.evolved' as const,
            payload: {
              character_id: meta.character_id,
              ...(output.evolution.personality === undefined
                ? {}
                : { personality: output.evolution.personality }),
              ...(output.evolution.goals === undefined
                ? {}
                : { goals: [...output.evolution.goals] }),
              origin: meta.origin,
              context_id: meta.context_id,
            },
          },
        ]),
  ];
}
