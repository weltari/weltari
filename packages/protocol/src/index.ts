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
 */
export const PROTOCOL_VERSION = '0.14.0';

export {
  ArtSwitchedEventSchema,
  CacheAppendedEventSchema,
  CharacterJoinedEventSchema,
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
  PainterCompletedEventSchema,
  PluginRejectedEventSchema,
  ReflectionCommittedEventSchema,
  SceneEndedEventSchema,
  SceneExpiredEventSchema,
  SceneStartedEventSchema,
  SublocationChangedEventSchema,
  SublocationCreatedEventSchema,
  SublocationMaterializedEventSchema,
  SublocationStubCreatedEventSchema,
  SubwikiUpdatedEventSchema,
  TurnCommittedEventSchema,
  TurnStartedEventSchema,
  TurnStepSchema,
  UpdateAvailableEventSchema,
  UpdateStagedEventSchema,
  WeltariEventSchema,
  WorldAgentCommittedEventSchema,
  WorldCronCompletedEventSchema,
  WorldTimeAdvancedEventSchema,
  type ImageRegion,
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
  EndSceneAcceptedSchema,
  EndSceneCommandSchema,
  ExitChatAcceptedSchema,
  ExitChatCommandSchema,
  ExitGroupChatAcceptedSchema,
  ExitGroupChatCommandSchema,
  ExploreAcceptedSchema,
  ExploreCommandSchema,
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
  SendChatMessageAcceptedSchema,
  SendChatMessageCommandSchema,
  SendGroupMessageAcceptedSchema,
  SendGroupMessageCommandSchema,
  StartGroupChatAcceptedSchema,
  StartGroupChatCommandSchema,
  StartSceneFromChatAcceptedSchema,
  StartSceneFromChatCommandSchema,
  StartTurnAcceptedSchema,
  StartTurnCommandSchema,
  type AdvanceTimeAccepted,
  type AdvanceTimeCommand,
  type ApplyUpdateAccepted,
  type ApplyUpdateCommand,
  type CommandRejected,
  type EndSceneAccepted,
  type EndSceneCommand,
  type ExitChatAccepted,
  type ExitChatCommand,
  type ExitGroupChatAccepted,
  type ExitGroupChatCommand,
  type ExploreAccepted,
  type ExploreCommand,
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
  type SendChatMessageAccepted,
  type SendChatMessageCommand,
  type SendGroupMessageAccepted,
  type SendGroupMessageCommand,
  type StartGroupChatAccepted,
  type StartGroupChatCommand,
  type StartSceneFromChatAccepted,
  type StartSceneFromChatCommand,
  type StartTurnAccepted,
  type StartTurnCommand,
} from './commands.js';
