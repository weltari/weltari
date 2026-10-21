// The engine-owned fictional WorldClock (Brief §2.10: monotonic, drives TTLs
// and replay). Fictional time is durable truth: the current clock is a
// projection of world.time_advanced events, so a kill -9 can never lose or
// repeat a skip. advanceTime is the atomicity twin of endScene: the
// time_advanced event and EVERY due world-cron occurrence row commit in one
// WriteGate transaction; code-class occurrences are all enqueued, LLM-class
// keep only the newest per-skip budget (default 10 — Brief §4).
//
// A16 note: the engine may not construct Dates; calendar math is delegated to
// ledger/scheduler.js (addMinutesIso / occurrencesBetween / utcDaysBetweenIso
// — pure functions).
import type { AdvanceTimeCommand, WeltariEvent } from '@weltari/protocol';
import { err, ok, OperationalError, type Result } from '../errors.js';
import type { EventBus } from '../http/bus.js';
import {
  addMinutesIso,
  occurrencesBetween,
  utcDaysBetweenIso,
} from '../ledger/scheduler.js';
import type { Logger } from '../observability/logger.js';
import type { Storage } from '../storage/db.js';

/** Where every world's fictional clock starts. */
export const WORLD_EPOCH = '2000-01-01T06:00:00.000Z';

/** The named part of the fictional day for an hour 0–23 — dawn holds the
 * 06:00 epoch (the fixture's lamplighter dawn), evening the 18:00 dusk. */
function partOfDay(hour: number): string {
  if (hour < 5) return 'night';
  if (hour < 7) return 'dawn';
  if (hour < 12) return 'morning';
  if (hour < 14) return 'midday';
  if (hour < 18) return 'afternoon';
  if (hour < 22) return 'evening';
  return 'night';
}

/**
 * A fictional instant as prompts read it (Rev 4 glossary: the world clock is
 * injected into Narrator and character prompts): "Day 3, 14:30, afternoon".
 * The day number is the Gameday page's GAMEDAY N — UTC calendar days since
 * the epoch's day, 1-based — and HH:MM is its digital readout. DYNAMIC by
 * nature (the clock advances between calls): it belongs in the dynamic tail
 * only, never a stable prefix (I5). No weather — that is V1.5.
 */
export function describeWorldTime(iso: string): string {
  const day = utcDaysBetweenIso(WORLD_EPOCH, iso) + 1;
  return `Day ${String(day)}, ${iso.slice(11, 16)}, ${partOfDay(Number(iso.slice(11, 13)))}`;
}

/** The world-clock line for a call that carries a situational sentence:
 * "Day 3, 14:30, afternoon. You are outside any scene, texting on your
 * phone." — the instant first, the call's own framing kept after it. */
export function worldClockLine(iso: string, situation: string): string {
  return `${describeWorldTime(iso)}. ${situation}`;
}

/**
 * The clock as it stood at a PAST log position: the latest
 * world.time_advanced appended before the first event `at` matches (the
 * current clock when nothing matches). Background jobs about a specific game
 * moment — a scene that ended, a chat range that closed — read THAT moment,
 * not the clock at run time (a skip may land between the moment and the job).
 */
export function worldTimeAt(
  storage: Storage,
  worldId: string,
  at: (event: WeltariEvent) => boolean,
): string {
  let time = WORLD_EPOCH;
  for (const event of storage.eventLog.readAllSince(0)) {
    if (at(event)) return time;
    if (event.type === 'world.time_advanced' && event.world_id === worldId) {
      time = event.payload.to;
    }
  }
  return time;
}

export interface WorldCronDefinition {
  /** 5/6-field cron pattern over FICTIONAL time (UTC calendar math). */
  pattern: string;
  /** Names the occurrence, e.g. 'lamplighter' — part of the idempotency key. */
  cronType: string;
  /** code = instant projection; llm = background, budget-capped per skip. */
  jobClass: 'code' | 'llm';
}

export interface WorldClockOptions {
  storage: Storage;
  eventBus: EventBus;
  logger: Logger;
  definitions: readonly WorldCronDefinition[];
  /** Max LLM-class occurrences enqueued per skip; older ones are dropped. */
  llmBudgetPerSkip?: number;
  /** Called after a skip commits — main wires this to an immediate runner drain. */
  kick?: () => void;
}

export interface AdvanceTimeResult {
  worldTime: string;
  codeEnqueued: number;
  llmEnqueued: number;
  llmSkipped: number;
}

export interface WorldClock {
  /** Current fictional time — the latest world.time_advanced, or the epoch. */
  currentTime(worldId: string): string;
  advanceTime(command: AdvanceTimeCommand): Result<AdvanceTimeResult>;
}

interface Occurrence {
  scheduledFor: string;
  cronType: string;
  jobClass: 'code' | 'llm';
}

/** The fictional clock as a standalone projection (M6 part 3: the
 * proactive_dm handler stamps outreach entries with it — game-day stamps are
 * the V2 trigger-base bridge, owner ruling 2026-07-10). */
export function worldTimeOf(storage: Storage, worldId: string): string {
  let time = WORLD_EPOCH;
  for (const event of storage.eventLog.readAllSince(0)) {
    if (event.type === 'world.time_advanced' && event.world_id === worldId) {
      time = event.payload.to;
    }
  }
  return time;
}

export function createWorldClock(options: WorldClockOptions): WorldClock {
  const {
    storage,
    eventBus,
    logger,
    definitions,
    llmBudgetPerSkip = 10,
    kick = (): void => undefined,
  } = options;

  function currentTime(worldId: string): string {
    return worldTimeOf(storage, worldId);
  }

  return {
    currentTime,

    advanceTime(command: AdvanceTimeCommand): Result<AdvanceTimeResult> {
      const from = currentTime(command.world_id);
      const to = addMinutesIso(from, command.minutes);

      const due: Occurrence[] = [];
      for (const def of definitions) {
        for (const scheduledFor of occurrencesBetween(def.pattern, from, to)) {
          due.push({
            scheduledFor,
            cronType: def.cronType,
            jobClass: def.jobClass,
          });
        }
      }
      due.sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));

      const codeClass = due.filter((o) => o.jobClass === 'code');
      const llmAll = due.filter((o) => o.jobClass === 'llm');
      // Budget keeps the NEWEST occurrences: after a week-long skip the world
      // reacts to recent fictional days, not day one (Brief §4, default ~10).
      const llmKept = llmAll.slice(-llmBudgetPerSkip);
      const llmSkipped = llmAll.length - llmKept.length;

      if (codeClass.length + llmKept.length > 5000) {
        return err(
          new OperationalError(
            'skip_too_large',
            'this skip would enqueue over 5000 jobs — advance in smaller steps',
          ),
        );
      }

      let codeEnqueued = 0;
      let llmEnqueued = 0;
      const persisted = storage.transact(() => {
        const event = storage.eventLog.append({
          world_id: command.world_id,
          actor_id: command.actor_id,
          type: 'world.time_advanced',
          payload: {
            from,
            to,
            code_enqueued: codeClass.length,
            llm_enqueued: llmKept.length,
            llm_skipped: llmSkipped,
          },
        });
        // Code-class rows first: ids order the claim queue, so every instant
        // projection runs before any background LLM occurrence — each class
        // internally in scheduled-game-timestamp order (Brief §4).
        for (const occurrence of codeClass) {
          const job = storage.ledger.enqueue({
            idempotency_key: `wcron:${occurrence.cronType}:${command.world_id}:${occurrence.scheduledFor}`,
            world_id: command.world_id,
            type: 'world_cron.code',
            payload: {
              cron_type: occurrence.cronType,
              scheduled_for: occurrence.scheduledFor,
            },
          });
          if (job !== null) codeEnqueued += 1;
        }
        for (const occurrence of llmKept) {
          const job = storage.ledger.enqueue({
            idempotency_key: `wcron:${occurrence.cronType}:${command.world_id}:${occurrence.scheduledFor}`,
            world_id: command.world_id,
            type: 'world_cron.llm',
            payload: {
              cron_type: occurrence.cronType,
              scheduled_for: occurrence.scheduledFor,
            },
          });
          if (job !== null) llmEnqueued += 1;
        }
        return event;
      });
      eventBus.publish(persisted);
      logger.info(
        {
          world_id: command.world_id,
          from,
          to,
          code: codeEnqueued,
          llm: llmEnqueued,
          skipped: llmSkipped,
        },
        'world clock advanced',
      );
      kick();
      return ok({
        worldTime: to,
        codeEnqueued,
        llmEnqueued,
        llmSkipped,
      });
    },
  };
}
