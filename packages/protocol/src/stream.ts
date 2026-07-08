import { z } from 'zod';

// Ephemeral SSE frames — never rows in the event log, never carry an SSE `id:`.
// A disconnect loses them by design: reconnect replays the durable events and
// the committed turn is the authoritative transcript (Guide B6).

/**
 * First frame on every SSE connection (`event: hello`). Carries the protocol
 * semver so non-JS clients can refuse an incompatible engine (Brief §1).
 */
export const StreamHelloSchema = z.strictObject({
  protocol_version: z.string().min(1),
  /** Highest event id already in the log at connect time. */
  last_event_id: z.int().nonnegative(),
  /** The running engine's app version (0.8.0 — splash footer + Config facts). */
  app_version: z.string().min(1).optional(),
});
export type StreamHello = z.infer<typeof StreamHelloSchema>;

/**
 * One streamed sentence (`event: stream`), display-only. `index` restarts at 0
 * per call; clients render in arrival order and discard on turn commit.
 */
export const StreamSentenceSchema = z.strictObject({
  turn_id: z.string().min(1),
  call: z.enum(['narrator', 'character', 'narration']),
  speaker: z.string().min(1),
  text: z.string(),
  index: z.int().nonnegative(),
});
export type StreamSentence = z.infer<typeof StreamSentenceSchema>;
