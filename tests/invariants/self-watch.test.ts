// I14 (the loop watches itself) + I13 (idle is quiet), one real boot for both:
// spawn the built server against a temp database, watch NDJSON stdout for 60
// idle seconds. Gauges must appear within 30 s of boot (Guide C13); steady-state
// idle must stay under a fixed info-line budget (Guide C9).
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MAIN = join(
  import.meta.dirname,
  '..',
  '..',
  'apps',
  'server',
  'dist',
  'main.js',
);

/** Fixed budget (I13): info lines allowed during one steady-state idle minute. */
const IDLE_INFO_BUDGET = 2;
const GAUGE_DEADLINE_MS = 30_000;
const IDLE_WINDOW_MS = 60_000;

interface LoggedLine {
  atMs: number;
  level: number;
  msg: string;
}

describe('self-watch (I14) and idle-quiet (I13)', () => {
  let child: ChildProcess | null = null;
  let dataDir = '';
  const lines: LoggedLine[] = [];
  let spawnedAt = 0;
  let listeningAt = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'weltari-selfwatch-'));
    const port = 7920 + Math.floor(Math.random() * 500);
    spawnedAt = Date.now();
    child = spawn(process.execPath, [MAIN], {
      env: {
        ...process.env,
        WELTARI_FAKE_LLM: '1',
        WELTARI_DB_PATH: join(dataDir, 'w.sqlite'),
        PORT: String(port),
        LOG_LEVEL: 'debug',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const stdout = child.stdout;
    if (stdout === null) throw new Error('no stdout pipe');

    const rl = createInterface({ input: stdout });
    rl.on('line', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return; // CATCH-OK: non-NDJSON output is not a log line under test
      }
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'level' in parsed &&
        typeof parsed.level === 'number'
      ) {
        const msg =
          'msg' in parsed && typeof parsed.msg === 'string' ? parsed.msg : '';
        lines.push({ atMs: Date.now() - spawnedAt, level: parsed.level, msg });
        if (msg === 'weltari listening') listeningAt = Date.now() - spawnedAt;
      }
    });

    // Wait for boot, then observe one full idle minute.
    await new Promise<void>((resolve, reject) => {
      const bootTimer = setTimeout(() => {
        reject(new Error('server did not report listening within 20 s'));
      }, 20_000);
      const poll = setInterval(() => {
        if (listeningAt > 0) {
          clearTimeout(bootTimer);
          clearInterval(poll);
          setTimeout(resolve, IDLE_WINDOW_MS);
        }
      }, 100);
      child?.on('exit', (code) => {
        clearTimeout(bootTimer);
        clearInterval(poll);
        reject(new Error(`server exited early with code ${String(code)}`));
      });
    });
  }, 110_000);

  afterAll(() => {
    child?.kill('SIGKILL'); // crash-only: SIGKILL is always safe (Brief §2.4)
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // CATCH-OK: Windows may still hold the WAL file; temp dirs get swept by the OS
    }
  });

  it('emits a gauge line within 30 s of boot (I14, Guide C13)', () => {
    const gaugeLines = lines.filter((l) => l.msg === 'gauges');
    expect(gaugeLines.length).toBeGreaterThan(0);
    expect(gaugeLines[0]?.atMs).toBeLessThanOrEqual(GAUGE_DEADLINE_MS);
  });

  it('gauges log at debug while healthy — never noisier (Guide C9)', () => {
    const gaugeLines = lines.filter((l) => l.msg === 'gauges');
    // An idle fixture world sits far below 200 ms p99 / 220 MB RSS; a warn here
    // means the thresholds or the sampler regressed.
    expect(gaugeLines.every((l) => l.level === 20)).toBe(true);
  });

  it('one idle minute stays under the fixed info-line budget (I13, Guide C9)', () => {
    expect(listeningAt).toBeGreaterThan(0);
    const idleInfoLines = lines.filter(
      (l) =>
        l.level === 30 &&
        l.atMs > listeningAt &&
        l.atMs <= listeningAt + IDLE_WINDOW_MS,
    );
    expect(idleInfoLines.length).toBeLessThanOrEqual(IDLE_INFO_BUDGET);
  });
});
