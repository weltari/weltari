// The only file that touches the AI SDK + OpenRouter provider (fence A11).
// Catches SDK exceptions at the edge and returns err(operational) — B-llm
// boundary code never throws for provider failures (Guide C2).
import { stepCountIs, streamText, tool, type ToolSet } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';
import { err, ok, OperationalError, type Result } from '../errors.js';
import type { Logger } from '../observability/logger.js';
import type { ModelRegistry } from './model-registry.js';
import {
  CacheToolSchema,
  ChangeSublocationToolSchema,
  CHAT_QUERY_DESCRIPTIONS,
  CHAT_TOOL_DESCRIPTIONS,
  CreateSublocationToolSchema,
  EndSceneToolSchema,
  EndSubsessionToolSchema,
  EvolveToolSchema,
  GROUP_ROUTER_TOOL_DESCRIPTIONS,
  MemoryDeltaToolSchema,
  MemoryqueryToolSchema,
  NARRATOR_TOOL_DESCRIPTIONS,
  QuerySublocationsToolSchema,
  ReactToolSchema,
  REFLECTION_TOOL_DESCRIPTIONS,
  RouteToolSchema,
  SessionqueryToolSchema,
  SOCIAL_REACT_TOOL_DESCRIPTIONS,
  StartSceneToolSchema,
  StaySilentToolSchema,
  SwitchArtToolSchema,
  UpdateCoreToolSchema,
  WikiqueryToolSchema,
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
  create_sublocation: tool({
    description: NARRATOR_TOOL_DESCRIPTIONS.create_sublocation,
    inputSchema: CreateSublocationToolSchema,
  }),
};

/** The chat toolset (M6 part 2, Rev 4 §8): data-only like every mutating
 * tool — the chat engine gates and appends, the SDK never executes. */
const CHAT_TOOLS: ToolSet = {
  cache: tool({
    description: CHAT_TOOL_DESCRIPTIONS.cache,
    inputSchema: CacheToolSchema,
  }),
  startscene: tool({
    description: CHAT_TOOL_DESCRIPTIONS.startscene,
    inputSchema: StartSceneToolSchema,
  }),
  stay_silent: tool({
    description: CHAT_TOOL_DESCRIPTIONS.stay_silent,
    inputSchema: StaySilentToolSchema,
  }),
};

/** The social-react toolset (M6 part 5, Rev 4 §12): one reaction decision —
 * data-only; the social_reaction handler gates and appends. */
const SOCIAL_REACT_TOOLS: ToolSet = {
  react: tool({
    description: SOCIAL_REACT_TOOL_DESCRIPTIONS.react,
    inputSchema: ReactToolSchema,
  }),
  stay_silent: tool({
    description: SOCIAL_REACT_TOOL_DESCRIPTIONS.stay_silent,
    inputSchema: StaySilentToolSchema,
  }),
  cache: tool({
    description: SOCIAL_REACT_TOOL_DESCRIPTIONS.cache,
    inputSchema: CacheToolSchema,
  }),
};

/**
 * How many model steps a narrator call may take when queries are offered:
 * query → (result) → maybe a refining query → (result) → the final step
 * whose text + mutating tool calls the engine gates. Without a gate executor
 * mutating tools carry no execute, so a step that calls one ends the loop.
 */
const QUERY_STEP_LIMIT = 3;
/** With the gate executor a refusal costs a step: rejected create → the
 * required query → the corrected create → the closing text (M6 part 2). */
const GATED_STEP_LIMIT = 4;

/** The narrator toolset, wired to the engine's executors the call offers.
 * query_sublocations runs mid-call (Rev 4 §6). With `gate` (M6 part 2) the
 * mutating tools ALSO execute mid-call — but their execute is the engine's
 * B6 double gate returning a staged-ack or the refusal string; staging stays
 * in-memory and durability still only happens at turn.committed. Without
 * `gate`, mutations carry no execute and come back as data for the gates. */
function narratorToolsFor(call: LlmCall): ToolSet {
  const gate = call.gate;
  const mutating: ToolSet =
    gate === undefined
      ? NARRATOR_TOOLS
      : {
          end_scene: tool({
            description: NARRATOR_TOOL_DESCRIPTIONS.end_scene,
            inputSchema: EndSceneToolSchema,
            execute: (input): string => gate({ tool: 'end_scene', input }),
          }),
          change_sublocation: tool({
            description: NARRATOR_TOOL_DESCRIPTIONS.change_sublocation,
            inputSchema: ChangeSublocationToolSchema,
            execute: (input): string =>
              gate({ tool: 'change_sublocation', input }),
          }),
          switch_art: tool({
            description: NARRATOR_TOOL_DESCRIPTIONS.switch_art,
            inputSchema: SwitchArtToolSchema,
            execute: (input): string => gate({ tool: 'switch_art', input }),
          }),
          create_sublocation: tool({
            description: NARRATOR_TOOL_DESCRIPTIONS.create_sublocation,
            inputSchema: CreateSublocationToolSchema,
            execute: (input): string =>
              gate({ tool: 'create_sublocation', input }),
          }),
        };
  const querySublocations = call.queries?.query_sublocations;
  if (querySublocations === undefined) return mutating;
  return {
    ...mutating,
    query_sublocations: tool({
      description: NARRATOR_TOOL_DESCRIPTIONS.query_sublocations,
      inputSchema: QuerySublocationsToolSchema,
      execute: (input): string => querySublocations(input),
    }),
  };
}

/** The chat toolset wired to the call's read-only query executors (M6 part
 * 3, Rev 4 §11): wikiquery/sessionquery run mid-call through the SAME seam
 * the narrator's query_sublocations proved in weeks 9/10 — results feed back
 * to the model; the stageable tools (cache/startscene) stay data-only. */
function chatToolsFor(call: LlmCall): ToolSet {
  return {
    ...CHAT_TOOLS,
    ...queryToolsFor(call),
  };
}

/** The read-only query tools a call offers, each wired to its engine
 * executor (mid-call, multi-step). Shared by the chat toolset and the
 * character_scene toolset (M7 part 1 — a character's scene turn carries
 * ONLY these: nothing stageable). */
function queryToolsFor(call: LlmCall): ToolSet {
  const wikiquery = call.queries?.wikiquery;
  const sessionquery = call.queries?.sessionquery;
  const memoryquery = call.queries?.memoryquery;
  return {
    ...(wikiquery === undefined
      ? {}
      : {
          wikiquery: tool({
            description: CHAT_QUERY_DESCRIPTIONS.wikiquery,
            inputSchema: WikiqueryToolSchema,
            execute: (input): string => wikiquery(input),
          }),
        }),
    ...(sessionquery === undefined
      ? {}
      : {
          sessionquery: tool({
            description: CHAT_QUERY_DESCRIPTIONS.sessionquery,
            inputSchema: SessionqueryToolSchema,
            execute: (input): string => sessionquery(input),
          }),
        }),
    ...(memoryquery === undefined
      ? {}
      : {
          memoryquery: tool({
            description: CHAT_QUERY_DESCRIPTIONS.memoryquery,
            inputSchema: MemoryqueryToolSchema,
            execute: (input): string => memoryquery(input),
          }),
        }),
  };
}

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
          // Without a gate executor, mutating tools carry no execute: their
          // calls come back as data for the B6 gates — the SDK must never run
          // a world mutation itself. With one (M6 part 2), their execute IS
          // the engine's double gate (in-memory staging only) so the model
          // reads the ack/refusal mid-call and can self-correct in one turn.
          ...(call.toolset === 'narrator'
            ? {
                tools: narratorToolsFor(call),
                toolChoice: 'auto' as const,
                ...(call.queries === undefined && call.gate === undefined
                  ? {}
                  : {
                      stopWhen: stepCountIs(
                        call.gate === undefined
                          ? QUERY_STEP_LIMIT
                          : GATED_STEP_LIMIT,
                      ),
                    }),
              }
            : call.toolset === 'chat'
              ? {
                  tools: chatToolsFor(call),
                  toolChoice: 'auto' as const,
                  // Query escalation (M6 part 3): query → result → the model
                  // keeps generating in ONE call, same budget as the narrator.
                  ...(call.queries === undefined
                    ? {}
                    : { stopWhen: stepCountIs(QUERY_STEP_LIMIT) }),
                }
              : call.toolset === 'group_router'
                ? {
                    // M6 part 4: the Group-chat Narrator's routing decision —
                    // data-only tools (route / endsubsession); the engine
                    // validates and executes, and drops any narration text.
                    tools: {
                      route: tool({
                        description: GROUP_ROUTER_TOOL_DESCRIPTIONS.route,
                        inputSchema: RouteToolSchema,
                      }),
                      endsubsession: tool({
                        description:
                          GROUP_ROUTER_TOOL_DESCRIPTIONS.endsubsession,
                        inputSchema: EndSubsessionToolSchema,
                      }),
                    },
                    toolChoice: 'auto' as const,
                  }
                : call.toolset === 'social_react'
                  ? {
                      // M6 part 5: one reaction decision (Rev 4 §12) —
                      // data-only; the social_reaction handler runs the gates.
                      tools: SOCIAL_REACT_TOOLS,
                      toolChoice: 'auto' as const,
                    }
                  : call.toolset === 'social_reply'
                    ? {
                        // M6 part 5: answer-only — the character can do
                        // nothing here but answer and write its CACHE, so
                        // the toolset carries nothing else (owner ruling
                        // 2026-07-11: no tools = no promises to break).
                        tools: {
                          cache: tool({
                            description: CHAT_TOOL_DESCRIPTIONS.cache,
                            inputSchema: CacheToolSchema,
                          }),
                        },
                        toolChoice: 'auto' as const,
                      }
                    : call.toolset === 'reflection'
                      ? {
                          // M7 part 1 (Rev 4 §11): the memory outputs —
                          // data-only; the reflection handlers run both B6
                          // gates and commit atomically.
                          tools: {
                            memory_delta: tool({
                              description:
                                REFLECTION_TOOL_DESCRIPTIONS.memory_delta,
                              inputSchema: MemoryDeltaToolSchema,
                            }),
                            update_core: tool({
                              description:
                                REFLECTION_TOOL_DESCRIPTIONS.update_core,
                              inputSchema: UpdateCoreToolSchema,
                            }),
                            evolve: tool({
                              description: REFLECTION_TOOL_DESCRIPTIONS.evolve,
                              inputSchema: EvolveToolSchema,
                            }),
                          },
                          toolChoice: 'auto' as const,
                        }
                      : call.toolset === 'character_scene'
                        ? {
                            // M7 part 1 (Rev 4 §7/§11): a character's scene
                            // turn — read-only queries only (memoryquery /
                            // wikiquery execute mid-call); nothing stageable.
                            tools: queryToolsFor(call),
                            toolChoice: 'auto' as const,
                            ...(call.queries === undefined
                              ? {}
                              : { stopWhen: stepCountIs(QUERY_STEP_LIMIT) }),
                          }
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

        // Collect mutating tool calls across ALL steps (a query step may
        // precede the step that creates/moves/ends): executed queries are
        // filtered out — they already ran mid-call and are never staged.
        // With a gate executor EVERY tool executed mid-call (and staged
        // engine-side), so nothing comes back as data — returning them
        // again would double-stage (M6 part 2).
        const executedQueries = [
          'query_sublocations',
          'wikiquery',
          'sessionquery',
          'memoryquery',
        ];
        const toolCalls: RawToolCall[] =
          call.toolset === undefined || call.gate !== undefined
            ? []
            : (await result.steps)
                .flatMap((step) => step.toolCalls)
                .filter((c) => !executedQueries.includes(c.toolName))
                .map((c) => ({
                  tool: c.toolName,
                  input: c.input,
                }));

        // totalUsage sums every step (a query round-trip is still one call's
        // spend); identical to usage for the single-step case.
        const usage = usageSchema.safeParse(await result.totalUsage);
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
