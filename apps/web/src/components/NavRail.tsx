// The Left Nav Rail (wireframes §0.1): logo, Scene ▶, Map, Feed, Chats, Wiki,
// Config stacked; the blinking clock and the profile avatar bottom-anchored.
// Destinations whose backend systems arrive with Milestone 5 (Chats/Feed/Wiki)
// render disabled with a "later" tooltip — the rail never links to a fake
// surface. Recorded deviation: the sketches assume desktop landscape; on
// mobile the rail becomes a bottom bar (docs/web.md).
import { useSceneStore } from '../store.js';
import { navigate, useRoute, type Route } from '../router.js';

function IconPlay(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="wl-rail-icon" aria-hidden="true">
      <path d="M6 4l10 6-10 6z" fill="currentColor" />
    </svg>
  );
}

function IconGlobe(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="wl-rail-icon" aria-hidden="true">
      <circle cx="10" cy="10" r="7.2" fill="none" strokeWidth="1.4" />
      <ellipse
        cx="10"
        cy="10"
        rx="3.2"
        ry="7.2"
        fill="none"
        strokeWidth="1.2"
      />
      <path
        d="M3 10h14M4.2 6.4h11.6M4.2 13.6h11.6"
        fill="none"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function IconCamera(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="wl-rail-icon" aria-hidden="true">
      <rect
        x="3"
        y="6"
        width="14"
        height="10"
        rx="2"
        fill="none"
        strokeWidth="1.4"
      />
      <path d="M7 6l1.4-2h3.2L13 6" fill="none" strokeWidth="1.4" />
      <circle cx="10" cy="11" r="3" fill="none" strokeWidth="1.4" />
    </svg>
  );
}

function IconChat(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="wl-rail-icon" aria-hidden="true">
      <path
        d="M3.5 4.5h13v9h-8l-3.5 3v-3h-1.5z"
        fill="none"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconBook(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="wl-rail-icon" aria-hidden="true">
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

function IconGear(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="wl-rail-icon" aria-hidden="true">
      <circle cx="10" cy="10" r="3" fill="none" strokeWidth="1.4" />
      <path
        d="M10 2.8v2.4M10 14.8v2.4M2.8 10h2.4M14.8 10h2.4M4.9 4.9l1.7 1.7M13.4 13.4l1.7 1.7M15.1 4.9l-1.7 1.7M6.6 13.4l-1.7 1.7"
        fill="none"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface Destination {
  route: Route | null;
  label: string;
  /** null = enabled; a string = disabled with this tooltip (wireframes §0.1). */
  disabledReason: string | null;
  icon: React.JSX.Element;
}

const DESTINATIONS: readonly Destination[] = [
  { route: '/', label: 'Scene', disabledReason: null, icon: <IconPlay /> },
  { route: '/map', label: 'Map', disabledReason: null, icon: <IconGlobe /> },
  {
    route: null,
    label: 'Feed',
    disabledReason: 'Feed arrives with Milestone 5 (social systems).',
    icon: <IconCamera />,
  },
  {
    route: null,
    label: 'Chats',
    disabledReason: 'Chats arrive with Milestone 5 (messaging system).',
    icon: <IconChat />,
  },
  {
    route: null,
    label: 'Wiki',
    disabledReason: 'Wiki arrives with Milestone 5 (wiki system).',
    icon: <IconBook />,
  },
  {
    route: '/config',
    label: 'Config',
    disabledReason: 'The Config page lands later in this milestone.',
    icon: <IconGear />,
  },
];

/** Fictional clock readout — read from world.time_advanced, never invented
 * (UI Spec §1.11). Null until the first skip event arrives on the stream. */
function clockLabel(worldTime: string | null): string {
  return worldTime === null ? '--:--' : worldTime.slice(11, 16);
}

export function NavRail(): React.JSX.Element {
  const route = useRoute();
  const connected = useSceneStore((s) => s.connected);
  const worldTime = useSceneStore((s) => s.worldTime);

  return (
    <nav className="wl-rail" aria-label="main navigation">
      <button
        className="wl-rail-logo"
        title="Weltari"
        onClick={() => {
          navigate('/');
        }}
      >
        W.
      </button>

      {DESTINATIONS.map((destination) => (
        <button
          key={destination.label}
          className="wl-rail-button"
          data-active={
            destination.route !== null && route === destination.route
          }
          disabled={destination.disabledReason !== null}
          title={destination.disabledReason ?? destination.label}
          aria-label={destination.label}
          onClick={() => {
            if (destination.route !== null) navigate(destination.route);
          }}
        >
          {destination.icon}
          <span className="wl-rail-label">{destination.label}</span>
        </button>
      ))}

      <div className="wl-rail-spacer" />

      <button
        className="wl-rail-clock"
        data-active={route === '/gameday'}
        disabled
        title="The Gameday clock lands later in this milestone."
        aria-label="advance in-game time"
      >
        {clockLabel(worldTime)}
      </button>
      <div
        className="wl-rail-avatar"
        data-connected={connected}
        title={connected ? 'you · connected' : 'you · reconnecting…'}
        aria-label="user profile"
      />
    </nav>
  );
}
