// The committed transcript — the authoritative reading pane (B6: only
// turn.committed text lands here). Scroll-back stays readable across soft
// closes (UI Spec §1.7). On mobile it slides over the stage.
import { useEffect, useRef } from 'react';
import { useSceneStore, type CommittedTurn } from '../store.js';

/** One committed turn as prose — shared by the transcript and Reader mode. */
export function TurnBlock(props: { turn: CommittedTurn }): React.JSX.Element {
  return (
    <div className="wl-turn">
      {props.turn.steps.map((step, i) => (
        <p
          key={i}
          className={
            step.call === 'character' ? 'wl-line-character' : 'wl-line-narrator'
          }
        >
          {step.call === 'character' ? <strong>{step.speaker}: </strong> : null}
          {step.text}
        </p>
      ))}
      {props.turn.interrupted ? (
        <span className="wl-interrupted-mark">— interrupted —</span>
      ) : null}
    </div>
  );
}

export function Transcript(props: {
  /** Turn being paced right now — excluded until the reader catches up. */
  pacingTurnId: string | null;
  open: boolean;
}): React.JSX.Element {
  const turns = useSceneStore((s) => s.turns);
  const sceneEnd = useSceneStore((s) => s.sceneEnd);
  const bottomRef = useRef<HTMLDivElement>(null);

  const visible = turns.filter((t) => t.turn_id !== props.pacingTurnId);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [visible.length]);

  return (
    <aside
      className="wl-transcript"
      data-open={props.open}
      aria-label="transcript"
    >
      <h2>Transcript</h2>
      {visible.length === 0 ? (
        <p className="wl-line-narrator">Nothing has happened yet.</p>
      ) : (
        visible.map((turn) => <TurnBlock key={turn.turn_id} turn={turn} />)
      )}
      {sceneEnd !== null ? (
        <p className="wl-divider">{sceneEnd.divider_text}</p>
      ) : null}
      <div ref={bottomRef} />
    </aside>
  );
}
