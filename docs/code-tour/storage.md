# Code tour — storage (the database layer)

This module is Weltari's only doorway to its database. The database itself is
SQLite — a database that lives in a single file on disk rather than a
separate server program — and the whole rest of the app is forbidden from
opening that file directly. Every other part of the codebase that needs to
read or write something durable (the engine that runs scenes, the ledger that
runs background jobs, the HTTP layer that talks to the browser) has to go
through the small set of functions this module exports. That's a deliberate
chokepoint: if all database access funnels through one place, that one place
can guarantee the data always stays in a valid, consistent shape — no other
file in the app can accidentally corrupt it or bypass the rules. The
centerpiece of those rules is that the `events` table is **append-only**:
rows can only ever be added, never changed or removed, enforced not just by
convention but by the database itself refusing the operation. Think of it
like a ship's logbook written in ink — the crew can always add a new entry,
but no one, not even the captain, can tear out or overwrite a page. Because
every important thing that happens in Weltari (a scene starting, a message
being sent, time advancing) becomes one of these permanent logbook entries,
the entire rest of the app's state can always be rebuilt just by reading the
log from the start — which makes the system resistant to bugs, crashes, and
tampering.

## `apps/server/src/storage/db.ts`

This is the one file in the whole codebase allowed to open a connection to
the SQLite database file. It sets the connection up, brings the schema
(the tables' structure) up to date, and hands out the objects everything
else uses to read and write data.

- **`openStorage(options)`** — opens the database file (or an in-memory one
  for tests), turns on a few safety/performance settings (`WAL` mode, which
  lets reads and writes happen more concurrently; a 5-second wait instead of
  an instant failure if two writes collide; foreign-key checking), then runs
  any database schema updates that haven't been applied yet, and finally
  returns a `Storage` object bundling the three "repositories" (the
  request-taking front doors for each table, described below) plus two more
  tools, `transact` and `close`.
- **`transact(fn)`** (a method on the returned `Storage`) — runs a batch of
  writes as one all-or-nothing unit (a "transaction"): if anything inside
  `fn` throws partway through, every change made in that batch is
  automatically undone, so the database is never left half-updated after a
  crash or an error.
- **`applyMigrations(db, migrationsDir)`** (internal, not exported) — reads
  the numbered `.sql` files in the migrations folder (each one describes one
  step of schema history, like "add this table") and applies any that
  haven't run yet, in strict numeric order. Before running a file it checks
  its contents against a stored fingerprint (a SHA-256 hash) recorded in
  `manifest.json`; if a shipped migration file was ever edited after the
  fact, the fingerprint won't match and the app refuses to start rather than
  risk running a schema history nobody can trust anymore. It also refuses to
  start if a migration file is missing from the manifest, or if the
  numbering has a gap (e.g. `0001` then `0003` with no `0002`).

## `apps/server/src/storage/repositories/event-log.ts`

This is the sole gateway to the `events` table — the permanent logbook
described above. Nothing else in the codebase is allowed to run SQL against
this table directly.

- **`createEventLogRepository(db, nowIso)`** — builds and returns the object
  with the three functions below, pre-preparing the SQL statements they'll
  use (a performance optimization, not a behavior change).
- **`append(event)`** — writes one new row to the logbook (adding the
  server's current timestamp) and hands back the fully-saved event, now with
  its permanent sequence number. This is genuinely the only way to put a row
  into `events`; there is no update or delete function on this object at
  all — the interface itself makes the append-only rule impossible to
  violate from code, on top of the database trigger that would also refuse
  an update or delete if somehow attempted.
- **`readSince(sinceId, limit)`** — fetches every event newer than a given
  sequence number, oldest first. This is how a reconnecting browser tab
  catches up: it says "give me everything after the last event I saw," which
  is exactly how the live-update stream (Server-Sent Events) resumes after a
  dropped connection.
- **`lastId()`** — returns the highest sequence number in the log so far (or
  0 if the log is empty), used to tell a freshly-connecting client where
  "now" is.
- Every row read back from the database is checked against the app's formal
  event schema (from the shared `@weltari/protocol` package). If a stored
  row doesn't match what's expected — corrupted JSON, or a shape the schema
  doesn't recognize — the code deliberately throws an error (`CorruptStateError`)
  rather than silently skipping the bad row, because silently dropping a
  logbook entry could hide something important.

## `apps/server/src/storage/repositories/gateway.ts`

This is the sole gateway to the `gateway_inbound` table, whose entire job is
to stop the same incoming chat message (from Telegram, WeChat, etc.) from
being processed twice — for example if the messaging platform re-delivers a
message after a network hiccup, or a malicious actor tries to replay one.

- **`createGatewayRepository(db, nowIso)`** — builds the object holding the
  one function below.
- **`recordInbound(message)`** — tries to insert a record of an incoming
  message. The table has a rule (a `UNIQUE` constraint) that a given
  connector's message ID can only be recorded once; if this exact message
  was already recorded, the insert is quietly turned into a no-op by the
  database itself rather than an error. The function returns `true` if this
  was a genuinely new message (first delivery) and `false` if it was a
  duplicate — callers use that boolean to decide whether to actually act on
  the message.

## `apps/server/src/storage/repositories/ledger.ts`

This is the sole gateway to the `ledger_jobs` table, which tracks background
work Weltari needs to do outside the main request/response flow — things
like generating a "reflection" after a scene, running scheduled world events,
or composing an image. Because this work can be slow or fail, jobs are
tracked with retry logic, expiry, and a way to permanently give up on a job
rather than losing track of it.

- **`createLedgerRepository(db, nowIso)`** — builds the object holding the
  functions below.
- **`enqueue(job)`** — adds a new job to the queue. Every job carries an
  "idempotency key," a natural, predictable ID (e.g. `reflection:alice:scene7`)
  that makes accidentally scheduling the same job twice a harmless no-op
  (the function returns `null` instead of creating a duplicate) — this
  matters because it means retried code paths can safely say "make sure this
  job exists" without worrying about double-booking it.
- **`claimNext(workerId, leaseSeconds)`** — picks the next job that's due to
  run and marks it as "running," reserved (leased) to the calling worker for
  a limited time. It skips any job whose "serial group" (e.g. "the World
  Agent for this particular world") already has another job running, so that
  kind of work only ever happens one-at-a-time per group. It also bumps the
  job's attempt counter at this point, on purpose — so if the process
  crashes mid-job, that still counts as a used attempt rather than a free
  retry forever.
- **`markCommitted(id)`** — marks a job as successfully finished.
- **`markRetry(id, runAt, error)`** — marks a job as failed but retryable,
  recording when it should be tried again and a trimmed-down summary of what
  went wrong (never the full error text or any AI prompt content, to avoid
  leaking sensitive data into stored error logs).
- **`markParked(id, error)`** — marks a job as permanently given up on (a
  "dead letter" — it sits there for a human to look at, and the system will
  never automatically retry it again).
- **`sweepExpiredLeases()`** — finds any job that's still marked "running"
  but whose reservation (lease) time has expired — meaning the worker that
  claimed it probably crashed — and puts it back to "pending" so another
  worker can pick it up. Returns how many jobs were reset.
- **`get(id)`** — fetches one job by its numeric ID, or `null` if it doesn't
  exist.
- **`countByKey(idempotencyKey)`** — counts how many jobs exist with a given
  idempotency key (mostly useful for tests confirming the no-duplicate
  behavior).
- **`listActive(worldId)`** — lists every job for a given world that isn't
  finished yet (pending, running, or failed-awaiting-retry). This is how the
  app can check "does this world still have unfinished background work?"
  before letting certain things happen.
- Just like the event log, every row read back is checked against an
  expected shape, and a row that doesn't parse correctly throws a
  `CorruptStateError` rather than being silently ignored.

## `apps/server/migrations/0001_events.sql`, `0002_jobs.sql`, `0003_gateway.sql`

These are the plain SQL files that actually define the three tables
described above (`events`, `ledger_jobs`, `gateway_inbound`) — table columns,
indexes for fast lookups, and, in `0001_events.sql`, two database triggers
(`events_no_update` and `events_no_delete`) that make the database itself
refuse any attempt to change or delete a row in `events`, no matter what code
tries it. These files are never edited after being shipped — a schema change
always means writing a brand-new numbered file rather than modifying an old
one, which is what lets `db.ts`'s fingerprint check work as a tamper alarm.

## `apps/server/migrations/manifest.json`

A simple list mapping each migration file's name to a SHA-256 fingerprint of
its exact contents at the time it was written. `db.ts` reads this file every
time the app starts and refuses to boot if any migration file's current
contents don't match its recorded fingerprint, or if a file exists that
isn't listed here — this is the "hash-locked" tamper check mentioned above,
in file form.

## How this connects to the rest of the app

Nothing outside `apps/server/src/storage/` is allowed to run SQL — that rule
is enforced both by convention (documented in `CLAUDE.md` and the coding
guide) and by an automated check (an "invariant test" that greps the
codebase for stray database access). Instead, other modules call the three
repository objects (`eventLog`, `ledger`, `gateway`) that `openStorage()`
hands back:

- **`engine/`** (the code that runs scenes and turns — files like
  `scene-turn.ts`, `chat.ts`, `scene-lifecycle.ts`, `world-clock.ts`,
  `sublocations.ts`) reads and appends events to record what happened in a
  scene, and reads the world clock's current time from the latest
  time-advance event.
- **`ledger/`** (`runner.ts`, `scheduler.ts`, and the job handlers under
  `ledger/handlers/` such as `reflection.ts`, `world-agent.ts`, `painter.ts`,
  `world-cron.ts`, `update-apply.ts`) is the code that actually claims and
  processes background jobs — it's the only part of the app allowed to call
  `claimNext`, and it decides what to do with retryable vs. permanent
  failures based on what `markRetry` / `markParked` record.
- **`gateway/host.ts`** (the messenger connector host — Telegram, WeChat,
  etc.) calls `recordInbound` on every incoming message to guarantee
  exactly-once handling before anything else happens with that message.
- **`http/`** (`server.ts`, `sse.ts`) reads the event log to serve the live
  update stream to connected browser tabs, replaying events since a client's
  last-seen ID.
- **`main.ts`** is where the whole app calls `openStorage()` once at startup
  and threads the resulting `Storage` object down into the engine, ledger,
  HTTP, and gateway layers.

Because `db.ts` is the only file that ever opens the SQLite connection, and
that connection is only ever handed out as these narrow repository objects
(never as the raw, do-anything database handle), Weltari effectively has a
**single writer** to its database: every durable change to the app's state,
no matter which part of the app triggered it, ultimately funnels through
this one module's `append`, `enqueue`, `recordInbound`, and their sibling
functions.
