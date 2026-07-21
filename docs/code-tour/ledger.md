# Code tour — ledger (crash-safe background work)

*Accurate as of the V1 close-out (week 19, 2026-07-21).*

A **`ledger_job`** is one row in a database table that represents a piece of
"background work" the app owes the world — generate a character's private
reflection after a scene, paint a map tile, send a proactive message, check
for a software update, and so on. Jobs are written to the database **before**
they run (not while, not after) so that if the whole program is killed
mid-task — power cut, crash, forced shutdown — nothing is lost: on restart,
the ledger simply looks for unfinished rows and continues, as if the crash
never happened. A **lease** is like a library checkout: one worker "borrows"
a job for a limited time (60 seconds by default); if it doesn't finish and
mark the job done before the checkout expires, the job goes back on the
shelf for someone (possibly the same worker, after a restart) to pick up
again. **Idempotency** means "safe to do more than once" — every job checks
first whether its result already exists in the permanent record, so an
accidental repeat never produces two of the same thing.

One week-19 refinement applies across the board: every job that needs the
character roster now folds it **live, per job** (via a helper called
`characterProfilesOf`) instead of trusting a list handed in at startup. So a
character minted mid-session — say, invented by the Narrator during a scene —
immediately reflects, gets compacted, can be picked for proactive messages,
and appears on the social feed, without restarting the server.

## `runner.ts` and `scheduler.ts` — the engine room

- `apps/server/src/ledger/runner.ts` — the single place in the codebase
  allowed to decide what happens when a job fails. It runs a "tick": sweep
  for jobs whose lease expired, grab the next due job, hand it to the right
  handler, record the outcome.
  - `createRunner(options)` builds the runner; its `tick()` method does one
    poll cycle, so tests call it directly instead of waiting on a timer.
  - Internally, `toAppError` wraps whatever a handler throws into the app's
    standard error format (an untyped crash counts as "our code broke its
    own rules").
  - `settleFailure` is the sorting logic: an "operational" failure
    (something outside our control, like the AI provider being down) gets a
    retry with a doubling wait, until it's tried too many times and is
    parked; a "bug" failure (our own code's mistake) is parked immediately
    — retrying a deterministic bug just fails forever; a "corrupt_state"
    failure (the saved data itself doesn't make sense) stops everything and
    hands off to fatal-error handling, because the in-memory picture of the
    world can no longer be trusted.

- `apps/server/src/ledger/scheduler.ts` — the wrapper around the `croner`
  library (which understands recurring schedules like "every day at
  midnight"). Its rule: it only ever *writes a future job row*; it never
  does scheduled work directly, so a crash between "the schedule fired" and
  "the work happened" loses nothing.
  - `createScheduler(...)` builds it; `tick()` makes sure the next
    occurrence of each recurring job exists as a row, keyed by the exact
    timestamp of that occurrence so restarts never create duplicates.
  - `addMinutesIso` and `occurrencesBetween` are pure date helpers for the
    game's fictional clock — the latter lists every time a pattern would
    have fired between two timestamps (used when the story clock jumps
    forward in one go), capped so a bad pattern can't flood the ledger.
  - `intervalOccurrencesBetween` does the same for simple "every N game
    minutes" cadences croner can't express — it's what paces the proactive
    messages and the social feed on the *game* clock, so a paused world
    sends nothing.

## `handlers/` — the actual jobs

Each handler follows the same shape: check the job's saved data is
well-formed, check whether the result already exists (skip if so — the
idempotency check), do the real work (often an AI call), re-check right
before saving (in case a duplicate "twin" snuck in while waiting on the AI
— the lease-overlap re-check explained at the bottom), then save everything
as one atomic write.

**Memory and reflection**

- `apps/server/src/ledger/handlers/reflection.ts` — after a scene ends,
  each character privately reflects on what happened (a few first-person
  sentences). The same single save now also carries the character's
  *memory outputs*: one to three lasting memory notes, optionally a full
  replacement of its core-memory snapshot, and (rarely) a personality
  evolution — each having passed both gates first, with evolution refused
  outright for a locked character. A short "cache line" (a compressed
  "what just happened to me" pointer) rides the same save too, so a crash
  can never separate a reflection from its memory or its cache entry. The
  roster is folded live, so a character minted this session reflects like
  any other.
- `apps/server/src/ledger/handlers/reflect-chat.ts` — the chat version:
  after a direct-message conversation closes (the user leaves, goes idle,
  or a scene starts), the character reflects on that chat the same way,
  with the identical memory-output treatment. It never produces a summary
  anyone else reads — it's purely the character's own private note.
- `apps/server/src/ledger/handlers/memory-compaction.ts` — when a
  character's pile of memory notes grows past a threshold, this job asks
  the AI to summarize the older ones into a single cumulative record. The
  originals never leave the permanent log or the search index — the
  summary is a reading convenience, and a repair re-run simply writes a
  superseding summary (latest wins); nothing is ever deleted.
- `apps/server/src/ledger/handlers/cache-prune.ts` — pure bookkeeping, no
  AI: keeps each character's cache-line lane to the most recent N entries
  by writing a "watermark" record that every reader ignores entries below.
  Replay rebuilds the identical pruned view; again, nothing is deleted.

**The living world**

- `apps/server/src/ledger/handlers/world-agent.ts` — the "World Agent":
  one pass per world, per ended scene, narrating how the wider world moves
  on (weather, schedules, background events). Only one runs per world at a
  time. The pass also writes one short wiki entry per Narrator-created
  place that genuinely took part in the scene. Week-19 hardenings: the
  wiki entries are generated from a *narration-only* transcript (character
  speech is filtered out by the committed step's own label, so gossip can
  never become wiki fact by construction); a scene where nothing happened
  still leaves a minimal entry derived from the place's own name (the
  World Agent observes, never invents); and a newly created interior place
  gets a deterministic "Inside lies ..." mention appended to its parent's
  wiki entry. Everything lands in one write — never half-done.
- `apps/server/src/ledger/handlers/world-cron.ts` — recurring "world
  calendar" events (a festival, a market day). Two flavors: the "code"
  flavor is pure bookkeeping with no AI call — and it's also where planned
  world *movement* and the map's chance-encounter *markers* get their
  events appended, atomically with the occurrence's completion record; the
  "llm" flavor asks the AI to narrate the occurrence's outcome in a
  sentence or two. Each occurrence is keyed by "which recurring thing"
  plus "which scheduled moment," so a retry can never replay one twice.
- `apps/server/src/ledger/handlers/proactive-dm.ts` — the job behind a
  character messaging *you* first. On a game-time cadence it picks one
  character (a deterministic but salted "random" pick that survives
  crash-retries), checks the character is actually available and the
  thread isn't frozen (three unanswered messages freezes it; your reply
  thaws it), generates the message, and commits message plus cache entry
  in one write. The character may explicitly decline via its stay-silent
  tool — a real decision, not an empty reply.
- `apps/server/src/ledger/handlers/object-gc.ts` — pure code, no AI: a
  small garbage sweep after a scene ends. Objects that were created in the
  scene but never written on and never touched again are tombstoned
  (marked swept) so the world doesn't fill with forgotten props; anything
  with written content, and anything the user approved via a GM proposal,
  is never a candidate.
- `apps/server/src/ledger/handlers/profile-analysis.ts` — the GM's
  analysis pass over an ended scene or chat: it distills one to five
  short hypotheses about what kind of story the user enjoys, tuned to
  story-quality signals (never raw time-spent). Doubly consent-gated: jobs
  are only enqueued while profiling is switched on, and the handler
  re-checks at run time — toggling it off in between means zero writes.
  The permanent log only ever records a *count*, never the text.

**The social feed**

- `apps/server/src/ledger/handlers/social-post.ts` — on a game-day cadence,
  picks one character not currently in a scene and has it write an
  in-character feed post grounded in its own recent cache lines and goals.
  The post, the poster's cache entry, and one reaction-decision job per
  picked acquaintance all commit in a single write — a crash can never
  produce a post without its reactions being owed.
- `apps/server/src/ledger/handlers/social-reaction.ts` — one picked
  character decides how to react to a post: a like, a one-line comment, or
  an explicit stay-silent. A like with a stray body has the body dropped;
  a comment without one is no reaction at all. Comments never thread
  between characters in V1.
- `apps/server/src/ledger/handlers/social-reply.ts` — when *you* reply to
  a character's comment, this job generates the character's answer. Its
  toolset carries nothing but the cache note — so a character physically
  cannot promise a meeting from a feed thread. Characters always answer;
  an empty generation is retried, never silently skipped.

**The map and pictures**

- `apps/server/src/ledger/handlers/painter.ts` — generates and composites
  map and scene artwork (depth in `docs/painter.md`). Builds its prompts
  from what's actually in the database right now, composites the new art
  onto the current image, and records the result with a checksum —
  idempotent per job key, so a retried lease can't paint the same spot
  twice.
- `apps/server/src/ledger/handlers/materialize.ts` — turns one "explored
  but empty" square of map fog into a real place. The AI is only trusted
  to invent a name and short description; where the place sits is decided
  by ordinary code. It also handles the no-AI case: a stub place the
  Narrator already created during a scene just needs slotting onto the
  map.
- `apps/server/src/ledger/handlers/map-edit.ts` — the user draws a shape
  on the map and describes what they want there; the AI fills in name and
  description, the geometry comes strictly from the drawing, and the
  matching paint job is queued so the artwork catches up.
- `apps/server/src/ledger/handlers/map-click.ts` — a click on unknown map
  ground: first the vision model classifies what's visibly there from a
  cropped picture, then a second AI call invents a place or moment
  strictly *inside* that classification (a forest click can't become a
  throne room). A lasting place becomes real; a passing moment never does.

**Software updates**

- `apps/server/src/ledger/handlers/update-check.ts` — periodically checks
  the release page for a newer version and, if one exists, announces it
  with a single event. It never downloads anything. Week-19 fix: a 404
  from the release page means "no releases published yet" (the normal
  state while the project is pre-release) and completes cleanly as a
  no-op, instead of parking a failed job on every boot; any other bad
  status is still a retried error.
- `apps/server/src/ledger/handlers/update-apply.ts` — the careful job that
  actually installs an approved update: re-checks the release, downloads,
  verifies authenticity (checksum plus a cryptographic signature), and
  flips a pointer to make the new version current. Only one can run at a
  time.

## `storage/repositories/ledger.ts` — the ledger's own database table

This file (outside the `ledger/` folder, but the ledger's sole gateway to
the database) is the *only* place in the entire codebase allowed to write
SQL against the `ledger_jobs` table.

- `JOB_STATES` — the possible states a row can be in (the life story
  below).
- `createLedgerRepository(...)` builds the repository:
  - `enqueue(job)` — inserts a row; a duplicate unique key silently does
    nothing instead of creating a twin.
  - `claimNext(...)` — picks the next due job (skipping any whose "serial
    group" already has one running), marks it running, records who claimed
    it and until when.
  - `markCommitted` / `markRetry` / `markParked` — the three outcomes.
  - `sweepExpiredLeases()` — puts timed-out "running" jobs back to pending.
  - `get` / `countByKey` / `listActive` — lookups; `listActive` is what the
    app checks before letting a user open a scene, so no relevant
    background work is still owed to that world.
  - Every row read back is checked against a strict shape; garbage is
    treated as corrupt state, never silently trusted.
- `apps/server/migrations/0002_jobs.sql` — the SQL creating the table:
  columns (id, unique key, world, type, payload, state, attempts, lease,
  worker, serial group, last error, timestamps) and the claim indexes.

## The job state machine — a job's life story

A job is **born** as `pending` the moment `enqueue()` succeeds — durable,
sitting in the database, waiting.

A worker's `tick()` **claims** it: state flips to `running`, the attempt
counter goes up, a lease timer starts. This happens before any real work,
so a crash right after claiming still "spends" one attempt — which is what
stops an endlessly crash-looping job from retrying forever.

From `running`, three fates:
- **`committed`** — finished and saved. Terminal.
- **`failed`** — an operational problem (something external). With attempts
  left, it's rescheduled with a growing wait (2, 4, 8... seconds, capped at
  300) and becomes claimable again — like `pending`, but remembering its
  attempt count and last error.
- **`parked`** — the dead-letter shelf: out of attempts, or a "bug"
  failure, or no handler registered for its type. Never auto-retried — a
  human has to look.

A fourth outcome touches no row: a `corrupt_state` failure skips straight
to fatal-error handling, because if the saved data can't be trusted, the
safest thing is to stop rather than guess.

Two extra rules:
- **Lease expiry / the sweep**: if a running job's lease runs out (say the
  program was killed mid-task), the next sweep — every poll, and at
  startup — puts it back to `pending`. This is what makes a `kill -9`
  mid-job safe.
- **Serialization**: some job types carry a `serial_group` tag (one World
  Agent pass per world; one memory job per character at a time; one social
  job per character; one update-apply ever). The claim query refuses to
  start a second job in a group that already has one running.

One subtlety: a lease can expire while a slow AI call is still running, so
the *same* job can briefly execute twice in overlap. Every handler defends
with a "fused" check-then-save: right before saving, it re-checks whether
the result already exists, with no pausing between that check and the save
— so two overlapping runs can never both slip through. The loser quietly
does nothing (a log warning, not an error): the app may waste one duplicate
AI generation, but never produces a duplicate permanent record.

## How this connects to the rest of the app

**Who enqueues jobs** — ordinary code puts rows on the ledger by calling
`storage.ledger.enqueue(...)`, never by doing the work directly:
- `apps/server/src/engine/scene-lifecycle.ts` fans out when a scene ends:
  a `reflection` per character, one `world_agent`, one `object_gc`, and —
  when profiling is on — a `profile_analysis`.
- `apps/server/src/engine/chat.ts` enqueues `reflect_chat` (and, consent
  permitting, `profile_analysis`) when a conversation closes; the
  reflection handlers themselves enqueue `memory_compaction` and
  `cache_prune` follow-ups when due.
- `apps/server/src/engine/explore.ts` and the world clock enqueue
  `materialize` and `world_cron` jobs; advancing the game clock also
  enqueues due `proactive_dm` and `social_post` occurrences (a paused
  world enqueues nothing); a committed social post enqueues its own
  `social_reaction` jobs atomically, and your feed reply enqueues a
  `social_reply`.
- `apps/server/src/engine/map-edit.ts` and `map-click.ts` enqueue their
  jobs when a user draws on or clicks the map; the painter's command layer
  enqueues `painter` jobs whenever artwork needs (re)painting.
- `apps/server/src/ledger/scheduler.ts` enqueues recurring jobs like
  `update_check`; `apps/server/src/main.ts` also enqueues one
  `update_check` shortly after every boot, runs a boot sweep for due
  memory maintenance, and enqueues `update_apply` when a user approves an
  update.

**Who executes jobs** — `apps/server/src/main.ts` builds one runner with a
lookup table mapping every job type to its handler — reflection,
reflect_chat, memory_compaction, cache_prune, world_agent, both world_cron
flavors, proactive_dm, the three social jobs, object_gc, profile_analysis,
materialize, map_edit, map_click, painter, update_check, update_apply — and
a one-second timer calls `runner.tick()` for as long as the app runs. The
handlers reach into `engine/` (to read world state), `llm/` (to make AI
calls), and `painter/` (to generate images) — the ledger is the crash-safe
scaffolding around that work, not the work itself.
