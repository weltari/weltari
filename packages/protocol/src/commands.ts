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
