# update — apps/server/src/boundary/update (B-update, Guide B12)

Purpose: the self-update path (FINAL item 12). Check GitHub Releases on a
croner schedule + at startup, announce newer versions as durable
`update.available` events, and — on the owner's apply command — download to
`versions/vNext`, verify **SHA-256 AND minisign signature**, extract, and flip
the `current` pointer atomically. The new version starts on the next restart
(the launcher reads the pointer). Zero resident updater; Docker images are
notify-only (the host pulls).

## Contract

- Inputs: GitHub release JSON + downloaded artifacts — ALL untrusted until the
  verifier passes (B12); the apply command names a version.
- Outputs: `update.available` / `update.staged` events; `versions/<version>/`
  directories; the `versions/current` pointer file.
- Never: trust release metadata; let the pointer flip without a
  `VerifiedArtifact` (the class value is not exported and its constructor is
  private — the compiler refuses any path that skips verification); touch the
  running version's files; keep a failed download (mismatch ⇒ delete, keep
  running version).

## Crash safety (Invariant I4, `mid_update` fault point)

All work happens under `versions/vNext`; the only visible writes are atomic
renames (version dir, then tmp+rename of `current`). A kill -9 at any moment
leaves the old pointer or the new one — both naming complete verified
directories. Startup deletes any stale `vNext` (`cleanStaleStaging`); the
killed job's lease expires and the retry redoes the whole pipeline
(idempotent). The kill harness SIGKILLs at `FAULT_POINT:mid_update` (after
verification, before the flip).

## File table

| File | What it does / talks to |
| --- | --- |
| `minisign.ts` | Minisign VERIFICATION on `node:crypto` (Ed25519 + BLAKE2b-512) — zero deps, never signs. Prehashed ('ED') and legacy pure ('Ed') modes; key-id match; global signature covers (sig ‖ trusted comment). Malformed anything ⇒ a `reason`, never a throw. |
| `tar.ts` | Minimal ustar reader for `.tar.gz` artifacts (files + dirs only, no links); runs only AFTER verification but still containment-checks every entry (zip-slip idiom, B13). The packaging script is the matching writer; tests use `tests/helpers/tar.ts`. |
| `version.ts` | Plain-semver parse/compare for untrusted release tags (`v`-prefix tolerated; garbage = "not newer"). |
| `release.ts` | Zod schemas for the GitHub release JSON (loose `z.object` — third-party payload, B5) + the artifact naming contract: `weltari-app-<version>-<platform>-<arch>.tar.gz` (+ `.minisig`, `.sha256`). |
| `verifier.ts` | `verifyArtifact`: SHA-256 compare + minisign verify ⇒ `Result<VerifiedArtifact>`. The `VerifiedArtifact` class is exported **as a type only**; construction is compiler-confined to this module. |
| `stage.ts` | `stageUpdate`: capped streaming downloads → verify → extract to `vNext/app` → `FAULT_POINT:mid_update` → rename to `versions/<version>` → `flipCurrentPointer(artifact: VerifiedArtifact)` (tmp+rename). Also `readCurrentPointer` + `cleanStaleStaging` (startup). |

The ledger handlers (`update_check`, `update_apply`) live in
`apps/server/src/ledger/handlers/` — see [ledger.md](ledger.md).

## Events consumed/emitted

Emits (via the handlers): `update.available` (actor `system:updater`; untrusted
notice, display only), `update.staged` (verified + pointer flipped — "restart
to apply"). Reads its own events for idempotency (a version is announced once,
staged once).

## Configuration

- `WELTARI_UPDATE_PUBKEY` — the minisign public key (base64 body line).
  **Absent = updates disabled entirely** (safe default until the owner
  generates a keypair: `minisign -G`).
- `WELTARI_UPDATE_RELEASES_URL` — default
  `https://api.github.com/repos/weltari/weltari/releases/latest`; the kill
  harness points it at a local fixture server.
- `WELTARI_VERSIONS_DIR` (default `versions`) · `WELTARI_APP_VERSION`
  (default: the server package.json version) · `WELTARI_UPDATE_CHECK_CRON`
  (default daily 08:00 UTC) · `WELTARI_UPDATE_MAX_BYTES` (download cap,
  default 128 MiB).

## Verified by

`tests/invariants/update-path.test.ts`: minisign roundtrip/tamper/rogue-key
fixtures, tar traversal refusal, wrong-hash + wrong-signature staging fixtures
(download deleted, pointer untouched — I10), idempotent re-staging, stale
vNext cleanup, and the `@ts-expect-error` proof that `VerifiedArtifact`
cannot be constructed or structurally faked outside the verifier.
