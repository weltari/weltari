import { Writable } from 'node:stream';
import type { DevGauges } from '@weltari/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startGauges, type GaugeSample } from './gauges.js';
import { createRootLogger } from './logger.js';

function capture(): {
  logger: ReturnType<typeof createRootLogger>;
  lines: string[];
} {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { logger: createRootLogger({ level: 'debug', stream }), lines };
}

function levelsOf(lines: string[]): number[] {
  return lines.map((line) => {
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'level' in parsed &&
      typeof parsed.level === 'number'
    ) {
      return parsed.level;
    }
    return -1;
  });
}

describe('startGauges', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs at debug and publishes a dev.gauges frame each interval', () => {
    const { logger, lines } = capture();
    const frames: DevGauges[] = [];
    const stop = startGauges({
      logger,
      publish: (frame) => frames.push(frame),
      intervalMs: 15_000,
      sample: (): GaugeSample => ({ loopP99Ms: 12.34, rssMb: 104.26 }),
    });

    vi.advanceTimersByTime(30_000);
    stop();

    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({
      type: 'dev.gauges',
      loop_p99_ms: 12.3,
      rss_mb: 104.3,
      degraded: false,
    });
    expect(levelsOf(lines)).toEqual([20, 20]); // pino debug = 20
  });

  it('escalates to warn past the 200 ms loop-p99 threshold (Guide C13)', () => {
    const { logger, lines } = capture();
    const frames: DevGauges[] = [];
    const stop = startGauges({
      logger,
      publish: (frame) => frames.push(frame),
      sample: (): GaugeSample => ({ loopP99Ms: 250, rssMb: 100 }),
    });

    vi.advanceTimersByTime(15_000);
    stop();

    expect(frames[0]?.degraded).toBe(true);
    expect(levelsOf(lines)).toEqual([40]); // pino warn = 40
  });

  it('escalates to warn past the 220 MB RSS threshold (Guide C13)', () => {
    const { logger, lines } = capture();
    const frames: DevGauges[] = [];
    const stop = startGauges({
      logger,
      publish: (frame) => frames.push(frame),
      sample: (): GaugeSample => ({ loopP99Ms: 5, rssMb: 300 }),
    });

    vi.advanceTimersByTime(15_000);
    stop();

    expect(frames[0]?.degraded).toBe(true);
    expect(levelsOf(lines)).toEqual([40]);
  });

  it('stops sampling after stop() is called', () => {
    const { logger } = capture();
    const frames: DevGauges[] = [];
    const stop = startGauges({
      logger,
      publish: (frame) => frames.push(frame),
      sample: (): GaugeSample => ({ loopP99Ms: 1, rssMb: 1 }),
    });

    vi.advanceTimersByTime(15_000);
    stop();
    vi.advanceTimersByTime(60_000);

    expect(frames).toHaveLength(1);
  });

  it('reads the real event loop and RSS when no sample seam is given', () => {
    const { logger } = capture();
    const frames: DevGauges[] = [];
    const stop = startGauges({
      logger,
      publish: (frame) => frames.push(frame),
    });

    vi.advanceTimersByTime(15_000);
    stop();

    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame?.rss_mb).toBeGreaterThan(0);
    expect(frame?.loop_p99_ms).toBeGreaterThanOrEqual(0);
  });
});
