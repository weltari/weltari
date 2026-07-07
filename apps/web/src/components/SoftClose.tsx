// Soft close (UI Spec §1.7): a subtle divider, never a "scene over" screen.
// The button set derives from scene.ended's end_type: rest → Stay/Map,
// continuation → Stay/Jump/Map, travel → Map. Opening goes through the
// App-owned masked transition (§1.14) — the cover animates the wait.
import { useSceneStore } from '../store.js';

export function SoftClose(props: {
  /** True once a plugin defined <wl-map> (the map surface is pluggable). */
  mapReady: boolean;
  /** True while the §1.14 cover masks an in-flight scene open. */
  covering: boolean;
  onOpenScene: (title: string) => void;
  onOpenMap: () => void;
}): React.JSX.Element | null {
  const sceneEnd = useSceneStore((s) => s.sceneEnd);
  const sceneTitle = useSceneStore((s) => s.sceneTitle);

  if (sceneEnd === null) return null;

  const busy = props.covering;
  const open = props.onOpenScene;

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
