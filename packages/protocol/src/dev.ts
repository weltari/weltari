import { z } from 'zod';

// Dev-channel frames — the log-only trail surfaced by dev mode (UI Spec §2.8,
// Guide C11). Ephemeral by design: never rows in the event log, never carry an
// SSE `id:`, lost on disconnect. They mirror diagnostics at their source —
// application code never parses pino output to produce them.

/**
 * Self-watch gauge sample (Guide C13): event-loop delay p99 + resident set
 * size, sampled every 15 s. Emitted by: observability/gauges. Consumed by:
 * dev-mode clients (health strip).
 */
export const DevGaugesSchema = z.strictObject({
  type: z.literal('dev.gauges'),
  loop_p99_ms: z.number().nonnegative(),
  rss_mb: z.number().nonnegative(),
  /** True when a warn threshold (200 ms p99 / 220 MB RSS) was crossed. */
  degraded: z.boolean(),
});
export type DevGauges = z.infer<typeof DevGaugesSchema>;

/** The closed union of dev-channel frames (`event: dev` on the SSE stream). */
export const DevEventSchema = z.discriminatedUnion('type', [DevGaugesSchema]);
export type DevEvent = z.infer<typeof DevEventSchema>;
