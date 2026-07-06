// Self-watch (Guide C13): every 15 s, event-loop delay p99 + RSS at debug,
// escalated to warn past 200 ms p99 / 220 MB RSS, mirrored as dev.gauges
// frames for dev mode. Started unconditionally in main.ts — that is the I14
// structural guard; the smoke test asserts the first line within 30 s of boot.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { DevGauges } from '@weltari/protocol';
import type { Logger } from './logger.js';

export interface GaugeSample {
  loopP99Ms: number;
  rssMb: number;
}

export interface GaugesOptions {
  logger: Logger;
  /** Mirror seam — main wires this to the dev bus (Guide C11: emitted at source). */
  publish: (frame: DevGauges) => void;
  intervalMs?: number;
  warnLoopP99Ms?: number;
  warnRssMb?: number;
  /** Test seam: replace the real histogram/RSS read with a scripted sample. */
  sample?: () => GaugeSample;
}

function createRealSampler(): { sample: () => GaugeSample; stop: () => void } {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  return {
    sample(): GaugeSample {
      // percentile() reports nanoseconds; reset so each window stands alone.
      const loopP99Ms = histogram.percentile(99) / 1e6;
      histogram.reset();
      return {
        loopP99Ms,
        rssMb: process.memoryUsage.rss() / (1024 * 1024),
      };
    },
    stop(): void {
      histogram.disable();
    },
  };
}

/** Returns a stop function (tests and drain); the interval never holds the process open. */
export function startGauges(options: GaugesOptions): () => void {
  const {
    logger,
    publish,
    intervalMs = 15_000,
    warnLoopP99Ms = 200,
    warnRssMb = 220,
  } = options;

  let sample: () => GaugeSample;
  let stopSampler = (): void => undefined;
  if (options.sample === undefined) {
    const real = createRealSampler();
    sample = real.sample;
    stopSampler = real.stop;
  } else {
    sample = options.sample;
  }

  function tick(): void {
    const { loopP99Ms, rssMb } = sample();
    const loop_p99_ms = Math.round(loopP99Ms * 10) / 10;
    const rss_mb = Math.round(rssMb * 10) / 10;
    const degraded = loop_p99_ms > warnLoopP99Ms || rss_mb > warnRssMb;
    if (degraded) {
      logger.warn({ loop_p99_ms, rss_mb }, 'gauges');
    } else {
      logger.debug({ loop_p99_ms, rss_mb }, 'gauges');
    }
    publish({ type: 'dev.gauges', loop_p99_ms, rss_mb, degraded });
  }

  const interval = setInterval(tick, intervalMs);
  interval.unref();
  return (): void => {
    clearInterval(interval);
    stopSampler();
  };
}
