// The Gameday clock flow (wireframes 11–13): "— GAMEDAY N —", the circular
// dial with a sun/moon bead, digital time. Fictional time is READ from
// world.time_advanced, never invented (UI Spec §1.11) — before the first
// skip event the readouts show placeholders. Advancing POSTs advance-time;
// the dial's advancing animation masks the cron replay window (§1.14: the
// bead keeps moving until the skip's occurrences finish or the backstop
// fires — "catching up", never "frozen"). Skip control: presets capped at
// +48h, forward-only, greyed while a scene is active (§1.11).
import { useCallback, useEffect, useRef, useState } from 'react';
import { postAdvanceTime } from '../commands.js';
import { readTokenMs } from '../tokens.js';
import { useSceneStore } from '../store.js';

/** Days since the first-seen fictional day, 1-based ("GAMEDAY 7"). */
function gamedayNumber(
  worldTime: string | null,
  worldEpoch: string | null,
): number | null {
  if (worldTime === null || worldEpoch === null) return null;
  const dayUtc = (iso: string): number =>
    Date.UTC(
      Number(iso.slice(0, 4)),
      Number(iso.slice(5, 7)) - 1,
      Number(iso.slice(8, 10)),
    );
  return Math.round((dayUtc(worldTime) - dayUtc(worldEpoch)) / 86400000) + 1;
}

/** Bead angle: noon at the top (sun), midnight at the bottom (moon). */
function beadAngle(worldTime: string): number {
  const hours =
    Number(worldTime.slice(11, 13)) + Number(worldTime.slice(14, 16)) / 60;
  return (hours / 24) * 360 + 180;
}

/** Minutes to the next fictional 06:00 (the "To morning" preset). */
function minutesToMorning(worldTime: string): number {
  const now =
    Number(worldTime.slice(11, 13)) * 60 + Number(worldTime.slice(14, 16));
  const morning = 6 * 60;
  const delta = (morning - now + 24 * 60) % (24 * 60);
  return delta === 0 ? 24 * 60 : delta;
}

const PRESETS: readonly { label: string; minutes: number | 'morning' }[] = [
  { label: '+1 hour', minutes: 60 },
  { label: '+6 hours', minutes: 360 },
  { label: 'To morning', minutes: 'morning' },
];

export function GamedayPage(): React.JSX.Element {
  const connected = useSceneStore((s) => s.connected);
  const worldTime = useSceneStore((s) => s.worldTime);
  const timeAdvance = useSceneStore((s) => s.timeAdvance);
  const cronCompleted = useSceneStore((s) => s.cronCompleted);
  const worldEpoch = useSceneStore((s) => s.worldEpoch);
  const sceneId = useSceneStore((s) => s.sceneId);
  const sceneEnd = useSceneStore((s) => s.sceneEnd);

  const [advancing, setAdvancing] = useState(false);
  const timeAtClickRef = useRef<string | null>(null);
  const startedAtRef = useRef(0);
  const backstopRef = useRef<number | null>(null);

  // §1.11: the skip control greys out while any scene is active.
  const sceneActive = sceneId !== null && sceneEnd === null;
  const canAdvance = connected && !sceneActive && !advancing;

  const fire = useCallback(
    (minutes: number): void => {
      timeAtClickRef.current = worldTime;
      startedAtRef.current = Date.now();
      setAdvancing(true);
      // Backstop (§1.14 pattern): a parked replay job must never trap the
      // dial; remaining occurrences keep landing in the background
      // ("catching up").
      if (backstopRef.current !== null) {
        window.clearTimeout(backstopRef.current);
      }
      backstopRef.current = window.setTimeout(() => {
        setAdvancing(false);
      }, 30000);
      postAdvanceTime(minutes)
        .then((accepted) => {
          if (accepted === null) setAdvancing(false);
        })
        .catch(() => {
          setAdvancing(false); // CATCH-OK: a refused skip re-enables the presets
        });
    },
    [worldTime],
  );

  // The advancing animation holds until the skip's event arrived AND its
  // cron replay caught up, with a token-set minimum so short skips still read.
  useEffect(() => {
    if (!advancing) return;
    const arrived = worldTime !== null && worldTime !== timeAtClickRef.current;
    const caughtUp =
      timeAdvance === null || cronCompleted >= timeAdvance.enqueued;
    if (!arrived || !caughtUp) return;
    const minMs = readTokenMs('--wl-gameday-min-duration', 1400);
    const wait = Math.max(0, startedAtRef.current + minMs - Date.now());
    const timer = window.setTimeout(() => {
      setAdvancing(false);
      if (backstopRef.current !== null) {
        window.clearTimeout(backstopRef.current);
        backstopRef.current = null;
      }
    }, wait);
    return (): void => {
      window.clearTimeout(timer);
    };
  }, [advancing, worldTime, timeAdvance, cronCompleted]);

  const gameday = gamedayNumber(worldTime, worldEpoch);
  const replaying =
    advancing && timeAdvance !== null && timeAdvance.enqueued > 0;

  return (
    <main className="wl-gameday" aria-label="gameday clock">
      <h1 className="wl-gameday-title">
        — GAMEDAY {gameday === null ? '—' : String(gameday)} —
      </h1>

      <div className="wl-gameday-center">
        <div className="wl-gameday-time" data-advancing={advancing}>
          {worldTime === null ? '--:--' : worldTime.slice(11, 16)}
        </div>

        <div className="wl-gameday-dial" data-advancing={advancing}>
          <span className="wl-dial-glyph wl-dial-sun" aria-hidden="true">
            ☀
          </span>
          <span className="wl-dial-glyph wl-dial-moon" aria-hidden="true">
            ☾
          </span>
          <span className="wl-dial-glyph wl-dial-dawn" aria-hidden="true">
            ☼
          </span>
          <span className="wl-dial-glyph wl-dial-wind" aria-hidden="true">
            ≋
          </span>
          <div className="wl-dial-ring" />
          {worldTime !== null ? (
            <div
              className="wl-dial-bead-arm"
              style={{
                transform: `rotate(${String(beadAngle(worldTime))}deg)`,
              }}
            >
              <div className="wl-dial-bead" />
            </div>
          ) : null}
        </div>
      </div>

      <p className="wl-gameday-status">
        {replaying
          ? `the world catches up… (${String(cronCompleted)} of ${String(
              timeAdvance.enqueued,
            )} occurrences)`
          : sceneActive
            ? 'Time advances between scenes — end the current scene first.'
            : worldTime === null
              ? 'No skip recorded yet — the clock reads engine time only.'
              : 'Forward only, up to +48h per skip.'}
      </p>

      <div className="wl-gameday-presets">
        {PRESETS.map((preset) => {
          const morningLocked =
            preset.minutes === 'morning' && worldTime === null;
          return (
            <button
              key={preset.label}
              className="wl-button wl-button-accent"
              disabled={!canAdvance || morningLocked}
              title={
                sceneActive
                  ? 'Greyed while a scene is active (UI Spec §1.11)'
                  : morningLocked
                    ? 'Needs a known clock — advance once first'
                    : preset.label
              }
              onClick={() => {
                fire(
                  preset.minutes === 'morning'
                    ? worldTime === null
                      ? 0
                      : minutesToMorning(worldTime)
                    : preset.minutes,
                );
              }}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
    </main>
  );
}
