// Emits the committed JSON Schemas for non-JS clients (Guide B9, Invariant I7).
// Generated output — never hand-edit schemas/*.json; re-run `npm run protocol:emit`.
// Run after `tsc -b` (imports the built dist/).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  CommandRejectedSchema,
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
  'start-turn-command.json': StartTurnCommandSchema,
  'start-turn-accepted.json': StartTurnAcceptedSchema,
  'command-rejected.json': CommandRejectedSchema,
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
