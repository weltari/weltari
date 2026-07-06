// croner computes cron occurrences; it ALWAYS writes ledger rows and never
// works inline (FINAL item 8) — so a kill -9 between "cron fired" and "work
// done" loses nothing: the row either exists or the next tick recreates it.
import { Cron } from 'croner';
import { BugError } from '../errors.js';
import type { Storage } from '../storage/db.js';

export interface CronDefinition {
  /** Standard 5/6-field cron pattern, evaluated in UTC. */
  pattern: string;
  jobType: string;
  worldId: string;
  payload?: unknown;
  serialGroup?: string;
}

export interface Scheduler {
  /**
   * Ensure the next occurrence of every definition exists as a ledger row.
   * Idempotent: the key embeds the occurrence timestamp, so re-ticking (or
   * restarting — startup IS recovery) never duplicates a row.
   */
  tick(): void;
}

/** Pure fictional-time arithmetic for the engine's WorldClock (A16: the engine
 * itself may not construct Dates — it calls this instead). */
export function addMinutesIso(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

/**
 * Every occurrence of `pattern` in (fromIso, toIso], ascending. Used by the
 * time-skip replay: these are FICTIONAL datetimes — croner only does calendar
 * math here, never reads the wall clock. Throws past `cap` occurrences so a
 * runaway pattern cannot flood the ledger.
 */
export function occurrencesBetween(
  pattern: string,
  fromIso: string,
  toIso: string,
  cap = 10000,
): string[] {
  const cron = new Cron(pattern, { timezone: 'UTC' });
  const to = new Date(toIso).getTime();
  const occurrences: string[] = [];
  let cursor = new Date(fromIso);
  for (;;) {
    const next = cron.nextRun(cursor);
    if (next === null || next.getTime() > to) break;
    occurrences.push(next.toISOString());
    if (occurrences.length > cap) {
      throw new BugError(
        'cron_occurrence_cap',
        `pattern "${pattern}" produced more than ${String(cap)} occurrences in one skip`,
      );
    }
    cursor = next;
  }
  return occurrences;
}

export function createScheduler(
  storage: Storage,
  definitions: readonly CronDefinition[],
  nowIso: () => string,
): Scheduler {
  return {
    tick(): void {
      for (const def of definitions) {
        const cron = new Cron(def.pattern, { timezone: 'UTC' });
        const next = cron.nextRun(new Date(nowIso()));
        if (next === null) continue;
        const runAt = next.toISOString();
        const enqueued = storage.ledger.enqueue({
          idempotency_key: `cron:${def.jobType}:${def.worldId}:${runAt}`,
          world_id: def.worldId,
          type: def.jobType,
          payload: def.payload ?? null,
          run_at: runAt,
          ...(def.serialGroup === undefined
            ? {}
            : { serial_group: def.serialGroup }),
        });
        void enqueued; // null = occurrence already scheduled (idempotent)
      }
    },
  };
}
