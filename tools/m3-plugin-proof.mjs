// M3 part-1 criteria (a) + (d) — the drop-in proof (FINAL §6, Week 3):
// author a plugin folder (one CSS theme, one custom-element surface, one
// connector) with ZERO build step, drop it into plugins/, boot the real
// server, and verify all three capabilities load with the provenance hash
// the dev overlay displays. Then tamper one byte and prove the B10 refusal
// on restart (plugin.rejected + app boots without it). Idle RSS is sampled
// from the server's own gauges with the plugins installed (< 170 MB).
// Usage: node tools/m3-plugin-proof.mjs  (after npx tsc -b)
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import Database from 'better-sqlite3';
import { computePluginContentHash } from '../packages/plugin-sdk/dist/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = join(ROOT, 'apps', 'server', 'dist', 'main.js');
const PLUGINS_DIR = join(ROOT, 'plugins');
const PROOF_DIR = join(PLUGINS_DIR, 'proof-dropin');
const PORT = Number(process.env.HARNESS_PORT ?? 7914);
const BASE = `http://127.0.0.1:${PORT}`;
const RSS_LIMIT_MB = 170;

const dataDir = mkdtempSync(join(tmpdir(), 'weltari-m3-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error(`M3-PROOF FAIL: ${message}`);
  rmSync(PROOF_DIR, { recursive: true, force: true });
  process.exit(1);
}

/* 1. Author the drop-in plugin — plain files, no toolchain. */
function writeProofPlugin() {
  rmSync(PROOF_DIR, { recursive: true, force: true });
  mkdirSync(join(PROOF_DIR, 'frontend'), { recursive: true });
  mkdirSync(join(PROOF_DIR, 'backend'), { recursive: true });
  writeFileSync(
    join(PROOF_DIR, 'theme.css'),
    ':root { --wl-accent: #6fb3d8; --wl-speaker-plate-text: #6fb3d8; }\n',
  );
  writeFileSync(
    join(PROOF_DIR, 'frontend', 'wl-proof-badge.mjs'),
    [
      '// A drop-in surface: zero imports, defines itself on load.',
      "if (!customElements.get('wl-proof-badge')) {",
      "  customElements.define('wl-proof-badge', class extends HTMLElement {",
      '    connectedCallback() {',
      "      this.textContent = 'proof-dropin plugin surface';",
      '    }',
      '  });',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(PROOF_DIR, 'backend', 'index.mjs'),
    [
      '// A minimal GatewayConnector: lifecycle-complete, does nothing.',
      'export function register(api) {',
      "  api.registerConnector('proof-echo', {",
      '    async start() {},',
      '    async stop() {},',
      '    async send() {',
      '      return { ok: true };',
      '    },',
      '    onInbound() {},',
      '    health() {',
      "      return 'ok';",
      '    },',
      '  });',
      '}',
      '',
    ].join('\n'),
  );
  const sha256 = computePluginContentHash(PROOF_DIR);
  writeFileSync(
    join(PROOF_DIR, 'plugin.json'),
    JSON.stringify(
      {
        name: 'proof-dropin',
        version: '0.1.0',
        engine: '0.x',
        capabilities: {
          themes: ['theme.css'],
          components: ['frontend/wl-proof-badge.mjs'],
          connectors: ['proof-echo'],
        },
        provenance: {
          source_url: 'https://example.com/proof-dropin',
          sha256,
        },
      },
      null,
      2,
    ),
  );
  return sha256;
}

function spawnServer() {
  const child = spawn(process.execPath, [MAIN], {
    env: {
      ...process.env,
      WELTARI_FAKE_LLM: '1',
      WELTARI_DB_PATH: join(dataDir, 'w.sqlite'),
      WELTARI_IMAGES_DIR: join(dataDir, 'images'),
      WELTARI_PLUGINS_DIR: PLUGINS_DIR,
      WELTARI_GAUGE_INTERVAL_MS: '500',
      PORT: String(PORT),
      LOG_LEVEL: 'debug',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const state = { listening: false, peakIdleRssMb: 0 };
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (parsed.msg === 'gauges' && typeof parsed.rss_mb === 'number') {
      state.peakIdleRssMb = Math.max(state.peakIdleRssMb, parsed.rss_mb);
    }
    if (parsed.msg === 'weltari listening') state.listening = true;
  });
  return { child, state };
}

async function waitListening(state) {
  const deadline = Date.now() + 30000;
  while (!state.listening) {
    if (Date.now() > deadline) fail('server never reported listening');
    await sleep(100);
  }
}

const expectedHash = writeProofPlugin();
console.log(
  `authored plugins/proof-dropin (sha256 ${expectedHash.slice(0, 12)}…)`,
);

/* 2. Boot with the plugin dropped in — zero build step happened. */
let { child, state } = spawnServer();
await waitListening(state);
await sleep(6000); // idle window: gauge samples with plugins installed

const listRes = await fetch(`${BASE}/v1/plugins`);
if (listRes.status !== 200) fail(`/v1/plugins returned ${listRes.status}`);
const list = await listRes.json();
const names = list.plugins.map((p) => p.name).sort();
if (!names.includes('proof-dropin') || !names.includes('wl-map')) {
  fail(`loaded plugins ${JSON.stringify(names)} missing proof-dropin/wl-map`);
}
const proof = list.plugins.find((p) => p.name === 'proof-dropin');
if (proof.provenance.sha256 !== expectedHash) {
  fail('provenance hash on /v1/plugins != computed content hash');
}
if (
  proof.themes.length !== 1 ||
  proof.components.length !== 1 ||
  !proof.connectors.includes('proof-echo')
) {
  fail(`capabilities incomplete: ${JSON.stringify(proof)}`);
}
console.log(
  `criterion (a): theme + component + connector loaded, zero build step; provenance ${proof.provenance.sha256.slice(0, 12)}… served to dev mode`,
);

/* 3. The assets really serve (what the browser imports). */
for (const url of [...proof.themes, ...proof.components]) {
  const res = await fetch(`${BASE}${url}`);
  if (res.status !== 200) fail(`asset ${url} returned ${res.status}`);
}
console.log('assets serve: theme.css + wl-proof-badge.mjs -> 200');

const idleRss = state.peakIdleRssMb;
if (idleRss === 0) fail('no gauge samples during the idle window');
console.log(
  `criterion (d): idle RSS ${idleRss.toFixed(1)} MB with plugins installed (limit ${RSS_LIMIT_MB} MB)`,
);
if (idleRss >= RSS_LIMIT_MB) fail(`idle RSS ${idleRss.toFixed(1)} MB >= limit`);

child.kill('SIGKILL');
await sleep(500);

/* 4. Tamper one byte -> restart -> refused + plugin.rejected (B10). */
const themePath = join(PROOF_DIR, 'theme.css');
writeFileSync(
  themePath,
  readFileSync(themePath, 'utf8').replace('#6fb3d8', '#6FB3D8'),
);
({ child, state } = spawnServer());
await waitListening(state);
const listAfter = await (await fetch(`${BASE}/v1/plugins`)).json();
if (listAfter.plugins.some((p) => p.name === 'proof-dropin')) {
  fail('tampered plugin still listed after restart');
}
if (!listAfter.plugins.some((p) => p.name === 'wl-map')) {
  fail('wl-map should still load next to the refused plugin');
}
const assetAfter = await fetch(`${BASE}/plugins/proof-dropin/theme.css`);
if (assetAfter.status !== 404) fail('refused plugin still serves assets');
child.kill('SIGKILL');
await sleep(500);

const db = new Database(join(dataDir, 'w.sqlite'));
const rejected = db
  .prepare(
    `SELECT COUNT(*) AS n FROM events WHERE type = 'plugin.rejected' AND payload LIKE '%hash_mismatch%'`,
  )
  .get();
db.close();
if (rejected.n < 1) fail('no durable plugin.rejected(hash_mismatch) event');
console.log(
  'B10 tamper path: one flipped byte -> refused on restart, plugin.rejected durable, app booted without it',
);

rmSync(PROOF_DIR, { recursive: true, force: true });
console.log('M3-PROOF PASS');
process.exit(0);
