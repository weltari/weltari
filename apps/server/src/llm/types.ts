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
  | 'jump_in';

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
   * / switch_art / create_sublocation / query_sublocations). Returned calls
   * are RAW — the caller must run both B6 gates.
   */
  toolset?: 'narrator';
  /**
   * Engine-owned read-only query executors offered alongside the toolset
   * (M6 part 1, Rev 4 §6). The client runs these DURING the call and feeds
   * the result string back to the model (multi-step): queries route context,
   * they never mutate — mutating tools always come back as data for the B6
   * gates. Input arrives unvalidated (provider JSON); the executor safeParses
   * and answers malformed input with an error string the model can react to.
   */
  queries?: {
    query_sublocations: (input: unknown) => string;
  };
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
