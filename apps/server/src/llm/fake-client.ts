// Deterministic LLM double, selected by WELTARI_FAKE_LLM=1. Ships in src (not
// tests/) because the kill harness runs the REAL binary against it (I4) —
// crash points must not depend on a live provider. No randomness, no clock.
import { ok, type Result } from '../errors.js';
import type { RawToolCall } from './tools.js';
import type { LlmCall, LlmCallResult, LlmClient } from './types.js';
import type { VlmCallResult, VlmClient } from './vlm.js';

const SCRIPT: Record<string, string> = {
  narrator:
    'Rain hammers the shutters of the Rainy Inn. The fire spits as the door swings open. Elias looks up from his workbench without setting down his tweezers.',
  character:
    '"Late again," Elias says. "The ferry, or the road?" He nudges the kettle back over the flame. "Sit. Tell me which lamp went out this time."',
  narration:
    'The storm settles into a steady drum on the roof. Somewhere upstairs the cracked bell holds its silence, and the inn feels smaller and warmer for it.',
  reflection:
    'The evening confirmed two things: the traveler lies about small matters, and the shrine bell stayed silent past midnight again. Note both. Say neither.',
  world_agent:
    'The storm eases toward dawn. The ferry will run late; Marta opens a fresh page in the ledger; the road north stays mud for another day.',
  // The materialize stub is structured output — gate 1 (schema) parses it
  // (malformed-stub rejection is driven by a stub client at the LlmClient
  // seam in the invariant tests).
  materialize:
    '{"name":"The Mill Pond","description":"A quiet pond behind the old grain mill; herons stand watch over water the storms keep restless."}',
  // The Flow-A GM form is the same structured shape (M5 part 2) — gate 1
  // parses it; malformed-form rejection is driven by a stub client at the
  // LlmClient seam in the handler tests.
  map_edit:
    '{"name":"The Drawn Garden","description":"A walled herb garden the innkeeper swears was always there; bees argue over the lavender."}',
  // The Flow-B story invention (M5 part 2) — persistent so the fake demo
  // exercises the row + pin + jump path; transient is driven by stub clients
  // at the seam in the handler tests.
  jump_in:
    '{"name":"The Heron Shallows","description":"A gravel shallows where herons stalk the reeds; the water hides more than fish.","persistence":"persistent"}',
};

/**
 * Scripted tool-call triggers, scanned from the dynamic tail (the player text
 * reaches it inside the <external source="player"> wrapper). This makes the
 * whole B6 tool pipeline drivable through the PUBLIC API — tests, the kill
 * harness and a browser all script tool calls by typing:
 *   !end [rest|continuation|travel]      → end_scene
 *   !move <sublocation_id>               → change_sublocation
 *   !art <character_id> <art_id>         → switch_art
 *   !badshape                            → switch_art with a malformed input (gate-1 subject)
 *   !ghosttool                           → an unknown tool name (gate-1 subject)
 */
function scriptedToolCalls(prompt: string): RawToolCall[] {
  const calls: RawToolCall[] = [];
  const end = /!end(?:\s+(rest|continuation|travel))?/.exec(prompt);
  if (end !== null) {
    calls.push({
      tool: 'end_scene',
      input: { type: end[1] ?? 'rest', divider_text: '— the rain eases —' },
    });
  }
  const move = /!move\s+(\S+)/.exec(prompt);
  if (move !== null) {
    calls.push({
      tool: 'change_sublocation',
      input: { sublocation_id: move[1] ?? '' },
    });
  }
  const art = /!art\s+(\S+)\s+(\S+)/.exec(prompt);
  if (art !== null) {
    calls.push({
      tool: 'switch_art',
      input: { character_id: art[1] ?? '', art_id: art[2] ?? '' },
    });
  }
  if (prompt.includes('!badshape')) {
    calls.push({ tool: 'switch_art', input: { character_id: 42 } });
  }
  if (prompt.includes('!ghosttool')) {
    calls.push({ tool: 'summon_dragon', input: { size: 'large' } });
  }
  return calls;
}

export interface FakeLlmOptions {
  /** Hold before the FIRST token of every call — simulates real-provider
   * prefill latency so the §1.14 masking animations can be exercised
   * against a 5–10 s generation window (WELTARI_FAKE_LLM_DELAY_MS). */
  firstTokenDelayMs?: number;
}

/** Deterministic VLM double (M5 part 2): a fixed, schema-valid Flow-B
 * classification — the kill harness and the fake browser demo classify
 * clicks at $0.00. The image is ignored on purpose (no vision, no clock). */
export function createFakeVlmClient(): VlmClient {
  return {
    async describe(): Promise<Result<VlmCallResult>> {
      await Promise.resolve();
      const text =
        '{"terrain_type":"river meadow","is_enterable":true,"suggested_setting":"Knee-high grass sloping to slow water; a heron watches the shallows.","style_tags":["riverside","pastoral"]}';
      return ok({
        text,
        usage: { inputTokens: 64, outputTokens: 32, cachedInputTokens: 0 },
        model: 'fake/vlm',
        durationMs: 0,
      });
    },
  };
}

export function createFakeLlmClient(options: FakeLlmOptions = {}): LlmClient {
  const firstTokenDelayMs = options.firstTokenDelayMs ?? 0;
  return {
    async streamCall(call: LlmCall): Promise<Result<LlmCallResult>> {
      const text = SCRIPT[call.kind] ?? 'The rain continues.';
      if (firstTokenDelayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, firstTokenDelayMs);
        });
      }
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
        toolCalls:
          call.toolset === 'narrator' ? scriptedToolCalls(call.prompt) : [],
      });
    },
  };
}
