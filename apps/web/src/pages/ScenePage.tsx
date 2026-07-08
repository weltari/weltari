// The Scene route (M3 page, hosted by the M4 shell) in its three display
// modes (wireframes 05/06/07): VN, VN-with-log, Reader — plus the M4-part-2
// lifecycle chrome: the "Adventure Awaits" splash (wireframe 03) when no
// scene is active, and the History modal (wireframe 04). One store, three
// views — mode and log-panel state are pure view state, so switching
// mid-turn can never lose scene state. Render-only (Brief §2.5).
import { useState } from 'react';
import { HistoryModal } from '../components/HistoryModal.js';
import { InputRow } from '../components/InputRow.js';
import { NarrationBox } from '../components/NarrationBox.js';
import { ReaderPane } from '../components/ReaderPane.js';
import { SceneControls, type SceneMode } from '../components/SceneControls.js';
import { SceneCover, type CoverState } from '../components/SceneCover.js';
import { SceneSplash } from '../components/SceneSplash.js';
import { SceneStage } from '../components/SceneStage.js';
import { SoftClose } from '../components/SoftClose.js';
import { Transcript } from '../components/Transcript.js';
import type { OpenSceneOptions } from '../commands.js';
import { useSceneStore } from '../store.js';
import type { Pacing } from '../usePacing.js';

export function ScenePage(props: {
  /** Owned by the shell so the read cursor survives route changes. */
  pacing: Pacing;
  /** The §1.14 masking cover state (shell-owned — map jumps land here). */
  cover: CoverState | null;
  onOpenScene: (title: string, options?: OpenSceneOptions) => void;
  mapReady: boolean;
  onOpenMap: () => void;
  onOpenMapPage: () => void;
}): React.JSX.Element {
  const sceneId = useSceneStore((s) => s.sceneId);
  const sceneTitle = useSceneStore((s) => s.sceneTitle);
  const sceneEnd = useSceneStore((s) => s.sceneEnd);
  const turns = useSceneStore((s) => s.turns);
  const liveTurnId = useSceneStore((s) => s.liveTurnId);
  const [mode, setMode] = useState<SceneMode>('vn');
  const [logOpen, setLogOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const { pacing } = props;

  // Splash vs soft close (wireframe 03 vs UI Spec §1.7): a scene that ends
  // while the user watches keeps its soft close (scroll-back stays readable);
  // arriving at an already-ended scene — fresh mount, reload, restart, route
  // return — shows the splash. The store's sceneEndedLive distinguishes a
  // live end from a REPLAYED one (a restart replays scene.ended mid-mount);
  // the local state scopes "watched it happen" to this mount, so leaving the
  // route and coming back lands on the splash again.
  const sceneEndedLive = useSceneStore((s) => s.sceneEndedLive);
  const [endedLive, setEndedLive] = useState(false);
  const [previousEnd, setPreviousEnd] = useState(sceneEnd);
  if (sceneEnd !== previousEnd) {
    setPreviousEnd(sceneEnd);
    if (previousEnd === null && sceneEnd !== null) setEndedLive(sceneEndedLive);
    if (sceneEnd === null) setEndedLive(false);
  }
  const showSplash = sceneId === null || (sceneEnd !== null && !endedLive);

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

  if (showSplash) {
    return (
      <main className="wl-main">
        <div className="wl-stage-column">
          <div className="wl-splash-stage">
            <SceneSplash
              covering={props.cover !== null}
              onHistory={() => {
                setHistoryOpen(true);
              }}
              onOpenMap={props.onOpenMapPage}
              onHangAround={(title, sublocationId) => {
                props.onOpenScene(title, { sublocationId });
              }}
            />
            <SceneCover cover={props.cover} />
          </div>
        </div>
        <HistoryModal
          open={historyOpen}
          covering={props.cover !== null}
          onClose={() => {
            setHistoryOpen(false);
          }}
          onContinue={(title, participants) => {
            setHistoryOpen(false);
            props.onOpenScene(title, {
              ...(participants.length > 0 ? { participants } : {}),
            });
          }}
        />
      </main>
    );
  }

  return (
    <main className="wl-main">
      <div className="wl-stage-column">
        <SceneControls
          mode={mode}
          onToggleMode={() => {
            setMode((m) => (m === 'vn' ? 'reader' : 'vn'));
          }}
          logOpen={logOpen}
          onToggleLog={() => {
            setLogOpen((open) => !open);
          }}
          auto={pacing.auto}
          onToggleAuto={pacing.setAuto}
        />
        {mode === 'vn' ? (
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
        ) : (
          <div className="wl-reader-stage">
            <span className="wl-scene-title-chip">{sceneTitle}</span>
            <ReaderPane pacing={pacing} pacingTurnId={pacingTurnId} />
            <SoftClose
              mapReady={props.mapReady}
              covering={props.cover !== null}
              onOpenScene={props.onOpenScene}
              onOpenMap={props.onOpenMap}
            />
            <SceneCover cover={props.cover} />
          </div>
        )}
        <InputRow pacing={pacing} />
      </div>

      <Transcript pacingTurnId={pacingTurnId} open={logOpen} />
    </main>
  );
}
