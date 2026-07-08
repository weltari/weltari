# painter — apps/server/src/painter (the only sharp site)

Purpose: kill-safe image compositing (FINAL item 10). M2 proved the crash-safety mechanics; M5 part 1 put a real generation backend behind the `ImageSource` seam. The stub stays the DEFAULT — tests, the kill harness and CI never touch a provider; `WELTARI_IMAGE_BACKEND=openrouter` (+ `OPENROUTER_API_KEY`) selects real generation (`WELTARI_IMAGE_MODEL`, default `google/gemini-3.1-flash-image` — the no-mask branch of Rev 4 §14: composite-back is the sole preservation guarantee). sharp is import-fenced here (A11; tests may read images).

## Contract

- Inputs: `painter` ledger jobs (`{image_id, region}` payload) enqueued by the paint-region command; base pixels on disk under `WELTARI_IMAGES_DIR`.
- Outputs: a NEW composited PNG per job (never overwrites the previous image) + a `painter.completed` event carrying `path` + `sha256` + `job_key` — the event, not the file, is the truth about which image is current (Brief §2.1).
- Image lease: `serial_group painter:<image_id>` — two painter jobs for one image never run concurrently, same region or not. Painter jobs CHAIN (each composites onto the latest completed composite for the image), so per-region granularity is not enough: week-7's first real-backend run had three ~10 s generations claim together, all read the same base, and the last writer dropped the other tiles (invisible on the ~5 ms stub). Region-level parallelism would need a different chaining design — out of V1 scope.
- Never: let a partial write become visible (temp-file + atomic rename, composite-on-success); duplicate a committed job (idempotency keys on the `painter.completed` EVENT — real backends are not byte-deterministic, so a killed real paint regenerates different-but-valid pixels on retry and the retry's event names the retry's file; the only retry cost is one duplicate API call, Rev 4 §14. The stub source remains byte-deterministic and the byte-identical-rerun tests run against it).

## Deviations recorded

- `painter/` is a new `apps/server/src` module directory beyond the Guide §0.6 list — mandated by M2 (sharp needs a fence home). Recorded here and in `CLAUDE.md`.
- ~~Region leases are exact-region granularity in V1~~ — replaced in M5 part 1 by the per-IMAGE lease above: real (slow) generations proved different-region jobs racing on the shared composite chain lose tiles. Rev 4 §14's "the target region is locked while a painter job is in flight" is satisfied a fortiori.

## File table

| File | What it does / talks to |
| --- | --- |
| `image-source.ts` | The M5 seam: `ImageSource.generateTile({jobKey, region, prompt}) → Buffer` (any encoded size — the compositor resizes). `createStubImageSource` = deterministic color from the job key at 256² (keeps the resize step real); real backends implement the same interface in `llm/` (the AI-SDK fence). Provider failures throw OperationalError → runner retry (C7). |
| `painter.ts` | The pipeline: extract crop → `source.generateTile` (default: stub) → blurred-edge feather mask joined as alpha → resize → composite at (x,y) → temp-file + atomic rename. Output filenames are CONTENT-ADDRESSED (the bytes' sha256 prefix, week-7 fix): duplicate executions racing on a lease-expiry reclaim write different files, so a committed event always names a file matching its hash — the loser's file is an unreferenced orphan, never a corruption. `ensureBaseImage` lazily creates the deterministic 512² checkerboard fixture base. Stub rerun writes byte-identical output (same bytes ⇒ same name ⇒ no-op). |
| `commands.ts` | paint-region command seam: writes the ledger row (durable intent before work) with the region-lease serial_group; duplicate `request_id` = silent no-op (I3). M5 adds `squareRegion` (fog square → pixel rect; painter-owned geometry) and `enqueueSquarePaint` — THE paint job for one fog square, key `painter:map:<world>:sq-<col>-<row>` so every caller (materialize handler, fixture-trio boot enqueue, retries) converges on one job. Called by the materialize handler right after `sublocation.materialized` commits (materialization = the map-presence job, Rev 4 §14) AND on its occupied no-op path — that heals a kill between event append and paint enqueue. The fixture trio enqueues at every boot (deduped forever), which also heals pre-M5 dev DBs. |
| `images.ts` | `createImageResolver` — read-only `GET /v1/images/*` serving (M3): traversal-contained to the images dir, image content types only; the tile source for the wl-map plugin. The event, never the file, stays the truth. |
| `../ledger/handlers/painter.ts` | The job handler: payload safeParse (garbage = corrupt_state, C2), idempotency via `painter.completed(job_key)` — checked at claim AND re-checked synchronously fused to the append (week-7 fix: a real generation can outlive its lease; the sweep reclaims the job and a second execution overlaps the first. Executions interleave only at `await` points in this single-process runtime, so the no-await check+append is race-free: exactly one event per job key, the overlap costs one duplicate API call and a warn). Base = latest completed composite for the image (else fixture base), fault point `mid_painter` between rename and event append — the nastiest kill window, healed by regeneration. `tilePromptFor` derives the generation prompt from the DB at paint time (the database, not the payload, is the source of truth): grid-aligned square with a materialized stub → name + description + adjacent squares' names (world coherence); anything else → a generic frontier prompt. |
| `../llm/image-source.ts` | `createOpenRouterImageSource` — the real backend (documented in [llm.md](llm.md); lives in `llm/` because `ai` + the provider are fenced there, A11). |

## Events consumed/emitted

Emits `painter.completed` (actor `system:painter`). Reads its own completed events for idempotency + current-image resolution.

## Tests

- Unit (`painter.test.ts`): base image created once; deterministic byte-identical rerun on the stub (the kill-retry shape, incl. Windows rename-over-existing); pixels change inside the region and nowhere outside; out-of-bounds region throws; safeName path hygiene; an injected source's pixels land in the region and it receives the prompt (the seam); a failing source leaves the base untouched and no output file (composite-on-success).
- Unit (`handlers/painter.test.ts`): exactly one event per job key across reruns, file hash matches the event's sha256 (zero corrupted images), chained composites use the previous output, garbage payload → corrupt_state; `tilePromptFor` carries the stub + adjacent neighbors, falls back to the frontier prompt for unaligned/empty squares, and sees freshly materialized squares immediately.
