// The LLM seam. Everything outside src/llm/ talks to THIS interface — the AI
// SDK is fenced in here (Guide A11), so a provider/SDK swap never touches the
// engine. Tests plug a FakeLlmClient in at the same seam (Guide E4).
import type { Result } from '../errors.js';

export type CallKind =
  'narrator' | 'character' | 'narration' | 'reflection' | 'world_agent';

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
}

export interface LlmClient {
  /** Never throws for provider failures — returns err(operational) (Guide C2). */
  streamCall(call: LlmCall): Promise<Result<LlmCallResult>>;
}
