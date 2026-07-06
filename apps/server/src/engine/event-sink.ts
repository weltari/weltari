// Append-then-publish: the row is durable BEFORE any client hears about it
// (crash-only, Brief §2.4). A kill between append and publish loses only the
// live push — reconnecting clients replay the row via Last-Event-ID.
import type { WeltariEvent } from '@weltari/protocol';
import type { EventBus } from '../http/bus.js';
import type { NewEvent } from '../storage/repositories/event-log.js';
import type { Storage } from '../storage/db.js';

export interface EventSink {
  append(event: NewEvent): WeltariEvent;
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
  };
}
