// The History surface (wireframe 04): a modal over the Scene route listing
// every played scene — a pure store projection of replayed scene.started /
// scene.ended + character.joined + turn.committed. Continue opens a NEW scene
// with the same title/participants through the §1.14 cover: scene.ended is
// final, closed envelopes are never resurrected.
import { useState } from 'react';
import { useSceneStore, type HistoryScene } from '../store.js';
import { TurnBlock } from './Transcript.js';

function whenLabel(scene: HistoryScene): string {
  if (scene.world_time === null) return '';
  // Fictional time, engine-owned (read, never invented — UI Spec §1.11).
  const parsed = new Date(scene.world_time);
  return Number.isNaN(parsed.getTime())
    ? scene.world_time
    : parsed.toISOString().slice(0, 16).replace('T', ' ');
}

function HistoryRow(props: {
  scene: HistoryScene;
  covering: boolean;
  onContinue: (title: string, participants: string[]) => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const { scene } = props;
  const when = whenLabel(scene);
  const names = scene.participants.map((p) => p.name).join(', ');

  return (
    <li className="wl-history-row">
      <div className="wl-history-row-head">
        <button
          className="wl-history-row-main"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((open) => !open);
          }}
        >
          <span className="wl-history-title">{scene.title}</span>
          <span className="wl-history-meta">
            {when === '' ? '' : `${when} · `}
            {names === '' ? 'no cast recorded' : names}
            {scene.ended ? '' : ' · still open'}
          </span>
        </button>
        <button
          className="wl-button wl-button-accent wl-history-continue"
          disabled={props.covering}
          title="Open a new scene with the same title and cast"
          onClick={() => {
            props.onContinue(
              scene.title,
              scene.participants.map((p) => p.character_id),
            );
          }}
        >
          ▶ Continue
        </button>
      </div>
      {expanded ? (
        <div className="wl-history-transcript" aria-label="scene transcript">
          {scene.turns.length === 0 ? (
            <p className="wl-line-narrator">No committed turns.</p>
          ) : (
            scene.turns.map((turn) => (
              <TurnBlock key={turn.turn_id} turn={turn} />
            ))
          )}
          {scene.divider_text === null ? null : (
            <p className="wl-divider">{scene.divider_text}</p>
          )}
        </div>
      ) : null}
    </li>
  );
}

export function HistoryModal(props: {
  open: boolean;
  covering: boolean;
  onClose: () => void;
  onContinue: (title: string, participants: string[]) => void;
}): React.JSX.Element | null {
  const history = useSceneStore((s) => s.history);
  if (!props.open) return null;

  return (
    <div className="wl-modal-backdrop" onClick={props.onClose}>
      <div
        className="wl-modal wl-history-modal"
        role="dialog"
        aria-label="history"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <div className="wl-modal-head">
          <h2>History</h2>
          <button
            className="wl-control-button"
            aria-label="close history"
            onClick={props.onClose}
          >
            ✕
          </button>
        </div>
        {history.length === 0 ? (
          <p className="wl-line-narrator">No scenes have been played yet.</p>
        ) : (
          <ul className="wl-history-list">
            {[...history].reverse().map((scene) => (
              <HistoryRow
                key={scene.scene_id}
                scene={scene}
                covering={props.covering}
                onContinue={props.onContinue}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
