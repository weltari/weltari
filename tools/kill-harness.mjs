// The kill harness (Invariant I4, permanent CI): SIGKILL the REAL server at
// named fault points, restart, verify consistency offline, and prove a
// reconnecting SSE client resumes via Last-Event-ID with every missed event
// exactly once. CYCLES=25 per PR, 100 nightly.
// Usage: CYCLES=25 node tools/kill-harness.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = join(ROOT, 'apps', 'server', 'dist', 'main.js');
const POINTS = ['mid_stream', 'between_calls', 'pre_commit'];
const CYCLES = Number(process.env.CYCLES ?? 25);
const PORT = Number(process.env.HARNESS_PORT ?? 7911);
const BASE = `http://127.0.0.1:${PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'weltari-kill-'));
const dbPath = join(dataDir, 'w.sqlite');

function fail(message) {
  console.error(`KILL-HARNESS FAIL: ${message}`);
  process.exit(1);
}

function dbEventIdsAbove(sinceId) {
  const db = new Database(dbPath);
  const ids = db
    .prepare('SELECT id FROM events WHERE id > ? ORDER BY id')
    .all(sinceId)
    .map((r) => r.id);
  db.close();
  return ids;
}

function spawnServer() {
  const child = spawn(process.execPath, [MAIN], {
    env: {
      ...process.env,
      WELTARI_FAKE_LLM: '1',
      WELTARI_EMIT_FAULT_POINTS: '1',
      WELTARI_FAULT_PAUSE_MS: '400',
      WELTARI_DB_PATH: dbPath,
      PORT: String(PORT),
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return child;
}

function waitForLine(child, needle, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for "${needle}"`)),
      timeoutMs,
    );
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes(needle)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve(undefined);
      }
    };
    child.stdout.on('data', onData);
    child.on('exit', () => {
      clearTimeout(timer);
      reject(new Error(`server exited while waiting for "${needle}"`));
    });
  });
}

function exited(child) {
  return new Promise((resolve) => child.on('exit', resolve));
}

/** Read SSE replay frames until the log head from the hello frame is reached. */
async function readReplayIds(lastEventId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const ids = [];
  try {
    const res = await fetch(`${BASE}/v1/events`, {
      headers: { 'Last-Event-ID': String(lastEventId) },
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let head = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const idLine = block.split('\n').find((l) => l.startsWith('id: '));
        const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
        if (block.startsWith('event: hello') && dataLine) {
          head = JSON.parse(dataLine.slice(6)).last_event_id;
        } else if (idLine) {
          ids.push(Number(idLine.slice(4)));
        }
        sep = buffer.indexOf('\n\n');
      }
      if (head !== null && (ids.at(-1) ?? lastEventId) >= head) break;
    }
    controller.abort();
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  } finally {
    clearTimeout(timer);
  }
  return ids;
}

async function postTurn() {
  const res = await fetch(`${BASE}/v1/commands/start-turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's1',
      text: 'Harness turn.',
    }),
  });
  if (res.status !== 202) fail(`start-turn returned ${res.status}`);
}

function runVerify() {
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [join(ROOT, 'tools', 'verify-consistency.mjs'), dbPath],
      {
        stdio: 'inherit',
      },
    );
    proc.on('exit', (code) => resolve(code));
  });
}

let previousMax = 0;
for (let cycle = 0; cycle < CYCLES; cycle++) {
  const point = POINTS[cycle % POINTS.length];
  const child = spawnServer();
  await waitForLine(child, 'weltari listening');

  // Resume check (criterion c/d): a reconnecting client gets every event it
  // missed — exactly once, in order.
  const expected = dbEventIdsAbove(previousMax);
  const replayed = await readReplayIds(previousMax);
  const got = replayed.slice(0, expected.length);
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    child.kill('SIGKILL');
    fail(
      `cycle ${cycle}: resume mismatch after ${previousMax} — expected [${expected}], got [${got}]`,
    );
  }

  const killAt = waitForLine(child, `FAULT_POINT:${point}`, 20000);
  await postTurn();
  await killAt;
  child.kill('SIGKILL'); // Windows: unconditional termination
  await exited(child);

  const verifyCode = await runVerify();
  if (verifyCode !== 0)
    fail(`cycle ${cycle}: verify-consistency failed after kill at ${point}`);

  previousMax = dbEventIdsAbove(0).at(-1) ?? 0;
  console.log(
    `cycle ${cycle + 1}/${CYCLES} ok (killed at ${point}, log head ${previousMax})`,
  );
}

console.log(
  `kill-harness: ${CYCLES} cycles, zero duplicate or lost events, resume exact`,
);
