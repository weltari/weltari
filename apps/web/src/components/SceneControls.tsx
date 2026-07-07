// The top-right control cluster (wireframes pages 05/06/07): VN ↔ Reader
// switch (book), transcript/log panel toggle, auto-advance, exit scene.
// Pure view state — the three displays are views over ONE store; switching
// can never lose scene state because no scene state lives here.
import { useState } from 'react';
import { postEndScene } from '../commands.js';
import { useSceneStore } from '../store.js';

export type SceneMode = 'vn' | 'reader';

function IconReader(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="wl-control-icon" aria-hidden="true">
      <path
        d="M10 4.5c-1.5-1-4-1.2-6-.6v11.4c2-.6 4.5-.4 6 .6 1.5-1 4-1.2 6-.6V3.9c-2-.6-4.5-.4-6 .6z"
        fill="none"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M10 4.5v11.4" fill="none" strokeWidth="1.2" />
    </svg>
  );
}

function IconLog(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="wl-control-icon" aria-hidden="true">
      <rect
        x="3"
        y="3.5"
        width="14"
        height="13"
        rx="1.5"
        fill="none"
        strokeWidth="1.4"
      />
      <path
        d="M11.5 3.5v13M13.5 7h1.8M13.5 10h1.8"
        fill="none"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function IconExit(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="wl-control-icon" aria-hidden="true">
      <path d="M8 3.5H4.5v13H8" fill="none" strokeWidth="1.4" />
      <path
        d="M8 10h8.5M13 6.5l3.5 3.5-3.5 3.5"
        fill="none"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SceneControls(props: {
  mode: SceneMode;
  onToggleMode: () => void;
  logOpen: boolean;
  onToggleLog: () => void;
  auto: boolean;
  onToggleAuto: (value: boolean) => void;
}): React.JSX.Element {
  const sceneId = useSceneStore((s) => s.sceneId);
  const sceneEnd = useSceneStore((s) => s.sceneEnd);
  const connected = useSceneStore((s) => s.connected);
  // Exit is a two-tap confirm (UI Spec §1.7: exit shows a confirm) — inline,
  // no browser dialog; the engine renders the close on the stream.
  const [confirmingExit, setConfirmingExit] = useState(false);
  const [exitBusy, setExitBusy] = useState(false);

  const canExit = connected && sceneId !== null && sceneEnd === null;

  function fireExit(): void {
    if (sceneId === null) return;
    setExitBusy(true);
    postEndScene(sceneId)
      .then(() => {
        // Truth arrives as scene.ended on the stream (render-only client).
        setConfirmingExit(false);
        setExitBusy(false);
      })
      .catch(() => {
        // CATCH-OK: a failed exit leaves the scene running and the button usable.
        setConfirmingExit(false);
        setExitBusy(false);
      });
  }

  return (
    <div className="wl-scene-controls" aria-label="scene display controls">
      <button
        className="wl-control-button"
        data-active={props.mode === 'reader'}
        title={props.mode === 'reader' ? 'Back to VN mode' : 'Reader mode'}
        aria-label="switch between VN and Reader mode"
        onClick={props.onToggleMode}
      >
        <IconReader />
      </button>
      <button
        className="wl-control-button"
        data-active={props.logOpen}
        title={
          props.logOpen
            ? 'Hide the transcript panel'
            : 'Show the transcript panel'
        }
        aria-label="toggle transcript panel"
        onClick={props.onToggleLog}
      >
        <IconLog />
      </button>
      <button
        className="wl-control-button"
        data-active={props.auto}
        title={props.auto ? 'Auto-advance is on' : 'Auto-advance narration'}
        aria-label="toggle auto-advance"
        onClick={() => {
          props.onToggleAuto(!props.auto);
        }}
      >
        <span className="wl-control-glyph">»</span>
      </button>
      {confirmingExit ? (
        <span className="wl-exit-confirm">
          <button
            className="wl-control-button wl-control-danger"
            disabled={exitBusy}
            title="End this scene"
            onClick={fireExit}
          >
            End scene?
          </button>
          <button
            className="wl-control-button"
            disabled={exitBusy}
            title="Keep playing"
            onClick={() => {
              setConfirmingExit(false);
            }}
          >
            Stay
          </button>
        </span>
      ) : (
        <button
          className="wl-control-button"
          disabled={!canExit}
          title={canExit ? 'Exit the scene' : 'No running scene to exit'}
          aria-label="exit scene"
          onClick={() => {
            setConfirmingExit(true);
          }}
        >
          <IconExit />
        </button>
      )}
    </div>
  );
}
