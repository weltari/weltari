import { z } from 'zod';
import { MapPositionSchema, MapSquareSchema } from './events.js';

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
 * POST /v1/commands/interrupt-turn — the interrupt-anywhere contract (UI Spec
 * §1.4): close the running turn's envelope at the interruption point. Only
 * sentences the user had displayed commit (marked `interrupted` on
 * turn.committed); everything generated after the point — text and staged
 * tool effects — is discarded and never durable (Guide B6).
 */
export const InterruptTurnCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  turn_id: z.string().min(1),
  /**
   * The last streamed sentence the user saw, addressed the way stream frames
   * are: call kind + per-call sentence index. Absent = nothing was displayed
   * yet — the whole turn voids (envelope closed, nothing durable).
   */
  seen: z
    .strictObject({
      call: z.enum(['narrator', 'character', 'narration']),
      sentence_index: z.int().nonnegative(),
    })
    .optional(),
});
export type InterruptTurnCommand = z.infer<typeof InterruptTurnCommandSchema>;

/**
 * 202 response: the interrupt landed. `committed` says whether a truncated
 * turn.committed was written (false = the turn voided entirely).
 */
export const InterruptTurnAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  committed: z.boolean(),
});
export type InterruptTurnAccepted = z.infer<typeof InterruptTurnAcceptedSchema>;

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
  /**
   * Open the scene AT this sublocation: the engine appends a
   * sublocation.changed atomically after scene.started (0.8.0 — Hang around
   * and map-pin jumps land where they claim). Engine-state gated: the id must
   * be known to the world (fixture trio or materialized) or the command 409s.
   * Absent = the scene opens at the world's default start sublocation.
   */
  sublocation_id: z.string().min(1).optional(),
});
export type OpenSceneCommand = z.infer<typeof OpenSceneCommandSchema>;

/** 202 response: the scene opened; scene.started is on the stream. */
export const OpenSceneAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
});
export type OpenSceneAccepted = z.infer<typeof OpenSceneAcceptedSchema>;

/**
 * POST /v1/commands/explore — reveal one fog square (UI Spec §1.8): enqueue
 * ONE LLM-class `materialize` ledger job that generates the new sublocation
 * stub (name + short description) behind the full B6 double gate, then
 * appends sublocation.materialized. Idempotent per square (the ledger key is
 * the square); 409 when the square is already occupied or the world unknown.
 * The click picks the square — placement is code-owned, never the LLM's
 * (Rev 4 §14).
 */
export const ExploreCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  square: MapSquareSchema,
});
export type ExploreCommand = z.infer<typeof ExploreCommandSchema>;

/** 202 response: the materialize job is on the ledger; the reveal arrives as
 * a sublocation.materialized event on the stream. */
export const ExploreAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  /** The ledger idempotency key (`materialize:<world>:<col>:<row>`). */
  job_key: z.string().min(1),
});
export type ExploreAccepted = z.infer<typeof ExploreAcceptedSchema>;

/**
 * POST /v1/commands/map-edit — Flow A (Rev 4 §14): the user drew a region
 * (pencil/lasso) on explored ground and spoke an intent. The command appends
 * the durable map_edit.requested intent and enqueues ONE `map_edit` ledger
 * job: GM form (B6 double gate) → sublocation.created at the mask centroid →
 * painter edit job for the drawn region (composite-back of the masked
 * interior only). Idempotent per request_id. 409 when the world is unknown or
 * the drawn centroid lies on unexplored fog.
 */
export const MapEditCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  /** The drawn region: a closed polygon in world coordinates ([0,1]²). */
  points: z.array(MapPositionSchema).min(3).max(128),
  /** What the user wants there — free text, capped (B7). */
  intent: z.string().min(1).max(500),
  /** Client-chosen idempotency token; becomes the edit_id. */
  request_id: z.string().min(1).max(100),
});
export type MapEditCommand = z.infer<typeof MapEditCommandSchema>;

/** 202 response: the map_edit job is on the ledger; the lock overlay, the
 * sublocation pin and the repaint all arrive as events. */
export const MapEditAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  /** The ledger idempotency key (`map_edit:<world>:<edit_id>`). */
  job_key: z.string().min(1),
  /** The edit id (echoes request_id) — ties every later event to this edit. */
  edit_id: z.string().min(1),
});
export type MapEditAccepted = z.infer<typeof MapEditAcceptedSchema>;

/**
 * POST /v1/commands/map-click — Flow B (Rev 4 §14): the user clicked explored
 * ground. Inside a known sublocation's footprint or radius the command
 * answers `enter` directly — zero model calls, zero rows. Outside all radii
 * it enqueues ONE `map_click` ledger job (VLM classification → story LLM →
 * persist-or-discard); the outcome arrives as a map_click.resolved event.
 * Idempotent per request_id. 409 when the world is unknown or the clicked
 * square is unexplored fog (fog clicks are Explore's business).
 */
export const MapClickCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  /** The clicked point, world coordinates ([0,1]²). */
  point: MapPositionSchema,
  /** Client-chosen idempotency token; becomes the click_id. */
  request_id: z.string().min(1).max(100),
});
export type MapClickCommand = z.infer<typeof MapClickCommandSchema>;

/** 202 response. `enter` = inside a known radius/footprint (the named
 * sublocation is attached, nothing was enqueued); `classify` = the map_click
 * job is on the ledger and a map_click.resolved event will follow. */
export const MapClickAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  outcome: z.enum(['enter', 'classify']),
  /** Echoes request_id — ties the coming map_click.resolved to this click. */
  click_id: z.string().min(1),
  /** `enter` only: the sublocation the click landed in. */
  sublocation_id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  /** `classify` only: the ledger idempotency key (`map_click:<world>:<id>`). */
  job_key: z.string().min(1).optional(),
});
export type MapClickAccepted = z.infer<typeof MapClickAcceptedSchema>;

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

/**
 * POST /v1/commands/paint-region — enqueue one painter job: crop →
 * feather-mask composite → resize under a region lease (FINAL item 10).
 * `request_id` makes the enqueue idempotent (client retries are no-ops).
 */
export const PaintRegionCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  image_id: z.string().min(1).max(100),
  region: z.strictObject({
    x: z.int().nonnegative(),
    y: z.int().nonnegative(),
    width: z.int().positive().max(4096),
    height: z.int().positive().max(4096),
  }),
  /** Client-chosen idempotency token for this paint request. */
  request_id: z.string().min(1).max(100),
});
export type PaintRegionCommand = z.infer<typeof PaintRegionCommandSchema>;

/** 202 response: the painter job is on the ledger; results arrive as events. */
export const PaintRegionAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  /** The ledger idempotency key (also echoed in painter.completed). */
  job_key: z.string().min(1),
});
export type PaintRegionAccepted = z.infer<typeof PaintRegionAcceptedSchema>;

/**
 * POST /v1/commands/apply-update — enqueue the update_apply job: download the
 * named release to versions/vNext, verify SHA-256 AND minisign signature,
 * then flip the `current` pointer (Guide B12; new version starts on restart).
 * 409 when updates are disabled (no verification key configured, or Docker
 * notify-only mode) or the version is not the announced one.
 */
export const ApplyUpdateCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  /** The release version tag from update.available. */
  version: z.string().min(1).max(100),
});
export type ApplyUpdateCommand = z.infer<typeof ApplyUpdateCommandSchema>;

/** 202 response: the update_apply job is on the ledger; progress arrives as events. */
export const ApplyUpdateAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  /** The ledger idempotency key (`update_apply:<version>`). */
  job_key: z.string().min(1),
});
export type ApplyUpdateAccepted = z.infer<typeof ApplyUpdateAcceptedSchema>;

/** 4xx response for a schema-valid command the engine refused (e.g. busy scene). */
export const CommandRejectedSchema = z.strictObject({
  accepted: z.literal(false),
  error: z.string().min(1),
});
export type CommandRejected = z.infer<typeof CommandRejectedSchema>;
