// In-process fan-out from writers to connected SSE clients. Durable events ride
// eventBus (with SSE ids); display-only sentences ride streamBus (no ids, B6).
// Publish AFTER the row is durable — the bus is a mirror, never the truth.
import type { StreamSentence, WeltariEvent } from '@weltari/protocol';
import type { Logger } from '../observability/logger.js';

export type Unsubscribe = () => void;

export class Bus<T> {
  private readonly listeners = new Set<(item: T) => void>();
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  subscribe(listener: (item: T) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(item: T): void {
    for (const listener of this.listeners) {
      try {
        listener(item);
      } catch (thrown) {
        // CATCH-OK: one dead SSE socket must not break the other listeners.
        this.logger.warn({ err: thrown }, 'bus listener threw');
      }
    }
  }
}

export type EventBus = Bus<WeltariEvent>;
export type StreamBus = Bus<StreamSentence>;
