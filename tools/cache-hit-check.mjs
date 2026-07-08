// Week-1 success-criteria runner (permanent: this is the nightly real-provider
// cache-hit check, Guide §0.14). Spawns the real server against OpenRouter,
// plays TURNS consecutive scripted turns, and reports:
//   (a) time-to-first-sentence per turn (criterion: turn 1 < 10 s @ ~50K prefix)
//   (b) provider-reported cached_tokens per call on turns 2+ (criterion: >= 80%
//       of the stable prefix)
//   (e) idle RSS after the run (criterion: < 150 MB)
// Usage: OPENROUTER_API_KEY=... node tools/cache-hit-check.mjs
// Env: TURNS (default 20), WELTARI_MODEL, WELTARI_PROVIDER_ORDER, PREFIX_TOKENS (default 50000)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TURNS = Number(process.env.TURNS ?? 20);
const PREFIX_TOKENS = Number(process.env.PREFIX_TOKENS ?? 50000);
const PORT = Number(process.env.CHECK_PORT ?? 7955);
const BASE = `http://127.0.0.1:${PORT}`;

if (!process.env.OPENROUTER_API_KEY) {
  console.error(
    'OPENROUTER_API_KEY is required (env var only — never a file in the repo).',
  );
  process.exit(2);
}

const dataDir = mkdtempSync(join(tmpdir(), 'weltari-cache-'));

// ---- child + NDJSON log capture -------------------------------------------
const llmCalls = []; // {turn (assigned later), call_kind, input_tokens, cached_tokens, duration_ms, model}
const child = spawn(
  process.execPath,
  [join(ROOT, 'apps', 'server', 'dist', 'main.js')],
  {
    env: {
      ...process.env,
      WELTARI_DB_PATH: join(dataDir, 'w.sqlite'),
      WELTARI_PREFIX_TOKENS: String(PREFIX_TOKENS),
      PORT: String(PORT),
      LOG_LEVEL: 'debug',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  },
);

let stdoutBuffer = '';
let listening = null;
const listeningPromise = new Promise((resolve) => (listening = resolve));
child.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk.toString();
  let nl = stdoutBuffer.indexOf('\n');
  while (nl !== -1) {
    const line = stdoutBuffer.slice(0, nl);
    stdoutBuffer = stdoutBuffer.slice(nl + 1);
    try {
      const parsed = JSON.parse(line);
      if (parsed.msg === 'weltari listening') listening();
      if (parsed.msg === 'llm call finished') {
        llmCalls.push({
          call_kind: parsed.call_kind,
          input_tokens: parsed.input_tokens,
          cached_tokens: parsed.cached_tokens,
          output_tokens: parsed.output_tokens,
          duration_ms: parsed.duration_ms,
          model: parsed.model,
        });
      }
    } catch {
      // non-JSON line: ignore
    }
    nl = stdoutBuffer.indexOf('\n');
  }
});
child.on('exit', (code) => {
  if (!finished) {
    console.error(`server exited early with code ${code}`);
    process.exit(1);
  }
});
let finished = false;

// ---- SSE listener -----------------------------------------------------------
const frames = [];
const waiters = [];
function notifyWaiters() {
  for (let i = waiters.length - 1; i >= 0; i--) {
    const match = frames.find(waiters[i].predicate);
    if (match) {
      waiters[i].resolve(match);
      waiters.splice(i, 1);
    }
  }
}
function waitForFrame(predicate, timeoutMs, label) {
  const existing = frames.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${label}`)),
      timeoutMs,
    );
    waiters.push({
      predicate,
      resolve: (frame) => {
        clearTimeout(timer);
        resolve(frame);
      },
    });
  });
}

async function attachSse() {
  const res = await fetch(`${BASE}/v1/events`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const eventLine = block
          .split('\n')
          .find((l) => l.startsWith('event: '));
        const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
        if (eventLine && dataLine) {
          frames.push({
            event: eventLine.slice(7),
            data: JSON.parse(dataLine.slice(6)),
            at: performance.now(),
          });
          notifyWaiters();
        }
        sep = buffer.indexOf('\n\n');
      }
    }
  })().catch(() => undefined);
}

// ---- the run ----------------------------------------------------------------
await listeningPromise;
await attachSse();

// M4 part 2: fresh worlds boot scene-less — open the measured scene first.
{
  const opened = await fetch(`${BASE}/v1/commands/open-scene`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's1',
      title: 'Cache-hit check scene',
      participants: ['char:elias'],
    }),
  });
  if (opened.status !== 202) {
    console.error(`open-scene returned ${opened.status}`);
    process.exit(1);
  }
}

const turns = [];
for (let turn = 1; turn <= TURNS; turn++) {
  const callsBefore = llmCalls.length;
  const t0 = performance.now();
  const res = await fetch(`${BASE}/v1/commands/start-turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's1',
      text: `Turn ${turn}: I ask Elias about the shrine bell.`,
    }),
  });
  if (res.status !== 202) {
    console.error(`start-turn returned ${res.status}`);
    process.exit(1);
  }
  const { turn_id } = await res.json();

  let firstSentenceMs;
  try {
    const firstSentence = await waitForFrame(
      (f) => f.event === 'stream' && f.data.turn_id === turn_id,
      180000,
      `first sentence of turn ${turn}`,
    );
    firstSentenceMs = Math.round(firstSentence.at - t0);
    await waitForFrame(
      (f) =>
        f.event === 'event' &&
        f.data.type === 'turn.committed' &&
        f.data.payload.turn_id === turn_id,
      300000,
      `commit of turn ${turn}`,
    );
  } catch (error) {
    // A voided turn (provider 429/5xx) is an expected operational outcome —
    // record it and retry the turn number once after a backoff.
    console.log(
      `turn ${turn}: VOIDED (${error.message}) — waiting 20 s, retrying`,
    );
    await new Promise((r) => setTimeout(r, 20000));
    turn -= 1;
    continue;
  }
  // llm calls logged for this turn (three of them, in order)
  const calls = llmCalls.slice(callsBefore);
  turns.push({ turn, firstSentenceMs, calls });
  console.log(
    `turn ${turn}: first sentence ${firstSentenceMs} ms; ` +
      calls
        .map(
          (c) =>
            `${c.call_kind} in=${c.input_tokens} cached=${c.cached_tokens} ${c.duration_ms}ms`,
        )
        .join(' | '),
  );
}

// ---- idle RSS (criterion e) ---------------------------------------------------
await new Promise((r) => setTimeout(r, 10000));
let rssMb = null;
try {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-Process -Id ${child.pid}).WorkingSet64`,
    ]);
    rssMb = Number(out.toString().trim()) / (1024 * 1024);
  } else {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)]);
    rssMb = Number(out.toString().trim()) / 1024;
  }
} catch {
  console.error('could not read RSS');
}

// ---- verdicts -----------------------------------------------------------------
const turn1 = turns[0];
const prefixEstimate = {};
for (const call of turn1.calls) {
  // turn-1 input ≈ stable prefix + small tail; use 95% as the prefix estimate
  prefixEstimate[call.call_kind] = Math.round(call.input_tokens * 0.95);
}

let cacheFailures = 0;
let cacheChecks = 0;
for (const t of turns.slice(1)) {
  for (const call of t.calls) {
    cacheChecks += 1;
    const needed = 0.8 * (prefixEstimate[call.call_kind] ?? 0);
    if (call.cached_tokens < needed) cacheFailures += 1;
  }
}

const a = turn1.firstSentenceMs;
const worstLater = Math.max(...turns.slice(1).map((t) => t.firstSentenceMs));
console.log('\n==== SUCCESS CRITERIA REPORT ====');
console.log(
  `model: ${turn1.calls[0]?.model} | prefix target: ${PREFIX_TOKENS} tokens | turns: ${TURNS}`,
);
console.log(
  `(a) first sentence, turn 1 (cold): ${a} ms  [< 10000 required]  ${a < 10000 ? 'PASS' : 'FAIL'}`,
);
console.log(`    worst turn 2+: ${worstLater} ms`);
console.log(
  `(b) cached_tokens >= 80% of prefix on turns 2+: ${cacheChecks - cacheFailures}/${cacheChecks} calls  ${
    cacheFailures === 0 ? 'PASS' : 'FAIL'
  }`,
);
console.log(
  `(e) idle RSS: ${rssMb === null ? 'unknown' : rssMb.toFixed(1)} MB  [< 150 required]  ${rssMb !== null && rssMb < 150 ? 'PASS' : 'FAIL'}`,
);

finished = true;
child.kill('SIGKILL');
process.exit(
  a < 10000 && cacheFailures === 0 && rssMb !== null && rssMb < 150 ? 0 : 1,
);
