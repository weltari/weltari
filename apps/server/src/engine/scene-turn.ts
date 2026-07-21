// The scripted Week-1 scene turn (FINAL §6): Narrator → character → narration,
// three sequential LLM calls streamed sentence-by-sentence. Crash-only shape:
// turn.started is durable BEFORE any LLM work; streamed text is display-only;
// the ONLY durable narration is turn.committed at close (Guide B6). A kill or
// failure anywhere in between voids the turn — nothing partial persists.
//
// M3 adds the Narrator tool surface: tool calls returned by the narrator call
// pass gate 1 (shape, llm/tools.ts) then gate 2 (game state, scene-tools.ts);
// valid effects are STAGED and appended atomically with turn.committed in one
// WriteGate transaction — a rejected call writes zero rows and lives only on
// the dev trail (I8).
import { randomUUID } from 'node:crypto';
import type {
  InterruptTurnCommand,
  StartTurnCommand,
  TurnStep,
  WeltariEvent,
} from '@weltari/protocol';
import {
  err,
  ok,
  OperationalError,
  type AppError,
  type Result,
} from '../errors.js';
import type { Logger } from '../observability/logger.js';
import type { DevBus, EventBus, StreamBus } from '../http/bus.js';
import {
  CharactercallToolSchema,
  parseCharacterSceneToolCall,
  parseToolCall,
  type RawToolCall,
} from '../llm/tools.js';
import type { LlmClient } from '../llm/types.js';
import type { Storage } from '../storage/db.js';
import {
  assembleContext,
  type CharacterProfile,
  type TurnLine,
} from './context-assembler.js';
import type { EventSink } from './event-sink.js';
import {
  runExploreQuery,
  runMemoryquery,
  runWikiquery,
} from './chat-queries.js';
import { characterLocationsOf } from './locations.js';
import { worldTimeOf } from './world-clock.js';
import { archiveRecapText, liveProfile } from './memory.js';
import {
  buildEliasProfile,
  buildNarratorProfile,
  FIXTURE_ART_SETS,
  FIXTURE_START_SUBLOCATION_ID,
  type SublocationDefinition,
} from './fixture/rainy-inn.js';
import { knownSublocations, latestBackdropPath } from './sublocations.js';
import { enqueueBackdropPaint } from '../painter/commands.js';
import type { FaultPointHook } from './fault-points.js';
import { characterProfilesOf } from './characters.js';
import { presenceOf } from './chat.js';
import {
  appendSceneEndWithFanOut,
  sceneRosterOf,
  type KnownCharacter,
  type SceneEndMarkerFanOut,
} from './scene-lifecycle.js';
import {
  createToolStage,
  currentSublocationId,
  type StagedToolEffect,
  type ToolStage,
} from './scene-tools.js';
import { createSentenceSplitter } from './sentences.js';

export interface TurnEngineOptions {
  storage: Storage;
  sink: EventSink;
  streamBus: StreamBus;
  /** Tool-effect events commit atomically, then publish here (durable-before-visible). */
  eventBus: EventBus;
  /** The log-only trail: dev.tool_call / dev.tool_rejected frames (Guide C11, I8). */
  devBus: DevBus;
  llm: LlmClient;
  logger: Logger;
  /**
   * Emits FAULT_POINT lines when the harness env flag is set; no-op otherwise.
   * Awaited at between_calls/pre_commit (mid_stream fires from a sync callback).
   */
  faultPoint?: FaultPointHook;
  /** Fixture world clock — engine-owned fictional time, injected (A16). */
  worldClockText?: string;
  stablePrefixTokens?: number;
  /** Speaker-name → character-id map for the end_scene fan-out (fixture default). */
  knownCharacters?: readonly KnownCharacter[];
  /** Seed character profiles for the LIVE registry fold (0.21.0):
   * charactercall and make_character resolve against seeds ∪ every
   * character.created. Fixture default: Elias alone. */
  seedProfiles?: readonly CharacterProfile[];
  /** Max charactercalls one user turn may run (Rev 4 §6 turn budget) —
   * past it the executor refuses and the Narrator yields. Default 3. */
  turnBudget?: number;
  /** The scene context budget in TOKENS (Rev 4 §6: sized for the character
   * LLM); within 5000 of it the engine warns the Narrator and
   * end_scene(context_limit_reached) becomes legal. Default 100000. */
  contextBudgetTokens?: number;
  /** World geography for the change_sublocation state gate. Default: the
   * sublocation registry (fixture trio + materialized), read fresh per turn
   * so newly explored squares are enterable without a restart. */
  sublocations?: readonly SublocationDefinition[];
  startSublocationId?: string;
  /** character_id → art poses for the switch_art state gate (fixture default). */
  artSets?: ReadonlyMap<string, readonly string[]>;
  /** Characters present in the scene (fixture default). */
  presentCharacterIds?: readonly string[];
  /** Drain the ledger now — a committed create's backdrop/materialize jobs
   * start on the spot instead of waiting out the runner's 1 s poll (the
   * same immediacy explore/map-edit get). Absent in tests: they tick. */
  kickRunner?: () => void;
  /** M7 part 4: the marker engine's scene-end fan-out — the Narrator's
   * end_scene follow-up (or the top-up fallback) rides the end transaction. */
  markerFanOut?: SceneEndMarkerFanOut;
}

export interface TurnEngine {
  /**
   * Opens the turn envelope durably, then runs the three calls detached.
   * `completion` resolves when the turn commits or voids (tests/harness await it).
   */
  startTurn(
    command: StartTurnCommand,
  ): Promise<Result<{ turnId: string; completion: Promise<void> }>>;
  /**
   * Interrupt-anywhere (UI Spec §1.4): closes the envelope NOW at the user's
   * last-seen sentence. Commits a truncated turn.committed (marked
   * `interrupted`) built from the sentences that actually streamed; discards
   * every staged tool effect; still-running LLM work finishes into the void.
   * `committed` false = nothing was displayed yet, the turn voided entirely.
   */
  interruptTurn(command: InterruptTurnCommand): Result<{ committed: boolean }>;
}

/** What the engine remembers about a live turn — the interrupt cut source. */
interface RunningTurn {
  command: StartTurnCommand;
  /** Streamed sentences per call, in call order (the display-only record). */
  recorded: { call: TurnStep['call']; speaker: string; sentences: string[] }[];
  stage: ToolStage;
  interrupted: boolean;
  /** True once ANY turn.committed was written (normal or interrupt path). */
  closed: boolean;
}

/**
 * Steps the user actually saw: calls before the cut in full, the cut call up
 * to (and including) the seen sentence, nothing after. Clamped to what really
 * streamed — a client naming an unseen sentence cannot mint text.
 */
function truncateAtSeen(
  recorded: RunningTurn['recorded'],
  seen: NonNullable<InterruptTurnCommand['seen']>,
): TurnStep[] {
  const steps: TurnStep[] = [];
  for (const rec of recorded) {
    const isCut = rec.call === seen.call;
    const sentences = isCut
      ? rec.sentences.slice(0, seen.sentence_index + 1)
      : rec.sentences;
    if (sentences.length > 0) {
      steps.push({
        call: rec.call,
        speaker: rec.speaker,
        text: sentences.join(' '),
      });
    }
    if (isCut) break;
  }
  return steps;
}

interface CallPlan {
  /** The scripted-turn subset of CallKind — the only calls that stream to clients. */
  kind: TurnStep['call'];
  profile: CharacterProfile;
  instruction: string;
  /** Character calls offer character_scene (M7 part 1: read-only queries +
   * the gated interact_object). The NARRATOR runs through runNarratorLoop
   * since 0.21.0 — its toolset never rides a CallPlan anymore. */
  toolset?: 'character_scene';
}

export function createTurnEngine(options: TurnEngineOptions): TurnEngine {
  const {
    storage,
    sink,
    streamBus,
    eventBus,
    devBus,
    llm,
    logger,
    faultPoint = (): void => undefined,
    worldClockText = 'Day 1, evening, heavy rain',
    stablePrefixTokens = 800,
    startSublocationId = FIXTURE_START_SUBLOCATION_ID,
    artSets = FIXTURE_ART_SETS,
    presentCharacterIds = ['char:elias'],
    turnBudget = 3,
    contextBudgetTokens = 100000,
  } = options;

  /** Rev 4 §6: the warning fires when the estimate comes within this many
   * tokens of the budget. */
  const CONTEXT_WARNING_MARGIN = 5000;

  function worldSublocations(
    worldId: string,
  ): readonly SublocationDefinition[] {
    return options.sublocations ?? knownSublocations(storage, worldId);
  }

  const elias = buildEliasProfile(stablePrefixTokens);
  const narrator = buildNarratorProfile(stablePrefixTokens);
  const knownCharacters = options.knownCharacters ?? [
    { character_id: elias.character_id, name: elias.name },
  ];
  const seedProfiles = options.seedProfiles ?? [elias];

  /** The world's chapter seed (world.seeded) — IMMUTABLE once present, so it
   * may ride the STABLE prefix (I5: byte-identical every turn of the
   * world's life; a fixture world without one changes nothing). */
  function chapterSeedOf(worldId: string): string | undefined {
    let seed: string | undefined;
    for (const event of storage.eventLog.readSince(0, 100000)) {
      if (event.type === 'world.seeded' && event.world_id === worldId) {
        seed = event.payload.chapter_seed;
      }
    }
    return seed;
  }

  /** The Narrator profile with the world's story layer folded into the
   * stable prefix (Rev 4 §6 input 2: chapter seed + story goals — Narrator
   * only, never characters). */
  function narratorProfileFor(worldId: string): CharacterProfile {
    const seed = chapterSeedOf(worldId);
    return seed === undefined
      ? narrator
      : { ...narrator, goals: [...narrator.goals, `Chapter seed: ${seed}`] };
  }

  /** The latest committed subgoal snapshot (0.21.0, Rev 4 §6) — DYNAMIC
   * (it changes turn to turn): reinjected into every Narrator tail, which is
   * exactly what makes a restart resume at the story position. */
  function latestGoals(
    sceneId: string,
  ): readonly { id: string; text: string; status: string }[] {
    let goals: readonly { id: string; text: string; status: string }[] = [];
    for (const event of storage.eventLog.readSince(0, 100000)) {
      if (
        event.type === 'scene.goals_updated' &&
        event.payload.scene_id === sceneId
      ) {
        goals = event.payload.goals;
      }
    }
    return goals;
  }

  /** Resolve a charactercall target to a callable profile: the live
   * registry (seeds ∪ character.created), or a character MINTED this very
   * turn (its staged effect carries the whole seed profile). */
  function profileForCharacter(
    characterId: string,
    registry: readonly CharacterProfile[],
    stage: ToolStage,
  ): CharacterProfile | undefined {
    const known = registry.find((p) => p.character_id === characterId);
    if (known !== undefined) return known;
    for (const effect of stage.staged()) {
      if (
        effect.kind === 'character_mint' &&
        effect.characterId === characterId
      ) {
        return {
          character_id: effect.characterId,
          name: effect.name,
          skills: [],
          personality: effect.personality,
          memory_core: effect.core,
          goals: effect.goals,
        };
      }
    }
    return undefined;
  }

  /** Dynamic scene options for the Narrator's instruction (tail-only — the
   * current sublocation changes turn to turn and must never touch the prefix). */
  function narratorToolContext(
    sceneId: string,
    worldId: string,
    sublocations: readonly SublocationDefinition[],
    cast: readonly KnownCharacter[],
  ): string {
    const current = currentSublocationId(storage, sceneId, startSublocationId);
    const sublocationList = sublocations
      .map((s) => `${s.sublocation_id} (${s.name})`)
      .join(', ');
    const artList = [...artSets.entries()]
      .map(([characterId, poses]) => `${characterId}: ${poses.join('|')}`)
      .join('; ');
    // The durable objects lying here (M7 part 3, Rev 4 §7): the Narrator
    // narrates an existing payload VERBATIM in spirit and may describe_object
    // only the ones marked empty — write-on-first-read, exactly once.
    const objects = storage.objects.heldAt(worldId, current);
    const objectList =
      objects.length === 0
        ? ''
        : ` Durable objects here: ${objects
            .map(
              (o) =>
                `${o.object_id} ("${o.name}"): ${o.payload ?? 'nothing written yet — improvise once with describe_object when examined'}`,
            )
            .join('; ')}.`;
    // The agentic loop's routing surface (0.21.0, Rev 4 §6): who is here to
    // charactercall, and where the story stands (the persisted snapshot).
    const castList =
      cast.length === 0
        ? 'none — make_character can bring someone in'
        : cast.map((c) => `${c.character_id} (${c.name})`).join(', ');
    const goals = latestGoals(sceneId);
    const goalsList =
      goals.length === 0
        ? 'none recorded yet — call update_goals to set them'
        : goals.map((g) => `${g.id}[${g.status}]: ${g.text}`).join('; ');
    return [
      `Current sublocation: ${current}.`,
      `Present characters: ${castList}.`,
      `Story subgoals: ${goalsList}.`,
      `Sublocations you may move the scene to: ${sublocationList}.`,
      `Art poses you may switch: ${artList}.${objectList}`,
    ].join(' ');
  }

  /**
   * The chat→scene handoff (M6 part 2, Rev 4 §8): scene.started may carry a
   * premise and/or an unresolved free-text place. The premise matters only
   * before the first committed turn; the place request stands until the scene
   * moved somewhere (a sublocation.changed exists) — then it is resolved.
   */
  function sceneHandoff(sceneId: string): {
    premise?: string;
    placeRequest?: string;
    briefHistory?: string;
    carriedGoals?: readonly string[];
  } {
    let premise: string | undefined;
    let placeRequest: string | undefined;
    let briefHistory: string | undefined;
    let carriedGoals: readonly string[] | undefined;
    let hasTurns = false;
    let hasMoved = false;
    let hasGoals = false;
    for (const event of storage.eventLog.readSince(0, 100000)) {
      if (!('scene_id' in event.payload) || event.payload.scene_id !== sceneId)
        continue;
      if (event.type === 'scene.started') {
        premise = event.payload.premise;
        placeRequest = event.payload.place_request;
        // The consumed continuation (0.21.0, Rev 4 §6): what makes the jump
        // a continuation instead of a cold open.
        briefHistory = event.payload.brief_history;
        carriedGoals = event.payload.carried_goals;
      } else if (event.type === 'turn.committed') {
        hasTurns = true;
      } else if (event.type === 'sublocation.changed') {
        hasMoved = true;
      } else if (event.type === 'scene.goals_updated') {
        hasGoals = true;
      }
    }
    return {
      ...(premise === undefined || hasTurns ? {} : { premise }),
      ...(placeRequest === undefined || hasMoved ? {} : { placeRequest }),
      // brief_history matters until the story picks up (first committed
      // turn); carried goals until the Narrator's own snapshot supersedes.
      ...(briefHistory === undefined || hasTurns ? {} : { briefHistory }),
      ...(carriedGoals === undefined || hasGoals ? {} : { carriedGoals }),
    };
  }

  function recentTurns(sceneId: string, limit = 4): TurnLine[] {
    const lines: TurnLine[] = [];
    for (const event of storage.eventLog.readSince(0, 10000)) {
      if (
        event.type === 'turn.committed' &&
        event.payload.scene_id === sceneId
      ) {
        for (const step of event.payload.steps) {
          lines.push({ speaker: step.speaker, text: step.text });
        }
      }
    }
    return lines.slice(-limit * 3);
  }

  async function runCall(
    plan: CallPlan,
    turn: RunningTurn,
    turnId: string,
    sceneId: string,
    worldId: string,
    priorSteps: readonly TurnStep[],
    userInput: string | undefined,
  ): Promise<Result<{ step: TurnStep; toolCalls: readonly RawToolCall[] }>> {
    const transcript = [
      ...recentTurns(sceneId),
      ...priorSteps.map((s) => ({ speaker: s.speaker, text: s.text })),
    ];
    // The LIVE profile fold (M7 part 1): seed + latest durable core, evolved
    // personality/goals — the scene call after a core update provably injects
    // it (criterion b); folding the Narrator is a no-op (it never reflects).
    // Character calls also carry the archive POINTER (owner ruling
    // 2026-07-11): the condensed summary of older memories, so the model can
    // judge whether its memoryquery deep dive is worthwhile.
    const archiveRecap =
      plan.toolset === 'character_scene'
        ? archiveRecapText(storage, plan.profile.character_id)
        : '';
    const context = assembleContext(liveProfile(storage, plan.profile), {
      scene_id: sceneId,
      world_clock_text: worldClockText,
      latest_turns: transcript,
      ...(userInput === undefined ? {} : { user_input: userInput }),
      wiki: [],
      ...(archiveRecap === '' ? {} : { archive_recap: archiveRecap }),
    });

    const record: RunningTurn['recorded'][number] = {
      call: plan.kind,
      speaker: plan.profile.name,
      sentences: [],
    };
    turn.recorded.push(record);

    let sentenceIndex = 0;
    let firstSentenceSeen = false;
    const splitter = createSentenceSplitter((sentence) => {
      record.sentences.push(sentence);
      // Post-interrupt sentences never display — and never commit (the
      // interrupt already closed the envelope at the seen cut).
      if (!turn.interrupted) {
        streamBus.publish({
          turn_id: turnId,
          call: plan.kind,
          speaker: plan.profile.name,
          text: sentence,
          index: sentenceIndex,
        });
      }
      sentenceIndex += 1;
      if (!firstSentenceSeen) {
        firstSentenceSeen = true;
        if (plan.kind === 'narrator') {
          const emitted = faultPoint('mid_stream');
          if (emitted instanceof Promise) {
            emitted.catch((thrown: unknown) => {
              logger.warn({ err: thrown }, 'fault-point hook failed');
            });
          }
        }
      }
    });

    const result = await llm.streamCall({
      kind: plan.kind,
      characterId: plan.profile.character_id,
      system: context.stablePrefix,
      prompt: `${context.dynamicTail}\n\n## Instruction\n${plan.instruction}`,
      onTextDelta: (delta) => {
        splitter.push(delta);
      },
      ...(plan.toolset === undefined
        ? {}
        : {
            // The character's scene-side queries (M7 part 1, Rev 4 §7/§11,
            // owner ruling 2026-07-11): read-only mid-call executors —
            // memoryquery deep-dives the character's OWN deltas; wikiquery
            // covers the query-sublocations-then-their-wiki flow in one
            // step. Dev-trailed like every query. M7 part 3 adds the gate:
            // interact_object runs both B6 gates mid-call exactly like the
            // narrator's tools — staging stays in-memory, durability only
            // at turn.committed.
            toolset: plan.toolset,
            queries: {
              memoryquery: (input: unknown): string => {
                devBus.publish({
                  type: 'dev.tool_call',
                  turn_id: turnId,
                  tool: 'memoryquery',
                  input_json: JSON.stringify(input),
                });
                return runMemoryquery(
                  storage,
                  plan.profile.character_id,
                  logger,
                  input,
                );
              },
              wikiquery: (input: unknown): string => {
                devBus.publish({
                  type: 'dev.tool_call',
                  turn_id: turnId,
                  tool: 'wikiquery',
                  input_json: JSON.stringify(input),
                });
                return runWikiquery(storage, worldId, logger, input);
              },
              // The §14 listing (M7 part 3): wiki + public objects + one
              // level of interiors; defaults to the place the turn is in
              // (staged moves included via the stage's live view).
              explore: (input: unknown): string => {
                devBus.publish({
                  type: 'dev.tool_call',
                  turn_id: turnId,
                  tool: 'explore',
                  input_json: JSON.stringify(input),
                });
                return runExploreQuery(
                  storage,
                  worldId,
                  turn.stage.currentSublocation(),
                  logger,
                  input,
                );
              },
            },
            gate: (raw: RawToolCall): string => {
              if (turn.interrupted) {
                return 'ERROR: the user interrupted this turn — stop; nothing will commit.';
              }
              const gated = gateOne(
                raw,
                turn.stage,
                turnId,
                plan.profile.character_id,
              );
              return gated.ok
                ? stagedAck(gated.value)
                : `ERROR: ${gated.error.message}`;
            },
          }),
    });
    if (!result.ok) return result;
    splitter.flush();
    return ok({
      step: {
        call: plan.kind,
        speaker: plan.profile.name,
        text: result.value.text,
      },
      toolCalls: result.value.toolCalls,
    });
  }

  /** Steps as the turn's records currently stand — the character prompt's
   * prior-steps view and the commit's source (0.21.0: steps derive from the
   * streamed records, so the loop's rotated narrator segments each become
   * their own step exactly as displayed). */
  function stepsFromRecords(turn: RunningTurn): TurnStep[] {
    return turn.recorded
      .filter((r) => r.sentences.length > 0)
      .map((r) => ({
        call: r.call,
        speaker: r.speaker,
        text: r.sentences.join(' '),
      }));
  }

  /**
   * The §6 orchestration loop (0.21.0): ONE narrator call drives the whole
   * turn — queries and both B6 gates run mid-call as before, and the LOOP
   * executors let the Narrator run characters inside its own reply:
   * determine_who_next validates the routing declaration (V1: exactly one),
   * charactercall runs the WHOLE C-Module call (streaming its sentences as a
   * `character` step) and returns the reply text; the narrator's later
   * sentences rotate into a fresh `narration` record, so the committed steps
   * read narrator → character → narration → … exactly as displayed. The
   * TURN BUDGET refuses charactercalls past the cap with an error string the
   * model reads (Rev 4 §6: max N character turns per user turn, then yield).
   */
  async function runNarratorLoop(
    turn: RunningTurn,
    turnId: string,
    sceneId: string,
    worldId: string,
    profile: CharacterProfile,
    registry: readonly CharacterProfile[],
    context: { stablePrefix: string; dynamicTail: string },
    instruction: string,
    userInput: string | undefined,
  ): Promise<Result<{ toolCalls: readonly RawToolCall[] }>> {
    let record: RunningTurn['recorded'][number] = {
      call: 'narrator',
      speaker: profile.name,
      sentences: [],
    };
    turn.recorded.push(record);
    let sentenceIndex = 0;
    let firstSentenceSeen = false;
    const splitter = createSentenceSplitter((sentence) => {
      record.sentences.push(sentence);
      if (!turn.interrupted) {
        streamBus.publish({
          turn_id: turnId,
          call: record.call,
          speaker: profile.name,
          text: sentence,
          index: sentenceIndex,
        });
      }
      sentenceIndex += 1;
      if (!firstSentenceSeen) {
        firstSentenceSeen = true;
        const emitted = faultPoint('mid_stream');
        if (emitted instanceof Promise) {
          emitted.catch((thrown: unknown) => {
            logger.warn({ err: thrown }, 'fault-point hook failed');
          });
        }
      }
    });
    let characterCalls = 0;
    // A failed INNER character call voids the whole turn (B6: a beat whose
    // reply silently vanished must never commit as if nothing was missing) —
    // recorded here because the executor can only hand the model a string.
    let innerError: AppError | undefined;

    const result = await llm.streamCall({
      kind: 'narrator',
      characterId: profile.character_id,
      system: context.stablePrefix,
      prompt: `${context.dynamicTail}\n\n## Instruction\n${instruction}`,
      onTextDelta: (delta) => {
        splitter.push(delta);
      },
      toolset: 'narrator',
      // The read-only query executors (Rev 4 §6): run mid-call, feed their
      // result back to the model, dev-trailed like every tool call (C11).
      queries: {
        query_sublocations: (input: unknown): string => {
          devBus.publish({
            type: 'dev.tool_call',
            turn_id: turnId,
            tool: 'query_sublocations',
            input_json: JSON.stringify(input),
          });
          return turn.stage.querySublocations(input);
        },
        query_wiki: (input: unknown): string => {
          devBus.publish({
            type: 'dev.tool_call',
            turn_id: turnId,
            tool: 'query_wiki',
            input_json: JSON.stringify(input),
          });
          return runWikiquery(storage, worldId, logger, input);
        },
      },
      // The mid-call gate executor (M6 part 2, owner decision 2026-07-09):
      // both B6 gates run DURING the call and the model reads the staged-ack
      // or the refusal as its tool result. Staging stays in-memory;
      // durability still only happens at turn.committed.
      gate: (raw: RawToolCall): string => {
        if (turn.interrupted) {
          return 'ERROR: the user interrupted this turn — stop; nothing will commit.';
        }
        const gated = gateOne(raw, turn.stage, turnId);
        return gated.ok
          ? stagedAck(gated.value)
          : `ERROR: ${gated.error.message}`;
      },
      loop: {
        determine_who_next: (input: unknown): string => {
          devBus.publish({
            type: 'dev.tool_call',
            turn_id: turnId,
            tool: 'determine_who_next',
            input_json: JSON.stringify(input),
          });
          if (turn.interrupted) {
            return 'ERROR: the user interrupted this turn — stop; nothing will commit.';
          }
          return turn.stage.declareNext(input);
        },
        charactercall: async (input: unknown): Promise<string> => {
          devBus.publish({
            type: 'dev.tool_call',
            turn_id: turnId,
            tool: 'charactercall',
            input_json: JSON.stringify(input),
          });
          if (turn.interrupted) {
            return 'ERROR: the user interrupted this turn — stop; nothing will commit.';
          }
          const parsed = CharactercallToolSchema.safeParse(input);
          if (!parsed.success) {
            return 'charactercall: malformed input — use {"character_id": "char:...", "seed"?: "one line"}.';
          }
          if (characterCalls >= turnBudget) {
            return `ERROR: the turn budget (${String(turnBudget)} character turns per player turn) is spent — no more character calls; close your narration and yield to the player.`;
          }
          const consumed = turn.stage.consumeDeclared(parsed.data.character_id);
          if (!consumed.ok) {
            return `ERROR: ${consumed.error.message}`;
          }
          const characterProfile = profileForCharacter(
            parsed.data.character_id,
            registry,
            turn.stage,
          );
          if (characterProfile === undefined) {
            return `ERROR: no callable profile for ${parsed.data.character_id}.`;
          }
          characterCalls += 1;
          // Close the narrator segment BEFORE the character speaks, so the
          // committed steps keep true display order.
          splitter.flush();
          const seed = parsed.data.seed;
          const reply = await runCall(
            {
              kind: 'character',
              profile: characterProfile,
              instruction: `Reply as ${characterProfile.name} in 1-3 short sentences of dialogue, true to your voice. If the conversation touches something from your own past that your core memory does not hold, search your long-term memories with memoryquery before answering; look up unfamiliar places with wikiquery. If you durably place, move, or write content into a physical object that matters beyond this moment, call interact_object — most scenery stays prose.${seed === undefined ? '' : ` (Direction for this moment: ${seed})`}`,
              toolset: 'character_scene',
            },
            turn,
            turnId,
            sceneId,
            worldId,
            stepsFromRecords(turn),
            userInput,
          );
          // Later narrator sentences land in their OWN record — the classic
          // narration step, exactly like the old scripted third call.
          record = { call: 'narration', speaker: profile.name, sentences: [] };
          turn.recorded.push(record);
          sentenceIndex = 0;
          if (!reply.ok) {
            innerError = reply.error;
            return `ERROR: the character call failed (${reply.error.code}) — stop; this turn will not commit.`;
          }
          // Data-path tool calls (the fake returns interact_object as data):
          // both gates run now, actor = the called character.
          runToolGates(
            reply.value.toolCalls,
            turn.stage,
            turnId,
            characterProfile.character_id,
          );
          return `${characterProfile.name} responds (speech is verbatim; narrate the observable surface of the rest):\n${reply.value.step.text}`;
        },
      },
    });
    if (!result.ok) return result;
    if (innerError !== undefined) return err(innerError);
    splitter.flush();
    return ok({ toolCalls: result.value.toolCalls });
  }

  /** One raw call through both B6 gates: valid → staged (in-memory) + a
   * dev.tool_call frame; rejected → a dev.tool_rejected frame and nothing
   * else (I8: zero rows). Shared by the post-call loop (fake/legacy clients
   * return calls as data) and the mid-call gate executor (M6 part 2).
   * `actorId` present = a character call (M7 part 3): gate 1 parses the
   * character toolset (interact_object) and the actor rides the staged
   * effect; absent = the Narrator's toolset. */
  function gateOne(
    raw: RawToolCall,
    stage: ToolStage,
    turnId: string,
    actorId?: string,
  ): Result<StagedToolEffect> {
    const parsed =
      actorId === undefined
        ? parseToolCall(raw, logger)
        : parseCharacterSceneToolCall(raw, logger);
    if (!parsed.ok) {
      devBus.publish({
        type: 'dev.tool_rejected',
        turn_id: turnId,
        tool: raw.tool,
        gate: 'schema',
        reason: parsed.error.message,
      });
      return parsed;
    }
    const staged = stage.apply(parsed.value, actorId);
    if (!staged.ok) {
      devBus.publish({
        type: 'dev.tool_rejected',
        turn_id: turnId,
        tool: parsed.value.tool,
        gate: 'state',
        reason: staged.error.message,
      });
      return staged;
    }
    devBus.publish({
      type: 'dev.tool_call',
      turn_id: turnId,
      tool: parsed.value.tool,
      input_json: JSON.stringify(parsed.value.input),
    });
    return staged;
  }

  /** The mid-call acknowledgement for a staged effect — names the ids so the
   * model can reference them later in the same reply (create →
   * change_sublocation → end_scene, the creation loop). */
  function stagedAck(effect: StagedToolEffect): string {
    switch (effect.kind) {
      case 'sublocation':
        return `staged: the scene moves to ${effect.sublocationId} (${effect.name}) when this reply commits.`;
      case 'art':
        return `staged: ${effect.characterId} switches to art "${effect.artId}".`;
      case 'create':
        return `staged: ${effect.sublocationId} ("${effect.name}") will be created when this reply commits — you may change_sublocation to it or register it as next_scene now.`;
      case 'end_scene':
        return `staged: the scene closes (${effect.endType}) when this reply commits.`;
      case 'object_create':
        return `staged: "${effect.name}" becomes a durable object (${effect.objectId}) at ${effect.holderSublocationId} when this reply commits${effect.payload === undefined ? '' : ', carrying your authored content'}.`;
      case 'object_payload':
        return `staged: your content is written into ${effect.objectId} when this reply commits.`;
      case 'object_move':
        return `staged: ${effect.objectId} moves to ${effect.toSublocationId} when this reply commits.`;
      case 'object_improv':
        return `staged: your improvised content is written into ${effect.objectId} when this reply commits — every later read returns exactly it.`;
      case 'character_join':
        return `staged: ${effect.characterId} ("${effect.name}") joins the scene when this reply commits — you may determine_who_next them now.`;
      case 'character_mint':
        return effect.present
          ? `staged: ${effect.characterId} ("${effect.name}") is minted into the world AND joins the scene when this reply commits.`
          : `staged: ${effect.characterId} ("${effect.name}") is minted into the world, offstage, when this reply commits.`;
      case 'character_leave':
        return `staged: ${effect.characterId} leaves the scene when this reply commits — they become available elsewhere.`;
      case 'character_move':
        return `staged: ${effect.characterId} moves to ${effect.toSublocationId} when this reply commits.`;
      case 'goals':
        return `staged: your subgoal snapshot (${String(effect.goals.length)} goals) persists when this reply commits — it is what a resumed scene reads.`;
    }
  }

  /** Both B6 gates over one call's raw tool calls — the post-call path for
   * clients that return mutating calls as data (no mid-call gate). */
  function runToolGates(
    rawCalls: readonly RawToolCall[],
    stage: ToolStage,
    turnId: string,
    actorId?: string,
  ): void {
    for (const raw of rawCalls) {
      gateOne(raw, stage, turnId, actorId);
    }
  }

  const running = new Map<string, RunningTurn>();

  return {
    async startTurn(
      command: StartTurnCommand,
    ): Promise<Result<{ turnId: string; completion: Promise<void> }>> {
      const turnId = randomUUID();
      // Durable intent before work (Brief §2.4) — recovery sees an open envelope.
      sink.append({
        world_id: command.world_id,
        actor_id: command.actor_id,
        type: 'turn.started',
        payload: { scene_id: command.scene_id, turn_id: turnId },
      });

      const sublocations = worldSublocations(command.world_id);
      // The chat→scene handoff (Rev 4 §8): an unresolved place request makes
      // the Narrator resolve it THIS turn via the standard workflow — the
      // free text itself rides the player-wrapped tail below (B14).
      const handoff = sceneHandoff(command.scene_id);
      const resolveInstruction =
        handoff.placeRequest === undefined
          ? ''
          : ' The player context names a meeting place that is not yet a sublocation of this world: resolve it THIS turn — call query_sublocations first (mode parentless and/or search); if an existing sublocation plausibly fits, change_sublocation to it; otherwise create_sublocation (the query-first rule applies) and change_sublocation to the new place.';

      // The live world registry (0.21.0): seeds ∪ every character.created —
      // minted characters are callable from the very next turn, no restart.
      const registry = characterProfilesOf(
        storage,
        command.world_id,
        seedProfiles,
      );
      const registryKnown: KnownCharacter[] = registry.map((p) => ({
        character_id: p.character_id,
        name: p.name,
      }));
      for (const known of knownCharacters) {
        if (!registryKnown.some((k) => k.character_id === known.character_id)) {
          registryKnown.push(known);
        }
      }
      // The scene's cast: the character.joined/left fold; only a scene with
      // NO roster events at all (bare test worlds, pre-0.21 logs) keeps the
      // configured fixture default — an emptied cast stays empty.
      const roster = sceneRosterOf(storage, command.scene_id);
      const presentIds = roster.tracked
        ? roster.cast.map((r) => r.character_id)
        : [...presentCharacterIds];
      const cast: KnownCharacter[] = presentIds.map(
        (id) =>
          registryKnown.find((k) => k.character_id === id) ?? {
            character_id: id,
            name: id,
          },
      );

      // The handoff text is data from chat (user free text / a character
      // line) — it enters the prompt only inside the player-wrapped external
      // block, never an instruction slot (B14).
      const handoffNotes = [
        ...(handoff.premise === undefined
          ? []
          : [`(Scene premise: ${handoff.premise})`]),
        ...(handoff.placeRequest === undefined
          ? []
          : [`(Meeting place requested from chat: "${handoff.placeRequest}")`]),
        ...(handoff.briefHistory === undefined
          ? []
          : [`(What just happened, carried over: ${handoff.briefHistory})`]),
        ...(handoff.carriedGoals === undefined ||
        handoff.carriedGoals.length === 0
          ? []
          : [
              `(Story goals carried from the previous scene: ${handoff.carriedGoals.join('; ')})`,
            ]),
      ];
      const firstTurnText = [command.text ?? '', ...handoffNotes]
        .filter((line) => line !== '')
        .join('\n');

      // The context-budget check (0.21.0, Rev 4 §6): estimate the narrator
      // prompt (chars/4 — the same heuristic the fake's accounting uses)
      // BEFORE the call; within the margin the tail carries the warning and
      // end_scene(context_limit_reached) becomes legal (the stage flag).
      const narratorProfile = narratorProfileFor(command.world_id);
      const narratorContext = assembleContext(narratorProfile, {
        scene_id: command.scene_id,
        world_clock_text: worldClockText,
        latest_turns: recentTurns(command.scene_id),
        ...(firstTurnText === '' ? {} : { user_input: firstTurnText }),
        wiki: [],
      });
      const estimatedTokens = Math.ceil(
        (narratorContext.stablePrefix.length +
          narratorContext.dynamicTail.length) /
          4,
      );
      const contextWarned =
        estimatedTokens > contextBudgetTokens - CONTEXT_WARNING_MARGIN;
      const warningText = contextWarned
        ? ` ENGINE WARNING: this scene's context (${String(estimatedTokens)} tokens) is within ${String(CONTEXT_WARNING_MARGIN)} tokens of its ${String(contextBudgetTokens)}-token budget — wind the scene down naturally (plant leave seeds through charactercall) and close with end_scene type context_limit_reached when it fits the fiction.`
        : '';

      const stage = createToolStage(
        {
          storage,
          worldId: command.world_id,
          sublocations,
          startSublocationId,
          artSets,
          presentCharacterIds: presentIds,
          worldCharacters: registryKnown,
          presence: (characterId) =>
            presenceOf(storage, command.world_id, characterId),
          contextWarned,
        },
        command.scene_id,
      );

      const turn: RunningTurn = {
        command,
        recorded: [],
        stage,
        interrupted: false,
        closed: false,
      };
      running.set(turnId, turn);

      const instruction = `Narrate the next beat of the scene, third person, present tense. YOU drive the turn (Rev 4 §6): declare who acts next with determine_who_next, run them with charactercall, and weave each reply into your narration — spoken words verbatim, actions by their observable surface. Another character may follow (declare again first); the engine caps character turns per player turn, and when it says the budget is spent, close your narration and stop. When the beat lands, yield to the player. You may call your other scene tools whenever the fiction calls for it.${resolveInstruction} ${narratorToolContext(command.scene_id, command.world_id, sublocations, cast)}${warningText}`;

      const completion = (async (): Promise<void> => {
        const result = await runNarratorLoop(
          turn,
          turnId,
          command.scene_id,
          command.world_id,
          narratorProfile,
          registry,
          narratorContext,
          instruction,
          // Every call of the turn hears the player's line (M7 part 1: the
          // character needs it to decide a memory/wiki query; it enters
          // each prompt only inside the player-wrapped external block, B14).
          firstTurnText !== '' ? firstTurnText : undefined,
        );
        // The interrupt already closed the envelope — everything from here
        // on (text and tool calls alike) finishes into the void (B6).
        if (turn.interrupted) return;
        if (!result.ok) {
          voidTurn(turnId, result.error);
          return;
        }
        // Data-path narrator tool calls (the fake returns mutations as data;
        // a gate-wired real client already gated everything mid-call).
        runToolGates(result.value.toolCalls, stage, turnId);
        await faultPoint('between_calls');
        const steps = stepsFromRecords(turn);
        if (steps.length === 0) {
          voidTurn(
            turnId,
            new OperationalError('empty_turn', 'no displayable steps streamed'),
          );
          return;
        }
        await faultPoint('pre_commit');
        // Re-read through the map: an interrupt may have landed during the
        // awaits above (the map lookup is what keeps this check visible to
        // the type system — same object, fresh narrowing).
        const live = running.get(turnId);
        if (live === undefined || live.interrupted || live.closed) return;

        // A parentless create's materialize anchor: the sublocation the
        // creating scene was in (Rev 4 §14's default) — resolved before the
        // commit so the payload is durable and replay-stable.
        const anchorPosition = ((): { x: number; y: number } => {
          const currentId = currentSublocationId(
            storage,
            command.scene_id,
            startSublocationId,
          );
          return (
            worldSublocations(command.world_id).find(
              (s) => s.sublocation_id === currentId,
            )?.map_position ?? { x: 0.5, y: 0.5 }
          );
        })();

        // One WriteGate transaction: the turn text, every staged tool effect
        // (incl. created stubs + their backdrop/materialize job rows) and
        // (when end_scene staged) scene.ended + its fan-out jobs commit or
        // vanish together (Brief §2.4). Publish only after commit.
        const appended: WeltariEvent[] = [];
        storage.transact(() => {
          appended.push(
            storage.eventLog.append({
              world_id: command.world_id,
              actor_id: command.actor_id,
              type: 'turn.committed',
              payload: { scene_id: command.scene_id, turn_id: turnId, steps },
            }),
          );
          for (const effect of stage.staged()) {
            if (effect.kind === 'sublocation') {
              // The current backdrop rides along when its paint already
              // landed (UI Spec §1.6) — absent means the client's themed
              // placeholder until painter.completed arrives live.
              const backdropPath = latestBackdropPath(
                storage,
                effect.sublocationId,
              );
              appended.push(
                storage.eventLog.append({
                  world_id: command.world_id,
                  actor_id: narrator.character_id,
                  type: 'sublocation.changed',
                  payload: {
                    scene_id: command.scene_id,
                    sublocation_id: effect.sublocationId,
                    name: effect.name,
                    ...(effect.mapPosition === undefined
                      ? {}
                      : { map_position: effect.mapPosition }),
                    ...(backdropPath === undefined
                      ? {}
                      : { backdrop_path: backdropPath }),
                  },
                }),
              );
            } else if (effect.kind === 'art') {
              appended.push(
                storage.eventLog.append({
                  world_id: command.world_id,
                  actor_id: narrator.character_id,
                  type: 'art.switched',
                  payload: {
                    scene_id: command.scene_id,
                    character_id: effect.characterId,
                    art_id: effect.artId,
                  },
                }),
              );
            } else if (effect.kind === 'create') {
              // The identity stub (Rev 4 §6: creation is hot) + its backdrop
              // job in the SAME transaction; parentless stubs also enqueue
              // their eager materialization (map presence is cold).
              appended.push(
                storage.eventLog.append({
                  world_id: command.world_id,
                  actor_id: narrator.character_id,
                  type: 'sublocation.stub_created',
                  payload: {
                    scene_id: command.scene_id,
                    sublocation_id: effect.sublocationId,
                    name: effect.name,
                    description: effect.brief,
                    ...(effect.parentId === undefined
                      ? {}
                      : { parent_id: effect.parentId }),
                    ...(effect.narrativeAnchor === undefined
                      ? {}
                      : { narrative_anchor: effect.narrativeAnchor }),
                  },
                }),
              );
              enqueueBackdropPaint(
                storage,
                command.world_id,
                effect.sublocationId,
              );
              if (effect.parentId === undefined) {
                storage.ledger.enqueue({
                  idempotency_key: `materialize:stub:${effect.sublocationId}`,
                  world_id: command.world_id,
                  type: 'materialize',
                  payload: {
                    stub_sublocation_id: effect.sublocationId,
                    anchor: anchorPosition,
                  },
                });
              }
            } else if (effect.kind === 'object_create') {
              // Materialize-on-touch (M7 part 3, Rev 4 §7): the row is the
              // event's same-transaction fold (repositories/objects.ts) —
              // actor = the touching character, never the Narrator.
              appended.push(
                storage.eventLog.append({
                  world_id: command.world_id,
                  actor_id: effect.actorId,
                  type: 'object.created',
                  payload: {
                    object_id: effect.objectId,
                    name: effect.name,
                    holder_sublocation_id: effect.holderSublocationId,
                    ...(effect.payload === undefined
                      ? {}
                      : { object_payload: effect.payload }),
                    scene_id: command.scene_id,
                  },
                }),
              );
            } else if (effect.kind === 'object_payload') {
              appended.push(
                storage.eventLog.append({
                  world_id: command.world_id,
                  actor_id: effect.actorId,
                  type: 'object.payload_written',
                  payload: {
                    object_id: effect.objectId,
                    object_payload: effect.payload,
                    scene_id: command.scene_id,
                  },
                }),
              );
            } else if (effect.kind === 'object_move') {
              appended.push(
                storage.eventLog.append({
                  world_id: command.world_id,
                  actor_id: effect.actorId,
                  type: 'object.moved',
                  payload: {
                    object_id: effect.objectId,
                    from_sublocation_id: effect.fromSublocationId,
                    to_sublocation_id: effect.toSublocationId,
                    scene_id: command.scene_id,
                  },
                }),
              );
            } else if (effect.kind === 'object_improv') {
              // Write-on-first-read (Rev 4 §7): the Narrator's improvised
              // content, persisted exactly once — actor = the Narrator.
              appended.push(
                storage.eventLog.append({
                  world_id: command.world_id,
                  actor_id: narrator.character_id,
                  type: 'object.payload_written',
                  payload: {
                    object_id: effect.objectId,
                    object_payload: effect.payload,
                    scene_id: command.scene_id,
                  },
                }),
              );
            } else if (effect.kind === 'character_join') {
              // The agentic scene (0.21.0, Rev 4 §6): an existing character
              // joins mid-scene — the same roster event scene open appends.
              appended.push(
                storage.eventLog.append({
                  world_id: command.world_id,
                  actor_id: narrator.character_id,
                  type: 'character.joined',
                  payload: {
                    scene_id: command.scene_id,
                    character_id: effect.characterId,
                    name: effect.name,
                  },
                }),
              );
            } else if (effect.kind === 'character_mint') {
              // A Narrator-minted character: the SAME character.created the
              // consent-gated GM path appends (engine.md characters.ts —
              // the registry fold makes them real everywhere).
              appended.push(
                storage.eventLog.append({
                  world_id: command.world_id,
                  actor_id: narrator.character_id,
                  type: 'character.created',
                  payload: {
                    character_id: effect.characterId,
                    name: effect.name,
                    personality: effect.personality,
                    goals: [...effect.goals],
                    core: [...effect.core],
                    skills: [],
                  },
                }),
              );
              if (effect.present) {
                appended.push(
                  storage.eventLog.append({
                    world_id: command.world_id,
                    actor_id: narrator.character_id,
                    type: 'character.joined',
                    payload: {
                      scene_id: command.scene_id,
                      character_id: effect.characterId,
                      name: effect.name,
                    },
                  }),
                );
              }
            } else if (effect.kind === 'character_leave') {
              appended.push(
                storage.eventLog.append({
                  world_id: command.world_id,
                  actor_id: narrator.character_id,
                  type: 'character.left',
                  payload: {
                    scene_id: command.scene_id,
                    character_id: effect.characterId,
                    ...(effect.reason === undefined
                      ? {}
                      : { reason: effect.reason }),
                  },
                }),
              );
            } else if (effect.kind === 'character_move') {
              // The Narrator's world repositioning (Rev 4 §6/§14): the same
              // event CRON movement appends — actor = the narrator, stamped
              // with the CURRENT world clock (the move happens now).
              const from = characterLocationsOf(storage, command.world_id).get(
                effect.characterId,
              );
              appended.push(
                storage.eventLog.append({
                  world_id: command.world_id,
                  actor_id: narrator.character_id,
                  type: 'character.location_changed',
                  payload: {
                    character_id: effect.characterId,
                    ...(from === undefined
                      ? {}
                      : { from_sublocation_id: from }),
                    to_sublocation_id: effect.toSublocationId,
                    game_time: worldTimeOf(storage, command.world_id),
                  },
                }),
              );
            } else if (effect.kind === 'goals') {
              appended.push(
                storage.eventLog.append({
                  world_id: command.world_id,
                  actor_id: narrator.character_id,
                  type: 'scene.goals_updated',
                  payload: {
                    scene_id: command.scene_id,
                    turn_id: turnId,
                    goals: effect.goals.map((g) => ({ ...g })),
                  },
                }),
              );
            }
            // end_scene is appended LAST so clients see the turn + moves first.
          }
          const end = stage.endScene();
          if (end?.kind === 'end_scene') {
            // The LIVE registry names the fan-out's speakers (0.21.0): a
            // character minted or joined this very session still gets its
            // reflection job.
            const core = appendSceneEndWithFanOut(
              storage,
              registryKnown,
              {
                world_id: command.world_id,
                actor_id: narrator.character_id,
                scene_id: command.scene_id,
                end_type: end.endType,
                ...(end.dividerText === undefined
                  ? {}
                  : { divider_text: end.dividerText }),
                ...(end.nextScene === undefined
                  ? {}
                  : {
                      next_scene: {
                        sublocation_id: end.nextScene.sublocationId,
                        ...(end.nextScene.premiseSeed === undefined
                          ? {}
                          : { premise_seed: end.nextScene.premiseSeed }),
                        ...(end.nextScene.timeOffsetHours === undefined
                          ? {}
                          : {
                              time_offset_hours: end.nextScene.timeOffsetHours,
                            }),
                        ...(end.nextScene.expectedParticipants === undefined
                          ? {}
                          : {
                              expected_participants: [
                                ...end.nextScene.expectedParticipants,
                              ],
                            }),
                        ...(end.nextScene.briefHistory === undefined
                          ? {}
                          : { brief_history: end.nextScene.briefHistory }),
                        ...(end.nextScene.carriedGoals === undefined
                          ? {}
                          : {
                              carried_goals: [...end.nextScene.carriedGoals],
                            }),
                      },
                    }),
                ...(end.followUpMarker === undefined
                  ? {}
                  : {
                      follow_up_marker: {
                        sublocation_id: end.followUpMarker.sublocationId,
                        premise_seed: end.followUpMarker.premiseSeed,
                      },
                    }),
              },
              options.markerFanOut,
            );
            appended.push(core.event, ...core.markerEvents);
          }
        });
        turn.closed = true;
        for (const event of appended) eventBus.publish(event);
        // The backdrop fires immediately (Rev 4 §6) — start it now, not at
        // the runner's next poll.
        if (stage.staged().some((effect) => effect.kind === 'create')) {
          options.kickRunner?.();
        }
      })().finally(() => {
        running.delete(turnId);
      });

      return Promise.resolve(ok({ turnId, completion }));
    },

    interruptTurn(
      command: InterruptTurnCommand,
    ): Result<{ committed: boolean }> {
      const turn = running.get(command.turn_id);
      if (turn === undefined || turn.closed || turn.interrupted) {
        return err(
          new OperationalError(
            'turn_not_running',
            `turn ${command.turn_id} is not open for interruption`,
          ),
        );
      }
      turn.interrupted = true;
      // The user cut the Narrator off: staged world changes never happened.
      turn.stage.discard();

      const steps =
        command.seen === undefined
          ? []
          : truncateAtSeen(turn.recorded, command.seen);
      if (steps.length === 0) {
        // Nothing was displayed — the envelope closes as a void (recovery
        // already treats started-without-committed as void).
        turn.closed = true;
        logger.info(
          { turn_id: command.turn_id },
          'turn interrupted before display: voided',
        );
        return ok({ committed: false });
      }

      const persisted = storage.transact(() =>
        storage.eventLog.append({
          world_id: turn.command.world_id,
          actor_id: command.actor_id,
          type: 'turn.committed',
          payload: {
            scene_id: turn.command.scene_id,
            turn_id: command.turn_id,
            steps,
            interrupted: true,
          },
        }),
      );
      turn.closed = true;
      eventBus.publish(persisted);
      logger.info(
        { turn_id: command.turn_id, steps: steps.length },
        'turn interrupted: truncated commit',
      );
      return ok({ committed: true });
    },
  };

  function voidTurn(turnId: string, error: AppError): void {
    // B6: nothing durable was written after turn.started — the turn simply
    // voids; recovery treats started-without-committed as void too.
    logger.error(
      { turn_id: turnId, code: error.code, kind: error.kind },
      'turn voided',
    );
  }
}
