// GET /v1/events — the one server-pushed stream (Brief §2.5). Durable events
// carry `id:` = event-log seq so browser-native Last-Event-ID replay works;
// ephemeral sentence frames carry no id and are lost on disconnect by design.
import type { ServerResponse } from 'node:http';
import type { StreamSentence, WeltariEvent } from '@weltari/protocol';
import type { EventLogRepository } from '../storage/repositories/event-log.js';
import type { EventBus, StreamBus } from './bus.js';

export interface SseDeps {
  eventLog: EventLogRepository;
  eventBus: EventBus;
  streamBus: StreamBus;
  protocolVersion: string;
  heartbeatMs?: number;
}

function writeDurable(raw: ServerResponse, event: WeltariEvent): void {
  raw.write(
    `event: event\nid: ${String(event.id)}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

function writeSentence(raw: ServerResponse, frame: StreamSentence): void {
  raw.write(`event: stream\ndata: ${JSON.stringify(frame)}\n\n`);
}

/**
 * Attach an SSE client to a hijacked response. Exactly-once replay contract:
 * cursor starts at the client's Last-Event-ID; the live subscription and the
 * synchronous replay loop share it, and the event-log read below is fully
 * synchronous, so no event can slip between "replay finished" and "live began".
 */
export function attachSseClient(
  raw: ServerResponse,
  lastEventId: number,
  deps: SseDeps,
): void {
  raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  raw.write(
    `event: hello\ndata: ${JSON.stringify({
      protocol_version: deps.protocolVersion,
      last_event_id: deps.eventLog.lastId(),
    })}\n\n`,
  );

  let cursor = lastEventId;
  const unsubscribeEvents = deps.eventBus.subscribe((event) => {
    if (event.id > cursor) {
      writeDurable(raw, event);
      cursor = event.id;
    }
  });
  const unsubscribeStream = deps.streamBus.subscribe((frame) => {
    writeSentence(raw, frame);
  });

  for (const event of deps.eventLog.readSince(lastEventId)) {
    writeDurable(raw, event);
    cursor = event.id;
  }

  const heartbeat = setInterval(() => {
    raw.write(': ping\n\n');
  }, deps.heartbeatMs ?? 15000);
  heartbeat.unref();

  raw.on('close', () => {
    clearInterval(heartbeat);
    unsubscribeEvents();
    unsubscribeStream();
  });
}
