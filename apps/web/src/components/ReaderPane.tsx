// Reader mode (wireframe page 07): the prose-first pane — committed turns as
// flowing text with the live turn paced at the tail. A view over the SAME
// store and pacing state as VN mode; switching modes mid-turn loses nothing
// because nothing lives here. Display-only live text (B6): only
// turn.committed prose is authoritative.
import { useEffect, useRef } from 'react';
import { useSceneStore } from '../store.js';
import { TurnBlock } from './Transcript.js';
import type { Pacing } from '../usePacing.js';

export function ReaderPane(props: {
  pacing: Pacing;
  /** Turn being paced right now — rendered live at the tail, not as a commit. */
  pacingTurnId: string | null;
}): React.JSX.Element {
  const turns = useSceneStore((s) => s.turns);
  const sceneEnd = useSceneStore((s) => s.sceneEnd);
  const openTurnId = useSceneStore((s) => s.openTurnId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { displayed, hasMore, advance } = props.pacing;

  const visible = turns.filter((t) => t.turn_id !== props.pacingTurnId);
  const live = props.pacingTurnId !== null;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [visible.length, displayed.length]);

  return (
    <section
      className="wl-reader"
      aria-label="reader pane"
      onClick={advance}
      role="button"
    >
      <div className="wl-reader-inner">
        {visible.length === 0 && !live ? (
          <p className="wl-line-narrator">Nothing has happened yet.</p>
        ) : (
          visible.map((turn) => <TurnBlock key={turn.turn_id} turn={turn} />)
        )}
        {live ? (
          <div className="wl-turn wl-reader-live">
            {displayed.length === 0 && openTurnId !== null ? (
              <p className="wl-thinking">the world stirs</p>
            ) : (
              displayed.map((sentence, i) => (
                <p
                  key={`${sentence.call}-${String(sentence.index)}`}
                  className={
                    sentence.call === 'character'
                      ? 'wl-line-character wl-sentence'
                      : 'wl-line-narrator wl-sentence'
                  }
                >
                  {sentence.call === 'character' &&
                  displayed[i - 1]?.call !== 'character' ? (
                    <strong>{sentence.speaker}: </strong>
                  ) : null}
                  {sentence.text}
                </p>
              ))
            )}
            {hasMore ? <span className="wl-advance-hint">▼</span> : null}
          </div>
        ) : null}
        {sceneEnd !== null ? (
          <p className="wl-divider">{sceneEnd.divider_text}</p>
        ) : null}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}
