// The Scene route (M3 page, hosted by the M4 shell): VN stage + paced
// narration + committed transcript + interrupt-anywhere chatbox, all a
// projection of the SSE stream. Render-only by constitution (Brief §2.5).
import { useState } from 'react';
import { InputRow } from '../components/InputRow.js';
import { NarrationBox } from '../components/NarrationBox.js';
import { SceneCover, type CoverState } from '../components/SceneCover.js';
import { SceneStage } from '../components/SceneStage.js';
import { SoftClose } from '../components/SoftClose.js';
import { Transcript } from '../components/Transcript.js';
import { useSceneStore } from '../store.js';
import type { Pacing } from '../usePacing.js';

export function ScenePage(props: {
  /** Owned by the shell so the read cursor survives route changes. */
  pacing: Pacing;
  /** The §1.14 masking cover state (shell-owned — map jumps land here). */
  cover: CoverState | null;
  onOpenScene: (title: string) => void;
  mapReady: boolean;
  onOpenMap: () => void;
}): React.JSX.Element {
  const sceneTitle = useSceneStore((s) => s.sceneTitle);
  const turns = useSceneStore((s) => s.turns);
  const liveTurnId = useSceneStore((s) => s.liveTurnId);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const { pacing } = props;

  // The live turn graduates into the transcript once the reader caught up
  // AND the turn committed (interrupted turns graduate immediately — the
  // truncated commit IS what was read).
  const liveCommitted = turns.find((t) => t.turn_id === liveTurnId);
  const stillPacing =
    liveTurnId !== null &&
    (liveCommitted === undefined ||
      (!pacing.caughtUp && !liveCommitted.interrupted));
  const pacingTurnId = stillPacing ? liveTurnId : null;

  const lastDisplayed = pacing.displayed[pacing.displayed.length - 1];

  return (
    <main className="wl-main">
      <div className="wl-stage-column">
        <SceneStage
          speakingCall={
            stillPacing && lastDisplayed !== undefined
              ? lastDisplayed.call
              : null
          }
        >
          <span className="wl-scene-title-chip">{sceneTitle}</span>
          <SoftClose
            mapReady={props.mapReady}
            covering={props.cover !== null}
            onOpenScene={props.onOpenScene}
            onOpenMap={props.onOpenMap}
          />
          <NarrationBox pacing={pacing} />
          <SceneCover cover={props.cover} />
        </SceneStage>
        <InputRow pacing={pacing} />
      </div>

      <button
        className="wl-button wl-transcript-toggle"
        onClick={() => {
          setTranscriptOpen((open) => !open);
        }}
      >
        {transcriptOpen ? 'Scene' : 'Transcript'}
      </button>
      <Transcript pacingTurnId={pacingTurnId} open={transcriptOpen} />
    </main>
  );
}
