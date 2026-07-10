// Emits the committed JSON Schemas for non-JS clients (Guide B9, Invariant I7).
// Generated output — never hand-edit schemas/*.json; re-run `npm run protocol:emit`.
// Run after `tsc -b` (imports the built dist/).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  AdvanceTimeAcceptedSchema,
  AdvanceTimeCommandSchema,
  ApplyUpdateAcceptedSchema,
  ApplyUpdateCommandSchema,
  CommandRejectedSchema,
  DevEventSchema,
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
  MapJumpDetailSchema,
  OpenSceneAcceptedSchema,
  OpenSceneCommandSchema,
  PaintRegionAcceptedSchema,
  PaintRegionCommandSchema,
  PluginListSchema,
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
  StreamHelloSchema,
  StreamSentenceSchema,
  WeltariEventSchema,
} from '../dist/index.js';

const outDir = join(import.meta.dirname, '..', 'schemas');
await mkdir(outDir, { recursive: true });

const files = {
  'weltari-event.json': WeltariEventSchema,
  'stream-hello.json': StreamHelloSchema,
  'stream-sentence.json': StreamSentenceSchema,
  'dev-event.json': DevEventSchema,
  'start-turn-command.json': StartTurnCommandSchema,
  'start-turn-accepted.json': StartTurnAcceptedSchema,
  'end-scene-command.json': EndSceneCommandSchema,
  'end-scene-accepted.json': EndSceneAcceptedSchema,
  'interrupt-turn-command.json': InterruptTurnCommandSchema,
  'interrupt-turn-accepted.json': InterruptTurnAcceptedSchema,
  'open-scene-command.json': OpenSceneCommandSchema,
  'open-scene-accepted.json': OpenSceneAcceptedSchema,
  'explore-command.json': ExploreCommandSchema,
  'explore-accepted.json': ExploreAcceptedSchema,
  'advance-time-command.json': AdvanceTimeCommandSchema,
  'advance-time-accepted.json': AdvanceTimeAcceptedSchema,
  'paint-region-command.json': PaintRegionCommandSchema,
  'paint-region-accepted.json': PaintRegionAcceptedSchema,
  'map-edit-command.json': MapEditCommandSchema,
  'map-edit-accepted.json': MapEditAcceptedSchema,
  'map-click-command.json': MapClickCommandSchema,
  'map-click-accepted.json': MapClickAcceptedSchema,
  'apply-update-command.json': ApplyUpdateCommandSchema,
  'apply-update-accepted.json': ApplyUpdateAcceptedSchema,
  'send-chat-message-command.json': SendChatMessageCommandSchema,
  'send-chat-message-accepted.json': SendChatMessageAcceptedSchema,
  'start-group-chat-command.json': StartGroupChatCommandSchema,
  'start-group-chat-accepted.json': StartGroupChatAcceptedSchema,
  'send-group-message-command.json': SendGroupMessageCommandSchema,
  'send-group-message-accepted.json': SendGroupMessageAcceptedSchema,
  'exit-group-chat-command.json': ExitGroupChatCommandSchema,
  'exit-group-chat-accepted.json': ExitGroupChatAcceptedSchema,
  'exit-chat-command.json': ExitChatCommandSchema,
  'exit-chat-accepted.json': ExitChatAcceptedSchema,
  'start-scene-from-chat-command.json': StartSceneFromChatCommandSchema,
  'start-scene-from-chat-accepted.json': StartSceneFromChatAcceptedSchema,
  'command-rejected.json': CommandRejectedSchema,
  'plugin-list.json': PluginListSchema,
  'map-jump-detail.json': MapJumpDetailSchema,
};

for (const [name, schema] of Object.entries(files)) {
  const jsonSchema = z.toJSONSchema(schema, { target: 'draft-2020-12' });
  await writeFile(
    join(outDir, name),
    `${JSON.stringify(jsonSchema, null, 2)}\n`,
    'utf8',
  );
}
console.log(
  `emitted ${Object.keys(files).length} schemas to packages/protocol/schemas/`,
);
