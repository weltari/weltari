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
 */
export const PROTOCOL_VERSION = '0.11.0';

export {
  ArtSwitchedEventSchema,
  CacheAppendedEventSchema,
  CharacterJoinedEventSchema,
  ChatEndedEventSchema,
  ChatMessageCommittedEventSchema,
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
  type StartSceneFromChatAccepted,
  type StartSceneFromChatCommand,
  type StartTurnAccepted,
  type StartTurnCommand,
} from './commands.js';
