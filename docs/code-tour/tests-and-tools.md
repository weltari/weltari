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
automated test in the repo actually runs and passes — by the V1 close-out
that's roughly 670 individual tests), and **knip** (a tool that flags dead
code — dependencies that are installed but never used, exported functions
nobody imports). Every one of those five must exit cleanly before any task,
feature, or fix is allowed to be called finished. This tour covers the four
folders that make up that safety net: `tests/`, `tools/`, `scripts/`, and
`fixtures/`.

## tests/

### tests/invariants/ — rules that must NEVER break

An "invariant" here is a promise about the system's behavior that is supposed
to hold no matter what — no matter how the server crashes, no matter what a
malicious plugin or player sends it, no matter how many times a job retries.
Each file in `tests/invariants/` is a small proof, in code, that one specific
promise is kept. These are the tests `npx vitest run --project invariants`
runs on their own, and CI treats a failure here as a merge-blocker, not a
suggestion. The collection grew steadily as features landed; here is the
full V1 set.

The foundations:

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
- **`gateway-binding.test.ts`** — the first time a messenger conversation
  ever reaches a world, the link is recorded and the GM's one-time welcome
  message fires — once per pairing, ever. Every later message from that
  conversation reuses the link; even a crash mid-welcome can't make the
  greeting fire twice.
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

The AI gates (nothing an AI says is trusted directly):

- **`llm-tool-gates.test.ts`** — every "tool call" the storytelling AI makes
  (move to a new location, change a character's expression, end the scene)
  must pass through two checks in a row: first a strict shape check (is this
  even valid JSON in the expected format?), then a game-state check (does
  this action make sense right now — e.g. is that location real, is that
  scene actually open?). A call that fails either check writes **zero**
  database rows — it's logged only to an internal debug channel, never
  treated as something that happened in the game.
- **`gm-tool-gates.test.ts`** — the same two-gate discipline for the game
  master AI's own toolset (proposing places, characters, objects, world
  seeds): a malformed or unknown authoring wish is rejected as plain data
  with zero rows written.
- **`materialize-gates.test.ts`** — the same discipline again, applied to
  the AI job that invents brand-new locations ("materializing" a map
  square). A malformed invention or one that collides with an
  already-occupied square writes zero rows; and even if the same job is
  retried three times after a simulated crash, a location is created exactly
  once, never twice.
- **`prompt-prefix/`** — a whole folder of byte-stability proofs. The fixed
  opening portion of every prompt sent to the AI (the "stable prefix" —
  world lore, character profile, rules) is required to come out
  byte-for-byte identical every time, given the same inputs — because AI
  providers charge much less for repeated ("cached") prompt text, this is
  what keeps the app affordable. `context-assembler.test.ts` proves it for
  the storytelling prompt, even against deliberately hostile player text;
  `gm-prefix.test.ts` proves it for the game master's prompt;
  `live-profile.test.ts` proves a character's memory only shifts the prefix
  *between* AI calls (when a reflection actually commits), never in the
  middle of one; and `story-goals.test.ts` proves the scene's ever-changing
  goal checklist lives only in the prompt's changing tail, never in the
  cached prefix.

The consent and social features:

- **`proposal-pipeline.test.ts`** — the GM's consent cards are real
  consent: rejecting a proposal leaves zero trace in the world (the "no" is
  the only record), approving applies the whole change in one atomic step,
  exactly once per card, and only a listed approver may answer.
- **`object-proposal.test.ts`** — the same promise for GM-authored objects:
  a rejected object never exists, an approved one is created exactly once
  with its approval recorded, and two objects with the same name can't be
  smuggled into the same place.
- **`gm-chat.test.ts`** — the GM rides the same chat plumbing as characters
  but is *not* a character: it accrues no memory, writes no reflections,
  and its replies commit together with any consent cards they fired —
  both or neither. Also walks the entire cold-boot path (setup interview →
  seed card → approval → a playable world) on the free fake AI.
- **`gm-followup.test.ts`** — after you answer a consent card, the GM says
  exactly one thing about your verdict — never zero (a crash is healed at
  next boot), never two (a deterministic message id makes doubles
  impossible), and the GM transcript shows chat lines and card outcomes in
  true log order.
- **`character-lock.test.ts`** — your lock on a character is checked live:
  flip it between two scenes and the very next attempted personality
  evolution is refused whole, while ordinary memories keep accruing;
  unlock and evolution resumes.
- **`profile-gdpr.test.ts`** — profiling off (the default) means zero
  profile writes anywhere, even for a stale job that was already queued;
  the GM's notes live in a genuinely deletable side store with only counts
  in the permanent log; and after a delete, nothing — not even replaying
  all of history — can resurrect the erased data.
- **`social-post-ceiling.test.ts`** — skipping the world clock forward
  many days produces at most 10 feed posts (the freshest ones), never an
  endless backlog to scroll through.

The living world:

- **`marker-lifecycle.test.ts`** — the map's story hooks obey their rules:
  always 1–5 live markers (the engine tops up below the floor, refuses
  drops above the ceiling with zero rows), never one born already expired,
  expiry is judged lazily against the world clock, the first click on a
  marker wins and opens the one scene while a racing second click joins it,
  and a scene ending re-tops-up the map in the same breath.
- **`world-movement.test.ts`** — characters wander the world on the
  background clock, but never while they're in an active scene, only to
  fully-created places, and exactly once per clock occurrence — a retried
  clock tick can't teleport someone twice.

The plumbing and the exits:

- **`plugin-hash.test.ts`** — every drop-in plugin folder is checked against
  a cryptographic fingerprint (a SHA-256 hash) of its own files at load
  time. Change even one byte of a plugin after it was approved, and the
  whole plugin is refused — the app boots normally without it, and the
  refusal is written down as a permanent record.
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
**26 named "fault points"** — very specific, deliberately risky moments in
its own code — and then kills the process outright with SIGKILL (the
operating system's most brutal "stop right now, no cleanup" signal, exactly
like unplugging the power). It then restarts the server against the same,
now-battered database and runs the offline consistency checker (below)
against it.

The 26 fault points grew with the features and now cover every dangerous
window in V1: midway through streaming an AI reply, just before committing a
database write, midway through generating a new location, midway through
applying a software update, mid-chat-reflection, mid proactive DM, mid
invitation expiry, mid feed post, mid memory commit and mid memory
compaction, inside a consent-card approval, inside the profiling job, mid
object clean-up, inside every phase of a map marker's life (sweep, click,
top-up), inside the GM's post-verdict follow-up, and — the final addition —
inside an agentic-scene "call the next character" step, proving a
half-finished turn is voided whole rather than half-saved.

Why this proves anything: if the server can be killed at literally its most
dangerous moment — half-written database row, half-downloaded update,
half-invented map location — and come back up with a database that is still
internally consistent (nothing duplicated, nothing half-written, nothing
lost that shouldn't be), that is strong evidence the app is "crash-safe": a
real power outage or an OS killing a hung process can never corrupt a
player's game. The harness cycles through the fault points round-robin, so
one full sweep of all 26 takes `CYCLES=26`; CI runs 25 cycles on every
push/PR and 100 cycles overnight (covering the full set several times). It
also proves that a web browser reconnecting mid-stream (via a mechanism
called "Last-Event-ID") receives exactly the events it missed — no
duplicates, no gaps.

`tools/verify-consistency.mjs` is the harness's offline judge: after each
kill, it opens the crashed database directly (something normally forbidden —
this is one of the few places in the whole repo allowed to do that, purely
for inspection) and runs a battery of checks organized into numbered blocks,
1 through 4r. The early blocks are the basics: is the SQLite file itself
intact; do row IDs strictly increase with no gaps or repeats; is every
stored payload valid JSON; did every "turn" get committed at most once and
never without being started; did every multi-step write (like ending a
scene and fanning out follow-up jobs) happen completely or not at all; did
every "exactly once" job (reflections, world updates, painted images,
materialized locations) actually run exactly once even after kill-triggered
retries; does the game clock only move forward; do painted images on disk
match their recorded fingerprints; and is the "which version is running"
pointer never left half-written. The later blocks, added one per feature,
apply the same discipline to everything V1 shipped: chat message and
reflection keys, proactive DMs, invitation expiry, group chats, the feed
(4k), the memory store and its search index (4l), consent proposals and the
GM's world-seeding (4m), objects (4n), map markers (4o), world movement —
now covering both the background clock and the storyteller moving people
(4p), the GM's one-per-verdict follow-up messages (4q), and finally the
agentic scene (4r): every goal snapshot belongs to a committed turn, scene
casts never tear (no double joins, no one leaving who wasn't there), and
every "continued" scene traces back to a real registration. Any single
violation, in any block, is a hard failure.

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
covering the classic early event kinds the real game produces.

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

- **The kill harness** (crash-torture the real server; 26 cycles = one full
  sweep of all 26 fault points):
  ```
  CYCLES=26 node tools/kill-harness.mjs
  ```
  (CI runs 25 cycles on every push/PR and 100 cycles overnight.)

- **Rebuild the example world fixture for manual inspection**:
  ```
  npm run build
  node fixtures/load-example-world.mjs
  ```
  then open `data/example-world.sqlite` with any SQLite viewer, e.g.
  `sqlite3 data/example-world.sqlite "SELECT id, type, actor_id FROM events"`.
