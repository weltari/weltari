import { z } from 'zod';

// POST command bodies — trust boundary B-http. Validated by
// fastify-type-provider-zod at the route (Guide B9); strictObject because the
// command wire format is ours (Guide B5). Inbound free text is length-capped
// before it can enter a prompt (Guide B7's 8 KB rule, applied to HTTP too).

/** POST /v1/commands/start-turn — open a turn envelope and run the scripted scene turn. */
export const StartTurnCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  scene_id: z.string().min(1),
  /** Optional player utterance folded into the dynamic tail — never the stable prefix. */
  text: z.string().max(8192).optional(),
});
export type StartTurnCommand = z.infer<typeof StartTurnCommandSchema>;

/** 202 response: the command was accepted; results arrive as events on the stream. */
export const StartTurnAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  turn_id: z.string().min(1),
});
export type StartTurnAccepted = z.infer<typeof StartTurnAcceptedSchema>;

/**
 * POST /v1/commands/end-scene — close the scene and fan out reflections: one
 * ledger job per participating character plus one World Agent job, enqueued
 * atomically with the scene.ended event (Brief §2.4).
 */
export const EndSceneCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  scene_id: z.string().min(1),
});
export type EndSceneCommand = z.infer<typeof EndSceneCommandSchema>;

/** 202 response: scene closed; reflection/World-Agent jobs are on the ledger. */
export const EndSceneAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  jobs_enqueued: z.int().nonnegative(),
});
export type EndSceneAccepted = z.infer<typeof EndSceneAcceptedSchema>;

/**
 * POST /v1/commands/open-scene — open a new scene. Blocks (409) only while
 * jobs for THIS world or THIS scene's participants are still pending (Brief
 * §4: new-scene opens block only on that world + involved characters' jobs).
 */
export const OpenSceneCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  scene_id: z.string().min(1),
  title: z.string().min(1).max(200),
  /** Character ids involved in the new scene. */
  participants: z.array(z.string().min(1)).max(50),
});
export type OpenSceneCommand = z.infer<typeof OpenSceneCommandSchema>;

/** 202 response: the scene opened; scene.started is on the stream. */
export const OpenSceneAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
});
export type OpenSceneAccepted = z.infer<typeof OpenSceneAcceptedSchema>;

/**
 * POST /v1/commands/advance-time — move the fictional world clock forward
 * (a time skip). Due world-cron occurrences replay in scheduled-game-timestamp
 * order: code-class instantly, LLM-class in background under the per-skip
 * budget (Brief §4).
 */
export const AdvanceTimeCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  /** Fictional minutes to skip; capped at one fictional year. */
  minutes: z.int().positive().max(527040),
});
export type AdvanceTimeCommand = z.infer<typeof AdvanceTimeCommandSchema>;

/** 202 response: the clock moved; occurrence jobs are on the ledger. */
export const AdvanceTimeAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  /** The new fictional world time. */
  world_time: z.iso.datetime(),
  code_enqueued: z.int().nonnegative(),
  llm_enqueued: z.int().nonnegative(),
  llm_skipped: z.int().nonnegative(),
});
export type AdvanceTimeAccepted = z.infer<typeof AdvanceTimeAcceptedSchema>;

/** 4xx response for a schema-valid command the engine refused (e.g. busy scene). */
export const CommandRejectedSchema = z.strictObject({
  accepted: z.literal(false),
  error: z.string().min(1),
});
export type CommandRejected = z.infer<typeof CommandRejectedSchema>;
