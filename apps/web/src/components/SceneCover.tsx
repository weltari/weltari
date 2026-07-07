// The masking cover (UI Spec §1.14: animations cover generation). Shown the
// moment a scene-open or map-jump is initiated and held until the new scene's
// opening narration actually streams — the user watches a continuously
// animated clock/dots panel, never a frozen screen, for the whole 5–10 s
// generation window. All durations are --wl-* tokens (theme.css).
export interface CoverState {
  reason: 'scene-open' | 'map-jump';
  /** The destination title shown under the clock. */
  label: string;
  /** True during the fade-out (the content underneath is ready). */
  leaving: boolean;
}

export function SceneCover(props: {
  cover: CoverState | null;
}): React.JSX.Element | null {
  if (props.cover === null) return null;
  return (
    <div
      className="wl-scene-cover"
      data-reason={props.cover.reason}
      data-leaving={props.cover.leaving}
      role="status"
      aria-label={`traveling to ${props.cover.label}`}
    >
      <div className="wl-cover-clock" aria-hidden="true">
        <div className="wl-cover-clock-hand" />
        <div className="wl-cover-clock-hand wl-cover-clock-hand-minute" />
      </div>
      <p className="wl-cover-label">{props.cover.label}</p>
      <p className="wl-cover-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </p>
    </div>
  );
}
