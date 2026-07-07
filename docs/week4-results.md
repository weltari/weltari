# Milestone 3 part 2 — success-criteria results (2026-07-07)

Measured on the owner's Windows dev box. Criteria from FINAL §6 Milestone 3,
part-2 subset (Week 4 Kickoff). Acceptance commands quoted per row.

## Verdicts

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| a | download-verify-swap-on-restart survives **kill -9 mid-update** (idempotent startup swap, harness-proven) | **PASS** — `mid_update` joined the fault table: apply-update against a local minisign-signed release fixture, SIGKILL after verification before the pointer flip; the retried job converged every cycle (`mid_update convergence ok: 0.2.N staged + pointer flipped after restart`), zero torn flips (verifier: a `current` pointer must name a complete version dir) | `CYCLES=25 node tools/kill-harness.mjs` → "25 cycles over 8 fault points, zero duplicate or lost events, zero corrupted images, zero torn update flips, resume exact" |
| b | The **Docker image and the Windows archive both boot the full app** (frontend included) on a clean machine/dir | **PASS** — zip extracted to a clean directory boots via `weltari.cmd` (GET / = 200 text/html, wl-map served with provenance hash, SSE streams); `docker build` + `docker run` passes the same checks on a fresh `/data` volume, and `apply-update` → 409 `updates_disabled` (notify-only proven). Multi-arch (arm64) publishes via the tag-triggered ghcr workflow — amd64 verified locally | `node scripts/package-win.mjs` + clean-dir boot; `docker build -t weltari:dev . && docker run -p 17777:7777 weltari:dev` |
| c | Scene-open and map-jump **animations fully mask a simulated 5–10 s generation window** on desktop and mobile-emulated browser | **PASS** — against `WELTARI_FAKE_LLM_DELAY_MS=7000`: desktop scene-open cover animated at every sample and dismissed at 7.5 s exactly when the first sentence streamed; map-jump (pin click → `wl-map-jump` → masked transition) animated at samples 2.0–8.0 s, dismissed at 10.0 s, `allAnimated: true`; mobile-emulated (375×812) jump covered + streamed; zero console errors. The cover loops clock-spin hands + pulsing dots + drifting veil — never a static frame | browser-driven (preview harness) with the fake-LLM delay; all durations `--wl-cover-*` tokens |
| d | Idle RSS still **< 170 MB** with the plugins installed, on the **packaged build** | **PASS — 113.7 MB** peak idle with wl-map + proof-dropin loaded, measured against the extracted Windows package (its own node.exe + node_modules), B10 tamper refusal intact | `PROOF_MAIN/PROOF_PLUGINS_DIR/PROOF_NODE=<extracted pkg> node tools/m3-plugin-proof.mjs` → `M3-PROOF PASS` |

## Real-provider spot check (carried over from Week 3)

First run of the Narrator tool surface against a real model
(`anthropic/claude-sonnet-4.5`, `provider.order=anthropic` pinned, key
env-only). All three tools ran through the SDK toolset and both B6 gates,
committing durable events:

- `change_sublocation` → `sublocation.changed` `subloc:cellar` (valid id
  picked from the offered list, map_position attached);
- `switch_art` → `art.switched` `char:elias` → `smile`;
- `end_scene` → `scene.ended` `end_type: "rest"` with a model-authored
  divider ("— the lamp burns low, and night settles in —").

Cache observability live: warm calls reported `cached_tokens` ≈ 1679/1095/1093
of ~1200–2500 input (the pinned-provider prompt cache hitting). Total spend:
12 calls ≈ a few cents. One observation: the model sometimes narrates a
reaction in prose instead of calling `switch_art` — tool choice is model
discretion; an explicit pose cue in the user text triggered it reliably.

## What part 2 shipped

- **Fastify serves the built frontend** (FINAL item 2): containment-guarded
  static resolver + SPA fallback; `npm run build && node
  apps/server/dist/main.js` needs zero Vite process.
- **The self-update path** (FINAL item 12, Guide B12): update_check
  (startup + croner) → durable `update.available`; apply-update command →
  update_apply job → capped download → SHA-256 + minisign verification
  (node:crypto, zero new deps) → ustar extraction → compiler-confined
  `VerifiedArtifact` pointer flip; notify-only mode for Docker. Protocol
  0.4.0 → 0.6.0 (additive).
- **Packaging**: Dockerfile (two-stage, ghcr release workflow), Windows zip
  (`scripts/package-win.mjs`: pinned node.exe, real `npm ci --omit=dev`
  natives, `weltari.cmd` honoring the pointer + exit-3 contract), update
  artifact + `.sha256` emitted per release.
- **§1.14 masking**: `SceneCover` + `openSceneCovered` (scene opens now play
  opening narration), clickable wl-map pins (`wl-map-jump` → validated
  `MapJumpDetail`), plugin assets cache-busted by provenance hash,
  `WELTARI_FAKE_LLM_DELAY_MS` latency injection.

## Notes / carried forward

- **Owner action for real self-updates:** generate a minisign keypair
  (`minisign -G`), publish the public key as `WELTARI_UPDATE_PUBKEY` default
  docs, sign release artifacts (`minisign -Sm …`). Until then updates stay
  disabled by design (safe default).
- The ghcr release workflow is untested until the first `v*` tag is pushed
  (amd64 image verified locally; arm64 builds via QEMU in CI).
- `.env.example` is caught by the `.env.*` gitignore pattern, so it is NOT in
  the repo despite B15 intending it as the committed name list — worth a
  one-line `.gitignore` fix (`!.env.example`).
- A missing `OPENROUTER_API_KEY` no longer aborts boot (fresh installs run
  the FakeLLM with a loud warn) — the old pinning test asserted the opposite
  and was changed with a recorded why.
- Screenshot capture of the cover mid-animation timed out in the preview
  harness (infinite animations); the §1.14 evidence is the timed DOM samples
  above — rerun interactively any time with `WELTARI_FAKE_LLM_DELAY_MS=7000`.
