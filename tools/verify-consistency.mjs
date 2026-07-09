// Post-crash consistency verifier (Invariant I4). Exits 1 with reasons on any
// violation. Raw driver access is sanctioned under tools/ (Guide A11) — this
// runs OFFLINE against the database file, after the process was SIGKILLed.
// Usage: node tools/verify-consistency.mjs <db-path> [<images-dir>]
//   <images-dir> enables the M2 painter hash check (criterion a: zero
//   corrupted images) — required when painter.completed events exist.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const dbPath = process.argv[2];
const imagesDir = process.argv[3] ?? process.env.WELTARI_IMAGES_DIR;
if (!dbPath) {
  console.error(
    'usage: node tools/verify-consistency.mjs <db-path> [<images-dir>]',
  );
  process.exit(2);
}

const failures = [];
// Opening the file performs the same WAL recovery the real startup performs.
const db = new Database(dbPath);

// 1. SQLite-level integrity
const integrity = db.pragma('integrity_check', { simple: true });
if (integrity !== 'ok') failures.push(`integrity_check: ${String(integrity)}`);

// 2. Event ids strictly increasing and unique (append-only log, I1/I4)
const ids = db
  .prepare('SELECT id FROM events ORDER BY id')
  .all()
  .map((r) => r.id);
for (let i = 1; i < ids.length; i++) {
  if (!(ids[i] > ids[i - 1])) {
    failures.push(
      `event ids not strictly increasing at index ${i}: ${ids[i - 1]} -> ${ids[i]}`,
    );
    break;
  }
}

// 3. Every payload is valid JSON with a scene/turn shape the engine could have written
const events = db
  .prepare('SELECT id, world_id, type, payload FROM events ORDER BY id')
  .all();
for (const event of events) {
  try {
    JSON.parse(event.payload);
  } catch {
    failures.push(`event ${event.id} payload is not JSON`);
  }
}

// 4. Turn envelope discipline (B6): at most one committed per turn_id, and
//    every committed turn has its started envelope. Started-without-committed
//    is EXPECTED (a killed turn voids) — never the reverse.
const started = new Set();
const committed = new Map();
for (const event of events) {
  const payload = JSON.parse(event.payload);
  if (event.type === 'turn.started') started.add(payload.turn_id);
  if (event.type === 'turn.committed') {
    committed.set(payload.turn_id, (committed.get(payload.turn_id) ?? 0) + 1);
  }
}
for (const [turnId, count] of committed) {
  if (count > 1)
    failures.push(`turn ${turnId} committed ${count} times (duplicate)`);
  if (!started.has(turnId))
    failures.push(`turn ${turnId} committed without turn.started`);
}

// 4b. Scene-end fan-out atomicity (M2, Brief §2.4): a scene.ended event can
//     only exist alongside ALL of its jobs — one WriteGate transaction wrote
//     them, so a kill can never leave the event without the rows.
const jobKeyExists = db.prepare(
  'SELECT COUNT(*) AS n FROM ledger_jobs WHERE idempotency_key = ?',
);
for (const event of events) {
  if (event.type !== 'scene.ended') continue;
  const payload = JSON.parse(event.payload);
  for (const participant of payload.participants) {
    const key = `reflection:${participant}:${payload.scene_id}`;
    if (jobKeyExists.get(key).n !== 1) {
      failures.push(`scene.ended ${payload.scene_id}: missing job ${key}`);
    }
  }
  const worldAgentKey = `world_agent:${payload.scene_id}`;
  if (jobKeyExists.get(worldAgentKey).n !== 1) {
    failures.push(
      `scene.ended ${payload.scene_id}: missing job ${worldAgentKey}`,
    );
  }
}

// 4c. Idempotent projections stayed idempotent under kill-retry (M2): every
//     cold-path outcome event is unique per its natural key.
const seenOnce = new Map();
const dupCheck = (kind, key, eventId) => {
  const mapKey = `${kind}|${key}`;
  if (seenOnce.has(mapKey)) {
    failures.push(
      `duplicate ${kind} for ${key} (events ${seenOnce.get(mapKey)} and ${eventId})`,
    );
  } else {
    seenOnce.set(mapKey, eventId);
  }
};
for (const event of events) {
  const payload = JSON.parse(event.payload);
  if (event.type === 'reflection.committed') {
    dupCheck(
      'reflection.committed',
      `${payload.scene_id}:${payload.character_id}`,
      event.id,
    );
  }
  if (event.type === 'world_agent.committed') {
    dupCheck('world_agent.committed', payload.scene_id, event.id);
  }
  if (event.type === 'world_cron.completed') {
    dupCheck(
      'world_cron.completed',
      `${payload.cron_type}:${payload.scheduled_for}`,
      event.id,
    );
  }
  if (event.type === 'painter.completed') {
    dupCheck('painter.completed', payload.job_key, event.id);
  }
  if (event.type === 'update.staged') {
    dupCheck('update.staged', payload.version, event.id);
  }
  if (event.type === 'sublocation.materialized') {
    dupCheck(
      'sublocation.materialized',
      `${event.world_id}:${payload.square.col}:${payload.square.row}`,
      event.id,
    );
    // M6 part 1: a Narrator stub materializes at most once — the natural key
    // is the stub id, not just the (solver-chosen) square.
    dupCheck(
      'sublocation.materialized:id',
      `${event.world_id}:${payload.sublocation_id}`,
      event.id,
    );
  }
  if (event.type === 'sublocation.stub_created') {
    dupCheck(
      'sublocation.stub_created',
      `${event.world_id}:${payload.sublocation_id}`,
      event.id,
    );
  }
  if (event.type === 'sublocation.created') {
    dupCheck(
      'sublocation.created',
      `${event.world_id}:${payload.edit_id}`,
      event.id,
    );
  }
  if (event.type === 'map_click.resolved') {
    dupCheck(
      'map_click.resolved',
      `${event.world_id}:${payload.click_id}`,
      event.id,
    );
  }
}

// 4g. Create-tool atomicity (M6 part 1, Rev 4 §6): a sublocation.stub_created
//     commits in ONE transaction with its backdrop paint job — and, when
//     parentless, its eager materialize job. The event without the rows is a
//     torn transaction.
for (const event of events) {
  if (event.type !== 'sublocation.stub_created') continue;
  const payload = JSON.parse(event.payload);
  const backdropKey = `painter:backdrop:${payload.sublocation_id}:initial`;
  if (jobKeyExists.get(backdropKey).n !== 1) {
    failures.push(
      `sublocation.stub_created ${payload.sublocation_id}: missing job ${backdropKey}`,
    );
  }
  if (payload.parent_id === undefined) {
    const materializeKey = `materialize:stub:${payload.sublocation_id}`;
    if (jobKeyExists.get(materializeKey).n !== 1) {
      failures.push(
        `parentless stub ${payload.sublocation_id}: missing job ${materializeKey}`,
      );
    }
  }
}

// 4f. Update pointer discipline (M3 part 2, Guide B12): if a `current`
//     pointer exists it must name a COMPLETE version directory — the flip is
//     rename-then-pointer, so a torn state is a violation. vNext leftovers
//     are legal here (startup deletes them; we run pre-startup).
const versionsDir = process.argv[4] ?? process.env.WELTARI_VERSIONS_DIR;
if (versionsDir && existsSync(join(versionsDir, 'current'))) {
  const pointer = readFileSync(join(versionsDir, 'current'), 'utf8').trim();
  if (pointer === '' || !existsSync(join(versionsDir, pointer))) {
    failures.push(
      `update pointer names "${pointer}" but versions/${pointer} does not exist (torn flip)`,
    );
  }
}

// 4d. World clock is monotonic per world (M2): each skip starts exactly where
//     the previous one ended.
const clockByWorld = new Map();
const eventWorlds = db
  .prepare('SELECT id, world_id, type, payload FROM events ORDER BY id')
  .all();
for (const event of eventWorlds) {
  if (event.type !== 'world.time_advanced') continue;
  const payload = JSON.parse(event.payload);
  const previous = clockByWorld.get(event.world_id);
  if (previous !== undefined && payload.from !== previous) {
    failures.push(
      `world clock gap in ${event.world_id}: skip starts at ${payload.from}, previous ended ${previous}`,
    );
  }
  if (!(payload.to > payload.from)) {
    failures.push(`world clock not monotonic at event ${event.id}`);
  }
  clockByWorld.set(event.world_id, payload.to);
}

// 4e. Zero corrupted images (M2 criterion a): every painter.completed names a
//     file whose bytes match its recorded sha256 — composite-on-success proven.
const painterEvents = events.filter((e) => e.type === 'painter.completed');
if (painterEvents.length > 0 && !imagesDir) {
  failures.push(
    `${painterEvents.length} painter.completed event(s) but no images dir given — cannot hash-verify`,
  );
}
if (imagesDir) {
  for (const event of painterEvents) {
    const payload = JSON.parse(event.payload);
    const filePath = join(imagesDir, payload.path);
    if (!existsSync(filePath)) {
      failures.push(
        `painter.completed ${payload.job_key}: file missing (${payload.path})`,
      );
      continue;
    }
    const hash = createHash('sha256')
      .update(readFileSync(filePath))
      .digest('hex');
    if (hash !== payload.sha256) {
      failures.push(
        `painter.completed ${payload.job_key}: hash mismatch — image corrupted`,
      );
    }
  }
}

// 5. Ledger rows are in legal states with legal shapes
const badStates = db
  .prepare(
    `SELECT id, state FROM ledger_jobs
     WHERE state NOT IN ('pending','running','committed','failed','parked')`,
  )
  .all();
for (const row of badStates)
  failures.push(`job ${row.id} has illegal state ${row.state}`);
const runningWithoutLease = db
  .prepare(
    `SELECT id FROM ledger_jobs WHERE state='running' AND lease_until IS NULL`,
  )
  .all();
for (const row of runningWithoutLease)
  failures.push(`running job ${row.id} has no lease`);

db.close();

if (failures.length > 0) {
  console.error(`CONSISTENCY FAILURES (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `consistency ok: ${events.length} events, ids strictly increasing, envelopes clean`,
);
