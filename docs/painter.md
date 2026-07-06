# painter — apps/server/src/painter (the only sharp site)

Purpose: kill-safe image compositing (FINAL item 10). M2 proves the crash-safety mechanics with a stub image source; real generation backends (FLUX Fill class, Brief §3) are a later milestone. sharp is import-fenced here (A11; tests may read images).

## Contract

- Inputs: `painter` ledger jobs (`{image_id, region}` payload) enqueued by the paint-region command; base pixels on disk under `WELTARI_IMAGES_DIR`.
- Outputs: a NEW composited PNG per job (never overwrites the previous image) + a `painter.completed` event carrying `path` + `sha256` + `job_key` — the event, not the file, is the truth about which image is current (Brief §2.1).
- Region lease: `serial_group painter:<image_id>:<x>-<y>-<w>-<h>` — two jobs for one region never run concurrently.
- Never: overwrite an existing output with different bytes (deterministic regeneration only); let a partial write become visible (temp-file + atomic rename, composite-on-success).

## Deviations recorded

- `painter/` is a new `apps/server/src` module directory beyond the Guide §0.6 list — mandated by M2 (sharp needs a fence home). Recorded here and in `CLAUDE.md`.
- Region leases are exact-region granularity in V1; overlapping-but-different regions do not serialize (fixture-scale accepted).

## File table

| File | What it does / talks to |
| --- | --- |
| `painter.ts` | The pipeline: extract crop → stub-generate tile (deterministic color from the job key, fixed 256² so the resize step is real) → blurred-edge feather mask joined as alpha → composite at (x,y) → temp-file + atomic rename. `ensureBaseImage` lazily creates the deterministic 512² checkerboard fixture base. Idempotent rerun writes byte-identical output. |
| `commands.ts` | paint-region command seam: writes the ledger row (durable intent before work) with the region-lease serial_group; duplicate `request_id` = silent no-op (I3). |
| `../ledger/handlers/painter.ts` | The job handler: payload safeParse (garbage = corrupt_state, C2), idempotency via `painter.completed(job_key)`, base = latest completed composite for the image (else fixture base), fault point `mid_painter` between rename and event append — the nastiest kill window, healed by deterministic regeneration. |

## Events consumed/emitted

Emits `painter.completed` (actor `system:painter`). Reads its own completed events for idempotency + current-image resolution.

## Tests

- Unit (`painter.test.ts`): base image created once; deterministic byte-identical rerun (the kill-retry shape, incl. Windows rename-over-existing); pixels change inside the region and nowhere outside; out-of-bounds region throws; safeName path hygiene.
- Unit (`handlers/painter.test.ts`): exactly one event per job key across reruns, file hash matches the event's sha256 (zero corrupted images), chained composites use the previous output, garbage payload → corrupt_state.
