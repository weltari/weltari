# Code tour — storage (the database layer)

*Current as of the V1 close-out (week 19, 2026-07-21).*

This module is Weltari's only doorway to its database. The database itself is
SQLite — a database that lives in a single file on disk rather than a
separate server program — and the whole rest of the app is forbidden from
opening that file directly. Every other part of the codebase that needs to
read or write something durable (the engine that runs scenes, the ledger that
runs background jobs, the HTTP layer that talks to the browser) has to go
through the small set of functions this module exports. That's a deliberate
chokepoint: if all database access funnels through one place, that one place
can guarantee the data always stays in a valid, consistent shape — no other
file in the app can accidentally corrupt it or bypass the rules.

The centerpiece of those rules is that the `events` table is **append-only**:
rows can only ever be added, never changed or removed, enforced not just by
convention but by the database itself refusing the operation. Think of it
like a ship's logbook written in ink — the crew can always add a new entry,
but no one, not even the captain, can tear out or overwrite a page. Because
every important thing that happens in Weltari (a scene starting, a message
being sent, time advancing) becomes one of these permanent logbook entries,
the entire rest of the app's state can always be rebuilt just by reading the
log from the start — which makes the system resistant to bugs, crashes, and
tampering.

A second idea now runs through this module: **projections**. Several tables
(the memory search index, the objects table, the markers table) are just
fast-to-query scratch copies *derived from* the logbook. They're rebuilt
from scratch every time the app starts, and updated in lockstep whenever a
relevant logbook entry is written — so deleting any of them loses nothing.
One table (the user profile store) is the deliberate exception, explained
below.

## `apps/server/src/storage/db.ts`

This is the one file in the whole codebase allowed to open a connection to
the SQLite database file. It sets the connection up, brings the schema (the
tables' structure) up to date, and hands out the objects everything else
uses to read and write data.

- **`openStorage(options)`** — opens the database file (or an in-memory one
  for tests), turns on a few safety/performance settings (`WAL` mode, which
  lets reads and writes happen more concurrently; a 5-second wait instead of
  an instant failure if two writes collide; foreign-key checking), and
  checks up front that this build of SQLite includes the full-text-search
  engine (FTS5) the memory index needs — if it doesn't, the app refuses to
  start with a clear message rather than silently running without search.
  It then applies any pending schema updates, rebuilds the three projection
  tables from the logbook, and returns a `Storage` object bundling seven
  repositories (the request-taking front doors for each table, described
  below) plus `transact` and `close`.
- **`transact(fn)`** — runs a batch of writes as one all-or-nothing unit (a
  "transaction"): if anything inside `fn` throws partway through, every
  change made in that batch is automatically undone, so the database is
  never left half-updated after a crash or an error.
- **The migration runner** (internal) — reads the numbered `.sql` files in
  the migrations folder (each one describes one step of schema history, like
  "add this table") and applies any that haven't run yet, in strict numeric
  order. Before running a file it checks its contents against a stored
  fingerprint (a SHA-256 hash) recorded in `manifest.json`; if a shipped
  migration was ever edited after the fact, the fingerprint won't match and
  the app refuses to start. It also refuses a file missing from the
  manifest, or a gap in the numbering (e.g. `0001` then `0003`).

## `apps/server/src/storage/repositories/event-log.ts`

The sole gateway to the `events` table — the permanent logbook. Nothing else
in the codebase is allowed to run SQL against this table directly.

- **`append(event)`** — writes one new row to the logbook (adding the
  server's current timestamp) and hands back the fully-saved event with its
  permanent sequence number. This is genuinely the only way to put a row
  into `events`; there is no update or delete function at all. On top of
  that, whenever the new event is one the projection tables care about
  (a memory delta, an object event, a marker event), `append` updates the
  matching projection **inside the same transaction** — so a committed
  event can never exist without its projection row, even if the process is
  killed mid-write.
- **`readSince(sinceId, limit)`** — fetches every event newer than a given
  sequence number, oldest first. This is how a reconnecting browser tab
  catches up after a dropped connection.
- **`lastId()`** — the highest sequence number so far (0 if empty), used to
  tell a freshly-connecting client where "now" is.
- Every row read back is checked against the app's formal event schema (from
  the shared `@weltari/protocol` package). A row that doesn't match —
  corrupted JSON, an unrecognized shape — deliberately throws a
  `CorruptStateError` rather than being silently skipped, because silently
  dropping a logbook entry could hide something important.

## `apps/server/src/storage/repositories/gateway.ts`

The sole gateway to the `gateway_inbound` table, whose job is to stop the
same incoming chat message (from Telegram, etc.) from being processed twice
— for example if the messaging platform re-delivers a message after a
network hiccup, or a malicious actor tries to replay one.

- **`recordInbound(message)`** — tries to insert a record of an incoming
  message. The table has a rule (a `UNIQUE` constraint) that a given
  connector's message ID can only be recorded once; a repeat is quietly
  turned into a no-op by the database itself. Returns `true` for a genuinely
  new message and `false` for a duplicate — callers use that to decide
  whether to actually act on the message.
- **`latestConversationId(connectorId)`** — remembers which external chat
  most recently talked to us on a given connector. This is the V1
  "subscription": messaging the bot once is subscribing, and outbound
  pushes go to whichever chat spoke last.

## `apps/server/src/storage/repositories/ledger.ts`

The sole gateway to the `ledger_jobs` table, which tracks background work
Weltari needs to do outside the main request/response flow — generating a
"reflection" after a scene, running scheduled world events, composing an
image. Because this work can be slow or fail, jobs carry retry logic,
expiry, and a way to permanently give up rather than losing track.

- **`enqueue(job)`** — adds a job. Every job carries an "idempotency key," a
  natural, predictable ID (e.g. `reflection:alice:scene7`) that makes
  accidentally scheduling the same job twice a harmless no-op (the function
  returns `null` instead of creating a duplicate).
- **`claimNext(workerId, leaseSeconds)`** — picks the next due job and marks
  it "running," reserved to the calling worker for a limited time. It skips
  any job whose "serial group" already has another job running (that kind of
  work happens one-at-a-time per group), and bumps the attempt counter at
  claim time on purpose — a crash mid-job still counts as a used attempt.
- **`markCommitted(id)`** / **`markRetry(id, runAt, error)`** /
  **`markParked(id, error)`** — finished, failed-but-retryable (with a
  trimmed error summary that never contains AI prompt content), and
  permanently-given-up ("dead letter" a human can inspect), respectively.
- **`sweepExpiredLeases()`** — puts jobs back to "pending" when the worker
  that claimed them apparently crashed (its reservation expired).
- **`get(id)`**, **`countByKey(key)`**, **`listActive(worldId)`** — lookups:
  one job, how many share an idempotency key, and every unfinished job for
  a world.
- As with the event log, a stored row that doesn't parse throws a
  `CorruptStateError` rather than being ignored.

## `apps/server/src/storage/repositories/memory-index.ts`

The search index over character memories — the first projection table. When
a scene ends, characters commit short "memory deltas"; this repository keeps
them in a full-text index (SQLite's built-in FTS5 engine, so no new
dependency) so a character can later search their own past.

- **`add(...)`** — called by the event log's `append`, inside the same
  transaction, whenever a memory delta commits — a saved memory is never
  unsearchable.
- **`rebuild()`** — wipes and re-derives the whole index from the logbook at
  every startup. The index is pure derived state: dropping it loses nothing.
- **`search(...)`** — a relevance-ranked (BM25) search, structurally limited
  to the asking character's own memories, and defensive about its input:
  because search queries can be written by the AI, the raw text is reduced
  to plain quoted words before reaching FTS5, so hostile search syntax is
  inert.

## `apps/server/src/storage/repositories/objects.ts`

The durable-items table — the second projection. Objects in Weltari (a
letter on a desk, a key on a hook) come into existence "on touch" during
play, and this table is the fast lookup over the `object.*` family of
logbook events. In V1 an object is always held by a **sublocation** (a
place), never carried by a character — backpacks are a V2 idea, per the
owner's 2026-07-16 ruling — so every object row is public.

- **`apply(event)`** — called by `append` inside the same transaction, so an
  object event can never commit without its row. An `object.swept` event
  (garbage collection) deletes the row — while the tombstone event stays in
  the append-only logbook forever.
- **`rebuild()`** — re-derives the table from the logbook at every startup.
- Reads: **`byId`**, **`heldAt`** (everything at a place, in creation
  order — the "look around" listing), **`resolveName`** (find an object by
  its everyday name, normalized so "The Old Key" and "the old key" match;
  an ambiguous name returns all matches), and **`strayCandidates`** (a
  pre-filter for the cleanup job: forgettable scene props never touched
  again).
- A uniqueness rule on (world, holder, normalized name) means two objects
  with the same name can't sit in the same place — the engine checks first,
  so a collision here would indicate corruption, not a user mistake.

## `apps/server/src/storage/repositories/markers.ts`

The chance-encounter markers table — the third projection. A marker is a
lazy "something could happen here" note the world drops at a place; if the
player wanders in before it expires, it becomes a real scene. This table
mirrors the `marker.*` event family.

- **`apply(event)`** / **`rebuild()`** — same lockstep-and-reboot discipline
  as objects.
- Unlike objects, finished markers **stay** in the table: a marker walks
  from `dropped` to either `instantiated` (it became a scene — the row
  remembers which one, which settles any race about joining it twice) or
  `expired` (kept as an audit trail). The state change is guarded in the
  SQL itself, so a settled marker can never flip again.
- Reads: **`byId`** and **`live`** (all still-dropped markers, oldest
  first — what the sweep, the map pins, and the "at most a handful live at
  once" rule all consult).

## `apps/server/src/storage/repositories/user-profile.ts`

The GM's notes-about-the-player store — and the one **deliberate exception**
to "everything is rebuildable from the logbook." The GM occasionally writes
down hypotheses about what the player enjoys; that's personal data, and
personal data must be *truly* erasable (think GDPR's right to be
forgotten). If it lived in the append-only log, no deletion could ever be
real — a replay would resurrect it. So it lives here, in an ordinary
mutable side table the logbook only ever references by count, never by
content.

- **`append`**, **`list`**, **`count`** — add a note, read them all (the
  view/export surface), count them.
- **`hasContext`** — lets the analysis job check "did I already write notes
  for this scene?" so retries don't double-write.
- **`deleteAll`** — physically removes the rows. Startup never rebuilds
  this table, so a deletion survives restarts by construction.

## `apps/server/migrations/0001…0007 + manifest.json`

The plain SQL files that define the tables above, one numbered step of
schema history each — never edited after shipping (a schema change is
always a *new* numbered file), which is what lets the fingerprint check in
`db.ts` work as a tamper alarm.

- **`0001_events.sql`** — the `events` logbook, including the two database
  triggers that make SQLite itself refuse any UPDATE or DELETE on it.
- **`0002_jobs.sql`** — the `ledger_jobs` background-work queue.
- **`0003_gateway.sql`** — the `gateway_inbound` duplicate-message fence.
- **`0004_memory_fts.sql`** — the memory search index (FTS5). Derived
  state; dropping it loses nothing.
- **`0005_user_profile.sql`** — the erasable GM-notes side store.
- **`0006_objects.sql`** — the objects projection, with the same-place
  same-name uniqueness rule. Derived; rebuildable.
- **`0007_markers.sql`** — the markers projection, including the state
  column and the drop/expiry timestamps in game time. Derived; rebuildable.
- **`manifest.json`** — each migration file's name mapped to a SHA-256
  fingerprint of its exact contents. `db.ts` refuses to boot on any
  mismatch, unlisted file, or numbering gap.

## How this connects to the rest of the app

Nothing outside `apps/server/src/storage/` is allowed to run SQL — enforced
both by convention (documented in `CLAUDE.md` and the coding guide) and by
an automated invariant test that greps the codebase for stray database
access. Instead, other modules call the seven repository objects
(`eventLog`, `ledger`, `gateway`, `memoryIndex`, `objects`, `markers`,
`userProfile`) that `openStorage()` hands back:

- **`engine/`** (scenes, chat, the world clock, sublocations, objects and
  markers during play) appends events to record what happened and reads the
  projections for fast lookups.
- **`ledger/`** (the job runner and its handlers — reflections, the World
  Agent, the painter, world cron, profile analysis, update apply) is the
  only code allowed to claim jobs, and the profile-analysis handler is one
  of only two writers to the user-profile store.
- **`gateway/`** (the messenger host and chat bridge) calls `recordInbound`
  on every incoming message to guarantee exactly-once handling, and
  `latestConversationId` to know where outbound pushes should go.
- **`http/`** reads the event log to serve the live update stream to
  connected browser tabs.
- **`main.ts`** calls `openStorage()` once at startup and threads the
  resulting `Storage` object down into everything else.

Because `db.ts` is the only file that ever opens the SQLite connection, and
that connection is only handed out as these narrow repository objects
(never as the raw, do-anything database handle), Weltari effectively has a
**single writer** to its database: every durable change, no matter which
part of the app triggered it, ultimately funnels through this one module.
