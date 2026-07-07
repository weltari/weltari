// Soft close (UI Spec §1.7): a subtle divider, never a "scene over" screen.
// The button set derives from scene.ended's end_type: rest → Stay/Map,
// continuation → Stay/Jump/Map, travel → Map.
import { useState } from 'react';
import { postOpenScene } from '../commands.js';
import { useSceneStore } from '../store.js';

export function SoftClose(props: {
  /** True once a plugin defined <wl-map> (the map surface is pluggable). */
  mapReady: boolean;
  onOpenMap: () => void;
}): React.JSX.Element | null {
  const sceneEnd = useSceneStore((s) => s.sceneEnd);
  const sceneTitle = useSceneStore((s) => s.sceneTitle);
  const [busy, setBusy] = useState(false);

  if (sceneEnd === null) return null;

  function open(title: string): void {
    setBusy(true);
    postOpenScene(title)
      .finally(() => {
        setBusy(false);
      })
      .catch(() => undefined); // CATCH-OK: a failed open leaves the buttons usable
  }

  return (
    <div className="wl-soft-close">
      <p className="wl-divider">{sceneEnd.divider_text}</p>
      <div className="wl-soft-close-buttons">
        {sceneEnd.end_type !== 'travel' ? (
          <button
            className="wl-button wl-button-accent"
            disabled={busy}
            onClick={() => {
              open(sceneTitle);
            }}
          >
            Stay longer
          </button>
        ) : null}
        {sceneEnd.end_type === 'continuation' ? (
          <button
            className="wl-button"
            disabled={busy}
            onClick={() => {
              open('The next scene');
            }}
          >
            Jump to the next scene
          </button>
        ) : null}
        <button
          className="wl-button"
          disabled={!props.mapReady}
          title={
            props.mapReady
              ? 'Open the world map'
              : 'No map plugin loaded (the map surface is pluggable).'
          }
          onClick={props.onOpenMap}
        >
          Open map
        </button>
      </div>
    </div>
  );
}
