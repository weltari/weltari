// The LLM seam. Everything outside src/llm/ talks to THIS interface — the AI
// SDK is fenced in here (Guide A11), so a provider/SDK swap never touches the
// engine. Tests plug a FakeLlmClient in at the same seam (Guide E4).
import type { Result } from '../errors.js';
import type { RawToolCall } from './tools.js';

export type CallKind =
  | 'narrator'
  | 'character'
  | 'narration'
  | 'reflection'
  | 'world_agent'
  | 'materialize'
  /** M5 part 2: the Flow-A GM form (drawn region + intent → name/description). */
  | 'map_edit'
  /** M5 part 2: the Flow-B story invention inside a VLM classification. */
  | 'jump_in'
  /** M6 part 2: a Weltari Chat DM reply (Rev 4 §8) — short context, chat toolset. */
  | 'chat'
  /** M6 part 2: the reflect_chat pass over an ended conversation range. */
  | 'reflect_chat'
  /** M6 part 4: one Group-chat Narrator routing decision (Rev 4 §8) —
   * router-class, tiny prompt, NO narration ever. */
  | 'group_route'
  /** M6 part 5: a character's feed post (Rev 4 §12) — chat-class, eager
   * generation at the cadence fire. */
  | 'social_post'
  /** M6 part 5: one recipient's reaction decision on a feed post —
   * chat-class; like / one-line comment / stay_silent. */
  | 'social_react'
  /** M6 part 5: the comment author's answer to the user's feed reply —
   * chat-class, answer-only (the toolset carries nothing but cache). */
  | 'social_reply'
  /** M7 part 1 (Rev 4 §11): the compaction pass — summarize the character's
   * old memory deltas into one record; cold path, world-inert. */
  | 'compaction'
  /** M7 part 2 (Rev 4 §9): a GM conversation turn — interview, authoring
   * negotiation, settings talk. Chat-class; per-role override via
   * WELTARI_GM_MODEL (the registry's per-character key char:gm). */
  | 'gm';

export interface LlmCall {
  /** Which of the scripted calls this is — routes via the ModelRegistry. */
  kind: CallKind;
  /** Per-character provider pinning key (FINAL owner decision #3). */
  characterId: string;
  /** The byte-stable stable prefix — sent first, verbatim, every turn (I5). */
  system: string;
  /** The dynamic tail: scene state, transcript, player input. */
  prompt: string;
  /** Called with raw text deltas as they stream. */
  onTextDelta: (delta: string) => void;
  /**
   * Offer a toolset to the model ('narrator' = end_scene / change_sublocation
   * / switch_art / create_sublocation / query_sublocations; 'chat' = the
   * character-side messaging tools, M6 part 2: cache — data-only, never
   * executed by the SDK). Returned calls are RAW — the caller must run both
   * B6 gates.
   */
  toolset?:
    | 'narrator'
    | 'chat'
    | 'group_router'
    | 'social_react'
    | 'social_reply'
    /** M7 part 1 (Rev 4 §11): the reflection memory outputs — memory_delta /
     * update_core / evolve, all data-only; the reflection handlers run both
     * B6 gates and commit atomically with their existing events. */
    | 'reflection'
    /** M7 part 1 (Rev 4 §7/§11, owner ruling 2026-07-11): a character's
     * SCENE turn — read-only queries only (memoryquery + wikiquery run
     * mid-call; nothing stageable), so a character can deep-dive its own
     * past or look up a place without ever mutating anything. */
    | 'character_scene'
    /** M7 part 2 (Rev 4 §9/§16): the GM's authoring tools — every one a
     * data-only PROPOSAL (propose_place / propose_character /
     * propose_wiki_edit / propose_world_seed); the GM engine gates and
     * submits, the user's approval applies. wikiquery runs mid-call. */
    | 'gm';
  /**
   * Engine-owned read-only query executors offered alongside the toolset
   * (M6 part 1, Rev 4 §6). The client runs these DURING the call and feeds
   * the result string back to the model (multi-step): queries route context,
   * they never mutate — mutating tools always come back as data for the B6
   * gates. Input arrives unvalidated (provider JSON); the executor safeParses
   * and answers malformed input with an error string the model can react to.
   */
  queries?: {
    /** Narrator toolset: the sublocation lookup (M6 part 1). */
    query_sublocations?: (input: unknown) => string;
    /** Chat + character_scene toolsets (M6 part 3, Rev 4 §11): the wiki read. */
    wikiquery?: (input: unknown) => string;
    /** Chat toolset (M6 part 3): scene-query — participation-gated. */
    sessionquery?: (input: unknown) => string;
    /** Chat + character_scene toolsets (M7 part 1, Rev 4 §11): the FTS5 deep
     * dive into the character's OWN memory deltas — participation-gated by
     * construction (the executor is bound to one character id). */
    memoryquery?: (input: unknown) => string;
  };
  /**
   * Engine-owned gate executor (M6 part 2). When offered, the client runs
   * BOTH B6 gates on each mutating tool call DURING the call (multi-step) and
   * feeds the result string back to the model: a staged-acknowledgement, or
   * the refusal reason as a tool ERROR the model can self-correct against in
   * the same turn (the week-9 trail-only-rejection upgrade). Staging stays
   * in-memory — nothing durable happens before turn.committed (Guide B6).
   * Calls gated mid-call are NOT returned in LlmCallResult.toolCalls.
   */
  gate?: (raw: RawToolCall) => string;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported cached prompt tokens — the Week-1 criterion (b) number. */
  cachedInputTokens: number;
}

export interface LlmCallResult {
  text: string;
  usage: LlmUsage;
  model: string;
  durationMs: number;
  /** Tool calls the model made — unvalidated boundary data (B-llm, Guide B6). */
  toolCalls: readonly RawToolCall[];
}

export interface LlmClient {
  /** Never throws for provider failures — returns err(operational) (Guide C2). */
  streamCall(call: LlmCall): Promise<Result<LlmCallResult>>;
}
