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

## Events consumed/emitted

Emits `plugin.rejected` (actor `system:plugins`) — reasons: `manifest_missing`,
`manifest_invalid`, `engine_mismatch`, `hash_mismatch`, `backend_failed`.

## Tests

- Invariants (I10): `tests/invariants/plugin-hash.test.ts` — valid plugin loads with provenance; tampered byte ⇒ refused + `plugin.rejected` + boots without it; invalid manifest / wrong engine / throwing backend refused with reasons; asset resolver containment (`../` and `..\\` escapes ⇒ null).
- Unit: `packages/plugin-sdk/src/manifest.test.ts` — manifest strictness, hash determinism, manifest-edit invariance, single-byte sensitivity.
