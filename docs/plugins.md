# plugins — apps/server/src/boundary/plugins + the plugins/ folder

Purpose: the drop-in plugin story (FINAL item 13, Guide B10). A plugin is a
folder in `plugins/` — no build step, no toolchain: `plugin.json` manifest,
`theme.css` token overrides, `frontend/*.mjs` custom elements,
`backend/index.mjs` exporting `register(api)`. The manifest contract + the
canonical content-hash rule live in the MIT `@weltari/plugin-sdk`
([plugin-sdk.md](plugin-sdk.md)) — the server dogfoods the same contract
plugin authors build against.

## Contract

- Inputs: folders under `plugins/` (env `WELTARI_PLUGINS_DIR`); everything read from them is B-plugin boundary data.
- Outputs: `LoadedPlugin[]` (manifest + asset URLs + registered connectors); durable `plugin.rejected` events for refusals; `GET /v1/plugins` (wire shape in `@weltari/protocol`); `/plugins/<name>/<path>` asset serving.
- Never: load a plugin whose content hash mismatches its manifest (a single tampered byte refuses it — verified at EVERY load); serve assets for a refused plugin; crash the boot because a plugin failed (the app boots without it).
- Honest security line (B10, documented as such): plugins run **in-process** in V1 — validation limits accidents and data corruption, not a malicious plugin; the real protections are the manifest hash + provenance display (Config + dev mode).

## File table

| File | What it does / talks to |
| --- | --- |
| `loader.ts` | Scans the plugins dir; per folder: strict manifest validation (`validateAt('plugin', …)`) → folder/name match → engine-major check (`0.x` vs `PROTOCOL_VERSION`) → content-hash verification (`computePluginContentHash`, plugin-sdk) → optional `backend/index.mjs` import + `register(api)` (`api.registerConnector` duck-type-checks the connector). Any failure ⇒ `plugin.rejected` event + skip. |
| `assets.ts` | `createPluginAssetResolver` — zero-build asset serving for LOADED plugins only; resolved paths are contained to the plugin folder (traversal-guarded); content types by extension. |
| `../../http/server.ts` | `GET /v1/plugins` (PluginList) + `GET /plugins/:name/*` (assets). |
| `apps/web/src/plugins.ts` | Frontend half: fetches `/v1/plugins` once, injects theme stylesheets, imports component modules (self-defining `<wl-*>` elements); provenance rendered by the dev overlay. |

## Plugin folder anatomy

```
plugins/<name>/
  plugin.json         # name, semver, engine ("0.x"), capabilities, provenance {source_url, sha256}
  theme.css           # --wl-* token overrides (capabilities.themes)
  frontend/*.mjs      # zero-build custom elements (capabilities.components)
  backend/index.mjs   # optional: export function register(api) — connectors etc.
```

The provenance `sha256` is `computePluginContentHash(dir)`: sha256 over every
file EXCEPT plugin.json, sorted relative paths, `<path>\0<bytes>\0` each.
Authors re-run it after any edit (a one-liner:
`node -e "import('@weltari/plugin-sdk').then(m => console.log(m.computePluginContentHash('plugins/<name>')))"`).

## The default wl-map plugin (plugins/wl-map)

The map renderer is a plugin by decree (UI Spec §1.8) and dogfoods this
contract: `frontend/wl-map.mjs` defines `<wl-map>` with ZERO imports —
lint-proven (`eslint.config.mjs` bans every import specifier under
`plugins/wl-map/`, M3 criterion b). It consumes only documented surfaces:
its own `EventSource('/v1/events')` for `painter.completed` (tile source,
pixels via `GET /v1/images/<path>`), `sublocation.changed` `map_position`
pins (world coordinates — a repaint never moves a pin) and — 0.3.0 (M4
part 2) — `sublocation.materialized` fog reveals plus the public
`POST /v1/commands/explore` command. Canvas 2D tile + REAL fog layer
(8×8 = the documented MAP_FOG_GRID; explored = materialized; faint borders;
hover overlay; "Unexplored Area" + Explore on click; spinning loader over
the target square while the materialize job runs — Explore reveals and
background reveals share the one event render path; job.parked for a
materialize stops the spinner honestly), DOM overlay pins (fixture trio +
every materialized square, all clickable jumps); themed via the same
`--wl-*` tokens (`--wl-map-fog-*`, `--wl-map-pending-fill`,
`--wl-map-spinner-duration` — inline fallbacks keep the plugin standalone).
The core web app only hosts a modal slot (`MapModal`) that lights up when any
plugin defines `<wl-map>` — a community plugin can replace the map wholesale.
0.2.0 (M3 part 2): pins are clickable and dispatch a bubbling `wl-map-jump`
CustomEvent whose detail matches `MapJumpDetailSchema` (@weltari/protocol) —
the HOST validates it and answers with the §1.14 masked scene transition;
the plugin never opens scenes itself (0.8.0: the host passes the detail's
sublocation_id to open-scene, so jumps land AT the pin's sublocation).
0.4.0 (M5 part 2, Rev 4 §14 Flow A): the right-edge pen control (wireframe
08, `data-wl-map-pen`) toggles draw mode — freehand lasso on the canvas
(mousedown/-move/-up, ≤128 points), then a persistent intent box
(`data-wl-map-intent`, survives SSE repaints) POSTs the public
`/v1/commands/map-edit`. Locked regions render as a grey polygon veil +
dashed outline + centroid spinner (`data-wl-map-lock=<edit_id>`) from
`map_edit.requested` (optimistic on submit, honest like the Explore
spinner: a refusal unlocks) until the edit's `painter.completed`
(`job_key painter:map:<w>:edit-<id>`) or a `job.parked` carrying the
edit's job_key; `sublocation.created` drops the pin at the mask centroid.
0.5.0 (M5 part 2, Rev 4 §14 Flow B): clicks on explored ground run the
documented radius rule locally (footprint containment, else nearest pin
within half a fog square — the engine's `sublocationNear` mirror): a hit
dispatches the normal `wl-map-jump` with zero server calls; a miss POSTs
the public `/v1/commands/map-click` and shows a pulse ring
(`data-wl-map-click=<click_id>`) until `map_click.resolved` — `created`
drops the pin and auto-jumps (this client's clicks only), `transient`
shows a dismissable discovery card (`data-wl-map-discovery`); a
`job.parked` carrying the click's job_key clears the ring. A server
`enter` answer (the authoritative radius) also jumps directly.
0.6.0 (M7 part 4, Rev 4 §14/§17, protocol 0.19.0): the living-world
overlays — live chance-encounter markers render as red "!" discs above
their anchor pin (`data-wl-map-marker=<marker_id>`, folded from
`marker.dropped` minus `marker.instantiated`/`marker.expired` — replay
rebuilds the exact live set); a marker click POSTs the public
`/v1/commands/marker-click` and dispatches `wl-map-jump` WITH the 202's
`scene_id` (the host enters the already-open scene — first click wins,
second joins server-side); a 409 (expired) drops the pin honestly.
CRON-moved characters render as initial-in-disc position bubbles under
their current sublocation's pin (`data-wl-map-character=<character_id>`,
folded latest-wins from `character.location_changed`), fanned out when
several share an anchor. New tokens: `--wl-map-marker`,
`--wl-map-character` (inline fallbacks as ever).
The web client cache-busts plugin
asset URLs with the provenance hash (`?v=…`), so a plugin update is picked
up on the next reload despite header-less asset serving.
NOTE: any edit to plugin content requires re-running `computePluginContentHash`
and updating plugin.json's provenance sha256 (the loader refuses otherwise).

## Events consumed/emitted

Emits `plugin.rejected` (actor `system:plugins`) — reasons: `manifest_missing`,
`manifest_invalid`, `engine_mismatch`, `hash_mismatch`, `backend_failed`.

## Tests

- Invariants (I10): `tests/invariants/plugin-hash.test.ts` — valid plugin loads with provenance; tampered byte ⇒ refused + `plugin.rejected` + boots without it; invalid manifest / wrong engine / throwing backend refused with reasons; asset resolver containment (`../` and `..\\` escapes ⇒ null).
- Unit: `packages/plugin-sdk/src/manifest.test.ts` — manifest strictness, hash determinism, manifest-edit invariance, single-byte sensitivity.
