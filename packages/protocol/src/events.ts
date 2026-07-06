import { z } from 'zod';

// Durable events — rows of the append-only event log (Brief §2.1), replayed on
// SSE reconnect via Last-Event-ID. Own formats use strictObject: an unexpected
// key in our own wire format is a bug or an attack (Guide B5).
// Every event carries actor_id — no module may assume a singleton user (Brief §2.8).

const eventEnvelope = {
  /** Event-log sequence number; doubles as the SSE `id:` field (FINAL item 4). */
  id: z.int().positive(),
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  /** Wall-clock append time, ISO 8601. Fictional time is engine-owned and separate. */
  ts: z.iso.datetime(),
};

/**
 * One finished LLM call inside a committed turn. `call` is the scripted
 * three-call scene turn of the Week-1 slice (FINAL §6: Narrator → character →
 * narration); the union grows when the real Scene Engine lands.
 */
export const TurnStepSchema = z.strictObject({
  call: z.enum(['narrator', 'character', 'narration']),
  speaker: z.string().min(1),
  text: z.string(),
});
export type TurnStep = z.infer<typeof TurnStepSchema>;

/** Emitted when a scene opens. Consumed by: web client (scene header), CLI. */
export const SceneStartedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('scene.started'),
  payload: z.strictObject({
    scene_id: z.string().min(1),
    title: z.string(),
  }),
});

/**
 * Turn envelope opened — durable intent before any LLM work happens
 * (crash-only design, Brief §2.4). Emitted by: scene engine. Consumed by:
 * clients (show "thinking"), recovery sweep (a started-but-never-committed
 * turn is void after restart).
 */
export const TurnStartedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('turn.started'),
  payload: z.strictObject({
    scene_id: z.string().min(1),
    turn_id: z.string().min(1),
  }),
});

/**
 * Turn envelope closed — the ONLY durable form of LLM narration (Guide B6:
 * streamed text is display-only until the engine wraps it in this event).
 * Emitted by: scene engine at turn close. Consumed by: clients (authoritative
 * transcript), all future projections.
 */
export const TurnCommittedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('turn.committed'),
  payload: z.strictObject({
    scene_id: z.string().min(1),
    turn_id: z.string().min(1),
    steps: z.array(TurnStepSchema).min(1),
  }),
});

/** Truncated error surface for the UI — never prompt content (Guide C7/C12). */
export const JobErrorSchema = z.strictObject({
  kind: z.enum(['operational', 'bug', 'corrupt_state']),
  code: z.string(),
  message: z.string(),
});

/**
 * A job failed an attempt and awaits its backoff retry. Emitted by: job runner
 * (the one catch site, Guide C7). Consumed by: clients (job status UI).
 */
export const JobFailedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('job.failed'),
  payload: z.strictObject({
    job_id: z.int().positive(),
    job_type: z.string().min(1),
    attempts: z.int().positive(),
    error: JobErrorSchema,
  }),
});

/**
 * A job entered the dead-letter lane — never auto-retried (Brief §2.2).
 * Emitted by: job runner. Consumed by: clients (owner should look, Guide C9).
 */
export const JobParkedEventSchema = z.strictObject({
  ...eventEnvelope,
  type: z.literal('job.parked'),
  payload: z.strictObject({
    job_id: z.int().positive(),
    job_type: z.string().min(1),
    attempts: z.int().positive(),
    error: JobErrorSchema,
  }),
});

/** The closed union of durable event shapes on the wire. */
export const WeltariEventSchema = z.discriminatedUnion('type', [
  SceneStartedEventSchema,
  TurnStartedEventSchema,
  TurnCommittedEventSchema,
  JobFailedEventSchema,
  JobParkedEventSchema,
]);
export type WeltariEvent = z.infer<typeof WeltariEventSchema>;
export type WeltariEventType = WeltariEvent['type'];
