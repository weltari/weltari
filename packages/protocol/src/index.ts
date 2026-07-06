// The protocol package is the language-neutral contract between the engine and
// every client (built-in web app, V1.5 CLI, future external games — Brief §1).
// It is MIT-licensed and must never import from apps/* (license fence, Guide A12).

/**
 * Protocol semver, sent in the handshake. Major bumps signal breaking wire
 * changes; CI blocks schema removals without one (Invariant I7).
 */
export const PROTOCOL_VERSION = '0.1.0';

export {
  JobErrorSchema,
  JobFailedEventSchema,
  JobParkedEventSchema,
  SceneStartedEventSchema,
  TurnCommittedEventSchema,
  TurnStartedEventSchema,
  TurnStepSchema,
  WeltariEventSchema,
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
  StartTurnAcceptedSchema,
  StartTurnCommandSchema,
  type StartTurnAccepted,
  type StartTurnCommand,
} from './commands.js';
