// Soft close (UI Spec §1.7): a subtle divider, never a "scene over" screen.
// The button set derives from scene.ended's end_type: rest → Stay/Map,
// continuation → Stay/Jump/Map, travel → Map. Opening goes through the
// App-owned masked transition (§1.14) — the cover animates the wait.
import type { OpenSceneOptions } from '../commands.js';
import { useSceneStore } from '../store.js';

export function SoftClose(props: {
  /** True once a plugin defined <wl-map> (the map surface is pluggable). */
  mapReady: boolean;
  /** True while the §1.14 cover masks an in-flight scene open. */
  covering: boolean;
  onOpenScene: (title: string, options?: OpenSceneOptions) => void;
  onOpenMap: () => void;
}): React.JSX.Element | null {
  const sceneEnd = useSceneStore((s) => s.sceneEnd);
  const sceneTitle = useSceneStore((s) => s.sceneTitle);
  const sublocationId = useSceneStore((s) => s.sublocationId);

  if (sceneEnd === null) return null;

  const busy = props.covering;
  const open = props.onOpenScene;
  const nextScene = sceneEnd.next_scene;

  return (
    <div className="wl-soft-close">
      <p className="wl-divider">{sceneEnd.divider_text}</p>
      <div className="wl-soft-close-buttons">
        {sceneEnd.end_type !== 'travel' ? (
          <button
            className="wl-button wl-button-accent"
            disabled={busy}
            onClick={() => {
              // Stay longer = the resume path (Rev 4 §6): the new scene
              // loads with the SAME sublocation, re-grounded.
              open(sceneTitle, sublocationId === '' ? {} : { sublocationId });
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
              // The registered continuation (M6 part 1): the follow-up scene
              // opens AT the next_scene sublocation — a stub created
              // mid-scene included (its backdrop is what makes this fluid).
              open(
                'The next scene',
                nextScene === undefined
                  ? {}
                  : { sublocationId: nextScene.sublocation_id },
              );
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
