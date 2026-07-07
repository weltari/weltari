// The Map page (wireframe 08): <wl-map> promoted from the modal slot to a
// full route — the modal stays for in-scene use. The renderer itself remains
// a PLUGIN custom element (UI Spec §1.8: the map surface is pluggable), so
// this page only hosts the tag plus chrome. Zoom and search are visual
// placeholders until the map-part-2 milestone (fog/explore/lasso); pin jumps
// dispatch wl-map-jump, which the shell masks per §1.14.
import { createElement } from 'react';
import { WORLD_ID } from '../commands.js';

export function MapPage(props: { mapReady: boolean }): React.JSX.Element {
  return (
    <main className="wl-map-page" aria-label="world map page">
      {props.mapReady ? (
        createElement('wl-map', {
          'world-id': WORLD_ID,
          className: 'wl-map-page-element',
        })
      ) : (
        <p className="wl-map-empty">
          No map plugin loaded — the map surface is pluggable. Drop a plugin
          that defines &lt;wl-map&gt; into the plugins/ folder.
        </p>
      )}

      <div className="wl-map-page-controls">
        <button
          className="wl-control-button"
          disabled
          title="Zoom arrives with map part 2"
          aria-label="zoom in"
        >
          +
        </button>
        <button
          className="wl-control-button"
          disabled
          title="Zoom arrives with map part 2"
          aria-label="zoom out"
        >
          −
        </button>
      </div>

      <div className="wl-map-page-search">
        <input
          disabled
          placeholder="Search location… (arrives with map part 2)"
          aria-label="search location"
        />
      </div>
    </main>
  );
}
