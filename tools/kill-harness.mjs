// The kill harness (Invariant I4, permanent CI): SIGKILL the REAL server at
// named fault points, restart, verify consistency offline, and prove a
// reconnecting SSE client resumes via Last-Event-ID with every missed event
// exactly once. M2 extends the Week-1 table (Brief §4): mid_reflection,
// mid_painter, mid_cron, client_disconnect — plus the criterion-b probe
// (scene opens block only on THAT world's pending jobs).
// CYCLES=25 per PR, 100 nightly. Usage: CYCLES=25 node tools/kill-harness.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = join(ROOT, 'apps', 'server', 'dist', 'main.js');
// The update fixtures reuse the compiled test helpers (tsc -b builds tests/).
// Windows: dynamic import of an absolute path needs a file:// URL.
const { generateMinisignKeypair, minisignSign } = await import(
  pathToFileURL(join(ROOT, 'tests', 'dist', 'helpers', 'minisign.js')).href
);
const { buildTarGz } = await import(
  pathToFileURL(join(ROOT, 'tests', 'dist', 'helpers', 'tar.js')).href
);
const POINTS = [
  'mid_stream',
  'between_calls',
  'pre_commit',
  'mid_reflection',
  'mid_painter',
  'mid_cron',
  'client_disconnect',
  'mid_update',
  'mid_materialize',
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
const versionsDir = join(dataDir, 'versions');

// ---- Local release fixture (mid_update): a real HTTP server serving a
// signed artifact trio, fresh version per mid_update cycle so the staged
// idempotency gate never skips the fault window.
const updateKeypair = generateMinisignKeypair();
let updateSeq = 0;
const updateVersion = () => `0.2.${updateSeq}`;
const releaseCache = new Map();
function releaseFixture(version) {
  let entry = releaseCache.get(version);
  if (entry) return entry;
  const base = `weltari-app-${version}-${process.platform}-${process.arch}.tar.gz`;
  const artifact = buildTarGz([
    { path: 'dist' },
    { path: 'dist/main.js', data: `// weltari ${version} (harness fixture)` },
    { path: 'package.json', data: `{"version":"${version}"}` },
  ]);
  const sha = createHash('sha256').update(artifact).digest('hex');
  entry = {
    json: JSON.stringify({
      tag_name: `v${version}`,
      html_url: `http://127.0.0.1/releases/v${version}`,
      assets: [base, `${base}.minisig`, `${base}.sha256`].map((name) => ({
        name,
        browser_download_url: `http://127.0.0.1:${releasePort}/assets/${name}`,
      })),
    }),
    files: new Map([
      [base, artifact],
      [`${base}.minisig`, Buffer.from(minisignSign(artifact, updateKeypair))],
      [`${base}.sha256`, Buffer.from(`${sha}  ${base}\n`)],
    ]),
  };
  releaseCache.set(version, entry);
  return entry;
}
const releaseServer = createServer((req, res) => {
  const fixture = releaseFixture(updateVersion());
  if (req.url === '/latest') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(fixture.json);
    return;
  }
  const asset = req.url?.startsWith('/assets/')
    ? fixture.files.get(decodeURIComponent(req.url.slice('/assets/'.length)))
    : undefined;
  if (asset === undefined) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/octet-stream' });
  res.end(asset);
});
let releasePort = PORT_BASE + 600;
for (;;) {
  try {
    await new Promise((resolve, reject) => {
      releaseServer.once('error', reject);
      releaseServer.listen(releasePort, '127.0.0.1', resolve);
    });
    break;
  } catch (error) {
    if (error?.code !== 'EADDRINUSE' || releasePort > PORT_BASE + 650)
      throw error;
    releasePort += 1;
  }
}

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

/** Exactly-once check for a fog square (I4/I3: retries converge, never twin). */
function dbCountMaterialized(square) {
  const db = new Database(dbPath);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE type = 'sublocation.materialized' AND payload LIKE ?`,
    )
    .get(`%"square":{"col":${square.col},"row":${square.row}}%`);
  db.close();
  return row.n;
}

function dbHasStagedUpdate(version) {
  const db = new Database(dbPath);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE type = 'update.staged' AND payload LIKE ?`,
    )
    .get(`%"${version}"%`);
  db.close();
  return row.n > 0;
}

function readPointer() {
  const file = join(versionsDir, 'current');
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8').trim();
  return text === '' ? null : text;
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
      WELTARI_VERSIONS_DIR: versionsDir,
      WELTARI_UPDATE_PUBKEY: updateKeypair.publicKeyBase64,
      WELTARI_UPDATE_RELEASES_URL: `http://127.0.0.1:${releasePort}/latest`,
      WELTARI_APP_VERSION: '0.1.0',
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
      [
        join(ROOT, 'tools', 'verify-consistency.mjs'),
        dbPath,
        imagesDir,
        versionsDir,
      ],
      {
        stdio: 'inherit',
      },
    );
    proc.on('exit', (code) => resolve(code));
  });
}

let previousMax = 0;
let currentScene = null;
let sceneSeq = 0;
// M4 part 2: a fresh world no longer auto-opens a scene (the splash is the
// entry surface), so the harness opens its first scene like any client would.
let needNewScene = true;
let paintSeq = 0;
let pendingUpdate = null;
// Fog squares for mid_materialize cycles: skip the fixture trio's squares
// (3,4)/(3,5)/(4,2) so every explore hits virgin fog.
const FIXTURE_SQUARES = new Set(['3,4', '3,5', '4,2']);
let squareSeq = 0;
function nextFreeSquare() {
  for (;;) {
    const col = squareSeq % 8;
    const row = Math.floor(squareSeq / 8) % 8;
    squareSeq += 1;
    if (!FIXTURE_SQUARES.has(`${col},${row}`)) return { col, row };
  }
}
let pendingSquare = null;

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

  // Criterion (a), M3 part 2: a kill at mid_update must CONVERGE after
  // restart — the leased job retries, re-verifies, and completes the flip.
  if (pendingUpdate !== null) {
    const deadline = Date.now() + 30000;
    while (
      !dbHasStagedUpdate(pendingUpdate) ||
      readPointer() !== pendingUpdate
    ) {
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        fail(
          `update ${pendingUpdate} never converged after mid_update kill (pointer=${readPointer()})`,
        );
      }
      await sleep(500);
    }
    console.log(
      `mid_update convergence ok: ${pendingUpdate} staged + pointer flipped after restart`,
    );
    pendingUpdate = null;
  }

  // Criterion (d), M4 part 2: a kill at mid_materialize must CONVERGE after
  // restart — the leased job retries and the square materializes EXACTLY once
  // (no duplicate squares, no lost reveal).
  if (pendingSquare !== null) {
    const deadline = Date.now() + 30000;
    for (;;) {
      const count = dbCountMaterialized(pendingSquare);
      if (count === 1) break;
      if (count > 1) {
        child.kill('SIGKILL');
        fail(
          `duplicate square: ${count} sublocation.materialized rows for ${JSON.stringify(pendingSquare)}`,
        );
      }
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        fail(
          `lost reveal: square ${JSON.stringify(pendingSquare)} never materialized after mid_materialize kill`,
        );
      }
      await sleep(500);
    }
    console.log(
      `mid_materialize convergence ok: square ${JSON.stringify(pendingSquare)} materialized exactly once after restart`,
    );
    pendingSquare = null;
  }

  // A scene ended by a previous cycle needs a successor — and getting one is
  // itself the criterion-b demonstration (blocked only while jobs pend).
  // The FIRST cycle opens one too: fresh worlds boot scene-less (M4 part 2).
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
    case 'mid_materialize': {
      const square = nextFreeSquare();
      const killAt = waitForLine(child, 'FAULT_POINT:mid_materialize', 25000);
      const res = await post('/v1/commands/explore', {
        world_id: 'w1',
        actor_id: 'user:owner',
        square,
      });
      if (res.status !== 202) fail(`explore returned ${res.status}`);
      await killAt;
      pendingSquare = square;
      break;
    }
    case 'mid_update': {
      updateSeq += 1; // fresh version: the staged-idempotency gate must not skip the window
      const version = updateVersion();
      const killAt = waitForLine(child, 'FAULT_POINT:mid_update', 30000);
      const res = await post('/v1/commands/apply-update', {
        world_id: 'w1',
        actor_id: 'user:owner',
        version,
      });
      if (res.status !== 202) fail(`apply-update returned ${res.status}`);
      await killAt;
      pendingUpdate = version;
      break;
    }
    default:
      fail(`unknown fault point ${point}`);
  }

  child.kill('SIGKILL'); // Windows: unconditional termination
  await exited(child);

  // Torn-flip check (B12): if the kill landed after the pointer write, the
  // pointer must name a COMPLETE version dir (rename happens before the flip).
  if (point === 'mid_update' && pendingUpdate !== null) {
    const pointer = readPointer();
    if (pointer === pendingUpdate && !existsSync(join(versionsDir, pointer))) {
      fail('torn update flip: pointer names a missing version dir');
    }
  }

  const verifyCode = await runVerify();
  if (verifyCode !== 0)
    fail(`cycle ${cycle}: verify-consistency failed after kill at ${point}`);

  previousMax = dbEventIdsAbove(0).at(-1) ?? 0;
  console.log(
    `cycle ${cycle + 1}/${CYCLES} ok (killed at ${point}, log head ${previousMax})`,
  );
}

releaseServer.close();
console.log(
  `kill-harness: ${CYCLES} cycles over ${POINTS.length} fault points, zero duplicate or lost events, zero corrupted images, zero torn update flips, resume exact`,
);
