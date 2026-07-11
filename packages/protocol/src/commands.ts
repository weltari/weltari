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

/**
 * POST /v1/commands/send-chat-message — DM a character in Weltari Chat (M6
 * part 2, Rev 4 §8). The user line commits durably at the seam; the reply
 * generates detached and arrives as its own chat.message_committed event.
 * Idempotent per request_id (a duplicate send is a silent 202 no-op). The
 * presence rule answers here: a character `in_scene` stores the message but
 * generates NO reply (they read it when the scene ends — chat shows offline).
 */
export const SendChatMessageCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  character_id: z.string().min(1),
  text: z.string().min(1).max(8192),
  /** Client-chosen idempotency token; becomes the message_id. */
  request_id: z.string().min(1).max(100),
});
export type SendChatMessageCommand = z.infer<
  typeof SendChatMessageCommandSchema
>;

/** 202 response: the user line is durable. `replying` = a character reply is
 * generating now (false while the character is `in_scene` — offline). */
export const SendChatMessageAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  conversation_id: z.string().min(1),
  message_id: z.string().min(1),
  replying: z.boolean(),
  /** The character's presence at send time (UI Spec §2.4: offline while in_scene). */
  presence: z.enum(['available', 'in_scene']),
});
export type SendChatMessageAccepted = z.infer<
  typeof SendChatMessageAcceptedSchema
>;

/**
 * POST /v1/commands/exit-chat — the explicit user exit() (Rev 4 §8): closes
 * the conversation's open range with chat.ended(reason exit) and enqueues its
 * ONE reflect_chat job atomically. A conversation with no unreflected
 * messages is a silent 202 no-op (nothing to reflect).
 */
export const ExitChatCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  character_id: z.string().min(1),
});
export type ExitChatCommand = z.infer<typeof ExitChatCommandSchema>;

/** 202 response. `ended` = a chat.ended committed (false: nothing to close). */
export const ExitChatAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  conversation_id: z.string().min(1),
  ended: z.boolean(),
  /** The reflect_chat ledger key, when a range closed. */
  job_key: z.string().min(1).optional(),
});
export type ExitChatAccepted = z.infer<typeof ExitChatAcceptedSchema>;

/**
 * POST /v1/commands/start-scene-from-chat — the startscene() bridge (M6 part
 * 2, Rev 4 §8): ends the chat (reason startscene) and opens a real scene with
 * the character. `place` is an existing sublocation id, an existing name, or
 * a free-text place string — resolved server-side; an unresolved place rides
 * scene.started as place_request for the Narrator's standard create workflow
 * (query-first rule included). 409 while scene-open blocking jobs run.
 */
export const StartSceneFromChatCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  character_id: z.string().min(1),
  scene_id: z.string().min(1),
  title: z.string().min(1).max(200),
  /** Existing sublocation id/name, or a free-text place ("the park"). */
  place: z.string().min(1).max(200),
  /** Optional premise line the scene opens on. */
  premise: z.string().min(1).max(500).optional(),
});
export type StartSceneFromChatCommand = z.infer<
  typeof StartSceneFromChatCommandSchema
>;

/** 202 response: the chat range closed and the scene opened. */
export const StartSceneFromChatAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  scene_id: z.string().min(1),
  /** Present when `place` resolved to a known sublocation — the scene opened
   * there. Absent = the Narrator received it as place_request instead. */
  sublocation_id: z.string().min(1).optional(),
});
export type StartSceneFromChatAccepted = z.infer<
  typeof StartSceneFromChatAcceptedSchema
>;

/**
 * POST /v1/commands/start-group-chat — open a group chat (0.14.0, Rev 4 §8:
 * USER-started only — characters cannot fire group chats and CRON never
 * posts into them). Members are fixed at start in V1. Idempotent per
 * request_id (it seeds the conversation id).
 */
export const StartGroupChatCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  member_ids: z.array(z.string().min(1)).min(2).max(5),
  title: z.string().min(1).max(120),
  request_id: z.string().min(1).max(100),
});
export type StartGroupChatCommand = z.infer<typeof StartGroupChatCommandSchema>;

/** 202 response: the group exists; chat.group_started is on the stream. */
export const StartGroupChatAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  conversation_id: z.string().min(1),
});
export type StartGroupChatAccepted = z.infer<
  typeof StartGroupChatAcceptedSchema
>;

/**
 * POST /v1/commands/send-group-message — one user line into a group (0.14.0):
 * the line commits at the seam; the Group-chat Narrator then routes up to the
 * engine-enforced turn budget of character replies (NO narration of its own),
 * each arriving as chat.group_message_committed. Idempotent per request_id.
 */
export const SendGroupMessageCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  conversation_id: z.string().min(1),
  text: z.string().min(1).max(8192),
  request_id: z.string().min(1).max(100),
});
export type SendGroupMessageCommand = z.infer<
  typeof SendGroupMessageCommandSchema
>;

/** 202 response: the user line is durable; `routing` = the router round is
 * generating now. */
export const SendGroupMessageAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  conversation_id: z.string().min(1),
  message_id: z.string().min(1),
  routing: z.boolean(),
});
export type SendGroupMessageAccepted = z.infer<
  typeof SendGroupMessageAcceptedSchema
>;

/**
 * POST /v1/commands/exit-group-chat — the user leaves the group (0.14.0):
 * closes the open range with chat.group_ended(reason exit) and enqueues
 * exactly ONE reflect_chat job per member atomically.
 */
export const ExitGroupChatCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  conversation_id: z.string().min(1),
});
export type ExitGroupChatCommand = z.infer<typeof ExitGroupChatCommandSchema>;

/** 202 response. `ended` = a chat.group_ended committed. */
export const ExitGroupChatAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  conversation_id: z.string().min(1),
  ended: z.boolean(),
  jobs_enqueued: z.int().nonnegative(),
});
export type ExitGroupChatAccepted = z.infer<typeof ExitGroupChatAcceptedSchema>;

/**
 * POST /v1/commands/feed-reply — the user replies to a comment on a feed
 * post (0.15.0, M6 part 5, owner ruling 2026-07-11): the reply lives in a
 * feed-local thread under that comment (never routed into Weltari Chat).
 * The reply commits durably at the seam; the comment's author answers
 * detached, arriving as social.reply_answered. Uncapped — user-triggered
 * spend. Idempotent per request_id (a duplicate send is a silent 202 no-op).
 */
export const FeedReplyCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  post_id: z.string().min(1).max(100),
  /** The comment (social.reaction_committed reaction_id) being replied to. */
  reaction_id: z.string().min(1).max(200),
  text: z.string().min(1).max(2000),
  /** Client-chosen idempotency token; becomes the reply_id. */
  request_id: z.string().min(1).max(100),
});
export type FeedReplyCommand = z.infer<typeof FeedReplyCommandSchema>;

/** 202 response: the user reply is durable; the answer is generating. */
export const FeedReplyAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  reply_id: z.string().min(1),
});
export type FeedReplyAccepted = z.infer<typeof FeedReplyAcceptedSchema>;

/**
 * POST /v1/commands/subwiki-edit — the user manually edits a sublocation's
 * wiki entry from the Wiki page (0.15.0, owner ruling 2026-07-11: applies
 * immediately — no Proposal round-trip in V1). Appends subwiki.edited with
 * USER actor provenance; every wiki read from then on sees this entry until
 * a later write (manual or World Agent) supersedes it, auditable in the log.
 */
export const SubwikiEditCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  sublocation_id: z.string().min(1),
  entry: z.string().min(1).max(4000),
});
export type SubwikiEditCommand = z.infer<typeof SubwikiEditCommandSchema>;

/** 202 response: the edit is durable and on the stream. */
export const SubwikiEditAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  sublocation_id: z.string().min(1),
});
export type SubwikiEditAccepted = z.infer<typeof SubwikiEditAcceptedSchema>;

/**
 * POST /v1/commands/resolve-proposal — the approver's decision on a pending
 * proposal (0.17.0, M7 part 2, Rev 4 §16). `approved` applies the diff
 * through the engine ATOMICALLY with proposal.resolved (the applied rows
 * carry the proposal_id as provenance); `rejected` writes only the resolved
 * event — zero domain rows (I8). Idempotent: a proposal resolves once; a
 * second resolve is a 409.
 */
export const ResolveProposalCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  proposal_id: z.string().min(1).max(100),
  resolution: z.enum(['approved', 'rejected']),
});
export type ResolveProposalCommand = z.infer<
  typeof ResolveProposalCommandSchema
>;

/** 202 response: the resolution is durable. `applied` counts the domain
 * events the approval appended (0 on reject). */
export const ResolveProposalAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  proposal_id: z.string().min(1),
  resolution: z.enum(['approved', 'rejected']),
  applied: z.int().nonnegative(),
});
export type ResolveProposalAccepted = z.infer<
  typeof ResolveProposalAcceptedSchema
>;

/**
 * POST /v1/commands/set-config-flag — flip a world flag (0.17.0, Rev 4 §15).
 * Durable as a config.flag_set event; the flag state is a latest-wins fold.
 */
export const SetConfigFlagCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  flag: z.enum(['profiling_enabled']),
  value: z.boolean(),
});
export type SetConfigFlagCommand = z.infer<typeof SetConfigFlagCommandSchema>;

/** 202 response: the flag state is durable and on the stream. */
export const SetConfigFlagAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  flag: z.enum(['profiling_enabled']),
  value: z.boolean(),
});
export type SetConfigFlagAccepted = z.infer<typeof SetConfigFlagAcceptedSchema>;

/**
 * POST /v1/commands/set-character-lock — toggle a character's evolution lock
 * (0.17.0, Rev 4 §7/§11): the user-facing switch over the flag that has
 * gated character.evolved since 0.16.0. 409 on an unknown character.
 */
export const SetCharacterLockCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
  character_id: z.string().min(1),
  locked: z.boolean(),
});
export type SetCharacterLockCommand = z.infer<
  typeof SetCharacterLockCommandSchema
>;

/** 202 response: the lock state is durable and on the stream. */
export const SetCharacterLockAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  character_id: z.string().min(1),
  locked: z.boolean(),
});
export type SetCharacterLockAccepted = z.infer<
  typeof SetCharacterLockAcceptedSchema
>;

/**
 * POST /v1/commands/delete-profile — the GDPR erasure right (0.17.0, Rev 4
 * §9 guardrails): physically deletes the caller's profile rows from the side
 * store and appends profile.deleted in the same transaction. The store is
 * not a log projection, so replay never resurrects the data. Deleting an
 * empty profile is a silent 202 no-op (removed: 0).
 */
export const DeleteProfileCommandSchema = z.strictObject({
  world_id: z.string().min(1),
  actor_id: z.string().min(1),
});
export type DeleteProfileCommand = z.infer<typeof DeleteProfileCommandSchema>;

/** 202 response: the rows are gone. */
export const DeleteProfileAcceptedSchema = z.strictObject({
  accepted: z.literal(true),
  removed: z.int().nonnegative(),
});
export type DeleteProfileAccepted = z.infer<typeof DeleteProfileAcceptedSchema>;

/** 4xx response for a schema-valid command the engine refused (e.g. busy scene). */
export const CommandRejectedSchema = z.strictObject({
  accepted: z.literal(false),
  error: z.string().min(1),
});
export type CommandRejected = z.infer<typeof CommandRejectedSchema>;
