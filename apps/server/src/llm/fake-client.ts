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
  // The Feed (M6 part 5, Rev 4 §12): the scripted post — deterministic,
  // in-character, grounded in the fixture world (the criterion-(a) shape).
  social_post:
    'Roof beams up over the workshop before the rain found its way back in. The cracked bell watched the whole job and said nothing, as usual.',
  // The reaction call's TEXT is never surfaced (the decision is the react
  // tool call); a comment's body rides the tool input below.
  social_react: 'Scrolling the feed over a cold cup of tea.',
  // The comment author's answer to the user's reply (answer-only thread).
  social_reply:
    'Ha — the river said the same thing, only wetter. Ask me again when the beams have held through one real storm.',
  // The memory compaction pass (M7 part 1, Rev 4 §11): the scripted summary
  // standing in for the covered delta range — deterministic, $0.
  compaction:
    'Storm season so far: the traveler lies about small things, the shrine bell is being silenced by someone, and the workshop roof went up before the rain returned.',
  // The GM conversation turn (M7 part 2, Rev 4 §9): deterministic, in-persona.
  gm: 'Welcome to the table. Tell me what kind of world you want to wake up in, and we will build it together — one honest question at a time.',
  // The profile-analysis pass (M7 part 2, Rev 4 §9 Job 2): structured JSON —
  // gate 1 parses it; malformed output is driven by stub clients at the seam.
  profile_analysis:
    '{"hypotheses":["The user leans into small mysteries and follows them across scenes — story-quality signal, not time-spent.","The user prefers short, decisive replies over long negotiation."]}',
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
 *   !describe <name-slug> <text…>        → describe_object (write-on-first-read, M7 part 3)
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
  // Write-on-first-read (M7 part 3, Rev 4 §7): `!describe <name-slug>
  // <text…>` scripts the Narrator's improvised payload for an empty object.
  const describe = /!describe\s+(\S+)\s+([^\n!]+)/.exec(prompt);
  if (describe !== null) {
    calls.push({
      tool: 'describe_object',
      input: {
        object: (describe[1] ?? '').replaceAll('-', ' '),
        payload: (describe[2] ?? '').trim(),
      },
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
      let text = SCRIPT[call.kind] ?? 'The rain continues.';
      // The scripted mid-call query (M6 part 1): a real model would receive
      // the executor's result and keep generating — the fake just runs the
      // executor so the engine's query-first flag and dev trail behave
      // exactly as with a real backend.
      if (
        call.toolset === 'narrator' &&
        call.queries?.query_sublocations !== undefined &&
        call.prompt.includes('!query')
      ) {
        call.queries.query_sublocations({ mode: 'parentless' });
      }
      // The scripted chat escalation (M6 part 3, Rev 4 §11): `!wikiquery
      // <words>` / `!sessionquery <words>` run the executor mid-call and the
      // reply VISIBLY uses the result — tests and the browser demo drive the
      // whole escalation at $0.
      if (call.toolset === 'chat') {
        const wiki = /!wikiquery\s+([^\n!]+)/.exec(call.prompt);
        if (wiki !== null && call.queries?.wikiquery !== undefined) {
          const answer = call.queries.wikiquery({
            query: (wiki[1] ?? '').trim(),
          });
          text = `Checked what I know. ${answer}`;
        }
        const session = /!sessionquery\s+([^\n!]+)/.exec(call.prompt);
        if (session !== null && call.queries?.sessionquery !== undefined) {
          const answer = call.queries.sessionquery({
            query: (session[1] ?? '').trim(),
          });
          text = `Let me think back. ${answer}`;
        }
        // The memory deep dive (M7 part 1, Rev 4 §11): `!memoryquery <words>`
        // runs the FTS5 executor mid-call and the reply VISIBLY uses the
        // recalled delta — criterion (c) drives at $0.
        const memory = /!memoryquery\s+([^\n!]+)/.exec(call.prompt);
        if (memory !== null && call.queries?.memoryquery !== undefined) {
          const answer = call.queries.memoryquery({
            query: (memory[1] ?? '').trim(),
          });
          text = `Give me a moment to remember. ${answer}`;
        }
      }
      // The GM's mid-call wiki read (M7 part 2): same marker as chat — the
      // GM checks what stands in the wiki before proposing an edit.
      if (call.toolset === 'gm') {
        const wiki = /!wikiquery\s+([^\n!]+)/.exec(call.prompt);
        if (wiki !== null && call.queries?.wikiquery !== undefined) {
          const answer = call.queries.wikiquery({
            query: (wiki[1] ?? '').trim(),
          });
          text = `Let me check the record. ${answer}`;
        }
      }
      // The character's scene-side queries (M7 part 1): same markers, spoken
      // in-scene — the character's reply embeds the executor result.
      if (call.toolset === 'character_scene') {
        const memory = /!memoryquery\s+([^\n!]+)/.exec(call.prompt);
        if (memory !== null && call.queries?.memoryquery !== undefined) {
          const answer = call.queries.memoryquery({
            query: (memory[1] ?? '').trim(),
          });
          text = `"Hold on — let me think," Elias says. ${answer}`;
        }
        const wiki = /!wikiquery\s+([^\n!]+)/.exec(call.prompt);
        if (wiki !== null && call.queries?.wikiquery !== undefined) {
          const answer = call.queries.wikiquery({
            query: (wiki[1] ?? '').trim(),
          });
          text = `"I know the place," Elias says. ${answer}`;
        }
        // The §14 listing (M7 part 3): `!explore [sublocation_id]` runs the
        // executor mid-call and the reply VISIBLY carries the listing —
        // objects, wiki and interiors drive at $0.
        const exploreMark = /!explore(?:\s+(subloc:\S+))?/.exec(call.prompt);
        if (exploreMark !== null && call.queries?.explore !== undefined) {
          const target = exploreMark[1];
          const answer = call.queries.explore(
            target === undefined ? {} : { sublocation_id: target },
          );
          text = `"Let me look around," Elias says. ${answer}`;
        }
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
            : call.toolset === 'group_router'
              ? // Group-router scripts (M6 part 4, Rev 4 §8) read the text
                // AFTER the last user line only, so a marker never haunts
                // later rounds: `!endsub` ends the round, `!route <char-id>`
                // routes explicitly, default = the FIRST listed member (the
                // engine's turn budget is what stops the ping-pong).
                ((): RawToolCall[] => {
                  const tail = call.prompt.slice(
                    call.prompt.lastIndexOf('User:'),
                  );
                  if (/!endsub\b/.test(tail)) {
                    return [{ tool: 'endsubsession', input: {} }];
                  }
                  const route = /!route\s+(\S+)/.exec(tail);
                  if (route?.[1] !== undefined) {
                    return [
                      { tool: 'route', input: { next_character_id: route[1] } },
                    ];
                  }
                  const members = /Members: ([^\n]+)/.exec(call.prompt);
                  const first = members?.[1]?.split(',')[0]?.trim();
                  return first === undefined || first === ''
                    ? []
                    : [
                        {
                          tool: 'route',
                          input: { next_character_id: first },
                        },
                      ];
                })()
              : call.toolset === 'chat'
                ? // The mandatory CACHE line rides every scripted chat reply
                  // (Rev 4 §11) — tests and the harness get real entries at $0.
                  // `!startscene <place-slug>` scripts the bridge (Rev 4 §8):
                  // hyphens become spaces, so `!startscene the-park` proposes
                  // meeting at "the park" (wait_hours 6 — the 0.13.0 window).
                  // `!startscene-nowindow <place>` omits wait_hours until the
                  // correction round arrives (scripts retry-then-succeed);
                  // `!startscene-stubborn <place>` omits it every round
                  // (scripts ceiling exhaustion → the chat.notice rollback).
                  [
                    {
                      tool: 'cache',
                      input: {
                        line:
                          call.kind === 'social_post'
                            ? 'Posted about the workshop roof on the feed.'
                            : 'Texted with the traveler; quiet stormy night at the inn.',
                      },
                    },
                    // `!staysilent` scripts the explicit decline (M6 part 4):
                    // the character chooses to send nothing — the proactive
                    // handler must leave the fire quiet at $0.
                    ...(call.prompt.includes('!staysilent')
                      ? [{ tool: 'stay_silent', input: {} }]
                      : []),
                    ...((): RawToolCall[] => {
                      const corrected = call.prompt.includes('## Correction');
                      const scripted =
                        /!(startscene(?:-nowindow|-stubborn)?)\s+(\S+)/.exec(
                          call.prompt,
                        );
                      if (scripted === null) return [];
                      const variant = scripted[1] ?? 'startscene';
                      const place = (scripted[2] ?? '').replaceAll('-', ' ');
                      const withWindow =
                        variant === 'startscene' ||
                        (variant === 'startscene-nowindow' && corrected);
                      return [
                        {
                          tool: 'startscene',
                          input: {
                            place,
                            premise:
                              'They meet as planned, the rain easing off.',
                            ...(withWindow ? { wait_hours: 6 } : {}),
                          },
                        },
                      ];
                    })(),
                  ]
                : call.toolset === 'social_react'
                  ? // The Feed reaction decision (M6 part 5, Rev 4 §12):
                    // default = a one-line comment (the most demonstrable
                    // outcome); `!like` scripts a bare like, `!staysilent`
                    // the explicit decline, `!badreact` a gate-1 subject
                    // (comment without body). The CACHE line rides every
                    // non-declined decision.
                    ((): RawToolCall[] => {
                      if (call.prompt.includes('!staysilent')) {
                        return [{ tool: 'stay_silent', input: {} }];
                      }
                      if (call.prompt.includes('!badreact')) {
                        return [{ tool: 'react', input: { kind: 'comment' } }];
                      }
                      const react: RawToolCall = call.prompt.includes('!like')
                        ? { tool: 'react', input: { kind: 'like' } }
                        : {
                            tool: 'react',
                            input: {
                              kind: 'comment',
                              body: 'Rain never asks first — good beams beat fast beams.',
                            },
                          };
                      return [
                        react,
                        {
                          tool: 'cache',
                          input: {
                            line: 'Reacted to a post on the feed; small news travels fast.',
                          },
                        },
                      ];
                    })()
                  : call.toolset === 'social_reply'
                    ? // Answer-only (M6 part 5): the mandatory CACHE line
                      // rides every scripted comment answer.
                      [
                        {
                          tool: 'cache',
                          input: {
                            line: 'Answered the traveler under my feed comment.',
                          },
                        },
                      ]
                    : call.toolset === 'reflection'
                      ? // The memory outputs (M7 part 1, Rev 4 §11): every
                        // scripted reflection commits deltas at $0. Markers
                        // (typed in scene/chat, riding the transcript into
                        // the reflection prompt) script the rest:
                        //   !memcore   → an update_core snapshot
                        //   !evolve    → an evolve call (gate-2 locked subject)
                        //   !overcap   → 4 deltas (gate-2 cap subject)
                        //   !badmemory → a malformed delta (gate-1 subject)
                        //   !evolveempty → evolve with no fields (gate-2)
                        ((): RawToolCall[] => {
                          const calls: RawToolCall[] = [];
                          if (call.prompt.includes('!badmemory')) {
                            calls.push({ tool: 'memory_delta', input: {} });
                          }
                          const deltas =
                            call.kind === 'reflection'
                              ? [
                                  'The traveler lies about small matters — the ferry story did not hold.',
                                  'The shrine bell stayed silent past midnight again; someone is stopping it deliberately.',
                                ]
                              : [
                                  'The traveler keeps texting about the weather when they mean something else — patience.',
                                ];
                          for (const content of deltas) {
                            calls.push({
                              tool: 'memory_delta',
                              input: { content },
                            });
                          }
                          if (call.prompt.includes('!overcap')) {
                            for (const n of ['three', 'four', 'five']) {
                              calls.push({
                                tool: 'memory_delta',
                                input: {
                                  content: `Overcap filler note ${n} — the gate must drop past the third.`,
                                },
                              });
                            }
                          }
                          if (call.prompt.includes('!memcore')) {
                            calls.push({
                              tool: 'update_core',
                              input: {
                                core: [
                                  'The shrine bell is silenced by a person, not the weather.',
                                  'The traveler cannot be trusted on small facts.',
                                ],
                              },
                            });
                          }
                          if (call.prompt.includes('!evolveempty')) {
                            calls.push({ tool: 'evolve', input: {} });
                          }
                          if (
                            call.prompt.includes('!evolve') &&
                            !call.prompt.includes('!evolveempty')
                          ) {
                            calls.push({
                              tool: 'evolve',
                              input: {
                                personality:
                                  'Warmer now, but still counts things.',
                                goals: [
                                  'Find who silences the bell — tonight.',
                                ],
                              },
                            });
                          }
                          return calls;
                        })()
                      : call.toolset === 'gm'
                        ? // The GM's scripted proposals (M7 part 2, Rev 4
                          // §9/§16) — tests, the harness and the browser
                          // drive the whole consent pipeline at $0:
                          //   !proposeplace <name-slug>   → propose_place (public)
                          //   !proposeprivate <name-slug> → propose_place (private)
                          //   !proposechar <name-slug>    → propose_character
                          //   !proposewiki <sublocation_id> → propose_wiki_edit
                          //   !proposeseed <world-slug>   → propose_world_seed
                          //     (3 places incl. the §9 public+private mix, 2
                          //     characters — the cold-boot demo's whole form)
                          //   !badproposal                → gate-1 subject
                          ((): RawToolCall[] => {
                            const calls: RawToolCall[] = [];
                            const place = /!proposeplace\s+(\S+)/.exec(
                              call.prompt,
                            );
                            if (place !== null) {
                              calls.push({
                                tool: 'propose_place',
                                input: {
                                  name: (place[1] ?? '').replaceAll('-', ' '),
                                  description:
                                    'A place the interview conjured; the rain has not mapped its corners yet.',
                                  space: 'public',
                                  wiki_entry:
                                    'Newly noted on the town record; details accrue as stories touch it.',
                                  rationale:
                                    'The user asked for somewhere like this, and the world has no such place yet.',
                                },
                              });
                            }
                            const privatePlace = /!proposeprivate\s+(\S+)/.exec(
                              call.prompt,
                            );
                            if (privatePlace !== null) {
                              calls.push({
                                tool: 'propose_place',
                                input: {
                                  name: (privatePlace[1] ?? '').replaceAll(
                                    '-',
                                    ' ',
                                  ),
                                  description:
                                    'A private space with a door that stays shut to strangers.',
                                  space: 'private',
                                  rationale:
                                    'Someone in this world needs a home the story can knock on.',
                                },
                              });
                            }
                            const character = /!proposechar\s+(\S+)/.exec(
                              call.prompt,
                            );
                            if (character !== null) {
                              calls.push({
                                tool: 'propose_character',
                                input: {
                                  name: (character[1] ?? '').replaceAll(
                                    '-',
                                    ' ',
                                  ),
                                  personality:
                                    'Steady, watchful, keeps promises slowly and completely.',
                                  goals: [
                                    'Find a place in this town worth defending.',
                                  ],
                                  core: [
                                    'Arrived with one bag and a debt nobody here knows about.',
                                  ],
                                  skills: [],
                                  rationale:
                                    'The interview asked for a new face; this one fits the world described.',
                                },
                              });
                            }
                            const wikiEdit = /!proposewiki\s+(\S+)/.exec(
                              call.prompt,
                            );
                            if (wikiEdit !== null) {
                              calls.push({
                                tool: 'propose_wiki_edit',
                                input: {
                                  sublocation_id: wikiEdit[1] ?? '',
                                  entry:
                                    'The record here has grown: what the town whispers is now written plainly.',
                                  rationale:
                                    'The current entry no longer matches what everyone can see.',
                                },
                              });
                            }
                            const seed = /!proposeseed\s+(\S+)/.exec(
                              call.prompt,
                            );
                            if (seed !== null) {
                              calls.push({
                                tool: 'propose_world_seed',
                                input: {
                                  world_name: (seed[1] ?? '').replaceAll(
                                    '-',
                                    ' ',
                                  ),
                                  language: 'en',
                                  chapter_seed:
                                    'A small town holds its breath between two storms.',
                                  places: [
                                    {
                                      name: 'The Lantern Square',
                                      description:
                                        'The town square; market stalls by day, lantern circles by night.',
                                      space: 'public',
                                      wiki_entry:
                                        'The square every road in town eventually crosses.',
                                    },
                                    {
                                      name: 'The Weaver House',
                                      description:
                                        'A narrow private house; looms upstairs, secrets downstairs.',
                                      space: 'private',
                                    },
                                    {
                                      name: 'The Rope Bridge',
                                      description:
                                        'A swaying crossing over the gorge; everyone has one bridge story.',
                                      space: 'public',
                                    },
                                  ],
                                  characters: [
                                    {
                                      name: 'Senna the Weaver',
                                      personality:
                                        'Sharp-eyed, dry-humored, counts threads and favors alike.',
                                      goals: [
                                        'Keep the loom house independent.',
                                      ],
                                      core: [
                                        'Senna wove the banner that hangs over the Lantern Square.',
                                      ],
                                      skills: [],
                                    },
                                    {
                                      name: 'Brack the Bridgekeeper',
                                      personality:
                                        'Slow-spoken, superstitious, remembers every crossing.',
                                      goals: [
                                        'See the bridge through one more storm season.',
                                      ],
                                      core: [],
                                      skills: [],
                                    },
                                  ],
                                  rationale:
                                    'The interview is complete: language chosen, world described, people named.',
                                },
                              });
                            }
                            if (call.prompt.includes('!badproposal')) {
                              calls.push({
                                tool: 'propose_place',
                                input: { name: 42 },
                              });
                            }
                            return calls;
                          })()
                        : call.toolset === 'character_scene'
                          ? // The character's object touches (M7 part 3, Rev 4
                            // §7) — the whole materialize-on-touch pipeline
                            // drivable at $0:
                            //   !obj <name-slug>                → bare create (place here)
                            //   !objwrite <name-slug> <text…>   → author payload
                            //   !objmove <name-slug> <subloc>   → move the object
                            //     (an unknown name materializes AT the target)
                            //   !objbad                         → gate-1 subject
                            // A bare !obj naming an EXISTING object is the
                            // gate-2 nothing-durable subject.
                            ((): RawToolCall[] => {
                              const calls: RawToolCall[] = [];
                              const bare = /!obj\b\s+(\S+)/.exec(call.prompt);
                              if (bare !== null) {
                                calls.push({
                                  tool: 'interact_object',
                                  input: {
                                    object: (bare[1] ?? '').replaceAll(
                                      '-',
                                      ' ',
                                    ),
                                  },
                                });
                              }
                              const write =
                                /!objwrite\s+(\S+)\s+([^\n!]+)/.exec(
                                  call.prompt,
                                );
                              if (write !== null) {
                                calls.push({
                                  tool: 'interact_object',
                                  input: {
                                    object: (write[1] ?? '').replaceAll(
                                      '-',
                                      ' ',
                                    ),
                                    payload: (write[2] ?? '').trim(),
                                  },
                                });
                              }
                              const move = /!objmove\s+(\S+)\s+(\S+)/.exec(
                                call.prompt,
                              );
                              if (move !== null) {
                                calls.push({
                                  tool: 'interact_object',
                                  input: {
                                    object: (move[1] ?? '').replaceAll(
                                      '-',
                                      ' ',
                                    ),
                                    move_to: move[2] ?? '',
                                  },
                                });
                              }
                              if (call.prompt.includes('!objbad')) {
                                calls.push({
                                  tool: 'interact_object',
                                  input: { payload: 42 },
                                });
                              }
                              return calls;
                            })()
                          : [],
      });
    },
  };
}
