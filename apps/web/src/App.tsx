// The app shell (M4): Left Nav Rail + History-API routes over one SSE
// connection. Render-only by constitution (Brief §2.5): the store is writable
// only by the SSE reducer, commands go up and truth comes back down as
// events. The shell owns the §1.14 masked transition (openSceneCovered) and
// the wl-map-jump listener so map jumps work from ANY route — the cover is
// rendered by the Scene page, which a jump always navigates to first.
import { useCallback, useEffect, useRef, useState } from 'react';
import { MapJumpDetailSchema, type PluginInfo } from '@weltari/protocol';
import {
  postOpenScene,
  postStartTurn,
  type OpenSceneOptions,
} from './commands.js';
import { DevOverlay } from './components/DevOverlay.js';
import { MapModal } from './components/MapModal.js';
import { NavRail } from './components/NavRail.js';
import { type CoverState } from './components/SceneCover.js';
import { ChatPage } from './pages/ChatPage.js';
import { ConfigPage } from './pages/ConfigPage.js';
import { WikiPage } from './pages/WikiPage.js';
import { GamedayPage } from './pages/GamedayPage.js';
import { MapPage } from './pages/MapPage.js';
import { ScenePage } from './pages/ScenePage.js';
import { loadPluginFrontends } from './plugins.js';
import { navigate, useRoute } from './router.js';
import { connectStream } from './stream.js';
import { readTokenMs } from './tokens.js';
import { useSceneStore } from './store.js';
import { usePacing } from './usePacing.js';

const DEV_MODE = new URLSearchParams(window.location.search).get('dev') === '1';

export function App(): React.JSX.Element {
  const route = useRoute();
  const pacing = usePacing();
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);

  // ---- §1.14 masking cover: shown from the click until the destination's
  // opening narration streams; continuously animated, never a frozen screen.
  const [cover, setCover] = useState<CoverState | null>(null);
  const coverActiveRef = useRef(false);
  const coverTurnRef = useRef<string | null>(null);
  const coverShownAtRef = useRef(0);
  const coverTimersRef = useRef<number[]>([]);
  const liveTurnId = useSceneStore((s) => s.liveTurnId);
  const liveSentenceCount = useSceneStore((s) => s.liveSentences.length);

  const dismissCover = useCallback((): void => {
    const minMs = readTokenMs('--wl-cover-min-duration', 900);
    const fadeMs = readTokenMs('--wl-cover-fade-duration', 450);
    const wait = Math.max(0, coverShownAtRef.current + minMs - Date.now());
    for (const timer of coverTimersRef.current) window.clearTimeout(timer);
    coverTimersRef.current = [
      window.setTimeout(() => {
        setCover((c) => (c === null ? null : { ...c, leaving: true }));
        coverTimersRef.current.push(
          window.setTimeout(() => {
            setCover(null);
            coverActiveRef.current = false;
            coverTurnRef.current = null;
          }, fadeMs),
        );
      }, wait),
    ];
  }, []);

  const openSceneCovered = useCallback(
    (
      title: string,
      reason: CoverState['reason'],
      options?: OpenSceneOptions,
    ): void => {
      if (coverActiveRef.current) return;
      coverActiveRef.current = true;
      setCover({ reason, label: title, leaving: false });
      coverShownAtRef.current = Date.now();
      coverTurnRef.current = null;
      // Backstop: whatever happens on the wire, the cover never traps the user.
      for (const timer of coverTimersRef.current) window.clearTimeout(timer);
      coverTimersRef.current = [
        window.setTimeout(() => {
          dismissCover();
        }, 30000),
      ];
      // One active scene: a still-open scene is ended as part of the jump —
      // left open it would pin its characters `in_scene` (presence) forever.
      const current = useSceneStore.getState();
      const endSceneId =
        current.sceneId !== null && current.sceneEnd === null
          ? current.sceneId
          : undefined;
      postOpenScene(
        title,
        options,
        endSceneId === undefined ? {} : { endSceneId },
      )
        .then(async (sceneId) => {
          if (sceneId === null) return null;
          // The scene opens with narration (VN behavior): the generation this
          // cover masks is that first turn's 5–10 s window.
          return postStartTurn(sceneId, '');
        })
        .then((started) => {
          if (started === null) {
            dismissCover();
            return;
          }
          coverTurnRef.current = started.turnId;
        })
        .catch(() => {
          dismissCover(); // CATCH-OK: a failed open just uncovers the old scene
        });
    },
    [dismissCover],
  );

  // Drop the cover as soon as the masked turn's first sentence is displayed.
  useEffect(() => {
    if (cover === null || cover.leaving) return;
    if (
      coverTurnRef.current !== null &&
      liveTurnId === coverTurnRef.current &&
      liveSentenceCount > 0
    ) {
      dismissCover();
    }
  }, [cover, liveTurnId, liveSentenceCount, dismissCover]);

  // The map plugin's jump surface (wl-map-jump, validated like any boundary).
  // Jumps land on the Scene route from anywhere — modal or Map page alike.
  useEffect(() => {
    function onJump(event: Event): void {
      if (!(event instanceof CustomEvent)) return;
      const raw: unknown = event.detail;
      const detail = MapJumpDetailSchema.safeParse(raw);
      if (!detail.success) return;
      setMapOpen(false);
      navigate('/');
      // 0.8.0: the jump opens the scene AT the pin's sublocation.
      openSceneCovered(detail.data.name, 'map-jump', {
        sublocationId: detail.data.sublocation_id,
      });
    }
    window.addEventListener('wl-map-jump', onJump);
    return (): void => {
      window.removeEventListener('wl-map-jump', onJump);
    };
  }, [openSceneCovered]);

  useEffect(() => connectStream(DEV_MODE), []);
  useEffect(() => {
    loadPluginFrontends()
      .then(setPlugins)
      .catch(() => undefined); // CATCH-OK: the core UI stands without plugins
    let alive = true;
    customElements
      .whenDefined('wl-map')
      .then(() => {
        if (alive) setMapReady(true);
      })
      .catch(() => undefined); // CATCH-OK: no map plugin = button stays off
    return (): void => {
      alive = false;
    };
  }, []);

  return (
    <div className="wl-app">
      <NavRail />
      <div className="wl-page">
        {route === '/map' ? (
          <MapPage mapReady={mapReady} />
        ) : route === '/gameday' ? (
          <GamedayPage />
        ) : route === '/chats' ? (
          <ChatPage
            devMode={DEV_MODE}
            onSceneOpened={() => {
              // The startscene() handoff (Rev 4 §8): the scene events arrive
              // over the stream; the Scene route renders them as they land.
              navigate('/');
            }}
          />
        ) : route === '/wiki' ? (
          <WikiPage />
        ) : route === '/config' ? (
          <ConfigPage plugins={plugins} />
        ) : (
          <ScenePage
            pacing={pacing}
            cover={cover}
            onOpenScene={(title, options) => {
              openSceneCovered(title, 'scene-open', options);
            }}
            mapReady={mapReady}
            onOpenMap={() => {
              setMapOpen(true);
            }}
            onOpenMapPage={() => {
              navigate('/map');
            }}
          />
        )}
      </div>

      <MapModal
        open={mapOpen}
        onClose={() => {
          setMapOpen(false);
        }}
      />
      {DEV_MODE ? <DevOverlay plugins={plugins} /> : null}
    </div>
  );
}
