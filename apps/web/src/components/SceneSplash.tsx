// The Scene landing splash (wireframe 03, "Adventure Awaits"): shown when no
// scene is active — a fresh world, or returning to the route after the last
// scene ended. Render-only: every affordance is a command; the store changes
// when events come back down. Opens go through the §1.14 masked transition.
import { useSceneStore } from '../store.js';
import { t } from '../i18n.js';
import { WORLD_NAME } from '../commands.js';

export function SceneSplash(props: {
  /** True while the §1.14 cover masks an in-flight scene open. */
  covering: boolean;
  onHistory: () => void;
  onOpenMap: () => void;
  /** Open a scene AT a sublocation through the cover (Hang around). */
  onHangAround: (title: string, sublocationId: string) => void;
}): React.JSX.Element {
  const knownSublocations = useSceneStore((s) => s.knownSublocations);
  const appVersion = useSceneStore((s) => s.appVersion);

  function hangAround(): void {
    // Hang around = a random KNOWN sublocation (materialized-only anchoring,
    // Rev 4 §14) — the cover masks the opening narration's generation window.
    const pick =
      knownSublocations[Math.floor(Math.random() * knownSublocations.length)];
    if (pick === undefined) return;
    props.onHangAround(pick.name, pick.sublocation_id);
  }

  return (
    <div className="wl-splash" aria-label="scene landing">
      <div className="wl-splash-shape wl-splash-cloud" aria-hidden="true" />
      <h1 className="wl-splash-title">{t('splash.title')}</h1>
      <div className="wl-splash-actions">
        <button
          className="wl-button"
          disabled={props.covering}
          onClick={props.onHistory}
        >
          <span aria-hidden="true">↺</span> {t('splash.history')}
        </button>
        {/* "Go Somewhere…", not "Open Map" (owner ruling 2026-07-11): the map
            is framed as a tool the player uses, never the entrance itself. */}
        <button
          className="wl-button"
          disabled={props.covering}
          onClick={props.onOpenMap}
        >
          <span aria-hidden="true">◎</span> {t('splash.goSomewhere')}
        </button>
        <button
          className="wl-button wl-button-accent"
          disabled={props.covering || knownSublocations.length === 0}
          title={
            knownSublocations.length === 0
              ? t('splash.hangAround.empty')
              : t('splash.hangAround.hint')
          }
          onClick={hangAround}
        >
          <span aria-hidden="true">➜</span> {t('splash.hangAround')}
        </button>
      </div>
      <div className="wl-splash-shape wl-splash-hills" aria-hidden="true" />
      <p className="wl-splash-footer">
        {WORLD_NAME} · Weltari{appVersion === null ? '' : ` v${appVersion}`}
      </p>
    </div>
  );
}
