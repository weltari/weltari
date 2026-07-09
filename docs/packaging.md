# packaging — Dockerfile, Windows zip, release flow (FINAL item 12)

Purpose: ship the one-process appliance two ways — a multi-arch Docker image
(primary) and a self-contained Windows zip — plus the update artifact the
self-update path ([update.md](update.md)) consumes.

## Exit-code contract (both packagings)

`0` = clean shutdown · `1` = crash (restart is safe — startup IS recovery) ·
`3` = **corrupt_state: do NOT blindly restart**; check the data directory
first. The Windows launcher implements this; Docker users should prefer
`restart: on-failure` and treat a stopped container with exit 3 as a
check-the-volume signal.

## File table

| File | What it does / talks to |
| --- | --- |
| `Dockerfile` | Two-stage build (node:24.14.1-bookworm-slim): full `npm ci` + `npm run build` + `npm prune --omit=dev`, then a runtime stage with only dists, migrations, plugins, and production node_modules (prebuilt natives arrive via npm's own install scripts per-arch). Binds 0.0.0.0 (the container boundary is the exposure decision), data on the `/data` volume, runs as `node`. `WELTARI_UPDATE_NOTIFY_ONLY=1`: the release check announces updates, apply always 409s — the host pulls a new image instead. |
| `.dockerignore` | The image builds from SOURCE: local dists, `*.tsbuildinfo` (would make `tsc -b` skip projects), node_modules, data, and env files never enter the context. |
| `.github/workflows/release.yml` | Tag push (`v*.*.*`) → buildx multi-arch (linux/amd64 + linux/arm64 via QEMU) → push to ghcr with semver tags. |
| `scripts/package-win.mjs` | The Windows bundle: copies the built repo shape into `versions/<version>/`, runs a real `npm ci --omit=dev` there (exact pins, win-x64 prebuilds), replaces workspace junctions with real copies (archives must not contain links), adds this machine's own `node.exe` (the pinned runtime), the `versions/current` pointer, and `weltari.cmd`. Emits the zip + the update artifact (`weltari-app-<v>-win32-x64.tar.gz`, ustar format — exactly what `boundary/update/tar.ts` reads) + its `.sha256`. The `.minisig` is added by the owner: `minisign -Sm <artifact>`. |
| `weltari.cmd` (in the zip) | The launcher: reads `versions/current`, sets the data/plugins/versions env, runs the pointed version, loops on crash (3 s delay, pointer re-read — a staged update takes effect here), **stops on exit 3** with the corrupt-state message. |

## Windows zip layout

```
weltari-win-x64/
  weltari.cmd            ← double-click to run
  node/node.exe          ← pinned Node 24 runtime
  versions/current       ← the update pointer ("0.1.0")
  versions/0.1.0/        ← the app (repo-shaped: apps/server/dist,
                            apps/web/dist, migrations, plugins, node_modules)
  data/                  ← created on first run (SQLite + images)
```

## Release checklist (owner)

1. Bump versions, tag `vX.Y.Z`, push — CI publishes the ghcr image.
2. On Windows: `npm run build && node scripts/package-win.mjs` →
   zip + update artifact + `.sha256`.
3. Sign: `minisign -Sm weltari-app-X.Y.Z-win32-x64.tar.gz` (secret key never
   enters the repo; the matching PUBLIC key ships baked as the committed
   `minisign.pub` — packaged into the zip/artifact/image automatically, so
   users need to set nothing; `WELTARI_UPDATE_PUBKEY` is the fork override.
   See docs/update.md "Public-key distribution").
4. Attach zip + artifact + `.sha256` + `.minisig` to the GitHub Release.

## Verified by (M3 part-2 criterion b + d, 2026-07-07)

- Windows: zip extracted to a clean directory → `weltari.cmd` boots; `GET /`
  serves the Scene page (200 text/html), wl-map loads with its provenance
  hash, SSE streams.
- Docker: `docker build` + `docker run` → same checks pass on a fresh `/data`
  volume; `apply-update` → 409 `updates_disabled` (notify-only proven).
- RSS: `PROOF_MAIN/PROOF_PLUGINS_DIR/PROOF_NODE` pointed
  `tools/m3-plugin-proof.mjs` at the extracted package → **idle RSS 113.7 MB**
  with wl-map + proof-dropin installed (< 170 MB) and the B10 tamper refusal
  intact on the packaged build.
