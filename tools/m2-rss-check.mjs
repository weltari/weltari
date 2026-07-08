// M2 criterion (c): peak RSS < 256 MB during reflection fan-out plus one
// painter composite (FINAL §6). Spawns the real server with the ~50K-token
// fixture prefix and 200 ms gauges, drives a turn -> end-scene fan-out ->
// painter composite -> 3-day time skip all at once, and takes the peak of the
// server's own gauge lines (Guide C13 — the process reports its own RSS).
// FakeLLM: RSS is about buffers and libvips, not provider latency.
// Usage: node tools/m2-rss-check.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import Database from 'better-sqlite3';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = join(ROOT, 'apps', 'server', 'dist', 'main.js');
const PORT = Number(process.env.HARNESS_PORT ?? 7913);
const BASE = `http://127.0.0.1:${PORT}`;
const LIMIT_MB = 256;

const dataDir = mkdtempSync(join(tmpdir(), 'weltari-rss-'));
const dbPath = join(dataDir, 'w.sqlite');

function fail(message) {
  console.error(`M2-RSS FAIL: ${message}`);
  process.exit(1);
}

const child = spawn(process.execPath, [MAIN], {
  env: {
    ...process.env,
    WELTARI_FAKE_LLM: '1',
    WELTARI_PREFIX_TOKENS: '50000',
    WELTARI_GAUGE_INTERVAL_MS: '200',
    WELTARI_DB_PATH: dbPath,
    WELTARI_IMAGES_DIR: join(dataDir, 'images'),
    PORT: String(PORT),
    LOG_LEVEL: 'debug',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});

let peakRssMb = 0;
let listening = false;
const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (parsed.msg === 'gauges' && typeof parsed.rss_mb === 'number') {
    peakRssMb = Math.max(peakRssMb, parsed.rss_mb);
  }
  if (parsed.msg === 'weltari listening') listening = true;
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 202) fail(`${path} returned ${res.status}`);
  return res.json();
}

function ledgerDrained() {
  const db = new Database(dbPath);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ledger_jobs WHERE state IN ('pending','running','failed')`,
    )
    .get();
  db.close();
  return row.n === 0;
}

const bootDeadline = Date.now() + 30000;
while (!listening) {
  if (Date.now() > bootDeadline) fail('server never reported listening');
  await sleep(100);
}

// M4 part 2: fresh worlds boot scene-less (the splash is the entry surface) —
// open the measured scene like any client would.
await post('/v1/commands/open-scene', {
  world_id: 'w1',
  actor_id: 'user:owner',
  scene_id: 's1',
  title: 'RSS criteria scene',
  participants: ['char:elias'],
});

// One committed turn gives the scene a participant (and exercises the 50K prefix).
await post('/v1/commands/start-turn', {
  world_id: 'w1',
  actor_id: 'user:owner',
  scene_id: 's1',
  text: 'RSS criteria turn.',
});
await sleep(2000); // FakeLLM streams in ms; leave room for the commit

// The measured burst: reflection fan-out + painter composite + 3-day skip.
await post('/v1/commands/end-scene', {
  world_id: 'w1',
  actor_id: 'user:owner',
  scene_id: 's1',
});
await post('/v1/commands/paint-region', {
  world_id: 'w1',
  actor_id: 'user:owner',
  image_id: 'map:w1',
  region: { x: 64, y: 64, width: 128, height: 128 },
  request_id: 'rss-check',
});
await post('/v1/commands/advance-time', {
  world_id: 'w1',
  actor_id: 'user:owner',
  minutes: 3 * 1440,
});

const drainDeadline = Date.now() + 60000;
while (!ledgerDrained()) {
  if (Date.now() > drainDeadline) fail('ledger never drained');
  await sleep(500);
}
await sleep(1000); // a few more gauge samples after the burst

child.kill('SIGKILL');

if (peakRssMb === 0) fail('no gauge lines observed — nothing measured');
console.log(
  `m2-rss-check: peak RSS ${peakRssMb.toFixed(1)} MB during fan-out + painter + time-skip (limit ${LIMIT_MB} MB)`,
);
if (peakRssMb >= LIMIT_MB)
  fail(`peak RSS ${peakRssMb.toFixed(1)} MB >= ${LIMIT_MB} MB`);
process.exit(0);
