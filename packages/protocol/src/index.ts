// The protocol package is the language-neutral contract between the engine and
// every client (built-in web app, V1.5 CLI, future external games — Brief §1).
// It is MIT-licensed and must never import from apps/* (license fence, Guide A12).

/**
 * Protocol semver, sent in the handshake. Major bumps signal breaking wire
 * changes; CI blocks schema removals without one (Invariant I7).
 * 0.2.0: interrupt-turn command; sublocation.changed + art.switched events;
 * scene.ended end_type/divider_text; dev.tool_call/dev.tool_rejected frames.
 * 0.3.0: plugin.rejected event; GET /v1/plugins wire shapes (PluginInfo).
 * 0.4.0: sublocation.changed optional map_position (map connector surface);
 * GET /v1/images/* serves painter outputs (tile source).
 * 0.5.0: update.available + update.staged events; apply-update command
 * (self-update path, FINAL item 12 / Guide B12).
 * 0.6.0: wl-map-jump DOM event detail (map connector surface, UI Spec §1.14).
 * 0.7.0: character.joined event (scene roster projection — the VN line-up
 * renders the cast from the stream instead of a fixture constant).
 * 0.8.0: sublocation.materialized event (fog projection: explored =
 * materialized); explore command (one LLM-class materialize job per square);
 * open-scene optional sublocation_id (open a scene AT a known sublocation);
 * hello optional app_version.
 * 0.9.0 (M5 part 2, Rev 4 §14): Flow A — map-edit command +
 * map_edit.requested + sublocation.created events (lasso/pencil edits);
 * Flow B — map-click command + map_click.resolved event (radius/footprint
 * enter bypass, VLM classify → story LLM → persist-or-discard); optional
 * job_key on job.failed/job.parked (clients tie failures back to their
 * command).
 * 0.10.0 (M6 part 1, Rev 4 §6): the in-scene creation loop —
 * sublocation.stub_created event (the Narrator's create_sublocation tool:
 * identity stubs, hot path; backdrops + materialization fire from it);
 * scene.ended optional next_scene (the "Jump to the next scene"
 * registration).
 * 0.11.0 (M6 part 2, Rev 4 §8/§11): Weltari Chat part one —
 * chat.message_committed + chat.ended + reflect_chat.committed +
 * cache.appended events (DMs on the ONE event stream; the CACHE store is a
 * projection); send-chat-message / exit-chat / start-scene-from-chat
 * commands (the startscene() bridge); scene.started optional premise +
 * place_request (the chat→scene handoff surface); subwiki.updated event
 * (Rev 4 §10: the World Agent's scene-end pass writes wiki entries for
 * Narrator-created sublocations that participated — transient places never).
 * 0.12.0 (M6 part 3, Rev 4 §8): proactive CRON DMs — chat.outreach_recorded
 * (eager generation: the push IS the message; natural key world +
 * occurrence_iso; stamped with both the real fire time and the fictional
 * game_time) and chat.thread_frozen (the 3-unanswered hard cap as a durable
 * event — the gateway's future push hook; a user reply resets the counter by
 * construction).
 * 0.13.0 (M6 part 4, Rev 4 §7, owner rulings 2026-07-10/11): invitation
 * expiry — scene.started optional invitation (character-chosen game-time
 * wait_hours + engine-stamped expires_at_game); scene.expired event (lazy
 * judgment at clock advances/triggers; closes the scene, releases presence,
 * rides one transaction with the hardcoded cache.appended absence entry);
 * chat.notice event (the red-line rollback notice after a critical tool
 * chain exhausts its retry ceiling).
 * 0.14.0 (M6 part 4, Rev 4 §8): group chats — chat.group_started /
 * chat.group_message_committed / chat.group_ended events (user-started only;
 * the Group-chat Narrator routes turns and NEVER narrates — router decisions
 * are log-only; a range close enqueues exactly one reflect_chat per member);
 * start-group-chat / send-group-message / exit-group-chat commands. The
 * proactive-DM occurrence_iso is a GAME-time boundary from 0.13.0 on (owner
 * ruling 2026-07-10/11: fires only when the world clock advances).
 * 0.15.0 (M6 part 5, Rev 4 §10/§11/§12, owner rulings 2026-07-11): the Feed —
 * social.post_committed (game-time cadence, natural key world +
 * occurrence_iso, acquaintance delivery) / social.reaction_committed (one
 * skill-triggered decision per picked recipient, cap env-tunable) /
 * social.reply_posted + social.reply_answered (feed-local comment threads:
 * the user replies, the comment's author answers — never routed into Chat);
 * feed-reply command; cache.appended origin gains `social` (latest-per-origin
 * keeps feed comments from shadowing scene memory). Wiki manual edits —
 * subwiki.edited event (USER actor provenance, applies immediately; the
 * Proposal pipeline is deferred) + subwiki-edit command.
 * 0.16.0 (M7 part 1, Rev 4 §11/§4.2/§7, owner rulings 2026-07-11): the real
 * memory store — memory.delta_committed (append-only archive deltas, the
 * FTS5 Search Index projection's source) / memory.core_updated (full durable
 * core snapshot; prompts inject seed + latest — I5 holds) /
 * character.evolved (personality/goals evolution behind the per-character
 * locked flag) / memory.compacted (cumulative summary over old deltas;
 * re-runs supersede — repair for free, the log stays append-only) /
 * cache.pruned (retention as a view watermark, never a deletion). All five
 * emitted only by reflection-class/maintenance ledger jobs through the
 * character's serial group.
 * 0.17.0 (M7 part 2, Rev 4 §9/§15/§16, owner rulings 2026-07-11): the GM
 * agent — proposal.submitted (the uniform consent object {action, diff,
 * rationale, proposer, approvers[]}; a closed per-action diff union) /
 * proposal.resolved (approve applies atomically, reject leaves zero domain
 * rows) / character.created (consent-gated seed profiles — the live-profile
 * fold's event-borne seed layer) / world.seeded (cold boot's terminal state)
 * / gateway.binding_established (gates the once-per-binding GM onboarding
 * push) / config.flag_set (world flags as latest-wins folds;
 * profiling_enabled) / character.lock_set (the user-facing evolution lock) /
 * profile.updated + profile.deleted (references only — hypotheses live in a
 * deletable side store outside the log: GDPR). sublocation.materialized
 * gains optional space + proposal_id; subwiki.edited gains optional
 * proposal_id (both additive). Commands: resolve-proposal, set-config-flag,
 * set-character-lock, delete-profile. GET /v1/profile (+ /export) wire
 * shape: UserProfileView (entries + the profiling_enabled fold — the
 * hypotheses travel only over this surface, never the event stream).
 */
export const PROTOCOL_VERSION = '0.17.0';

export {
  ArtSwitchedEventSchema,
  CacheAppendedEventSchema,
  CachePrunedEventSchema,
  CharacterCreatedEventSchema,
  CharacterEvolvedEventSchema,
  CharacterJoinedEventSchema,
  CharacterLockSetEventSchema,
  ConfigFlagSetEventSchema,
  GatewayBindingEstablishedEventSchema,
  ChatEndedEventSchema,
  ChatMessageCommittedEventSchema,
  ChatGroupEndedEventSchema,
  ChatGroupMessageCommittedEventSchema,
  ChatGroupStartedEventSchema,
  ChatNoticeEventSchema,
  ChatOutreachRecordedEventSchema,
  ChatThreadFrozenEventSchema,
  ReflectChatCommittedEventSchema,
  ImageRegionSchema,
  MAP_FOG_GRID,
  MapPositionSchema,
  type MapPosition,
  MapSquareSchema,
  type MapSquare,
  JobErrorSchema,
  JobFailedEventSchema,
  JobParkedEventSchema,
  MapClickResolvedEventSchema,
  MapEditRequestedEventSchema,
  MemoryCompactedEventSchema,
  MemoryCoreUpdatedEventSchema,
  MemoryDeltaCommittedEventSchema,
  PainterCompletedEventSchema,
  PluginRejectedEventSchema,
  ProfileDeletedEventSchema,
  ProfileUpdatedEventSchema,
  ProposalCharacterDiffSchema,
  ProposalPlaceDiffSchema,
  ProposalResolvedEventSchema,
  ProposalSubmittedEventSchema,
  ReflectionCommittedEventSchema,
  SceneEndedEventSchema,
  SceneExpiredEventSchema,
  SceneStartedEventSchema,
  SocialPostCommittedEventSchema,
  SocialReactionCommittedEventSchema,
  SocialReplyAnsweredEventSchema,
  SocialReplyPostedEventSchema,
  SublocationChangedEventSchema,
  SublocationCreatedEventSchema,
  SublocationMaterializedEventSchema,
  SublocationStubCreatedEventSchema,
  SubwikiEditedEventSchema,
  SubwikiUpdatedEventSchema,
  TurnCommittedEventSchema,
  TurnStartedEventSchema,
  TurnStepSchema,
  UpdateAvailableEventSchema,
  UpdateStagedEventSchema,
  WeltariEventSchema,
  WorldAgentCommittedEventSchema,
  WorldCronCompletedEventSchema,
  WorldSeededEventSchema,
  WorldTimeAdvancedEventSchema,
  type ImageRegion,
  type ProposalCharacterDiff,
  type ProposalPlaceDiff,
  type TurnStep,
  type WeltariEvent,
  type WeltariEventType,
} from './events.js';
export {
  StreamHelloSchema,
  StreamSentenceSchema,
  type StreamHello,
  type StreamSentence,
} from './stream.js';
export {
  MapJumpDetailSchema,
  PluginInfoSchema,
  PluginListSchema,
  type MapJumpDetail,
  type PluginInfo,
  type PluginList,
} from './plugins.js';
export {
  ProfileEntrySchema,
  UserProfileViewSchema,
  type ProfileEntry,
  type UserProfileView,
} from './profile.js';
export {
  DevEventSchema,
  DevGaugesSchema,
  DevToolCallSchema,
  DevToolRejectedSchema,
  type DevEvent,
  type DevGauges,
  type DevToolCall,
  type DevToolRejected,
} from './dev.js';
export {
  AdvanceTimeAcceptedSchema,
  AdvanceTimeCommandSchema,
  ApplyUpdateAcceptedSchema,
  ApplyUpdateCommandSchema,
  CommandRejectedSchema,
  DeleteProfileAcceptedSchema,
  DeleteProfileCommandSchema,
  EndSceneAcceptedSchema,
  EndSceneCommandSchema,
  ExitChatAcceptedSchema,
  ExitChatCommandSchema,
  ExitGroupChatAcceptedSchema,
  ExitGroupChatCommandSchema,
  ExploreAcceptedSchema,
  ExploreCommandSchema,
  FeedReplyAcceptedSchema,
  FeedReplyCommandSchema,
  InterruptTurnAcceptedSchema,
  InterruptTurnCommandSchema,
  MapClickAcceptedSchema,
  MapClickCommandSchema,
  MapEditAcceptedSchema,
  MapEditCommandSchema,
  OpenSceneAcceptedSchema,
  OpenSceneCommandSchema,
  PaintRegionAcceptedSchema,
  PaintRegionCommandSchema,
  ResolveProposalAcceptedSchema,
  ResolveProposalCommandSchema,
  SendChatMessageAcceptedSchema,
  SendChatMessageCommandSchema,
  SetCharacterLockAcceptedSchema,
  SetCharacterLockCommandSchema,
  SetConfigFlagAcceptedSchema,
  SetConfigFlagCommandSchema,
  SendGroupMessageAcceptedSchema,
  SendGroupMessageCommandSchema,
  StartGroupChatAcceptedSchema,
  StartGroupChatCommandSchema,
  StartSceneFromChatAcceptedSchema,
  StartSceneFromChatCommandSchema,
  StartTurnAcceptedSchema,
  StartTurnCommandSchema,
  SubwikiEditAcceptedSchema,
  SubwikiEditCommandSchema,
  type AdvanceTimeAccepted,
  type AdvanceTimeCommand,
  type ApplyUpdateAccepted,
  type ApplyUpdateCommand,
  type CommandRejected,
  type DeleteProfileAccepted,
  type DeleteProfileCommand,
  type EndSceneAccepted,
  type EndSceneCommand,
  type ExitChatAccepted,
  type ExitChatCommand,
  type ExitGroupChatAccepted,
  type ExitGroupChatCommand,
  type ExploreAccepted,
  type ExploreCommand,
  type FeedReplyAccepted,
  type FeedReplyCommand,
  type InterruptTurnAccepted,
  type InterruptTurnCommand,
  type MapClickAccepted,
  type MapClickCommand,
  type MapEditAccepted,
  type MapEditCommand,
  type OpenSceneAccepted,
  type OpenSceneCommand,
  type PaintRegionAccepted,
  type PaintRegionCommand,
  type ResolveProposalAccepted,
  type ResolveProposalCommand,
  type SendChatMessageAccepted,
  type SendChatMessageCommand,
  type SetCharacterLockAccepted,
  type SetCharacterLockCommand,
  type SetConfigFlagAccepted,
  type SetConfigFlagCommand,
  type SendGroupMessageAccepted,
  type SendGroupMessageCommand,
  type StartGroupChatAccepted,
  type StartGroupChatCommand,
  type StartSceneFromChatAccepted,
  type StartSceneFromChatCommand,
  type StartTurnAccepted,
  type StartTurnCommand,
  type SubwikiEditAccepted,
  type SubwikiEditCommand,
} from './commands.js';
