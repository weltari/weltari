// M5 map-QA spot check (Week 7 criterion c): feed a composited map + one
// sublocation stub description to the real VLM and ask whether the described
// area is plausibly visible. Uses the SAME fenced seam the server ships
// (dist/llm/vlm.js) and the same gate-1 pattern (parseLlmJson → validateAt) —
// a garbage/non-JSON reply is rejected and NOTHING is written anywhere (this
// tool owns no database). Flow B click classification (week 8) reuses the
// VlmCall shape; only the prompt/schema will differ.
//
// Usage: OPENROUTER_API_KEY=... node tools/m5-map-qa.mjs \
//          --image data/images/map-w1/<sha>.png \
//          --name "The Mill Pond" --description "A still pond ..."
// Env: WELTARI_VLM_MODEL (default google/gemini-3.5-flash)
// Exit: 0 = schema-gated verdict, visible; 1 = gated verdict, NOT visible;
//       2 = reply rejected by the gate / provider failure / bad usage.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (p) =>
  import(pathToFileURL(join(ROOT, 'apps', 'server', 'dist', p)).href);

const { createOpenRouterVlmClient, mapQaVerdictSchema } =
  await dist('llm/vlm.js');
const { parseLlmJson } = await dist('llm/structured.js');
const { validateAt } = await dist('boundary/validate.js');
const { createRootLogger } = await dist('observability/logger.js');

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const imagePath = arg('image');
const name = arg('name') ?? 'the described area';
const description = arg('description');
const apiKey = process.env.OPENROUTER_API_KEY;
if (!imagePath || !description || !apiKey) {
  console.error(
    'usage: OPENROUTER_API_KEY=... node tools/m5-map-qa.mjs --image <png> --description "<stub description>" [--name "<name>"]',
  );
  process.exit(2);
}

const logger = createRootLogger({ level: 'warn' });
const model = process.env.WELTARI_VLM_MODEL ?? 'google/gemini-3.5-flash';
const client = createOpenRouterVlmClient({ apiKey, model, logger });

const prompt =
  'You are quality-checking one tile region of a hand-painted top-down fantasy world map. ' +
  `Somewhere on this map there should be an area matching this description:\n"${name}": ${description}\n` +
  'Judge whether such an area is plausibly visible in the image (terrain type, ' +
  'landmark shapes — names/labels are never painted). Respond with ONLY a JSON object: ' +
  '{"visible": true|false, "confidence": "low"|"medium"|"high", "reasoning": "one or two sentences"}';

const result = await client.describe({
  kind: 'map_qa',
  prompt,
  image: readFileSync(imagePath),
  mediaType: 'image/png',
});
if (!result.ok) {
  console.error(`VLM call failed (operational): ${result.error.message}`);
  process.exit(2);
}

console.log(
  `model: ${result.value.model} | ${result.value.durationMs} ms | ` +
    `in=${result.value.usage.inputTokens} out=${result.value.usage.outputTokens} tokens`,
);

const verdict = validateAt(
  'llm',
  'map_qa.verdict',
  mapQaVerdictSchema,
  parseLlmJson(result.value.text),
  logger,
);
if (!verdict.ok) {
  console.error(
    'REJECTED: the reply failed the schema gate (zero rows written anywhere).',
  );
  console.error(
    `raw reply (first 400 chars): ${result.value.text.slice(0, 400)}`,
  );
  process.exit(2);
}

console.log(JSON.stringify(verdict.value, null, 2));
process.exit(verdict.value.visible ? 0 : 1);
