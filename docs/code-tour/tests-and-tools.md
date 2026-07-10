# Code tour — tests, tools & scripts (the safety net)

Weltari treats its automated checks as the actual definition of "done" — not
a nice-to-have that runs after the fact. The single command `npm run gate`
chains five checks in order: **format check** (is every file laid out the way
the team's auto-formatter, Prettier, would lay it out — catches nothing about
correctness, only style), **lint** (a static reader called ESLint scans the
code for known-bad patterns — banned constructs, wrong imports across module
boundaries — and must report zero warnings, not just zero errors),
**typecheck** (the TypeScript compiler proves every value is used the way its
declared type promises, with no shortcuts), the **full test suite** (every
automated test in the repo actually runs and passes), and **knip** (a tool
that flags dead code — dependencies that are installed but never used,
exported functions nobody imports). Every one of those five must exit
cleanly before any task, feature, or fix is allowed to be called finished.
This tour covers the four folders that make up that safety net: `tests/`,
`tools/`, `scripts/`, and `fixtures/`.

## tests/

### tests/invariants/ — rules that must NEVER break

An "invariant" here is a promise about the system's behavior that is supposed
to hold no matter what — no matter how the server crashes, no matter what a
malicious plugin or player sends it, no matter how many times a job retries.
Each file in `tests/invariants/` is a small proof, in code, that one specific
promise is kept. These are the tests `npx vitest run --project invariants`
runs on their own, and CI treats a failure here as a merge-blocker, not a
suggestion.

- **`event-log-append-only.test.ts`** — the database's history table
  (`events`) physically refuses any attempt to edit or delete a row after
  it's written, even via a raw, no-safety-rails database connection. History
  can only ever grow, never be rewritten.
- **`gateway-inbound.test.ts`** — messages arriving from outside chat
  connectors (e.g. Telegram) are deduplicated by a real database constraint,
  not by in-memory bookkeeping, so a duplicate delivery — even one replayed
  after the server restarts — still triggers exactly one reply. Oversized
  text gets capped before it can reach the AI, and malformed or
  suspiciously-shaped messages are dropped with zero side effects.
- **`ledger-dead-letter.test.ts`** — a background job (a "ledger job" — a
  task like "write a reflection" or "check for game-world time passing"
  queued for later processing) that keeps failing past its retry limit gets
  permanently parked ("dead-lettered"), never silently retried forever, and
  that parking is recorded as a durable event.
- **`ledger-idempotency.test.ts`** — queuing the exact same job twice (say,
  because a crash caused a retry) is a safe no-op the second time, thanks to
  a unique key — the job never runs twice by accident.
- **`ledger-lease-expiry.test.ts`** — when a worker "leases" (checks out) a
  job to run it, and then that worker vanishes (e.g. because it was just
  killed), the lease expires and the job becomes claimable again — this is
  exactly what happens on every crash recovery.
- **`ledger-per-world.test.ts`** — certain job types (like the World Agent's
  end-of-scene notes) are serialized per game world, so two jobs for the same
  world can never run at once and race each other, while different worlds
  stay fully independent.
- **`llm-tool-gates.test.ts`** — nothing the AI outputs is trusted directly.
  Every "tool call" the AI makes (move to a new location, change a
  character's expression, end the scene) must pass through two checks in a
  row: first a strict shape check (is this even valid JSON in the expected
  format?), then a game-state check (does this action make sense right now —
  e.g. is that location real, is that scene actually open?). A call that
  fails either check writes **zero** database rows — it's logged only to an
  internal debug channel, never treated as something that happened in the
  game.
- **`materialize-gates.test.ts`** — the same two-gate discipline, applied to
  the AI job that invents brand-new locations ("materializing" a map square).
  A malformed invention or one that collides with an already-occupied map
  square writes zero rows; and even if the same job is retried three times
  after a simulated crash, a location is created exactly once, never twice.
- **`plugin-hash.test.ts`** — every drop-in plugin folder is checked against
  a cryptographic fingerprint (a SHA-256 hash) of its own files at load time.
  Change even one byte of a plugin after it was approved, and the whole
  plugin is refused — the app boots normally without it, and the refusal is
  written down as a permanent record.
- **`prompt-prefix/context-assembler.test.ts`** — the fixed opening portion of
  every prompt sent to the AI (the "stable prefix" — world lore, character
  profile, rules) is required to come out byte-for-byte identical every time,
  given the same inputs, and to be completely unmoved by anything
  session-specific (the player's latest message, in-game time, wiki text) —
  even when that dynamic text is deliberately hostile and tries to trick the
  AI into ignoring its instructions. This matters because providers charge
  less for repeated ("cached") prompt text, so keeping the prefix stable
  keeps the app affordable to run.
- **`repository-fence.test.ts`** — only one folder in the codebase
  (`apps/server/src/storage/`) is allowed to talk to the SQLite database
  directly. This test greps the entire server source tree for any file
  outside that folder importing the database driver or calling raw SQL, and
  fails if it finds one — a backstop in case the stricter automated linter
  ever gets weakened by mistake.
- **`secrets-redaction.test.ts`** — if an API key or other secret ever ends
  up in a value that gets logged, the logging system is required to print
  `[Redacted]` instead of the real value, on every code path, including
  secrets buried inside nested objects or HTTP headers.
- **`self-watch.test.ts`** — this one actually boots the real, compiled
  server and watches its live log output for a full minute. It proves the
  server reports its own health ("gauges" — periodic self-measurements of
  memory and latency) within 30 seconds of starting, and that a healthy,
  idle server stays quiet — it isn't allowed to spam more than a couple of
  informational log lines while nothing is happening.
- **`update-jobs.test.ts`** — the background jobs that check for and apply
  app updates: checking for a new release announces it exactly once, even if
  retried; applying an update downloads, verifies, and "stages" the new
  version, flipping the app over to it, exactly once — and a tampered
  checksum or an untrusted signature stops the whole process cold, with the
  currently-running version left untouched.
- **`update-path.test.ts`** — the lower-level building blocks behind updates:
  the digital-signature checker (a mostly from-scratch reimplementation of
  the "minisign" signing scheme), the archive extractor (which explicitly
  refuses any file path that tries to escape its target folder — a classic
  "zip slip" attack), and version-string comparison (which must safely
  reject garbage strings someone could feed it, like `"lol; rm -rf /"`,
  without executing anything).

### tests/helpers/ — shared test plumbing

Small pieces of reusable scaffolding that many tests lean on so each test
file doesn't reinvent them:

- **`temp-storage.ts`** — opens a brand-new, throwaway SQLite database in a
  temp folder for a test to use, so tests never share state or touch a real
  database.
- **`capture-logger.ts`** — builds a real logger whose output lines land in a
  plain array instead of the terminal, so a test can inspect exactly what was
  logged (used heavily by the secrets-redaction test).
- **`minisign.ts`** — a test-only implementation of the digital-signature
  *signer* half of minisign (the real server code only ever *verifies*
  signatures, never creates them) — used to manufacture fake "signed
  releases" for the update tests and the kill harness.
- **`tar.ts`** — a test-only `.tar.gz` archive *writer*, producing the exact
  archive format the real update-installer *reads* — again, only tests need
  to build these files; the shipped app only needs to unpack them.

### tests/fakes/ — stand-ins so tests never need a real AI or network

- **`clock.ts`** (`FakeClock`) — a fake wall clock whose time only moves when
  a test explicitly advances it. This lets tests prove things like "a lease
  expires after 60 seconds" instantly, with no real waiting and no
  flakiness from actual timing.

Notably, the fake AI itself — the "FakeLLM" — does **not** live under
`tests/`. It lives in the real app source at
`apps/server/src/llm/fake-client.ts`, deliberately, because the kill harness
(described below) has to start the *actual* built server binary and crash it
mid-operation — and that requires the fake AI to be a real, shippable part of
the app (switched on with the `WELTARI_FAKE_LLM=1` environment variable), not
a test-only mock. It responds to scripted commands typed as player input
(like `!end`, `!move <place>`, `!create <name> <parent>`) with fixed, free,
instant text — so both the automated tests and a human clicking around in a
browser can exercise the entire AI-tool pipeline without spending a cent or
depending on a live AI provider being reachable.

## tools/

### The kill harness — proving the app survives being killed at any moment

`tools/kill-harness.mjs` is the project's permanent crash-torture rig. In
plain terms: it starts the real, compiled server (using the fake AI so it's
free and fast), waits for the server to print that it has reached one of
about a dozen named "fault points" — very specific, deliberately risky
moments in its own code, like *midway through streaming an AI reply*, *just
before committing a database write*, *midway through generating a new
location*, *midway through applying a software update* — and then kills the
process outright with SIGKILL (the operating system's most brutal "stop
right now, no cleanup" signal, exactly like unplugging the power). It then
restarts the server against the same, now-battered database and runs the
offline consistency checker (below) against it.

Why this proves anything: if the server can be killed at literally its most
dangerous moment — half-written database row, half-downloaded update,
half-invented map location — and come back up with a database that is still
internally consistent (nothing duplicated, nothing half-written, nothing
lost that shouldn't be), that is strong evidence the app is "crash-safe": a
real power outage or an OS killing a hung process can never corrupt a
player's game. The harness runs one full cycle per named fault point, 25
cycles on every push/PR and 100 cycles overnight, and it also proves that a
web browser reconnecting mid-stream (via a mechanism called
"Last-Event-ID") receives exactly the events it missed — no duplicates, no
gaps.

`tools/verify-consistency.mjs` is the harness's offline judge: after each
kill, it opens the crashed database directly (something normally forbidden —
this is one of the few places in the whole repo allowed to do that, purely
for inspection) and runs a battery of checks: is the SQLite file itself
intact; do row IDs strictly increase with no gaps or repeats; is every stored
payload valid JSON; did every "turn" in the game get committed at most once,
and never committed without first being properly started; did every
multi-step database write (like ending a scene and fanning out follow-up
jobs) either happen completely or not at all, never half-way; did every job
that's supposed to run exactly once (reflections, world updates, painted
images, materialized locations) actually run exactly once even after
kill-triggered retries; does the game's internal clock only ever move
forward; do all painted images on disk actually match their recorded
fingerprint; and is the "which version is currently running" pointer file
always pointing at a fully-written version, never a version that was only
half-written when the kill happened. Any single violation is a hard failure.

### The other tools

- **`tools/m3-plugin-proof.mjs`** — builds a real drop-in plugin from scratch,
  boots the server with it installed, confirms the server reports it
  correctly with the right fingerprint, then flips one byte in it and proves
  the server refuses to load the tampered plugin and boots fine without it.
- **`tools/m2-rss-check.mjs`** — drives a realistic sequence of actions (open
  scene, take a turn, end scene, paint an image, skip forward 3 days) and
  measures the server's peak memory use, failing if it climbs too high.
- **`tools/cache-hit-check.mjs`** — the one tool that talks to a *real* AI
  provider (not the fake one) over the network, spending real (small)
  amounts of money, to confirm the app actually gets the prompt-caching
  discount it's designed for and responds quickly.
- **`tools/update-fixture.mjs`** — a manual helper a developer can run by
  hand to stand up a fake "new version is available" server locally, so the
  in-app update screen can be tested against something real without needing
  an actual new release.
- **`tools/m5-map-qa.mjs`** — a manual spot-check that sends one real image
  to a vision-capable AI model and confirms its answer about whether a
  described location is visible in that image passes the same strict
  validation the live server would apply.
- **`tools/check-tests-accompany.mjs`** — described under scripts below (it
  lives in `tools/` but acts as a CI gate, so see that section).

## scripts/

Each of these is a small, fast script that CI runs to refuse specific kinds
of bad changes from ever landing, independent of the main test suite:

- **`scripts/check-dep-ledger.mjs`** — refuses any dependency whose version
  isn't pinned to an exact number (no "roughly this version" ranges), and
  refuses any dependency that doesn't have a matching write-up entry in
  `docs/dependencies.md`.
- **`scripts/check-licenses.mjs`** — refuses a mismatch between what a
  package's license field says and what it's supposed to say (the core app
  is AGPL, some shared packages are meant to stay MIT), refuses the
  MIT-licensed packages from ever depending on the AGPL core, and refuses
  any installed dependency whose license isn't on an approved, AGPL-safe
  list.
- **`scripts/check-c6-handlers.mjs`** — refuses the codebase from having more
  than one handler for "uncaught exception" and "unhandled promise
  rejection" (the two catch-alls for otherwise-fatal errors), and refuses
  those handlers from living anywhere except the single designated startup
  file — so there's exactly one, predictable place deciding what happens
  when something goes catastrophically wrong.
- **`scripts/check-catch-audit.mjs`** — refuses any `catch` block in the
  server's source code that doesn't show clear evidence of what it's doing
  with the error nearby (re-throwing it, returning an error value, escalating
  it, logging it prominently, or an explicit "this is fine" marker) — this is
  a deliberately blunt check against silently swallowing errors.
- **`scripts/package-win.mjs`** — not a CI refusal check but the Windows
  packaging script: it bundles the built app, a pinned Node.js runtime, and
  native dependencies into one self-contained zip, and produces the signed
  update artifact used by the update system above. It's included here
  because it lives in `scripts/` alongside the check scripts.
- **`tools/check-tests-accompany.mjs`** — technically in `tools/`, but it's a
  CI gate like the others above: it refuses a pull request that adds a new
  source file under the server or shared packages without also adding or
  touching at least one test file in that same pull request — no
  "we'll write tests later."

## fixtures/

`fixtures/example-world/events.jsonl` is a hand-written, human-readable file
containing one line per historical event — a played scene, characters
joining, several turns of dialogue (including one that was deliberately cut
off mid-stream, to show what an interrupted turn looks like), the
AI-generated end-of-scene reflections, a skip forward in game time, a
painted background image, a plugin that was refused, and an app update —
covering nearly every kind of event the real game can produce.

`fixtures/load-example-world.mjs` loads that file into a real, fresh SQLite
database — but only through the same repository code path the live app uses,
and only after checking every single line against the project's official
wire-format rules first. That double discipline means this fixture data can
never quietly drift out of sync with what the real app actually writes.

The point of all this is purely for a human (the owner, or an agent) to be
able to open a real, populated database with a normal SQLite browser and
look at actual example rows while debugging or exploring — instead of
guessing what a table's columns mean from their names alone. The generated
database file itself is disposable and excluded from version control; it can
be regenerated at any time with the command below.

## How to run all of this

- **The full Definition of Done** (must pass before anything is "finished"):
  ```
  npm run gate
  ```
  This runs, in order: `format:check` → `lint` → `typecheck` → `npm test`
  (the whole automated test suite) → `knip`.

- **Just the invariant tests** (the "must never break" rules):
  ```
  npx vitest run --project invariants
  ```

- **A single test file** (fast, for iterating on one thing):
  ```
  npx vitest run path/to/file.test.ts
  ```

- **The kill harness** (crash-torture the real server):
  ```
  CYCLES=25 node tools/kill-harness.mjs
  ```
  (CI runs 25 cycles on every push/PR and 100 cycles overnight.)

- **Rebuild the example world fixture for manual inspection**:
  ```
  npm run build
  node fixtures/load-example-world.mjs
  ```
  then open `data/example-world.sqlite` with any SQLite viewer, e.g.
  `sqlite3 data/example-world.sqlite "SELECT id, type, actor_id FROM events"`.
