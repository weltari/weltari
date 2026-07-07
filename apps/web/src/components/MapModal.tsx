// The map surface host. The renderer itself is a PLUGIN custom element
// (<wl-map>, UI Spec §1.8) — the core only provides this modal slot, so a
// community plugin can replace the map wholesale by defining the same tag.
import { createElement } from 'react';

export function MapModal(props: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  if (!props.open) return null;
  return (
    <div className="wl-map-modal" role="dialog" aria-label="world map">
      <div className="wl-map-modal-panel">
        <div className="wl-map-modal-bar">
          <span>World map</span>
          <button className="wl-button" onClick={props.onClose}>
            Close
          </button>
        </div>
        {createElement('wl-map', {
          'world-id': 'w1',
          className: 'wl-map-element',
        })}
      </div>
    </div>
  );
}
