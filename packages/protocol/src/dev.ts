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

/**
 * A Narrator tool call that passed both B6 gates (Zod shape, then engine
 * state) and whose effect will commit with the turn. Emitted by: the scene
 * engine's tool pipeline. Consumed by: dev-mode clients (UI Spec §2.8 shows
 * tool calls inline).
 */
export const DevToolCallSchema = z.strictObject({
  type: z.literal('dev.tool_call'),
  turn_id: z.string().min(1),
  tool: z.string().min(1),
  /** The validated input, JSON-serialized for display. */
  input_json: z.string(),
});
export type DevToolCall = z.infer<typeof DevToolCallSchema>;

/**
 * A Narrator tool call rejected by one of the two B6 gates. This is the I8
 * trail subject: the rejection lives ONLY here — zero rows are written for a
 * rejected call. Emitted by: the scene engine's tool pipeline. Consumed by:
 * dev-mode clients ("why did my character act weird").
 */
export const DevToolRejectedSchema = z.strictObject({
  type: z.literal('dev.tool_rejected'),
  turn_id: z.string().min(1),
  tool: z.string().min(1),
  /** Which gate refused: `schema` = malformed shape, `state` = invalid against game state. */
  gate: z.enum(['schema', 'state']),
  reason: z.string().min(1),
});
export type DevToolRejected = z.infer<typeof DevToolRejectedSchema>;

/** The closed union of dev-channel frames (`event: dev` on the SSE stream). */
export const DevEventSchema = z.discriminatedUnion('type', [
  DevGaugesSchema,
  DevToolCallSchema,
  DevToolRejectedSchema,
]);
export type DevEvent = z.infer<typeof DevEventSchema>;
