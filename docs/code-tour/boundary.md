# Code tour — boundary (trust checks at the edges)

The boundary is the codebase's border control. Anywhere untrusted data
crosses into the app — a setting from an environment variable, a folder full
of someone else's plugin code, a downloaded update package, an odd payload
from a third-party service — the code in this folder is what checks it
before it's allowed any further in. The guiding idea is simple: nothing gets
to say "trust me." A setting has to match an exact template (a "schema") or
the app refuses to start; a plugin folder has to prove, every single time it
loads, that its contents haven't been altered by even one byte; and a
downloaded update has to pass two independent cryptographic checks before
the app will ever consider running it. If any of these checks fail, the app
doesn't crash — it either refuses to boot with a clear error, or it quietly
skips the untrustworthy thing (a rejected plugin, a refused update) and
keeps running everything else.

## validate.ts

`apps/server/src/boundary/validate.ts` is the single shared checkpoint that
every other file in this tour (and much of the rest of the app) routes
through. A "schema" here means a precise description of what a piece of data
is allowed to look like — which fields must exist, what type each one is,
nothing extra allowed. Checking data against a schema and getting back
either "yes, and here's the clean value" or "no" is called validation.

- `validateAt(boundary, schemaName, schema, raw, logger)` — runs `raw` (any
  untrusted value) through `schema`. On success it returns the cleaned,
  type-checked value. On failure it writes a log line recording *which*
  boundary and schema rejected the data and *why* (the list of problems) —
  but deliberately never logs the raw data itself, so a malformed payload
  can't leak secrets or spam the logs. The `boundary` argument has to be one
  of a fixed, named list (`llm`, `telegram`, `wechat`, `http`, `plugin`,
  `config`, `env`, `update`, `upload`) — so adding a brand-new kind of
  untrusted input without deciding which named boundary it belongs to is
  simply impossible; the code won't compile.

`apps/server/src/boundary/validate.test.ts` is the automated test proving
this: it checks a valid payload passes through cleanly, and that a rejected
payload's log output contains the boundary name, schema name, and problem
list — but never the secret content that was rejected.

## config/

### config/env.ts

`apps/server/src/boundary/config/env.ts` is the *only* file in the entire
codebase allowed to read environment variables (the small key/value settings
an operator sets before starting the app, like `PORT` or an API key — an
"env var"). Every other file that needs a setting has to get it from here,
which means there's exactly one place to check what settings exist and
exactly one place that can leak a secret value into a log by mistake — and
this file is careful not to.

- `readEnv(raw)` — validates the whole environment against a strict
  template covering every setting the app understands (network port,
  database path, log level, the Telegram bot's secret token, which AI model
  to use, plugin folder location, update-channel settings, and more). If
  anything is malformed it returns the list of offending setting *names*
  only — never their values, so a bad `OPENROUTER_API_KEY` never ends up
  printed anywhere. Notably, a missing (but optional) secret like the AI
  provider key is treated as a perfectly legal state — a freshly unpacked
  install has to be able to start up before it's been configured; it just
  runs on a stand-in "fake" AI backend until a real key is added.
- `readEnvOrExplain()` — the version actually called at startup: it prints a
  one-line, names-only error to the console (not a full logger, because the
  logger doesn't exist yet this early) and returns `null` on failure, or the
  validated settings on success.

### config/app-version.ts

`apps/server/src/boundary/config/app-version.ts` answers one question: what
version is this running copy of the app? That's the number the self-update
system compares incoming releases against.

- `readAppVersion(packageJsonPath, logger)` — reads and parses the app's own
  `package.json` file and pulls out its `version` field. If the file is
  missing, unreadable, or has no version field, it doesn't crash — it logs a
  warning and falls back to the sentinel version `0.0.0`, which simply means
  "everything looks newer than this," so updates still work, just without a
  meaningful before/after comparison.

### config/env.test.ts

`apps/server/src/boundary/config/env.test.ts` is the automated test for
`readEnv`: it checks that sensible defaults apply, that a bad `PORT` value
is reported by name only (never showing the bad value itself, even if that
value looked like it might contain something secret), that a fresh install
with no AI key still boots successfully onto the fake backend, and that an
invalid choice for the image-generation backend (e.g. `"dall-e"`, which
isn't one of the two allowed options) is rejected.

## plugins/

Plugins are the drop-in extension system (things like the map renderer):
each one is just a folder dropped into a `plugins/` directory — no build
step required. Because anyone (including the project owner) can drop a
folder in there, and because that folder's contents could be corrupted,
tampered with, or simply out of date compared to what it claims to be, every
plugin folder is checked from scratch *every time the app starts* — not just
once when it was first installed.

The central check is a **content hash**: a hash is like a fingerprint
calculated from a file's exact bytes — change even one character anywhere in
the plugin folder and the fingerprint comes out completely different. Each
plugin's manifest (`plugin.json`) declares the fingerprint the folder is
supposed to have; the loader recomputes the real fingerprint from the actual
files on disk and compares it. A mismatch means someone changed the plugin
folder's contents without updating its declared fingerprint — which the
loader has no way to distinguish from tampering — so it refuses to load that
plugin at all. It doesn't crash the whole app over it: the plugin is simply
skipped, and the refusal itself is written down permanently as a
`plugin.rejected` event, so there's a durable record of exactly what was
rejected and why. (The docs are candid that this hash check guards against
accidents and corruption, not a genuinely malicious plugin author — in this
version plugins run inside the same process as the rest of the app, so the
real protection against a bad actor is that the plugin's origin and
fingerprint are shown to the owner, not a sandbox.)

### plugins/loader.ts

`apps/server/src/boundary/plugins/loader.ts` is where a plugin folder is
read, checked, and either accepted or refused.

- `loadPlugins(options)` — walks every folder under the plugins directory
  and, for each one, runs it through a chain of checks in order: does
  `plugin.json` (the manifest — a small file describing the plugin's name,
  version, and capabilities) exist and parse as valid JSON? Does it pass
  strict schema validation? Does the manifest's declared name match the
  folder's actual name? Does the plugin target a compatible major version of
  the engine? And finally, does the recomputed content hash match the one
  the manifest claims? Any single failure rejects that plugin (recording
  *why*, using one of five fixed reasons: manifest missing, manifest
  invalid, engine mismatch, hash mismatch, or a failing backend) and moves
  on to the next folder — the app still boots normally without it. A plugin
  that passes every check may optionally supply backend code
  (`backend/index.mjs`) that gets imported and asked to register things like
  a new messaging connector; anything it hands back is itself checked to
  make sure it actually looks like a real connector before being accepted,
  because a plugin's return value is just more untrusted data to verify.
  Everything that made it through comes back as a `LoadedPlugin` — its
  manifest, its folder location, the public information the web app is
  allowed to see about it, and any connectors it registered.

### plugins/assets.ts

`apps/server/src/boundary/plugins/assets.ts` serves the actual files inside
a plugin folder (its stylesheet, its custom UI code) to the web browser,
without needing any build/bundling step.

- `createPluginAssetResolver(loaded)` — builds a lookup function that, given
  a plugin's name and a path someone is requesting inside it, finds the real
  file on disk — but only for plugins that already passed the loader's
  checks; a rejected plugin has no files served at all. It also guards
  against **path traversal** (a request trying to sneak outside the plugin's
  own folder using something like `../../secrets`) by confirming the
  resolved file path is still physically contained inside that plugin's
  directory before ever opening it.

## update/

The self-update system checks GitHub for new released versions, and — only
when the owner explicitly approves it — downloads, verifies, and switches
the app over to the new version. The core rule: a downloaded update file is
never trusted just because it came from the right URL. It has to pass *two*
independent checks: a **SHA-256** checksum (a cryptographic fingerprint of
the download's exact bytes, compared against the fingerprint GitHub
published alongside it) *and* a **minisign signature** (cryptographic proof
that the file was produced by the holder of the project's private signing
key — something a checksum alone can't prove, since anyone could publish a
matching checksum for a fake file). Only after both checks pass does the app
consider "flipping the pointer" to make the new version the one that runs
next time it restarts.

### update/version.ts

`apps/server/src/boundary/update/version.ts` handles version-number
comparisons for GitHub's release tags (like `v0.4.0`), which are untrusted
metadata and might not even be a real version string.

- `parseVersion(tag)` — reads a tag as major/minor/patch numbers; anything
  that doesn't fit that pattern returns `null` rather than crashing.
- `isNewerVersion(candidate, current)` — true only if `candidate` is a
  validly-formed version genuinely newer than `current`; a garbled tag is
  simply never treated as newer.
- `normalizeVersion(tag)` — returns the tag in a clean `major.minor.patch`
  form (stripping a leading `v`), or `null` if it isn't a real version.

### update/release.ts

`apps/server/src/boundary/update/release.ts` describes the shape of
GitHub's release information and the artifact-naming convention the update
system relies on. GitHub's release JSON is third-party data, so it's
validated loosely (unrecognized extra fields are simply dropped rather than
causing a rejection, since GitHub can add fields at any time) — but at this
stage it's still just *metadata*; nothing here is treated as safe to run.

- `artifactName(version, platform, arch)` — builds the expected filename for
  a given version, operating system, and CPU architecture, following a fixed
  naming pattern (e.g. `weltari-app-0.4.0-win32-x64.tar.gz`).
- `pickUpdateAssets(release, version, platform, arch)` — looks through a
  GitHub release's file list and finds the three files a valid update needs
  together: the actual package, its `.minisig` signature file, and its
  `.sha256` checksum file. If any of the three is missing, it returns
  `null` — an update can't proceed with only some of the proof.

### update/minisign.ts

`apps/server/src/boundary/update/minisign.ts` implements *checking* (never
creating) a minisign signature, using only Node's built-in cryptography
tools — no extra dependencies. This is the half of the two-check rule that
proves the file really came from the project's own signing key.

- `verifyMinisign(content, signatureText, publicKeyBase64)` — given the
  downloaded file's bytes, the accompanying signature file's text, and the
  project's public key, this walks through the minisign format step by step
  (decoding the key, decoding the signature, confirming the key IDs match,
  verifying the cryptographic signature itself, and verifying a second
  "global" signature that also covers a human-readable comment line so that
  even the comment can't be tampered with) and returns either `{ ok: true }`
  or `{ ok: false, reason: '...' }` explaining exactly what didn't check
  out. Every malformed input — a garbled key, a corrupted signature file —
  produces a clear reason rather than an unhandled crash.

### update/verifier.ts

`apps/server/src/boundary/update/verifier.ts` is where the SHA-256 and
minisign checks are actually combined into the one decision that matters:
is this downloaded file safe to install?

- `verifyArtifact(input)` — first recomputes the SHA-256 checksum of the
  downloaded bytes and compares it to the checksum GitHub published; if that
  doesn't match, it stops right there. Only if the checksum matches does it
  also run the minisign signature check from `minisign.ts`. Only if *both*
  pass does it return a `VerifiedArtifact` value representing "this file is
  now trusted."
- The `VerifiedArtifact` class itself is deliberately impossible to
  construct anywhere else in the codebase — its constructor is private, and
  the class is exported only as a *type* (a label for the compiler to check
  against), never as a usable value. That means the only way any other file
  can ever obtain a real `VerifiedArtifact` is by going through this
  verification function — the compiler itself blocks any shortcut that
  would skip the checks.

### update/tar.ts

`apps/server/src/boundary/update/tar.ts` unpacks the downloaded update
package (a `.tar.gz` — a compressed bundle of files and folders, the same
format used to package the update artifact) — but only *after* the file has
already passed both cryptographic checks above, so this file's job is
correctness, not the security boundary itself. It still refuses to write a
file to anywhere outside the intended destination folder — the same kind of
path-escaping trick (nicknamed "zip-slip") that `assets.ts` guards against
for plugins — and it refuses anything that isn't a plain file or folder
(symbolic links and similar tricks are rejected outright, since the
project's own packaging tool never produces them).

- `extractTarGz(archive, destDir)` — decompresses and unpacks the archive
  into `destDir`, checking every single entry's path stays contained inside
  that destination and validating each entry's internal checksum as it
  goes; any problem returns a clear rejection reason instead of partially
  unpacking a broken or hostile archive.

### update/stage.ts

`apps/server/src/boundary/update/stage.ts` is the conductor that runs the
whole update pipeline end-to-end and is the only code allowed to actually
switch the app over to a new version.

- `stageUpdate(deps, input)` — downloads the update package, its signature,
  and its checksum (each capped at a maximum size so an oversized or endless
  download can't exhaust disk space), runs them through `verifyArtifact`,
  unpacks the verified package with `extractTarGz`, and — only if every one
  of those steps succeeded — moves the new version into place and flips the
  "current version" pointer to it. If verification fails at any point, the
  partially-downloaded files are deleted and the currently running version
  is left completely untouched. All of this staging work happens inside a
  temporary `vNext` folder first, so a crash or forced shutdown midway
  through never leaves the real, running version in a half-updated state.
- `flipCurrentPointer(artifact, versionsDir)` — the one moment that actually
  makes a new version "the" version: it writes the version number to a
  temporary file and then renames it into place, a trick that means the
  switch either happens completely or not at all, never halfway (an
  interrupted rename simply leaves the old pointer as it was).
- `readCurrentPointer(versionsDir)` — reads which version is currently
  marked as "current."
- `cleanStaleStaging(versionsDir, logger)` — run at every startup: if a
  leftover `vNext` folder exists, it means a previous update attempt was
  interrupted before it finished; this simply deletes the leftovers so the
  next update attempt starts clean.

Together, `verifier.ts`'s locked-down `VerifiedArtifact` type and
`stage.ts`'s atomic rename-based pointer flip mean that even a forced kill
of the app at the worst possible moment can only ever leave the pointer
naming *one* of two fully-verified, fully-extracted versions — never
anything in between.

## How this connects to the rest of the app

Boundary code doesn't do interesting things with data itself — its entire
job is deciding what's allowed to cross into the trusted parts of the app in
the first place, and it hands that decision-making off through
`validate.ts`'s single shared checkpoint rather than each part of the app
inventing its own rules. `config/env.ts` gates every setting the rest of the
app relies on at startup. `plugins/loader.ts` and `plugins/assets.ts` gate
what the web app and the gateway (see `docs/code-tour/gateway.md`) are
allowed to load and serve from third-party plugin folders — a rejected
plugin is invisible everywhere downstream. And the `update/` files gate the
one path by which the running application code itself ever changes,
recording their decisions as durable events (`update.available`,
`update.staged`) the same way the plugin loader records `plugin.rejected` —
so every border-control decision the app makes leaves a permanent, readable
trail.
