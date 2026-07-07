// The only file that touches the AI SDK + OpenRouter provider (fence A11).
// Catches SDK exceptions at the edge and returns err(operational) — B-llm
// boundary code never throws for provider failures (Guide C2).
import { streamText, tool, type ToolSet } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';
import { err, ok, OperationalError, type Result } from '../errors.js';
import type { Logger } from '../observability/logger.js';
import type { ModelRegistry } from './model-registry.js';
import {
  ChangeSublocationToolSchema,
  EndSceneToolSchema,
  NARRATOR_TOOL_DESCRIPTIONS,
  SwitchArtToolSchema,
  type RawToolCall,
} from './tools.js';
import type { LlmCall, LlmCallResult, LlmClient } from './types.js';

// The SDK-side half of gate 1: the provider sees these Zod inputSchemas and
// malformed shapes die inside the SDK. The engine still re-parses every
// returned call with our own safeParse (Guide B6 — never trust provider JSON).
const NARRATOR_TOOLS: ToolSet = {
  end_scene: tool({
    description: NARRATOR_TOOL_DESCRIPTIONS.end_scene,
    inputSchema: EndSceneToolSchema,
  }),
  change_sublocation: tool({
    description: NARRATOR_TOOL_DESCRIPTIONS.change_sublocation,
    inputSchema: ChangeSublocationToolSchema,
  }),
  switch_art: tool({
    description: NARRATOR_TOOL_DESCRIPTIONS.switch_art,
    inputSchema: SwitchArtToolSchema,
  }),
};

export interface OpenRouterClientOptions {
  apiKey: string;
  registry: ModelRegistry;
  logger: Logger;
  timeoutMs?: number;
}

// Loose schemas (third-party payload, B5): unknown keys stripped, never trusted.
const usageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
});
const metadataSchema = z.object({
  openrouter: z
    .object({
      usage: z
        .object({
          promptTokens: z.number().optional(),
          completionTokens: z.number().optional(),
          promptTokensDetails: z
            .object({ cachedTokens: z.number().optional() })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

export function createOpenRouterClient(
  options: OpenRouterClientOptions,
): LlmClient {
  const openrouter = createOpenRouter({ apiKey: options.apiKey });
  const timeoutMs = options.timeoutMs ?? 120000;

  return {
    async streamCall(call: LlmCall): Promise<Result<LlmCallResult>> {
      const route = options.registry.routeFor(call.characterId, call.kind);
      const startedAt = performance.now();
      try {
        // v6 streamText does NOT throw on mid-stream provider errors — it ends
        // the stream and calls onError (default: console.error). Capture it so
        // an errored stream can never become a committed turn (B6).
        let streamError: unknown;
        const result = streamText({
          onError: ({ error }): void => {
            streamError = error;
          },
          model: openrouter.chat(route.model, {
            usage: { include: true },
            ...(route.providerOrder === undefined
              ? {}
              : {
                  extraBody: {
                    provider: {
                      order: [...route.providerOrder],
                      allow_fallbacks: false,
                    },
                  },
                }),
          }),
          // The stable prefix is the system message, sent first and byte-identical
          // every turn (I5). The cache_control breakpoint makes Anthropic-style
          // caching explicit and deterministic; OpenRouter drops it harmlessly
          // for providers with automatic prefix caching (OpenAI, Gemini, …).
          messages: [
            {
              role: 'system',
              content: call.system,
              providerOptions: {
                openrouter: { cacheControl: { type: 'ephemeral' } },
              },
            },
            { role: 'user', content: call.prompt },
          ],
          temperature: route.temperature,
          maxOutputTokens: route.maxOutputTokens,
          abortSignal: AbortSignal.timeout(timeoutMs),
          // No execute functions: calls come back as data for the B6 gates —
          // the SDK must never run a world mutation itself.
          ...(call.toolset === 'narrator'
            ? { tools: NARRATOR_TOOLS, toolChoice: 'auto' }
            : {}),
          // Our system message MUST live in messages[] to carry the
          // cache_control breakpoint; its content is the engine-owned stable
          // prefix, never user input, so the injection warning does not apply.
          allowSystemInMessages: true,
        });

        let text = '';
        for await (const delta of result.textStream) {
          text += delta;
          call.onTextDelta(delta);
        }
        if (streamError !== undefined) {
          return err(
            new OperationalError(
              'llm_stream_error',
              streamError instanceof Error
                ? streamError.message
                : JSON.stringify(streamError),
              { cause: streamError },
            ),
          );
        }

        const toolCalls: RawToolCall[] =
          call.toolset === undefined
            ? []
            : (await result.toolCalls).map((c) => ({
                tool: c.toolName,
                input: c.input,
              }));

        const usage = usageSchema.safeParse(await result.usage);
        const metadata = metadataSchema.safeParse(
          await result.providerMetadata,
        );
        const orUsage = metadata.success
          ? metadata.data.openrouter?.usage
          : undefined;
        const inputTokens =
          (usage.success ? usage.data.inputTokens : undefined) ??
          orUsage?.promptTokens ??
          0;
        const outputTokens =
          (usage.success ? usage.data.outputTokens : undefined) ??
          orUsage?.completionTokens ??
          0;
        const cachedInputTokens =
          (usage.success ? usage.data.cachedInputTokens : undefined) ??
          orUsage?.promptTokensDetails?.cachedTokens ??
          0;

        const durationMs = Math.round(performance.now() - startedAt);
        // C12: this debug line IS the cache-hit observability the risk register requires.
        options.logger.debug(
          {
            model: route.model,
            call_kind: call.kind,
            character_id: call.characterId,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cached_tokens: cachedInputTokens,
            duration_ms: durationMs,
          },
          'llm call finished',
        );
        return ok({
          text,
          usage: { inputTokens, outputTokens, cachedInputTokens },
          model: route.model,
          durationMs,
          toolCalls,
        });
      } catch (thrown) {
        return err(
          new OperationalError(
            'llm_call_failed',
            thrown instanceof Error
              ? thrown.message
              : 'unknown provider failure',
            { cause: thrown },
          ),
        );
      }
    },
  };
}
