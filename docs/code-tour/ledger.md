# Code tour — ledger (crash-safe background work)

A **`ledger_job`** is one row in a database table that represents a piece of "background work" the app owes the world — generate a character's private reflection after a scene, paint a map tile, check for a software update, and so on. Jobs are written to the database **before** they run (not while they run, not after) so that if the whole program is killed mid-task — power cut, crash, forced shutdown — nothing is lost: on restart, the ledger simply looks for unfinished rows and continues, exactly as if the crash never interrupted anything. A **lease** is like a library checkout: one worker "borrows" a job for a limited time (60 seconds by default); if it doesn't finish and mark the job done before the checkout expires, the job automatically goes back on the shelf for someone (possibly the same worker, after a restart) to pick up again. **Idempotency** means "safe to do more than once" — every job checks first whether its result already exists in the permanent record, so an accidental repeat (from a retried lease) never produces two of the same thing.

## `runner.ts` and `scheduler.ts` — the engine room

- `apps/server/src/ledger/runner.ts` — the single place in the whole codebase allowed to decide what happens when a job fails. It runs a "tick": sweep for jobs whose lease expired, grab the next due job, hand it to the right handler function, and record the outcome.
  - `createRunner(options)` — builds the runner. Its returned `tick()` method does one poll cycle and reports whether it found a job to run; tests call `tick()` directly instead of waiting on a timer, so nothing has to sleep during testing.
  - Internally, `toAppError` — catches whatever a handler throws and makes sure it's wrapped in the app's standard error format (an untyped crash counts as "our code broke its own rules").
  - `settleFailure` — the sorting logic: an "operational" failure (something outside our control, like the AI provider being down) gets scheduled for a retry with a doubling wait time (1s, 2s, 4s... capped at 5 minutes) until it's tried too many times, at which point it's parked; a "bug" failure (our own code's mistake) is parked immediately, never retried, because retrying a deterministic bug just fails the same way forever; a "corrupt_state" failure (the saved data itself doesn't make sense) stops everything and hands off to a fatal-error routine rather than touching the row at all, because the in-memory picture of the world can no longer be trusted.

- `apps/server/src/ledger/scheduler.ts` — the wrapper around the `croner` library (which understands cron-style recurring schedules like "every day at midnight"). Its rule: it only ever writes a future job row to the ledger; it never does the scheduled work directly. That way, a crash between "the schedule fired" and "the work happened" loses nothing.
  - `createScheduler(storage, definitions, nowIso)` — builds a scheduler; calling its `tick()` makes sure the next occurrence of each recurring job exists as a ledger row, using a key that bakes in the exact timestamp of that occurrence so re-running `tick()` (or restarting the whole app) never creates a duplicate.
  - `addMinutesIso(iso, minutes)` — plain date-arithmetic helper (add minutes to a timestamp) used by the game's in-story clock.
  - `occurrencesBetween(pattern, fromIso, toIso, cap)` — lists every time a cron pattern would have fired between two timestamps; used when the story's fictional clock jumps forward in one go (a "time skip") so all the missed occurrences get queued at once. It refuses to produce more than 10,000 occurrences at a time, so a badly-written pattern can't flood the ledger.

## `handlers/` — the actual jobs

Each handler below follows the same shape: check the job's saved data is well-formed, check whether the result already exists (skip if so — that's the idempotency check), do the real work (often an AI call), check again right before saving (in case a duplicate "twin" of this same job snuck in while it was waiting on the AI — the "lease-overlap re-check" explained below), then save the result as one atomic write.

- `apps/server/src/ledger/handlers/reflection.ts` — the first real job type the ledger runs. After a scene ends, each character privately reflects on what happened (2–4 sentences, first person).
  - `sceneTranscript(storage, sceneId)` — pulls together the lines a character actually said during a scene, to feed to the reflection prompt.
  - `createReflectionHandler(options)` — builds the handler: it checks whether this character already has a committed reflection for this scene (skip if so), asks the AI to write one, and saves it as a `reflection.committed` event. It also writes a short "cache line" (a compressed pointer to "what just happened to me") in the very same save, so a crash can never separate a reflection from its cache entry.
  - Test coverage: `apps/server/src/ledger/handlers/reflection.test.ts`.

- `apps/server/src/ledger/handlers/world-agent.ts` — the "World Agent": one pass per world, per scene, that narrates how the wider world moves on after a scene (weather, schedules, background events). Only one of these can run per world at a time.
  - `participatingStubs(storage, sceneId)` — figures out which "sublocations" (places the Narrator created, like a new tavern) were actually part of this scene, either created in it or visited during it — places merely mentioned in passing don't count.
  - `createWorldAgentHandler(options)` — builds the handler: writes the World Agent's note, and also writes one short "wiki entry" (what a place looks like right now) for every qualifying place from `participatingStubs`. All of it — the wiki entries and the World Agent's own note — is saved together in one write, so it can never be half-done.
  - Test coverage: `apps/server/src/ledger/handlers/world-agent.test.ts`.

- `apps/server/src/ledger/handlers/reflect-chat.ts` — the chat version of `reflection.ts`: after a direct-message conversation with a character closes (the user leaves, goes idle, or starts a scene), the character privately reflects on that chat the same way. Unlike scene reflections, it never produces a "session summary" for anyone else to read — it's purely the character's own private note.
  - `rangeTranscript(...)` — gathers the messages from the closed part of the conversation, most recent 40 lines.
  - `createReflectChatHandler(options)` — builds the handler, same idempotency-check-then-save shape as `reflection.ts`.
  - Test coverage: `apps/server/src/ledger/handlers/reflect-chat.test.ts`.

- `apps/server/src/ledger/handlers/world-cron.ts` — handlers for recurring "world calendar" events (things that happen on a schedule inside the story, like a festival). Two flavors share one idea: the job is uniquely identified by "which recurring thing" plus "which scheduled moment," so a retry can never replay the same occurrence twice.
  - `alreadyCompleted(...)` — the shared idempotency check both flavors use.
  - `createWorldCronCodeHandler(options)` — the "code" flavor: pure bookkeeping, no AI call, finishes instantly.
  - `createWorldCronLlmHandler(options)` — the "llm" flavor: asks the AI to narrate the occurrence's outcome in 1–2 sentences.
  - Test coverage: `apps/server/src/ledger/handlers/world-cron.test.ts`.

- `apps/server/src/ledger/handlers/painter.ts` — generates and composites map/scene artwork. Documented in more depth in `docs/painter.md`; described here only at the ledger level.
  - `tilePromptFor(storage, worldId, imageId, region)` — builds the text prompt for one square tile of the world map, pulling the "what's actually there" flavor from the database (not from the job's saved payload) so the picture always matches current game state.
  - `backdropPromptFor(storage, worldId, imageId)` — same idea for a scene's background illustration (an empty stage with no people in it).
  - `createPainterHandler(options)` — builds the handler: figures out the current image, composites the new artwork onto it, and saves a `painter.completed` event recording the new file's location and a checksum. Idempotent per unique job key, so a retried lease can't paint the same spot twice.
  - Test coverage: `apps/server/src/ledger/handlers/painter.test.ts`.

- `apps/server/src/ledger/handlers/materialize.ts` — turns one "explored but empty" square of fog on the map into a real place. The AI is only trusted to invent a name and a short description; where the place actually sits on the map is decided by ordinary code, never by the AI.
  - `createMaterializeHandler(options)` — builds the handler. It handles two situations: (1) the user explored a specific empty square, so the AI invents what's there; (2) the Narrator already created a "stub" place during a scene and just needs it slotted onto the map (no AI call needed — the identity already exists). Either way, the invented name/description first has to pass a strict format check, then a check that the square is still genuinely empty, before anything is saved.
  - Test coverage: `apps/server/src/ledger/handlers/materialize.test.ts`.

- `apps/server/src/ledger/handlers/map-edit.ts` — lets a user draw a shape on the map and describe in words what they want there; the AI fills in a name and description for that request, but the actual geometry (the shape's boundary, center point) is computed by code from the user's drawing, never invented by the AI.
  - `createMapEditHandler(options)` — builds the handler: checks the drawn area still sits on already-explored ground, gets the AI's name/description, saves one `sublocation.created` event, then queues the matching paint job so the artwork catches up.
  - Test coverage: `apps/server/src/ledger/handlers/map-edit.test.ts`.

- `apps/server/src/ledger/handlers/map-click.ts` — handles a user clicking somewhere on the map that isn't already a known place. Two AI calls happen in sequence: first an image-understanding model looks at a cropped picture of that spot and classifies what's visibly there (forest, building, etc.); then a second AI call invents a place or moment that fits strictly within that classification (a forest click can't turn into a throne room) and decides whether it's a lasting place worth remembering or a one-off passing moment.
  - `classificationSchema` / `inventionSchema` — the strict formats each AI response must match before anything is trusted.
  - `createMapClickHandler(options)` — builds the handler, saves exactly one `map_click.resolved` event recording the outcome (a persistent place becomes a real sublocation; a transient moment never does).
  - Test coverage: `apps/server/src/ledger/handlers/map-click.test.ts`.

- `apps/server/src/ledger/handlers/update-check.ts` — periodically (on startup, and on a cron schedule) checks the software's release page for a newer version, and if one exists, announces it with one `update.available` event. It never downloads anything itself — that's a separate, more careful job below.
  - `createUpdateCheckHandler(options)` — builds the handler.

- `apps/server/src/ledger/handlers/update-apply.ts` — the job that actually downloads and installs a new version once approved: re-checks the release, downloads the update files, verifies they're authentic (checksum + a cryptographic signature), and flips a pointer to make the new version current. Only one of these can run at a time.
  - `createUpdateApplyHandler(options)` — builds the handler.

## `storage/repositories/ledger.ts` — the ledger's own database table

This file (outside the `ledger/` folder itself, but the ledger's sole gateway to the database) is the *only* place in the entire codebase allowed to write SQL against the `ledger_jobs` table.

- `JOB_STATES` — the five possible states a job row can be in (see the life-story below).
- `createLedgerRepository(db, nowIso)` — builds the repository object with these methods:
  - `enqueue(job)` — inserts a new job row; if a job with the same unique key already exists, this silently does nothing (returns `null`) instead of creating a duplicate.
  - `claimNext(workerId, leaseSeconds)` — picks the next due job (skipping any job whose "serial group" already has one running — see below), marks it running, records who claimed it and until when.
  - `markCommitted(id)` — marks a job permanently done.
  - `markRetry(id, runAt, error)` — marks a job as failed-but-retryable, scheduling when it becomes claimable again.
  - `markParked(id, error)` — marks a job as permanently abandoned (dead-letter).
  - `sweepExpiredLeases()` — finds jobs whose lease ran out while still "running" and puts them back to "pending" so someone can retry them.
  - `get(id)` / `countByKey(key)` / `listActive(worldId)` — lookups; `listActive` is what the app checks before letting a user open a scene, to make sure no relevant background work is still owed to that world.
  - Every row read back from the database is checked against a strict shape; if it doesn't match, that's treated as `CorruptStateError` rather than silently trusted.

- `apps/server/migrations/0002_jobs.sql` — the SQL that creates the `ledger_jobs` table itself: its columns (id, unique key, world, job type, payload, state, attempt count, lease expiry, worker id, serial group, last error, timestamps) and the indexes that make claiming jobs fast.

## The job state machine — a job's life story

A job is **born** as `pending` the moment `enqueue()` succeeds — it's now durable, sitting in the database, waiting.

A worker's `tick()` **claims** it: the state flips to `running`, the attempt counter goes up by one, and a lease (checkout timer) starts. This happens even before any real work runs, so a crash right after claiming still "spends" one attempt — that's what stops an endlessly crash-looping job from retrying forever.

From `running`, a job reaches one of three fates:
- **`committed`** — the handler finished successfully and its result was saved. Terminal; nothing more happens to this row.
- **`failed`** — the handler hit an "operational" problem (something external, like a flaky AI provider). If there are attempts left, it's rescheduled with a growing wait (backoff: 2, 4, 8... seconds, capped at 300) and becomes claimable again once that time passes — effectively it goes back to being like `pending`, but remembers its attempt count and last error.
- **`parked`** — the dead-letter shelf. A job lands here either because it ran out of attempts, or because the failure was a "bug" (our own code being wrong, which no amount of retrying will fix), or because the runner refused to even try (e.g. no handler was registered for its job type). Parked jobs are never auto-retried — a human has to look at them.

There's a fourth outcome that touches no row at all: a `corrupt_state` failure (the saved data itself is nonsensical) skips straight to the app's fatal-error handling, because if the in-memory picture of the world can't be trusted, the safest thing is to stop rather than guess.

Two extra rules round out the life story:
- **Lease expiry / the sweep**: if a `running` job's lease timer runs out before it finishes (say, the whole program was killed mid-task), the next sweep — which happens on every poll and again at startup — quietly puts it back to `pending`. This is what makes a `kill -9` mid-job safe: the job just gets tried again, burning one attempt.
- **Per-world serialization**: some job types (like the World Agent) carry a `serial_group` tag such as `world_agent:<world_id>`. The claim query refuses to start a second job in the same group while one is already `running`, so at most one World Agent pass ever runs per world at a time.

One subtlety worth calling out: because a lease can expire while an AI call is still slowly running, it's possible for the *same* job to end up executing twice in an overlapping window (the sweep reclaimed it as "dead" while the original run was still working). Every handler defends against this with a "fused" check-then-save: right before saving its result, it re-checks one more time whether the result already exists, with no pausing (`await`) between that check and the save — so the two overlapping runs can never both slip through. The loser of that race just quietly does nothing (a log warning, not an error): the app may waste one duplicate AI generation, but it never produces a duplicate permanent record.

## How this connects to the rest of the app

**Who enqueues jobs** — ordinary application code puts rows on the ledger by calling `storage.ledger.enqueue(...)`, never by doing the work directly:
- `apps/server/src/engine/scene-lifecycle.ts` enqueues a `reflection` job per character and one `world_agent` job when a scene ends.
- `apps/server/src/engine/chat.ts` enqueues `reflect_chat` jobs when a direct-message conversation closes.
- `apps/server/src/engine/explore.ts` and `apps/server/src/engine/world-clock.ts` enqueue `materialize` and `world_cron` jobs respectively.
- `apps/server/src/engine/map-edit.ts` and `apps/server/src/engine/map-click.ts` enqueue their matching jobs when a user draws on or clicks the map.
- `apps/server/src/painter/commands.ts` enqueues `painter` jobs whenever artwork needs (re)painting.
- `apps/server/src/ledger/scheduler.ts` (the croner wrapper) enqueues recurring jobs like `update_check` on their schedule; `apps/server/src/main.ts` also enqueues one `update_check` shortly after every boot and enqueues `update_apply` when a user approves installing an update.

**Who executes jobs** — `apps/server/src/main.ts` builds one `Runner` (via `createRunner` in `runner.ts`) with a lookup table mapping every job type name (`reflection`, `world_agent`, `reflect_chat`, `world_cron.code`, `world_cron.llm`, `materialize`, `map_edit`, `map_click`, `painter`, `update_check`, `update_apply`) to its handler function. A one-second timer calls `runner.tick()` over and over for as long as the app runs; each tick sweeps expired leases, claims at most one due job, and runs it. The handlers themselves reach into `engine/` (to read scene state), `llm/` (to make AI calls), and `painter/` (to generate images) — the ledger is the crash-safe scaffolding around that work, not the work itself.
