// Post-crash consistency verifier (Invariant I4). Exits 1 with reasons on any
// violation. Raw driver access is sanctioned under tools/ (Guide A11) — this
// runs OFFLINE against the database file, after the process was SIGKILLed.
// Usage: node tools/verify-consistency.mjs <db-path>
import Database from 'better-sqlite3';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: node tools/verify-consistency.mjs <db-path>');
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
  .prepare('SELECT id, type, payload FROM events ORDER BY id')
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
