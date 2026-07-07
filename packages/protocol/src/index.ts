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
 */
export const PROTOCOL_VERSION = '0.4.0';

export {
  ArtSwitchedEventSchema,
  ImageRegionSchema,
  MapPositionSchema,
  type MapPosition,
  JobErrorSchema,
  JobFailedEventSchema,
  JobParkedEventSchema,
  PainterCompletedEventSchema,
  PluginRejectedEventSchema,
  ReflectionCommittedEventSchema,
  SceneEndedEventSchema,
  SceneStartedEventSchema,
  SublocationChangedEventSchema,
  TurnCommittedEventSchema,
  TurnStartedEventSchema,
  TurnStepSchema,
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
  PluginInfoSchema,
  PluginListSchema,
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
  CommandRejectedSchema,
  EndSceneAcceptedSchema,
  EndSceneCommandSchema,
  InterruptTurnAcceptedSchema,
  InterruptTurnCommandSchema,
  OpenSceneAcceptedSchema,
  OpenSceneCommandSchema,
  PaintRegionAcceptedSchema,
  PaintRegionCommandSchema,
  StartTurnAcceptedSchema,
  StartTurnCommandSchema,
  type AdvanceTimeAccepted,
  type AdvanceTimeCommand,
  type CommandRejected,
  type EndSceneAccepted,
  type EndSceneCommand,
  type InterruptTurnAccepted,
  type InterruptTurnCommand,
  type OpenSceneAccepted,
  type OpenSceneCommand,
  type PaintRegionAccepted,
  type PaintRegionCommand,
  type StartTurnAccepted,
  type StartTurnCommand,
} from './commands.js';
