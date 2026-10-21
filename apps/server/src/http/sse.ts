// GET /v1/events — the one server-pushed stream (Brief §2.5). Durable events
// carry `id:` = event-log seq so browser-native Last-Event-ID replay works;
// ephemeral sentence frames carry no id and are lost on disconnect by design.
// Dev-channel frames (`event: dev`) are gated per client (?dev=1) — the same
// stream carries the log-only trail when enabled (UI Spec §2.8).
import type { ServerResponse } from 'node:http';
import type { DevEvent, StreamSentence, WeltariEvent } from '@weltari/protocol';
import { BugError } from '../errors.js';
import { catchAndLog } from '../observability/catch-and-log.js';
import type { Logger } from '../observability/logger.js';
import type { EventLogRepository } from '../storage/repositories/event-log.js';
import type { DevBus, EventBus, StreamBus } from './bus.js';

export interface SseDeps {
  eventLog: EventLogRepository;
  eventBus: EventBus;
  streamBus: StreamBus;
  devBus: DevBus;
  /** Where a replay that cannot finish (a corrupt row) is reported. */
  logger: Logger;
  /** True when this client asked for the dev channel (?dev=1). */
  devChannel: boolean;
  protocolVersion: string;
  heartbeatMs?: number;
  /** Running app version, included in the hello frame when known (0.8.0). */
  appVersion?: string;
  /** Events per replay page (default 1000) — injectable so tests prove the
   * paged replay across many pages with a handful of rows. */
  replayPageSize?: number;
}

const REPLAY_PAGE_SIZE = 1000;

function writeDurable(raw: ServerResponse, event: WeltariEvent): boolean {
  return raw.write(
    `event: event\nid: ${String(event.id)}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

function writeSentence(raw: ServerResponse, frame: StreamSentence): void {
  raw.write(`event: stream\ndata: ${JSON.stringify(frame)}\n\n`);
}

function writeDev(raw: ServerResponse, frame: DevEvent): void {
  raw.write(`event: dev\ndata: ${JSON.stringify(frame)}\n\n`);
}

/** Between replay pages: wait for the socket buffer to drain when the last
 * write said it is full (a slow client holds one page, never the whole log),
 * else yield one macrotask so other requests run during a long replay. */
async function nextPage(raw: ServerResponse, flowing: boolean): Promise<void> {
  await new Promise<void>((resolve) => {
    if (flowing) {
      setImmediate(resolve);
      return;
    }
    const done = (): void => {
      raw.off('drain', done);
      raw.off('close', done);
      resolve();
    };
    raw.on('drain', done);
    raw.on('close', done);
  });
}

/**
 * Attach an SSE client to a hijacked response. Exactly-once replay contract:
 * the cursor starts at the client's Last-Event-ID and is shared by the paged
 * replay and the live subscription, which is taken BEFORE the replay. Every
 * event up to the hello head is replayed from the log in id order, one page
 * at a time. Bus frames published meanwhile (durable and ephemeral) queue in
 * publish order and are flushed in the same synchronous step that finishes
 * the replay, so nothing slips between "replay finished" and "live began";
 * the shared cursor drops the durable ones the replay already sent. A log
 * that fits one page replays synchronously, exactly as before paging.
 */
export function attachSseClient(
  raw: ServerResponse,
  lastEventId: number,
  deps: SseDeps,
): void {
  const pageSize = deps.replayPageSize ?? REPLAY_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new BugError(
      'sse_replay_page_size',
      `SSE replay page size must be a positive integer, got ${String(pageSize)}`,
    );
  }
  raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  // The replay target: every id up to here exists durably now; anything
  // appended later reaches this client through the bus (the queue below).
  const head = deps.eventLog.lastId();
  raw.write(
    `event: hello\ndata: ${JSON.stringify({
      protocol_version: deps.protocolVersion,
      last_event_id: head,
      ...(deps.appVersion === undefined
        ? {}
        : { app_version: deps.appVersion }),
    })}\n\n`,
  );

  let cursor = lastEventId;
  // Until the replay is live a bus frame waits in `queued`: writing a live
  // durable event mid-replay would jump the shared cursor past pages not yet
  // read (a gap), and a sentence would overtake the history it follows.
  let live = false;
  let stopped = false;
  let queued: (() => void)[] = [];
  const deliver = (write: () => void): void => {
    if (stopped) return;
    if (live) write();
    else queued.push(write);
  };
  const unsubscribeEvents = deps.eventBus.subscribe((event) => {
    deliver(() => {
      if (event.id > cursor) {
        writeDurable(raw, event);
        cursor = event.id;
      }
    });
  });
  const unsubscribeStream = deps.streamBus.subscribe((frame) => {
    deliver(() => {
      writeSentence(raw, frame);
    });
  });
  const unsubscribeDev = deps.devChannel
    ? deps.devBus.subscribe((frame) => {
        deliver(() => {
          writeDev(raw, frame);
        });
      })
    : (): void => undefined;

  const heartbeat = setInterval(() => {
    raw.write(': ping\n\n');
  }, deps.heartbeatMs ?? 15000);
  heartbeat.unref();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    queued = [];
    clearInterval(heartbeat);
    unsubscribeEvents();
    unsubscribeStream();
    unsubscribeDev();
  };
  raw.on('close', stop);

  async function replay(): Promise<void> {
    try {
      while (cursor < head && !stopped) {
        const before = cursor;
        let flowing = true;
        for (const event of deps.eventLog.readSince(cursor, pageSize)) {
          // Past the head: appended after connect — the queue (or the live
          // tail, if it is published later) carries it.
          if (event.id > head) break;
          flowing = writeDurable(raw, event);
          cursor = event.id;
        }
        if (cursor === before) break; // defensive: no row left up to head
        if (cursor < head) await nextPage(raw, flowing);
      }
    } catch (thrown) {
      // A replay that cannot finish must never go live — live frames after
      // a hole break the no-gap contract. End the stream instead; the client
      // reconnects from the last id it received.
      stop();
      raw.end();
      throw thrown;
    }
    if (stopped) return;
    // Caught up: flush the queue and go live in this one synchronous step.
    const pending = queued;
    queued = [];
    for (const write of pending) write();
    live = true;
  }
  catchAndLog(replay(), deps.logger, 'sse.replay');
}
