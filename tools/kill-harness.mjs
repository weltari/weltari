// The kill harness (Invariant I4, permanent CI): SIGKILL the REAL server at
// named fault points, restart, verify consistency offline, and prove a
// reconnecting SSE client resumes via Last-Event-ID with every missed event
// exactly once. M2 extends the Week-1 table (Brief §4): mid_reflection,
// mid_painter, mid_cron, client_disconnect — plus the criterion-b probe
// (scene opens block only on THAT world's pending jobs).
// CYCLES=25 per PR, 100 nightly. Usage: CYCLES=25 node tools/kill-harness.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = join(ROOT, 'apps', 'server', 'dist', 'main.js');
const POINTS = [
  'mid_stream',
  'between_calls',
  'pre_commit',
  'mid_reflection',
  'mid_painter',
  'mid_cron',
  'client_disconnect',
];
const CYCLES = Number(process.env.CYCLES ?? 25);
// Windows: each cycle's respawned server gets a FRESH port. Aborted SSE
// reads leave client-side TIME_WAIT tuples against the old port; Windows'
// sequential ephemeral allocator then streaks `connect EADDRINUSE` against
// a reused destination. A new destination per cycle makes collisions
// structurally impossible (the 4-tuple never repeats within a run).
const PORT_BASE = Number(process.env.HARNESS_PORT ?? 7911);
let PORT = PORT_BASE;
let BASE = `http://127.0.0.1:${PORT}`;
let portSeq = 0;
function rotatePort() {
  PORT = PORT_BASE + (portSeq++ % 500);
  BASE = `http://127.0.0.1:${PORT}`;
}

const dataDir = mkdtempSync(join(tmpdir(), 'weltari-kill-'));
const dbPath = join(dataDir, 'w.sqlite');
const imagesDir = join(dataDir, 'images');

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

/** WAL allows this concurrent read while the server is running. */
function dbHasCommittedTurn(turnId) {
  const db = new Database(dbPath);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE type = 'turn.committed' AND payload LIKE ?`,
    )
    .get(`%${turnId}%`);
  db.close();
  return row.n > 0;
}

function spawnServer() {
  const child = spawn(process.execPath, [MAIN], {
    env: {
      ...process.env,
      WELTARI_FAKE_LLM: '1',
      WELTARI_EMIT_FAULT_POINTS: '1',
      WELTARI_FAULT_PAUSE_MS: '400',
      WELTARI_LEASE_SECONDS: '2', // a killed-mid-job lease expires within a cycle
      WELTARI_DB_PATH: dbPath,
      WELTARI_IMAGES_DIR: imagesDir,
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Windows flake shield (same as server.test.ts): under ephemeral-port
 * pressure (thousands of TIME_WAIT sockets on this box) a connect draws
 * `EADDRINUSE`. Random allocation makes every retry an independent draw, so
 * persistence wins: 40 attempts × 100 ms rides out even a near-exhausted
 * range while TIME_WAITs expire. Environmental, not behavior under test. */
async function fetchRetry(url, init) {
  let lastError = new Error('fetchRetry: no attempt ran');
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      return await fetch(url, init);
    } catch (thrown) {
      const transient = thrown?.cause?.code === 'EADDRINUSE';
      if (!transient) throw thrown;
      lastError = thrown;
      await sleep(100);
    }
  }
  throw lastError;
}

/** Read SSE replay frames until the log head from the hello frame is reached. */
async function readReplayIds(lastEventId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const ids = [];
  try {
    const res = await fetchRetry(`${BASE}/v1/events`, {
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

async function post(path, body) {
  const res = await fetchRetry(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

async function postTurn(sceneId, expectStatus = 202) {
  const res = await post('/v1/commands/start-turn', {
    world_id: 'w1',
    actor_id: 'user:owner',
    scene_id: sceneId,
    text: 'Harness turn.',
  });
  if (res.status !== expectStatus) fail(`start-turn returned ${res.status}`);
  const body = await res.json();
  return body.turn_id;
}

/**
 * Poll open-scene until the fan-out jobs drain (criterion b: blocked ONLY
 * while this world + involved characters owe jobs). The first 409 also runs
 * the cross-world probe: another world must open instantly.
 */
let crossWorldProbed = false;
let crossWorldSceneSeq = 0;
async function openSceneWhenUnblocked(sceneId, deadlineMs = 60000) {
  const startedAt = Date.now();
  for (;;) {
    const res = await post('/v1/commands/open-scene', {
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: sceneId,
      title: `Harness scene ${sceneId}`,
      participants: ['char:elias'],
    });
    if (res.status === 202) return;
    if (res.status !== 409) fail(`open-scene returned ${res.status}`);
    if (!crossWorldProbed) {
      crossWorldProbed = true;
      crossWorldSceneSeq += 1;
      const probe = await post('/v1/commands/open-scene', {
        world_id: 'w2-probe',
        actor_id: 'user:owner',
        scene_id: `w2-probe-s${crossWorldSceneSeq}`,
        title: 'Cross-world probe',
        participants: ['char:elias'],
      });
      if (probe.status !== 202) {
        fail(
          `criterion b violated: w1 jobs blocked an unrelated world (status ${probe.status})`,
        );
      }
      console.log(
        'criterion b probe ok: w1 blocked while its jobs pend, w2 opened instantly',
      );
    }
    if (Date.now() - startedAt > deadlineMs) {
      fail(`open-scene still blocked after ${deadlineMs} ms`);
    }
    await sleep(500);
  }
}

/** Drive one turn and abort the SSE client mid-stream (the disconnect case:
 * a vanished reader must cost nothing durable — the turn still commits). */
async function driveClientDisconnect(sceneId) {
  const controller = new AbortController();
  const res = await fetchRetry(`${BASE}/v1/events`, {
    signal: controller.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  const turnId = await postTurn(sceneId);

  let buffer = '';
  const deadline = Date.now() + 10000;
  streamWait: for (;;) {
    if (Date.now() > deadline) fail('client_disconnect: no stream frame seen');
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const block of buffer.split('\n\n')) {
      if (block.startsWith('event: stream')) break streamWait;
    }
  }
  controller.abort(); // the disconnect, mid-narration

  const commitDeadline = Date.now() + 15000;
  while (!dbHasCommittedTurn(turnId)) {
    if (Date.now() > commitDeadline) {
      fail('client_disconnect: turn never committed after disconnect');
    }
    await sleep(250);
  }
}

function runVerify() {
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [join(ROOT, 'tools', 'verify-consistency.mjs'), dbPath, imagesDir],
      {
        stdio: 'inherit',
      },
    );
    proc.on('exit', (code) => resolve(code));
  });
}

let previousMax = 0;
let currentScene = 's1';
let sceneSeq = 0;
let needNewScene = false;
let paintSeq = 0;

for (let cycle = 0; cycle < CYCLES; cycle++) {
  const point = POINTS[cycle % POINTS.length];
  rotatePort();
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

  // A scene ended by a previous cycle needs a successor — and getting one is
  // itself the criterion-b demonstration (blocked only while jobs pend).
  if (needNewScene) {
    sceneSeq += 1;
    currentScene = `s-h${sceneSeq}`;
    await openSceneWhenUnblocked(currentScene);
    needNewScene = false;
  }

  switch (point) {
    case 'mid_stream':
    case 'between_calls':
    case 'pre_commit': {
      const killAt = waitForLine(child, `FAULT_POINT:${point}`, 20000);
      await postTurn(currentScene);
      await killAt;
      break;
    }
    case 'mid_reflection': {
      // A committed turn gives the scene a participant to reflect.
      const committed = waitForLine(child, 'FAULT_POINT:pre_commit', 20000);
      const turnId = await postTurn(currentScene);
      await committed;
      const commitDeadline = Date.now() + 15000;
      while (!dbHasCommittedTurn(turnId)) {
        if (Date.now() > commitDeadline)
          fail('mid_reflection: seed turn never committed');
        await sleep(250);
      }
      const killAt = waitForLine(child, 'FAULT_POINT:mid_reflection', 25000);
      const res = await post('/v1/commands/end-scene', {
        world_id: 'w1',
        actor_id: 'user:owner',
        scene_id: currentScene,
      });
      if (res.status !== 202) fail(`end-scene returned ${res.status}`);
      needNewScene = true;
      await killAt;
      break;
    }
    case 'mid_painter': {
      paintSeq += 1;
      const killAt = waitForLine(child, 'FAULT_POINT:mid_painter', 25000);
      const res = await post('/v1/commands/paint-region', {
        world_id: 'w1',
        actor_id: 'user:owner',
        image_id: 'map:w1',
        region: {
          x: 32 * (paintSeq % 8),
          y: 32 * (paintSeq % 8),
          width: 64,
          height: 64,
        },
        request_id: `harness-${paintSeq}`,
      });
      if (res.status !== 202) fail(`paint-region returned ${res.status}`);
      await killAt;
      break;
    }
    case 'mid_cron': {
      const killAt = waitForLine(child, 'FAULT_POINT:mid_cron', 25000);
      const res = await post('/v1/commands/advance-time', {
        world_id: 'w1',
        actor_id: 'user:owner',
        minutes: 1440,
      });
      if (res.status !== 202) fail(`advance-time returned ${res.status}`);
      await killAt;
      break;
    }
    case 'client_disconnect': {
      await driveClientDisconnect(currentScene);
      break;
    }
    default:
      fail(`unknown fault point ${point}`);
  }

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
  `kill-harness: ${CYCLES} cycles over ${POINTS.length} fault points, zero duplicate or lost events, zero corrupted images, resume exact`,
);
