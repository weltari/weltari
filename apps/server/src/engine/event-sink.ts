// Append-then-publish: the row is durable BEFORE any client hears about it
// (crash-only, Brief §2.4). A kill between append and publish loses only the
// live push — reconnecting clients replay the row via Last-Event-ID.
import type { WeltariEvent } from '@weltari/protocol';
import type { EventBus } from '../http/bus.js';
import type { NewEvent } from '../storage/repositories/event-log.js';
import type { NewLedgerJob } from '../storage/repositories/ledger.js';
import type { Storage } from '../storage/db.js';

export interface EventSink {
  append(event: NewEvent): WeltariEvent;
  /**
   * Append several events in ONE WriteGate transaction — all durable or none
   * (Brief §2.4); published after commit in append order (M6 part 2: a
   * reflection and its CACHE line, a chat reply and its CACHE line).
   */
  appendMany(events: readonly NewEvent[]): WeltariEvent[];
  /**
   * Append events AND enqueue ledger jobs in ONE WriteGate transaction (M6
   * part 5) — the scene-end fan-out shape made reusable: intent is durable
   * with the fact that caused it (a feed post + its reaction decisions), so
   * a kill between them cannot exist. Duplicate job keys are silent no-ops
   * (I3); published after commit in append order.
   */
  appendManyWithJobs(
    events: readonly NewEvent[],
    jobs: readonly NewLedgerJob[],
  ): WeltariEvent[];
}

export function createEventSink(
  storage: Storage,
  eventBus: EventBus,
): EventSink {
  return {
    append(event: NewEvent): WeltariEvent {
      const persisted = storage.eventLog.append(event);
      eventBus.publish(persisted);
      return persisted;
    },
    appendMany(events: readonly NewEvent[]): WeltariEvent[] {
      const persisted: WeltariEvent[] = [];
      storage.transact(() => {
        for (const event of events) {
          persisted.push(storage.eventLog.append(event));
        }
      });
      for (const event of persisted) eventBus.publish(event);
      return persisted;
    },
    appendManyWithJobs(
      events: readonly NewEvent[],
      jobs: readonly NewLedgerJob[],
    ): WeltariEvent[] {
      const persisted: WeltariEvent[] = [];
      storage.transact(() => {
        for (const event of events) {
          persisted.push(storage.eventLog.append(event));
        }
        for (const job of jobs) {
          storage.ledger.enqueue(job); // duplicate key = silent no-op (I3)
        }
      });
      for (const event of persisted) eventBus.publish(event);
      return persisted;
    },
  };
}
