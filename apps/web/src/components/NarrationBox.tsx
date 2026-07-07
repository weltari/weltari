// The paced narration surface: displays revealed sentences of the live turn,
// advances on click / Auto-Advance, shows the thinking indicator while an
// envelope is open with nothing streamed yet. Display-only text — the
// committed transcript is the authority (B6).
import type { Pacing } from '../usePacing.js';
import { useSceneStore } from '../store.js';

function voiceOf(call: 'narrator' | 'character' | 'narration'): string {
  return call === 'character' ? 'character' : 'narrator';
}

export function NarrationBox(props: { pacing: Pacing }): React.JSX.Element {
  const openTurnId = useSceneStore((s) => s.openTurnId);
  const { displayed, hasMore, advance } = props.pacing;
  const last = displayed[displayed.length - 1];

  return (
    <div
      className="wl-narration"
      onClick={advance}
      role="button"
      aria-label="advance narration"
    >
      {last?.call === 'character' ? (
        <span className="wl-speaker-plate">{last.speaker}</span>
      ) : null}

      {displayed.length === 0 ? (
        openTurnId !== null ? (
          <p className="wl-thinking">the world stirs</p>
        ) : (
          <p className="wl-thinking">What do you do?</p>
        )
      ) : (
        displayed.map((sentence, i) => (
          <p
            key={`${sentence.call}-${String(sentence.index)}`}
            className="wl-sentence"
            data-voice={voiceOf(sentence.call)}
            style={i === displayed.length - 1 ? undefined : { opacity: 0.55 }}
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
  );
}
