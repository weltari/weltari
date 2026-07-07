// The Scene page (M3): VN stage + paced narration + committed transcript +
// interrupt-anywhere chatbox, all a projection of the SSE stream. Render-only
// by constitution (Brief §2.5): zero game logic, the store is writable only
// by the SSE reducer, commands go up and truth comes back down as events.
import { useEffect, useState } from 'react';
import { DevOverlay } from './components/DevOverlay.js';
import { InputRow } from './components/InputRow.js';
import { NarrationBox } from './components/NarrationBox.js';
import { SceneStage } from './components/SceneStage.js';
import { SoftClose } from './components/SoftClose.js';
import { Transcript } from './components/Transcript.js';
import { connectStream } from './stream.js';
import { useSceneStore } from './store.js';
import { usePacing } from './usePacing.js';

const DEV_MODE = new URLSearchParams(window.location.search).get('dev') === '1';

export function App(): React.JSX.Element {
  const connected = useSceneStore((s) => s.connected);
  const protocolVersion = useSceneStore((s) => s.protocolVersion);
  const sceneTitle = useSceneStore((s) => s.sceneTitle);
  const worldTime = useSceneStore((s) => s.worldTime);
  const turns = useSceneStore((s) => s.turns);
  const liveTurnId = useSceneStore((s) => s.liveTurnId);
  const pacing = usePacing();
  const [transcriptOpen, setTranscriptOpen] = useState(false);

  useEffect(() => connectStream(DEV_MODE), []);

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
    <div className="wl-app">
      <header className="wl-topbar">
        <span
          className="wl-conn-dot"
          data-connected={connected}
          title={connected ? 'connected' : 'reconnecting…'}
        />
        <h1>{sceneTitle}</h1>
        {worldTime !== null ? (
          <span className="wl-clock">
            {worldTime.replace('T', ' · ').slice(0, 18)}
          </span>
        ) : null}
        <span>{protocolVersion ?? '…'}</span>
      </header>

      <main className="wl-main">
        <div className="wl-stage-column">
          <SceneStage
            speakingCall={
              stillPacing && lastDisplayed !== undefined
                ? lastDisplayed.call
                : null
            }
          >
            <SoftClose />
            <NarrationBox pacing={pacing} />
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

      {DEV_MODE ? <DevOverlay /> : null}
    </div>
  );
}
