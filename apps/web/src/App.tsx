// Bare Week-1 client: renders the server-pushed stream, holds zero game logic
// (Brief §2.5). Everything arriving is safeParse-checked against
// @weltari/protocol — the frontend is just another untrusting client.
import { useEffect, useRef, useState } from 'react';
import {
  StreamHelloSchema,
  StreamSentenceSchema,
  WeltariEventSchema,
  type StreamSentence,
  type TurnStep,
} from '@weltari/protocol';

interface CommittedTurn {
  turn_id: string;
  steps: TurnStep[];
}

const styles = {
  page: {
    fontFamily: 'Georgia, serif',
    maxWidth: '46rem',
    margin: '2rem auto',
    padding: '0 1rem',
    lineHeight: 1.6,
  },
  meta: { color: '#888', fontSize: '0.8rem', fontFamily: 'monospace' },
  narrator: { fontStyle: 'italic', color: '#444' },
  character: { color: '#123' },
  live: { opacity: 0.65 },
  input: { width: '70%', padding: '0.4rem', fontSize: '1rem' },
  button: { padding: '0.4rem 1rem', fontSize: '1rem', marginLeft: '0.5rem' },
} as const;

function speakerStyle(call: string): React.CSSProperties {
  return call === 'character' ? styles.character : styles.narrator;
}

/** SSE payloads are boundary data: string in, unknown out, then safeParse. */
function parseJson(message: MessageEvent<unknown>): unknown {
  return typeof message.data === 'string' ? JSON.parse(message.data) : null;
}

export function App(): React.JSX.Element {
  const [protocolVersion, setProtocolVersion] = useState('…');
  const [connected, setConnected] = useState(false);
  const [turns, setTurns] = useState<CommittedTurn[]>([]);
  const [live, setLive] = useState<StreamSentence[]>([]);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const source = new EventSource('/v1/events');
    source.addEventListener('open', () => {
      setConnected(true);
    });
    source.addEventListener('error', () => {
      setConnected(false); // EventSource reconnects itself with Last-Event-ID
    });
    source.addEventListener('hello', (message: MessageEvent<unknown>) => {
      const hello = StreamHelloSchema.safeParse(parseJson(message));
      if (hello.success) setProtocolVersion(hello.data.protocol_version);
    });
    source.addEventListener('stream', (message: MessageEvent<unknown>) => {
      const frame = StreamSentenceSchema.safeParse(parseJson(message));
      if (frame.success) setLive((prev) => [...prev, frame.data]);
    });
    source.addEventListener('event', (message: MessageEvent<unknown>) => {
      const event = WeltariEventSchema.safeParse(parseJson(message));
      if (!event.success) return;
      if (event.data.type === 'turn.committed') {
        const { turn_id, steps } = event.data.payload;
        setTurns((prev) =>
          prev.some((t) => t.turn_id === turn_id)
            ? prev
            : [...prev, { turn_id, steps }],
        );
        // The committed event is the authoritative transcript (B6): drop the
        // display-only sentences it replaces.
        setLive((prev) => prev.filter((f) => f.turn_id !== turn_id));
        setPending(false);
      }
    });
    return (): void => {
      source.close();
    };
  }, []);

  async function submitTurn(): Promise<void> {
    const text = inputRef.current?.value.trim();
    setPending(true);
    const response = await fetch('/v1/commands/start-turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        world_id: 'w1',
        actor_id: 'user:owner',
        scene_id: 's1',
        ...(text === undefined || text === '' ? {} : { text }),
      }),
    });
    if (!response.ok) setPending(false);
    if (inputRef.current !== null) inputRef.current.value = '';
  }

  return (
    <main style={styles.page}>
      <p style={styles.meta}>
        weltari · protocol {protocolVersion} ·{' '}
        {connected ? 'connected' : 'reconnecting…'}
      </p>
      <h1>The Rainy Inn</h1>

      {turns.map((turn) => (
        <section key={turn.turn_id}>
          {turn.steps.map((step, i) => (
            <p key={i} style={speakerStyle(step.call)}>
              {step.call === 'character' ? (
                <strong>{step.speaker}: </strong>
              ) : null}
              {step.text}
            </p>
          ))}
          <hr />
        </section>
      ))}

      {live.length > 0 ? (
        <section style={styles.live}>
          {live.map((frame, i) => (
            <p key={i} style={speakerStyle(frame.call)}>
              {frame.call === 'character' ? (
                <strong>{frame.speaker}: </strong>
              ) : null}
              {frame.text}
            </p>
          ))}
        </section>
      ) : null}

      <p>
        <input
          ref={inputRef}
          style={styles.input}
          placeholder="What do you do?"
        />
        <button
          style={styles.button}
          disabled={pending || !connected}
          onClick={() => {
            void submitTurn().catch(() => {
              setPending(false);
            });
          }}
        >
          {pending ? 'Playing…' : 'Play turn'}
        </button>
      </p>
    </main>
  );
}
