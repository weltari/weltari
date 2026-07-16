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
  'mid_map_edit',
  'mid_map_click',
  // M6 part 1: the in-scene creation loop — a Narrator create_sublocation
  // turn whose PARENTLESS stub is killed mid-placement (the stub branch of
  // the materialize handler shares the mid_materialize fault point; the
  // creation commit itself is one transaction with the turn).
  'mid_stub_create',
  // M6 part 2 (Weltari Chat): a DM'd + exited conversation whose reflect_chat
  // job is killed mid-reflection; convergence = exactly one
  // reflect_chat.committed for the range (Elias is in_scene during harness
  // cycles, so the DM stores without a reply — fully deterministic).
  'mid_reflect_chat',
  // M6 part 3 (proactive CRON DMs): a scheduler fire killed mid-commit —
  // the DM is generated, the message + outreach transaction not yet
  // appended; convergence = the retried job commits EXACTLY one
  // chat.outreach_recorded for the occurrence (the fire's natural key).
  // The cycle resets the thread first (a user line + exit while Elias is
  // still in_scene — no reply generates), then frees him by ending the
  // scene, so eligibility is deterministic. Cadence env: 0.02 min = 1.2 s.
  'mid_proactive_dm',
  // M6 part 4 (invitation expiry, Rev 4 §7): a character-fired startscene
  // sits pending, a 12 h skip crosses its 6 h window, and the sweep is
  // killed BEFORE the scene.expired + cache.appended pair commits;
  // convergence = the BOOT sweep (recovery path = startup path) commits the
  // pair exactly once (natural key scene_id, fused re-check).
  'mid_invitation_expiry',
  // M6 part 5 (the Feed, Rev 4 §12): a 12 h skip crosses one social cadence
  // boundary (default 2 posts/game day = 720 min) and the social_post job is
  // killed AFTER generation, BEFORE the post + poster-CACHE + reaction-job
  // transaction; convergence = the retried fire commits EXACTLY one
  // social.post_committed for the occurrence (natural key world +
  // occurrence_iso, fused re-check). The scene is ended first so both
  // fixture characters are available — the salted pick lands first try.
  'mid_social_post',
  // M7 part 1 (the memory store, Rev 4 §11): a scene reflection killed
  // inside the NEW memory-commit window — deltas/core gated, the atomic
  // append (reflection + CACHE + memory events) not yet written; convergence
  // = the retried job commits EXACTLY one reflection and EXACTLY one delta
  // set (the fake scripts two scene deltas) for the (character, scene).
  'mid_memory_commit',
  // M7 part 1: the compaction pass killed AFTER the summary generation,
  // BEFORE memory.compacted appends. The cycle grows Elias's uncompacted
  // archive past the trigger (each scene end reflects 2 deltas) until the
  // pass fires; convergence = the retried job commits at least one record,
  // and per-range uniqueness is verify-consistency's 4l sweep.
  'mid_compaction',
  // M7 part 2 (the Proposal pipeline, Rev 4 §16): the GM proposes a place
  // through its own conversation (!proposeplace), and the user's APPROVE is
  // killed inside the apply window — every gate passed, the atomic append
  // (proposal.resolved + applied rows + backdrop job) not yet written;
  // convergence = the killed resolve half-applied NOTHING and a fresh
  // resolve applies EXACTLY once (natural key proposal_id; 4m sweeps the
  // resolution↔rows pairing).
  'mid_proposal_apply',
  // M7 part 2 (GM Job 2): profiling ON, a one-line chat range closes and
  // enqueues the analysis; the job is killed AFTER generation + gating,
  // BEFORE the side-store rows + profile.updated transaction; convergence =
  // the retried job commits EXACTLY one hypothesis set (the fake scripts
  // two) for the (actor, context).
  'mid_profile_analysis',
  // M7 part 3 (objects, Rev 4 §7): a character materializes a payload-less
  // stray (!obj) in a scene, the scene ends (enqueuing the object_gc sweep),
  // and the sweep is killed BEFORE its tombstone transaction; convergence =
  // the retried job sweeps the stray EXACTLY once (row gone, ONE
  // object.swept, the object.created stays in the log — I1).
  'mid_object_gc',
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

/** Exactly-once checks for a Narrator stub (M6 part 1): the identity commit
 * and its materialization each happen at most once per stub id. */
function dbCountStub(stubId) {
  const db = new Database(dbPath);
  const created = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE type = 'sublocation.stub_created' AND payload LIKE ?`,
    )
    .get(`%"sublocation_id":"${stubId}"%`).n;
  const materialized = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE type = 'sublocation.materialized' AND payload LIKE ?`,
    )
    .get(`%"sublocation_id":"${stubId}"%`).n;
  const backdrops = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE type = 'painter.completed' AND payload LIKE ?`,
    )
    .get(`%"image_id":"backdrop:${stubId}"%`).n;
  db.close();
  return { created, materialized, backdrops };
}

/** Exactly-once check for a Flow-A edit (the retry must converge, never twin). */
function dbCountCreated(editId) {
  const db = new Database(dbPath);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE type = 'sublocation.created' AND payload LIKE ?`,
    )
    .get(`%"edit_id":"${editId}"%`);
  db.close();
  return row.n;
}

/** The invitation cycle's pending scene (M6 part 4): the first scene.started
 * above sinceId that carries an invitation — the character-fired bridge's
 * commit; null until the detached reply lands. */
function dbFindInvitationSceneAbove(sinceId) {
  const db = new Database(dbPath);
  const row = db
    .prepare(
      `SELECT payload FROM events
       WHERE id > ? AND type = 'scene.started' AND payload LIKE '%"invitation"%'
       ORDER BY id LIMIT 1`,
    )
    .get(sinceId);
  db.close();
  return row === undefined ? null : JSON.parse(row.payload).scene_id;
}

/** Exactly-once check for an invitation expiry (natural key scene_id). */
function dbCountExpired(sceneId) {
  const db = new Database(dbPath);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE type = 'scene.expired' AND payload LIKE ?`,
    )
    .get(`%"scene_id":"${sceneId}"%`);
  db.close();
  return row.n;
}

/** Exactly-once check for a Flow-B click resolution. */
function dbCountResolved(clickId) {
  const db = new Database(dbPath);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE type = 'map_click.resolved' AND payload LIKE ?`,
    )
    .get(`%"click_id":"${clickId}"%`);
  db.close();
  return row.n;
}

/** Exactly-once check for a chat reflection range (M6 part 2). */
function dbCountReflectChat(conversationId, rangeEndId) {
  const db = new Database(dbPath);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE type = 'reflect_chat.committed' AND payload LIKE ? AND payload LIKE ?`,
    )
    .get(
      `%"conversation_id":"${conversationId}"%`,
      `%"range_end_id":${rangeEndId}%`,
    );
  db.close();
  return row.n;
}

/** Proposal convergence (M7 part 2): the card's resolutions + applied rows. */
function dbProposalState(proposalId) {
  const db = new Database(dbPath);
  const like = `%"proposal_id":"${proposalId}"%`;
  const resolutions = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE type = 'proposal.resolved' AND payload LIKE ?`,
    )
    .get(like).n;
  const materialized = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE type = 'sublocation.materialized' AND payload LIKE ?`,
    )
    .get(like).n;
  db.close();
  return { resolutions, materialized };
}

/** One harness stray's object state (M7 part 3): the live row count, its
 * tombstone count, and whether the creating event still stands (I1). */
function dbObjectGcState(name) {
  const db = new Database(dbPath);
  const liveRows = db
    .prepare('SELECT COUNT(*) AS n FROM objects WHERE name = ?')
    .get(name).n;
  const createdRow = db
    .prepare(
      `SELECT payload FROM events
       WHERE type = 'object.created' AND payload LIKE ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(`%"name":"${name}"%`);
  let swept = 0;
  if (createdRow !== undefined) {
    const objectId = JSON.parse(createdRow.payload).object_id;
    swept = db
      .prepare(
        `SELECT COUNT(*) AS n FROM events
         WHERE type = 'object.swept' AND payload LIKE ?`,
      )
      .get(`%"object_id":"${objectId}"%`).n;
  }
  db.close();
  return { liveRows, swept, created: createdRow === undefined ? 0 : 1 };
}

/** The GM card for one harness place name (the reply commits detached —
 * cycles poll until the card lands). */
function dbProposalIdByPlace(name) {
  const db = new Database(dbPath);
  const row = db
    .prepare(
      `SELECT payload FROM events
       WHERE type = 'proposal.submitted' AND payload LIKE ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(`%"name":"${name}"%`);
  db.close();
  return row ? JSON.parse(row.payload).proposal_id : null;
}

/** Profiling convergence (M7 part 2): side-store rows + the count event. */
function dbProfileState(contextId) {
  const db = new Database(dbPath);
  const rows = db
    .prepare(`SELECT COUNT(*) AS n FROM user_profile WHERE context_id = ?`)
    .get(contextId).n;
  const updated = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE type = 'profile.updated' AND payload LIKE ?`,
    )
    .get(`%"context_id":"${contextId}"%`).n;
  db.close();
  return { rows, updated };
}

/** Feed convergence (M6 part 5): posts committed after a log head. */
function dbCountPostsAbove(sinceId) {
  const db = new Database(dbPath);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE type = 'social.post_committed' AND id > ?`,
    )
    .get(sinceId);
  db.close();
  return row.n;
}

/** Memory convergence (M7 part 1): the reflection + its delta set for one
 * (character, scene) — exactly one reflection, exactly one delta set. */
function dbCountMemoryFor(sceneId) {
  const db = new Database(dbPath);
  const reflections = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE type = 'reflection.committed' AND payload LIKE ?`,
    )
    .get(`%"scene_id":"${sceneId}"%`).n;
  const deltas = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE type = 'memory.delta_committed' AND payload LIKE ?`,
    )
    .get(`%"context_id":"${sceneId}"%`).n;
  db.close();
  return { reflections, deltas };
}

/** Compaction convergence (M7 part 1): records committed after a log head. */
function dbCountCompactionsAbove(sinceId) {
  const db = new Database(dbPath);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE type = 'memory.compacted' AND id > ?`,
    )
    .get(sinceId);
  db.close();
  return row.n;
}

/** Elias's uncompacted delta count — deltas newer than the latest record's
 * up_to_id (the compaction trigger's own arithmetic, read offline). */
function dbCountUncompactedDeltas() {
  const db = new Database(dbPath);
  const upTo =
    db
      .prepare(
        `SELECT MAX(json_extract(payload, '$.up_to_id')) AS m FROM events
         WHERE type = 'memory.compacted' AND payload LIKE '%"char:elias"%'`,
      )
      .get().m ?? 0;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE type = 'memory.delta_committed' AND id > ?
         AND payload LIKE '%"character_id":"char:elias"%'`,
    )
    .get(upTo);
  db.close();
  return row.n;
}

/** Proactive-DM convergence (I4): outreaches committed after a log head. */
function dbCountOutreachAbove(sinceId) {
  const db = new Database(dbPath);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE type = 'chat.outreach_recorded' AND id > ?`,
    )
    .get(sinceId);
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

function spawnServer(extraEnv = {}) {
  const child = spawn(process.execPath, [MAIN], {
    env: {
      ...process.env,
      ...extraEnv,
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

async function postTurn(sceneId, expectStatus = 202, text = 'Harness turn.') {
  const res = await post('/v1/commands/start-turn', {
    world_id: 'w1',
    actor_id: 'user:owner',
    scene_id: sceneId,
    text,
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
// Flow-A edits: a fresh triangle over the common-room square each cycle —
// the edit_id keys everything, so identical geometry is fine.
let editSeq = 0;
let pendingEdit = null;
// Flow-B classify clicks must land OUTSIDE all radii: corner points of the
// fixture squares, far enough from every anchor AND from each other that
// earlier cycles' persistent spawns (radius = half a square) never swallow a
// later point.
// M6 part 1 creation-loop cycles: a parentless Narrator create killed
// mid-placement; convergence = the stub committed once, materialized once,
// and its backdrop landed.
let stubSeq = 0;
let pendingStub = null;
const CLICK_POINTS = [
  { x: 0.495, y: 0.505 }, // corners of the common-room square (3,4)…
  { x: 0.38, y: 0.62 },
  { x: 0.495, y: 0.62 },
  { x: 0.505, y: 0.255 }, // …the shrine square (4,2)…
  { x: 0.62, y: 0.255 },
  { x: 0.505, y: 0.37 },
  { x: 0.495, y: 0.745 }, // …and the cellar square (3,5): each ≥ the enter
  // radius from every fixture anchor, the harness-edit centroid (~0.42,0.55),
  // every possible materialized square center, and each other.
];
let clickSeq = 0;
let pendingClick = null;
// M6 part 2 chat cycles: DM + exit → reflect_chat killed mid-reflection;
// convergence = exactly one reflect_chat.committed for the exited range.
let chatSeq = 0;
let pendingReflectChat = null;
// M6 part 3 proactive cycles: a CRON fire killed mid-commit; convergence =
// the retried job commits its outreach exactly once (natural key).
let proactiveSeq = 0;
let pendingProactive = null;
// M6 part 4 invitation cycles: the expiry sweep killed mid-commit;
// convergence = the boot sweep commits the pair exactly once.
let inviteSeq = 0;
let pendingInvitationScene = null;
// M6 part 5 feed cycles: the social_post fire killed mid-commit;
// convergence = the retried fire commits exactly one post (natural key).
let pendingSocialPost = null;
// M7 part 1 memory cycles: a reflection killed inside the memory-commit
// window; convergence = one reflection + one delta set for the scene.
let pendingMemoryScene = null;
// M7 part 1 compaction cycles: the pass killed before its record appends;
// convergence = at least one memory.compacted above the cycle's log head
// (per-range uniqueness is verify-consistency's 4l sweep).
let pendingCompaction = null;
// M7 part 2 proposal cycles: the approve killed inside the apply window;
// convergence = zero half-applied rows and a fresh resolve applies once.
let pendingProposal = null;
let proposalSeq = 0;
// M7 part 2 profiling cycles: the analysis killed before its transaction;
// convergence = exactly one hypothesis set per (actor, context).
let pendingProfile = null;
let profileSeq = 0;
let objectGcSeq = 0;
let pendingObjectGc = null;

for (let cycle = 0; cycle < CYCLES; cycle++) {
  const point = POINTS[cycle % POINTS.length];
  rotatePort();
  // Proactive DMs ride the game clock since M6 part 4 (owner ruling
  // 2026-07-10/11) — the default daily cadence stays on; fires only ever
  // happen when a cycle advances time, and Elias is in_scene during those,
  // so no stray outreach perturbs other cycles.
  const child = spawnServer({});
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

  // M5 part 2: a kill at mid_map_edit must CONVERGE — the leased job retries
  // and the sublocation is created EXACTLY once (no twins, no lost edit).
  if (pendingEdit !== null) {
    const deadline = Date.now() + 30000;
    for (;;) {
      const count = dbCountCreated(pendingEdit);
      if (count === 1) break;
      if (count > 1) {
        child.kill('SIGKILL');
        fail(
          `duplicate edit: ${count} sublocation.created rows for ${pendingEdit}`,
        );
      }
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        fail(`lost edit: ${pendingEdit} never created after mid_map_edit kill`);
      }
      await sleep(500);
    }
    console.log(
      `mid_map_edit convergence ok: ${pendingEdit} created exactly once after restart`,
    );
    pendingEdit = null;
  }

  // M5 part 2: a kill at mid_map_click must CONVERGE — the click resolves
  // EXACTLY once (no duplicate spawns, no lost resolution).
  if (pendingClick !== null) {
    const deadline = Date.now() + 30000;
    for (;;) {
      const count = dbCountResolved(pendingClick);
      if (count === 1) break;
      if (count > 1) {
        child.kill('SIGKILL');
        fail(
          `duplicate resolution: ${count} map_click.resolved rows for ${pendingClick}`,
        );
      }
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        fail(
          `lost click: ${pendingClick} never resolved after mid_map_click kill`,
        );
      }
      await sleep(500);
    }
    console.log(
      `mid_map_click convergence ok: ${pendingClick} resolved exactly once after restart`,
    );
    pendingClick = null;
  }

  // M6 part 1: a kill mid-stub-placement must CONVERGE — the stub committed
  // exactly once (atomic with its turn), its materialization retries to
  // exactly one row, and its backdrop paint lands.
  if (pendingStub !== null) {
    const deadline = Date.now() + 30000;
    for (;;) {
      const counts = dbCountStub(pendingStub);
      if (counts.created !== 1) {
        child.kill('SIGKILL');
        fail(
          `stub ${pendingStub}: ${counts.created} sublocation.stub_created rows (expected exactly 1)`,
        );
      }
      if (counts.materialized > 1) {
        child.kill('SIGKILL');
        fail(
          `duplicate stub placement: ${counts.materialized} sublocation.materialized rows for ${pendingStub}`,
        );
      }
      if (counts.materialized === 1 && counts.backdrops >= 1) break;
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        fail(
          `stub ${pendingStub} never converged (materialized=${counts.materialized}, backdrops=${counts.backdrops})`,
        );
      }
      await sleep(500);
    }
    console.log(
      `mid_stub_create convergence ok: ${pendingStub} committed once, placed once, backdrop landed`,
    );
    pendingStub = null;
  }

  // M6 part 2: a kill at mid_reflect_chat must CONVERGE — the leased job
  // retries and the range reflects EXACTLY once (no twins, no lost note).
  if (pendingReflectChat !== null) {
    const deadline = Date.now() + 30000;
    for (;;) {
      const count = dbCountReflectChat(
        pendingReflectChat.conversationId,
        pendingReflectChat.rangeEndId,
      );
      if (count === 1) break;
      if (count > 1) {
        child.kill('SIGKILL');
        fail(
          `duplicate reflection: ${count} reflect_chat.committed rows for range ${pendingReflectChat.rangeEndId}`,
        );
      }
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        fail(
          `lost reflection: range ${pendingReflectChat.rangeEndId} never reflected after mid_reflect_chat kill`,
        );
      }
      await sleep(500);
    }
    console.log(
      `mid_reflect_chat convergence ok: range ${pendingReflectChat.rangeEndId} reflected exactly once after restart`,
    );
    pendingReflectChat = null;
  }

  // M6 part 3: a kill at mid_proactive_dm must CONVERGE — the leased fire
  // retries and commits its outreach (message + record atomically) exactly
  // once; per-occurrence uniqueness is verify-consistency's dup check.
  if (pendingProactive !== null) {
    const deadline = Date.now() + 30000;
    while (dbCountOutreachAbove(pendingProactive) < 1) {
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        fail(
          'lost proactive DM: no chat.outreach_recorded committed after mid_proactive_dm kill',
        );
      }
      await sleep(500);
    }
    console.log(
      'mid_proactive_dm convergence ok: the fire committed its outreach after restart',
    );
    pendingProactive = null;
  }

  // M6 part 4: a kill at mid_invitation_expiry must CONVERGE — the boot
  // sweep (recovery path = startup path) expires the still-pending
  // invitation exactly once; pair atomicity is verify-consistency's 4j.
  if (pendingInvitationScene !== null) {
    const deadline = Date.now() + 30000;
    while (dbCountExpired(pendingInvitationScene) < 1) {
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        fail(
          'lost invitation expiry: no scene.expired committed after mid_invitation_expiry kill',
        );
      }
      await sleep(500);
    }
    if (dbCountExpired(pendingInvitationScene) > 1) {
      child.kill('SIGKILL');
      fail('twinned invitation expiry: scene.expired committed twice');
    }
    console.log(
      'mid_invitation_expiry convergence ok: the boot sweep expired the invitation exactly once',
    );
    pendingInvitationScene = null;
  }

  // M6 part 5: a kill at mid_social_post must CONVERGE — the leased fire
  // retries and commits its post (+ poster CACHE + reaction jobs, one
  // transaction) exactly once; per-occurrence uniqueness across the whole
  // log is verify-consistency's 4k sweep.
  if (pendingSocialPost !== null) {
    const deadline = Date.now() + 30000;
    while (dbCountPostsAbove(pendingSocialPost) < 1) {
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        fail(
          'lost feed post: no social.post_committed committed after mid_social_post kill',
        );
      }
      await sleep(500);
    }
    if (dbCountPostsAbove(pendingSocialPost) > 1) {
      child.kill('SIGKILL');
      fail('twinned feed post: social.post_committed committed twice');
    }
    console.log(
      'mid_social_post convergence ok: the fire committed its post exactly once after restart',
    );
    pendingSocialPost = null;
  }

  // M7 part 1: a kill at mid_memory_commit must CONVERGE — the retried
  // reflection commits EXACTLY one reflection.committed and EXACTLY one
  // delta set (the fake scripts two scene deltas) for the (character, scene).
  if (pendingMemoryScene !== null) {
    const deadline = Date.now() + 30000;
    for (;;) {
      const counts = dbCountMemoryFor(pendingMemoryScene);
      if (counts.reflections === 1 && counts.deltas === 2) break;
      if (counts.reflections > 1 || counts.deltas > 3) {
        child.kill('SIGKILL');
        fail(
          `duplicate memory commit for ${pendingMemoryScene}: ${counts.reflections} reflections, ${counts.deltas} deltas`,
        );
      }
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        fail(
          `lost memory commit: ${pendingMemoryScene} never converged (${counts.reflections} reflections, ${counts.deltas} deltas) after mid_memory_commit kill`,
        );
      }
      await sleep(500);
    }
    console.log(
      `mid_memory_commit convergence ok: ${pendingMemoryScene} reflected once with exactly one delta set after restart`,
    );
    pendingMemoryScene = null;
  }

  // M7 part 1: a kill at mid_compaction must CONVERGE — the leased pass
  // retries and commits its record (never twinned: 4l sweeps uniqueness).
  if (pendingCompaction !== null) {
    const deadline = Date.now() + 30000;
    while (dbCountCompactionsAbove(pendingCompaction) < 1) {
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        fail(
          'lost compaction: no memory.compacted committed after mid_compaction kill',
        );
      }
      await sleep(500);
    }
    console.log(
      'mid_compaction convergence ok: the pass committed its record after restart',
    );
    pendingCompaction = null;
  }

  // M7 part 2: a kill at mid_proposal_apply must CONVERGE — the killed
  // resolve was synchronous, so either it committed whole before the kill
  // or NOTHING happened (never a torn apply); a fresh resolve applies the
  // card exactly once.
  if (pendingProposal !== null) {
    const before = dbProposalState(pendingProposal);
    if (before.resolutions === 0 && before.materialized > 0) {
      child.kill('SIGKILL');
      fail(
        `torn proposal apply: ${pendingProposal} has rows without a resolution`,
      );
    }
    if (before.resolutions === 0) {
      const res = await post('/v1/commands/resolve-proposal', {
        world_id: 'w1',
        actor_id: 'user:owner',
        proposal_id: pendingProposal,
        resolution: 'approved',
      });
      if (res.status !== 202) {
        child.kill('SIGKILL');
        fail(`resolve-proposal retry returned ${res.status}`);
      }
    }
    const state = dbProposalState(pendingProposal);
    if (state.resolutions !== 1 || state.materialized !== 1) {
      child.kill('SIGKILL');
      fail(
        `proposal ${pendingProposal} did not converge: ${state.resolutions} resolutions, ${state.materialized} rows`,
      );
    }
    console.log(
      'mid_proposal_apply convergence ok: the card applied exactly once after restart',
    );
    pendingProposal = null;
  }

  // M7 part 2: a kill at mid_profile_analysis must CONVERGE — the leased
  // job retries and commits exactly one hypothesis set for the context.
  if (pendingProfile !== null) {
    const deadline = Date.now() + 30000;
    for (;;) {
      const state = dbProfileState(pendingProfile);
      if (state.rows === 2 && state.updated === 1) break;
      if (state.rows > 2 || state.updated > 1) {
        child.kill('SIGKILL');
        fail(
          `duplicate profile analysis for ${pendingProfile}: ${state.rows} rows, ${state.updated} updates`,
        );
      }
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        fail(
          `lost profile analysis: ${pendingProfile} never converged (${state.rows} rows, ${state.updated} updates)`,
        );
      }
      await sleep(500);
    }
    console.log(
      'mid_profile_analysis convergence ok: one hypothesis set committed after restart',
    );
    pendingProfile = null;
  }

  // M7 part 3: a kill at mid_object_gc must CONVERGE — the leased sweep
  // retries and tombstones the stray EXACTLY once; the creating event stays
  // in the log (I1: the tombstone is the deletion, never an event delete).
  if (pendingObjectGc !== null) {
    const deadline = Date.now() + 30000;
    for (;;) {
      const state = dbObjectGcState(pendingObjectGc);
      if (state.created !== 1) {
        child.kill('SIGKILL');
        fail(
          `object.created for "${pendingObjectGc}" left the log (I1 broken)`,
        );
      }
      if (state.liveRows === 0 && state.swept === 1) break;
      if (state.swept > 1) {
        child.kill('SIGKILL');
        fail(
          `duplicate tombstones for "${pendingObjectGc}": ${state.swept} object.swept events`,
        );
      }
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        fail(
          `lost sweep: "${pendingObjectGc}" never converged (${state.liveRows} rows, ${state.swept} swept)`,
        );
      }
      await sleep(500);
    }
    console.log(
      'mid_object_gc convergence ok: the stray swept exactly once after restart',
    );
    pendingObjectGc = null;
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
    case 'mid_map_edit': {
      editSeq += 1;
      const editId = `harness-edit-${editSeq}`;
      const killAt = waitForLine(child, 'FAULT_POINT:mid_map_edit', 25000);
      const res = await post('/v1/commands/map-edit', {
        world_id: 'w1',
        actor_id: 'user:owner',
        points: [
          { x: 0.4, y: 0.53 },
          { x: 0.45, y: 0.53 },
          { x: 0.42, y: 0.58 },
        ],
        intent: 'a small stone well between the buildings',
        request_id: editId,
      });
      if (res.status !== 202) fail(`map-edit returned ${res.status}`);
      await killAt;
      pendingEdit = editId;
      break;
    }
    case 'mid_map_click': {
      const point = CLICK_POINTS[clickSeq % CLICK_POINTS.length];
      clickSeq += 1;
      const clickId = `harness-click-${clickSeq}`;
      const killAt = waitForLine(child, 'FAULT_POINT:mid_map_click', 25000);
      const res = await post('/v1/commands/map-click', {
        world_id: 'w1',
        actor_id: 'user:owner',
        point,
        request_id: clickId,
      });
      if (res.status !== 202) fail(`map-click returned ${res.status}`);
      const body = await res.json();
      if (body.outcome !== 'classify') {
        fail(
          `map-click at ${JSON.stringify(point)} answered ${body.outcome} — expected classify (point inside a radius?)`,
        );
      }
      await killAt;
      pendingClick = clickId;
      break;
    }
    case 'mid_stub_create': {
      stubSeq += 1;
      const slug = `harness-annex-${stubSeq}`;
      // The stub branch of the materialize handler shares mid_materialize:
      // by the time it fires, the turn (stub + job rows) has committed.
      const killAt = waitForLine(child, 'FAULT_POINT:mid_materialize', 30000);
      await postTurn(
        currentScene,
        202,
        `Somewhere new calls. !query !createwild ${slug}`,
      );
      await killAt;
      pendingStub = `subloc:stub-${slug}`;
      break;
    }
    case 'mid_reflect_chat': {
      chatSeq += 1;
      // Elias is in_scene (the harness scene) — the DM stores, no reply
      // generates, and exit-chat closes a one-message range deterministically.
      const sendRes = await post('/v1/commands/send-chat-message', {
        world_id: 'w1',
        actor_id: 'user:owner',
        character_id: 'char:elias',
        text: `Harness DM ${chatSeq}: how goes the storm?`,
        request_id: `harness-chat-${chatSeq}`,
      });
      if (sendRes.status !== 202)
        fail(`send-chat-message returned ${sendRes.status}`);
      const sendBody = await sendRes.json();
      if (sendBody.replying !== false) {
        fail(
          'presence rule violated: Elias is in a scene but the chat engine started a reply',
        );
      }
      const killAt = waitForLine(child, 'FAULT_POINT:mid_reflect_chat', 25000);
      const exitRes = await post('/v1/commands/exit-chat', {
        world_id: 'w1',
        actor_id: 'user:owner',
        character_id: 'char:elias',
      });
      if (exitRes.status !== 202) fail(`exit-chat returned ${exitRes.status}`);
      const exitBody = await exitRes.json();
      if (exitBody.ended !== true) fail('exit-chat closed nothing');
      await killAt;
      const rangeEndId = Number(exitBody.job_key.split(':').at(-1));
      pendingReflectChat = {
        conversationId: exitBody.conversation_id,
        rangeEndId,
      };
      break;
    }
    case 'mid_proactive_dm': {
      proactiveSeq += 1;
      // Reset the thread deterministically while Elias is STILL in_scene:
      // the user line stores without a reply (presence rule) and clears any
      // unanswered count; exit-chat closes the range (quiet thread).
      const resetRes = await post('/v1/commands/send-chat-message', {
        world_id: 'w1',
        actor_id: 'user:owner',
        character_id: 'char:elias',
        text: `Harness reset ${proactiveSeq}: clearing the outreach counter.`,
        request_id: `harness-proactive-reset-${proactiveSeq}`,
      });
      if (resetRes.status !== 202)
        fail(`send-chat-message returned ${resetRes.status}`);
      const resetBody = await resetRes.json();
      if (resetBody.replying !== false) {
        fail(
          'presence rule violated: Elias is in a scene but the chat engine started a reply',
        );
      }
      const exitRes = await post('/v1/commands/exit-chat', {
        world_id: 'w1',
        actor_id: 'user:owner',
        character_id: 'char:elias',
      });
      if (exitRes.status !== 202) fail(`exit-chat returned ${exitRes.status}`);
      const sinceId = dbEventIdsAbove(0).at(-1) ?? 0;
      const killAt = waitForLine(child, 'FAULT_POINT:mid_proactive_dm', 30000);
      // Free the character: the fire's eligibility needs presence available.
      const endRes = await post('/v1/commands/end-scene', {
        world_id: 'w1',
        actor_id: 'user:owner',
        scene_id: currentScene,
      });
      if (endRes.status !== 202) fail(`end-scene returned ${endRes.status}`);
      needNewScene = true;
      // The fire rides the world clock (M6 part 4): a one-day skip crosses
      // a daily boundary and enqueues + drains the occurrence on the spot.
      const advRes = await post('/v1/commands/advance-time', {
        world_id: 'w1',
        actor_id: 'user:owner',
        minutes: 1440,
      });
      if (advRes.status !== 202) fail(`advance-time returned ${advRes.status}`);
      await killAt;
      pendingProactive = sinceId;
      break;
    }
    case 'mid_invitation_expiry': {
      inviteSeq += 1;
      // Free Elias first (chat replies need presence available), then have
      // HIM fire the meeting — the character-led startscene carries the
      // game-time window (the fake scripts wait_hours 6).
      const endRes = await post('/v1/commands/end-scene', {
        world_id: 'w1',
        actor_id: 'user:owner',
        scene_id: currentScene,
      });
      if (endRes.status !== 202) fail(`end-scene returned ${endRes.status}`);
      needNewScene = true;
      const sinceId = dbEventIdsAbove(0).at(-1) ?? 0;
      const sendRes = await post('/v1/commands/send-chat-message', {
        world_id: 'w1',
        actor_id: 'user:owner',
        character_id: 'char:elias',
        text: `Meet me. !startscene harness-shrine-${inviteSeq}`,
        request_id: `harness-invite-${inviteSeq}`,
      });
      if (sendRes.status !== 202)
        fail(`send-chat-message returned ${sendRes.status}`);
      // The reply + bridge run detached (the bridge waits out the ended
      // scene's fan-out); poll for the invitation scene it opens.
      let inviteScene = null;
      const bridgeDeadline = Date.now() + 30000;
      while (inviteScene === null) {
        if (Date.now() > bridgeDeadline) {
          child.kill('SIGKILL');
          fail('no invitation scene.started committed by the bridge');
        }
        inviteScene = dbFindInvitationSceneAbove(sinceId);
        if (inviteScene === null) await sleep(250);
      }
      // A 12 h skip crosses the 6 h window: the expiry sweep runs right
      // after the advance and the kill lands inside its window.
      const killAt = waitForLine(
        child,
        'FAULT_POINT:mid_invitation_expiry',
        30000,
      );
      const advRes = await post('/v1/commands/advance-time', {
        world_id: 'w1',
        actor_id: 'user:owner',
        minutes: 720,
      });
      if (advRes.status !== 202) fail(`advance-time returned ${advRes.status}`);
      await killAt;
      pendingInvitationScene = inviteScene;
      break;
    }
    case 'mid_social_post': {
      // Free BOTH fixture characters (presence gates the poster pick): with
      // everyone available the first salted pick always lands and the fire
      // is deterministic. The new scene opens after convergence.
      const endRes = await post('/v1/commands/end-scene', {
        world_id: 'w1',
        actor_id: 'user:owner',
        scene_id: currentScene,
      });
      if (endRes.status !== 202) fail(`end-scene returned ${endRes.status}`);
      needNewScene = true;
      const sinceId = dbEventIdsAbove(0).at(-1) ?? 0;
      // A 12 h skip crosses exactly ONE social cadence boundary (720 min at
      // the default 2 posts/game day) — the fire enqueues + drains on the
      // spot and the kill lands inside its commit window.
      const killAt = waitForLine(child, 'FAULT_POINT:mid_social_post', 30000);
      const advRes = await post('/v1/commands/advance-time', {
        world_id: 'w1',
        actor_id: 'user:owner',
        minutes: 720,
      });
      if (advRes.status !== 202) fail(`advance-time returned ${advRes.status}`);
      await killAt;
      pendingSocialPost = sinceId;
      break;
    }
    case 'mid_memory_commit': {
      // Same seed as mid_reflection: a committed turn gives the scene a
      // participant; the kill lands INSIDE the memory-commit window (after
      // gating, before the atomic append).
      const committed = waitForLine(child, 'FAULT_POINT:pre_commit', 20000);
      const turnId = await postTurn(currentScene);
      await committed;
      const commitDeadline = Date.now() + 15000;
      while (!dbHasCommittedTurn(turnId)) {
        if (Date.now() > commitDeadline)
          fail('mid_memory_commit: seed turn never committed');
        await sleep(250);
      }
      const killAt = waitForLine(child, 'FAULT_POINT:mid_memory_commit', 25000);
      const res = await post('/v1/commands/end-scene', {
        world_id: 'w1',
        actor_id: 'user:owner',
        scene_id: currentScene,
      });
      if (res.status !== 202) fail(`end-scene returned ${res.status}`);
      const memoryScene = currentScene;
      needNewScene = true;
      await killAt;
      pendingMemoryScene = memoryScene;
      break;
    }
    case 'mid_compaction': {
      // Grow Elias's uncompacted archive to just BELOW the trigger (16):
      // every scene end reflects two deltas (the fake's script), and earlier
      // cycles' reflections count too. The FINAL round crosses the threshold
      // while we already wait on the fault line, so the kill lands inside
      // the compaction pass's own commit window.
      const sinceId = dbEventIdsAbove(0).at(-1) ?? 0;
      const runRound = async (endOnly) => {
        const committed = waitForLine(child, 'FAULT_POINT:pre_commit', 20000);
        const turnId = await postTurn(currentScene);
        await committed;
        const commitDeadline = Date.now() + 15000;
        while (!dbHasCommittedTurn(turnId)) {
          if (Date.now() > commitDeadline)
            fail('mid_compaction: seed turn never committed');
          await sleep(250);
        }
        const res = await post('/v1/commands/end-scene', {
          world_id: 'w1',
          actor_id: 'user:owner',
          scene_id: currentScene,
        });
        if (res.status !== 202) fail(`end-scene returned ${res.status}`);
        if (endOnly) return;
        sceneSeq += 1;
        currentScene = `s-h${sceneSeq}`;
        await openSceneWhenUnblocked(currentScene);
      };
      let rounds = 0;
      while (dbCountUncompactedDeltas() < 14) {
        if (rounds++ > 12)
          fail('mid_compaction: archive never grew — deltas missing?');
        await runRound(false);
      }
      const killAt = waitForLine(child, 'FAULT_POINT:mid_compaction', 60000);
      await runRound(true); // the crossing reflection enqueues the pass
      needNewScene = true;
      await killAt;
      pendingCompaction = sinceId;
      break;
    }
    case 'mid_proposal_apply': {
      proposalSeq += 1;
      const placeName = `harness court ${proposalSeq}`;
      // The GM proposes through its own conversation: the fake scripts a
      // create_place card off !proposeplace; the reply + card commit
      // detached, so poll the log for the card.
      const gmRes = await post('/v1/commands/send-chat-message', {
        world_id: 'w1',
        actor_id: 'user:owner',
        character_id: 'char:gm',
        text: `Harness authoring ${proposalSeq}: !proposeplace harness-court-${proposalSeq}`,
        request_id: `harness-gm-${proposalSeq}`,
      });
      if (gmRes.status !== 202)
        fail(`send-chat-message (GM) returned ${gmRes.status}`);
      const cardDeadline = Date.now() + 15000;
      let proposalId = dbProposalIdByPlace(placeName);
      while (proposalId === null) {
        if (Date.now() > cardDeadline)
          fail('mid_proposal_apply: the GM card never committed');
        await sleep(250);
        proposalId = dbProposalIdByPlace(placeName);
      }
      const killAt = waitForLine(
        child,
        'FAULT_POINT:mid_proposal_apply',
        25000,
      );
      // The approve holds at the fault line — fire and forget (the SIGKILL
      // severs the socket; the retry is the convergence check's business).
      post('/v1/commands/resolve-proposal', {
        world_id: 'w1',
        actor_id: 'user:owner',
        proposal_id: proposalId,
        resolution: 'approved',
      }).catch(() => {});
      await killAt;
      pendingProposal = proposalId;
      break;
    }
    case 'mid_profile_analysis': {
      profileSeq += 1;
      // Consent first (idempotent event append): profiling ON.
      const flagRes = await post('/v1/commands/set-config-flag', {
        world_id: 'w1',
        actor_id: 'user:owner',
        flag: 'profiling_enabled',
        value: true,
      });
      if (flagRes.status !== 202)
        fail(`set-config-flag returned ${flagRes.status}`);
      // A one-message range while Elias is in_scene closes deterministically
      // (the mid_reflect_chat shape) and enqueues the analysis job.
      const sendRes = await post('/v1/commands/send-chat-message', {
        world_id: 'w1',
        actor_id: 'user:owner',
        character_id: 'char:elias',
        text: `Harness profiling ${profileSeq}: the storm again, always the storm.`,
        request_id: `harness-profile-${profileSeq}`,
      });
      if (sendRes.status !== 202)
        fail(`send-chat-message returned ${sendRes.status}`);
      const killAt = waitForLine(
        child,
        'FAULT_POINT:mid_profile_analysis',
        25000,
      );
      const exitRes = await post('/v1/commands/exit-chat', {
        world_id: 'w1',
        actor_id: 'user:owner',
        character_id: 'char:elias',
      });
      if (exitRes.status !== 202) fail(`exit-chat returned ${exitRes.status}`);
      const exitBody = await exitRes.json();
      if (exitBody.ended !== true) fail('exit-chat closed nothing');
      const rangeEndId = Number(exitBody.job_key.split(':').at(-1));
      await killAt;
      pendingProfile = `${exitBody.conversation_id}:${rangeEndId}`;
      break;
    }
    case 'mid_object_gc': {
      objectGcSeq += 1;
      const strayName = `harness stray ${String(objectGcSeq)}`;
      // A committed turn materializes the payload-less stray (!obj —
      // hyphens become spaces in the fake's marker).
      const committed = waitForLine(child, 'FAULT_POINT:pre_commit', 20000);
      const turnId = await postTurn(
        currentScene,
        202,
        `I drop something. !obj harness-stray-${String(objectGcSeq)}`,
      );
      await committed;
      const commitDeadline = Date.now() + 15000;
      while (!dbHasCommittedTurn(turnId)) {
        if (Date.now() > commitDeadline)
          fail('mid_object_gc: seed turn never committed');
        await sleep(250);
      }
      if (dbObjectGcState(strayName).liveRows !== 1)
        fail(`mid_object_gc: stray "${strayName}" never materialized`);
      // Ending the scene enqueues the sweep; the kill lands inside its
      // tombstone window.
      const killAt = waitForLine(child, 'FAULT_POINT:mid_object_gc', 25000);
      const res = await post('/v1/commands/end-scene', {
        world_id: 'w1',
        actor_id: 'user:owner',
        scene_id: currentScene,
      });
      if (res.status !== 202) fail(`end-scene returned ${res.status}`);
      needNewScene = true;
      await killAt;
      pendingObjectGc = strayName;
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
