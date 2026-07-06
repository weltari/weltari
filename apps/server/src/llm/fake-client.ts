// Deterministic LLM double, selected by WELTARI_FAKE_LLM=1. Ships in src (not
// tests/) because the kill harness runs the REAL binary against it (I4) —
// crash points must not depend on a live provider. No randomness, no clock.
import { ok, type Result } from '../errors.js';
import type { LlmCall, LlmCallResult, LlmClient } from './types.js';

const SCRIPT: Record<string, string> = {
  narrator:
    'Rain hammers the shutters of the Rainy Inn. The fire spits as the door swings open. Elias looks up from his workbench without setting down his tweezers.',
  character:
    '"Late again," Elias says. "The ferry, or the road?" He nudges the kettle back over the flame. "Sit. Tell me which lamp went out this time."',
  narration:
    'The storm settles into a steady drum on the roof. Somewhere upstairs the cracked bell holds its silence, and the inn feels smaller and warmer for it.',
};

export function createFakeLlmClient(): LlmClient {
  return {
    async streamCall(call: LlmCall): Promise<Result<LlmCallResult>> {
      const text = SCRIPT[call.kind] ?? 'The rain continues.';
      // Stream word by word so sentence assembly and SSE pacing are exercised.
      for (const word of text.split(' ')) {
        call.onTextDelta(`${word} `);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      const inputTokens = Math.round(
        (call.system.length + call.prompt.length) / 4,
      );
      return ok({
        text,
        usage: {
          inputTokens,
          outputTokens: Math.round(text.length / 4),
          // Deterministic 90% "cache hit" exercises the observability plumbing.
          cachedInputTokens: Math.round(inputTokens * 0.9),
        },
        model: 'fake/scripted',
        durationMs: 0,
      });
    },
  };
}
