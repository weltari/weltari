// The SSE reducer — the ONLY writer of the zustand store (render-only client,
// Brief §2.5). Every frame is boundary data: safeParse against
// @weltari/protocol before it may touch state; invalid frames are dropped.
// EventSource reconnects itself and resumes via Last-Event-ID; on a fresh
// connect the server replays the full log, which is how state is rebuilt.
import {
  DevEventSchema,
  StreamHelloSchema,
  StreamSentenceSchema,
  WeltariEventSchema,
} from '@weltari/protocol';
import { useSceneStore } from './store.js';

/** SSE payloads are boundary data: string in, unknown out, then safeParse. */
function parseJson(message: MessageEvent<unknown>): unknown {
  if (typeof message.data !== 'string') return null;
  try {
    return JSON.parse(message.data);
  } catch {
    // CATCH-OK: a malformed frame is dropped, never rendered.
    return null;
  }
}

export function connectStream(dev: boolean): () => void {
  const store = useSceneStore.getState();
  const source = new EventSource(dev ? '/v1/events?dev=1' : '/v1/events');

  source.addEventListener('open', () => {
    useSceneStore.getState().setConnected(true);
  });
  source.addEventListener('error', () => {
    useSceneStore.getState().setConnected(false); // EventSource retries itself
  });
  source.addEventListener('hello', (message: MessageEvent<unknown>) => {
    const hello = StreamHelloSchema.safeParse(parseJson(message));
    if (hello.success) {
      store.applyHello(
        hello.data.protocol_version,
        hello.data.app_version,
        hello.data.last_event_id,
      );
    }
  });
  source.addEventListener('event', (message: MessageEvent<unknown>) => {
    const event = WeltariEventSchema.safeParse(parseJson(message));
    if (event.success) store.applyEvent(event.data);
  });
  source.addEventListener('stream', (message: MessageEvent<unknown>) => {
    const frame = StreamSentenceSchema.safeParse(parseJson(message));
    if (frame.success) store.applyStream(frame.data);
  });
  source.addEventListener('dev', (message: MessageEvent<unknown>) => {
    const frame = DevEventSchema.safeParse(parseJson(message));
    if (frame.success) store.applyDev(frame.data);
  });

  return (): void => {
    source.close();
  };
}
