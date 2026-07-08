// The VLM seam, tested offline through the provider's fetch seam — no
// network, no cost. What matters: the image travels as an image part, the
// raw text comes back untouched (a gate-1 subject), and provider failures
// are operational Results, never throws (C2).
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { validateAt } from '../boundary/validate.js';
import { createRootLogger } from '../observability/logger.js';
import { parseLlmJson } from './structured.js';
import {
  createOpenRouterVlmClient,
  mapQaVerdictSchema,
  type VlmCall,
} from './vlm.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

// A 1×1 red PNG — enough to prove the byte path.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const CALL: VlmCall = {
  kind: 'map_qa',
  prompt: 'Is a mill pond visible?',
  image: TINY_PNG,
  mediaType: 'image/png',
};

function completionResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: 'gen-1',
      object: 'chat.completion',
      created: 1,
      model: 'google/gemini-3.5-flash',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1300, completion_tokens: 25, total_tokens: 1325 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('VLM seam (B-llm: image + prompt in, raw gate-1 text out)', () => {
  it('sends the image as an image part and returns the raw text + usage', async () => {
    let requestBody = '';
    const client = createOpenRouterVlmClient({
      apiKey: 'test-key',
      model: 'google/gemini-3.5-flash',
      logger: quietLogger(),
      fetch: async (_url, init): Promise<Response> => {
        requestBody = typeof init?.body === 'string' ? init.body : '';
        return Promise.resolve(
          completionResponse('{"visible": true, "confidence": "high"}'),
        );
      },
    });
    const result = await client.describe(CALL);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // RAW text, untouched — parsing/validation is the caller's gate 1.
      expect(result.value.text).toBe('{"visible": true, "confidence": "high"}');
      expect(result.value.usage.inputTokens).toBe(1300);
      expect(result.value.usage.outputTokens).toBe(25);
    }
    // The image reached the wire as a data URL with our bytes.
    expect(requestBody).toContain(TINY_PNG.toString('base64'));
    expect(requestBody).toContain('Is a mill pond visible?');
  });

  it('a garbage reply dies at gate 1 — schema-rejected, nothing usable (B6/B4)', async () => {
    const client = createOpenRouterVlmClient({
      apiKey: 'test-key',
      model: 'google/gemini-3.5-flash',
      logger: quietLogger(),
      fetch: async (): Promise<Response> =>
        Promise.resolve(
          completionResponse('The pond is lovely, I refuse to emit JSON.'),
        ),
    });
    const result = await client.describe(CALL);
    expect(result.ok).toBe(true); // the CALL succeeded — the reply is garbage
    if (result.ok) {
      const verdict = validateAt(
        'llm',
        'map_qa.verdict',
        mapQaVerdictSchema,
        parseLlmJson(result.value.text),
        quietLogger(),
      );
      expect(verdict.ok).toBe(false); // reject, never repair
    }
  });

  it('a provider failure is an operational Result, never a throw (C2)', async () => {
    const client = createOpenRouterVlmClient({
      apiKey: 'test-key',
      model: 'google/gemini-3.5-flash',
      logger: quietLogger(),
      maxRetries: 0,
      fetch: async (): Promise<Response> =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'overloaded' } }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });
    const result = await client.describe(CALL);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('operational');
      expect(result.error.code).toBe('vlm_call_failed');
    }
  });
});
