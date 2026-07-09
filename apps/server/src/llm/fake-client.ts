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
  // Weltari Chat (M6 part 2): the DM reply — deterministic, in-character,
  // grounded in Elias's fixture memory core (the criterion-(a) shape).
  chat: 'Storm has the roads to itself tonight. The common room is quiet for once — just me, the ledger, and that cracked bell upstairs refusing to ring. What do you need?',
  reflect_chat:
    'The traveler keeps texting about the weather when they mean something else. Patience. They will say it eventually — probably about the ferry.',
};

/**
 * Scripted tool-call triggers, scanned from the dynamic tail (the player text
 * reaches it inside the <external source="player"> wrapper). This makes the
 * whole B6 tool pipeline drivable through the PUBLIC API — tests, the kill
 * harness and a browser all script tool calls by typing:
 *   !end [rest|continuation|travel]      → end_scene
 *   !endnext <sublocation_id>            → end_scene continuation + next_scene (M6 part 1)
 *   !move <sublocation_id>               → change_sublocation
 *   !art <character_id> <art_id>         → switch_art
 *   !create <name-slug> <parent_id>      → create_sublocation (interior; hyphens become spaces)
 *   !createwild <name-slug>              → PARENTLESS create_sublocation (gate-2 subject
 *                                          without !query — the query-first rule)
 *   !query                               → run the engine's query_sublocations
 *                                          executor (mode parentless) mid-call
 *   !badshape                            → switch_art with a malformed input (gate-1 subject)
 *   !ghosttool                           → an unknown tool name (gate-1 subject)
 */
function scriptedToolCalls(prompt: string): RawToolCall[] {
  const calls: RawToolCall[] = [];
  // Creates come first — a scripted move/continuation may reference a stub
  // created in this same reply (the creation loop's natural call order).
  // \b keeps "!createwild" from also matching as "!create".
  const create = /!create\b\s+(\S+)\s+(\S+)/.exec(prompt);
  if (create !== null) {
    calls.push({
      tool: 'create_sublocation',
      input: {
        name: (create[1] ?? '').replaceAll('-', ' '),
        brief:
          'A place the story just invented; the lamplight has not reached its corners yet.',
        parent_id: create[2] ?? '',
      },
    });
  }
  const wild = /!createwild\s+(\S+)/.exec(prompt);
  if (wild !== null) {
    calls.push({
      tool: 'create_sublocation',
      input: {
        name: (wild[1] ?? '').replaceAll('-', ' '),
        brief: 'A genuinely new place beyond the inn; rain hides its far side.',
        narrative_anchor: 'near the sublocation the scene is in',
      },
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
  const endNext = /!endnext\s+(\S+)/.exec(prompt);
  if (endNext !== null) {
    calls.push({
      tool: 'end_scene',
      input: {
        type: 'continuation',
        divider_text: '— the rain eases —',
        next_scene: {
          sublocation_id: endNext[1] ?? '',
          premise_seed: 'The story picks up where the lamplight leads.',
        },
      },
    });
  }
  // \b keeps "!endnext" from also matching as a bare "!end".
  const end = /!end\b(?:\s+(rest|continuation|travel))?/.exec(prompt);
  if (end !== null && endNext === null) {
    calls.push({
      tool: 'end_scene',
      input: { type: end[1] ?? 'rest', divider_text: '— the rain eases —' },
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
      // The scripted mid-call query (M6 part 1): a real model would receive
      // the executor's result and keep generating — the fake just runs the
      // executor so the engine's query-first flag and dev trail behave
      // exactly as with a real backend.
      if (
        call.toolset === 'narrator' &&
        call.queries !== undefined &&
        call.prompt.includes('!query')
      ) {
        call.queries.query_sublocations({ mode: 'parentless' });
      }
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
          call.toolset === 'narrator'
            ? scriptedToolCalls(call.prompt)
            : call.toolset === 'chat'
              ? // The mandatory CACHE line rides every scripted chat reply
                // (Rev 4 §11) — tests and the harness get real entries at $0.
                // `!startscene <place-slug>` scripts the bridge (Rev 4 §8):
                // hyphens become spaces, so `!startscene the-park` proposes
                // meeting at "the park".
                [
                  {
                    tool: 'cache',
                    input: {
                      line: 'Texted with the traveler; quiet stormy night at the inn.',
                    },
                  },
                  ...((): RawToolCall[] => {
                    const meet = /!startscene\s+(\S+)/.exec(call.prompt);
                    return meet === null
                      ? []
                      : [
                          {
                            tool: 'startscene',
                            input: {
                              place: (meet[1] ?? '').replaceAll('-', ' '),
                              premise:
                                'They meet as planned, the rain easing off.',
                            },
                          },
                        ];
                  })(),
                ]
              : [],
      });
    },
  };
}
