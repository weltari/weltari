// The Scene page (M3): VN stage + paced narration + committed transcript +
// interrupt-anywhere chatbox, all a projection of the SSE stream. Render-only
// by constitution (Brief §2.5): zero game logic, the store is writable only
// by the SSE reducer, commands go up and truth comes back down as events.
import { useCallback, useEffect, useRef, useState } from 'react';
import { MapJumpDetailSchema, type PluginInfo } from '@weltari/protocol';
import { postOpenScene, postStartTurn } from './commands.js';
import { DevOverlay } from './components/DevOverlay.js';
import { InputRow } from './components/InputRow.js';
import { MapModal } from './components/MapModal.js';
import { NarrationBox } from './components/NarrationBox.js';
import { SceneCover, type CoverState } from './components/SceneCover.js';
import { SceneStage } from './components/SceneStage.js';
import { SoftClose } from './components/SoftClose.js';
import { Transcript } from './components/Transcript.js';
import { loadPluginFrontends } from './plugins.js';
import { connectStream } from './stream.js';
import { useSceneStore } from './store.js';
import { usePacing } from './usePacing.js';

const DEV_MODE = new URLSearchParams(window.location.search).get('dev') === '1';

/** Duration tokens stay in theme.css (§1.14); JS reads them, never owns them. */
function readTokenMs(token: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(token)
    .trim();
  const match = /^([\d.]+)(ms|s)$/.exec(raw);
  if (match?.[1] === undefined) return fallback;
  const value = Number(match[1]);
  return match[2] === 's' ? value * 1000 : value;
}

export function App(): React.JSX.Element {
  const connected = useSceneStore((s) => s.connected);
  const protocolVersion = useSceneStore((s) => s.protocolVersion);
  const sceneTitle = useSceneStore((s) => s.sceneTitle);
  const worldTime = useSceneStore((s) => s.worldTime);
  const turns = useSceneStore((s) => s.turns);
  const liveTurnId = useSceneStore((s) => s.liveTurnId);
  const pacing = usePacing();
  const [transcriptOpen, setTranscriptOpen] = useState(false);
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
    (title: string, reason: CoverState['reason']): void => {
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
      postOpenScene(title)
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
  useEffect(() => {
    function onJump(event: Event): void {
      if (!(event instanceof CustomEvent)) return;
      const raw: unknown = event.detail;
      const detail = MapJumpDetailSchema.safeParse(raw);
      if (!detail.success) return;
      setMapOpen(false);
      openSceneCovered(detail.data.name, 'map-jump');
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
        {mapReady ? (
          <button
            className="wl-button"
            onClick={() => {
              setMapOpen(true);
            }}
          >
            Map
          </button>
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
            <SoftClose
              mapReady={mapReady}
              covering={cover !== null}
              onOpenScene={(title) => {
                openSceneCovered(title, 'scene-open');
              }}
              onOpenMap={() => {
                setMapOpen(true);
              }}
            />
            <NarrationBox pacing={pacing} />
            <SceneCover cover={cover} />
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
