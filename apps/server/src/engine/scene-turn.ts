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
import { parseToolCall, type RawToolCall } from '../llm/tools.js';
import type { LlmClient } from '../llm/types.js';
import type { Storage } from '../storage/db.js';
import {
  assembleContext,
  type CharacterProfile,
  type TurnLine,
} from './context-assembler.js';
import type { EventSink } from './event-sink.js';
import { runMemoryquery, runWikiquery } from './chat-queries.js';
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
import {
  appendSceneEndWithFanOut,
  type KnownCharacter,
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
  /** Narrator calls offer the narrator toolset (Guide B6); character calls
   * offer character_scene (M7 part 1: read-only queries, nothing stageable). */
  toolset?: 'narrator' | 'character_scene';
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
  } = options;

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

  /** Dynamic scene options for the Narrator's instruction (tail-only — the
   * current sublocation changes turn to turn and must never touch the prefix). */
  function narratorToolContext(
    sceneId: string,
    sublocations: readonly SublocationDefinition[],
  ): string {
    const current = currentSublocationId(storage, sceneId, startSublocationId);
    const sublocationList = sublocations
      .map((s) => `${s.sublocation_id} (${s.name})`)
      .join(', ');
    const artList = [...artSets.entries()]
      .map(([characterId, poses]) => `${characterId}: ${poses.join('|')}`)
      .join('; ');
    return [
      `Current sublocation: ${current}.`,
      `Sublocations you may move the scene to: ${sublocationList}.`,
      `Art poses you may switch: ${artList}.`,
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
  } {
    let premise: string | undefined;
    let placeRequest: string | undefined;
    let hasTurns = false;
    let hasMoved = false;
    for (const event of storage.eventLog.readSince(0, 100000)) {
      if (!('scene_id' in event.payload) || event.payload.scene_id !== sceneId)
        continue;
      if (event.type === 'scene.started') {
        premise = event.payload.premise;
        placeRequest = event.payload.place_request;
      } else if (event.type === 'turn.committed') {
        hasTurns = true;
      } else if (event.type === 'sublocation.changed') {
        hasMoved = true;
      }
    }
    return {
      ...(premise === undefined || hasTurns ? {} : { premise }),
      ...(placeRequest === undefined || hasMoved ? {} : { placeRequest }),
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
        : plan.toolset === 'character_scene'
          ? {
              // The character's scene-side queries (M7 part 1, Rev 4 §7/§11,
              // owner ruling 2026-07-11): read-only mid-call executors,
              // nothing stageable — memoryquery deep-dives the character's
              // OWN deltas; wikiquery covers the query-sublocations-then-
              // their-wiki flow in one step. Dev-trailed like every query.
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
              },
            }
          : {
              toolset: plan.toolset,
              // The read-only query executor (Rev 4 §6): runs mid-call, feeds
              // its result back to the model, arms the stage's query-first
              // flag — and leaves a dev-trail frame like any tool call (C11).
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
              },
              // The mid-call gate executor (M6 part 2, owner decision
              // 2026-07-09): both B6 gates run DURING the call and the model
              // reads the staged-ack or the refusal as its tool result — a
              // rejected create is no longer trail-only, the Narrator can
              // self-correct in the same turn. Staging stays in-memory;
              // durability still only happens at turn.committed below.
              gate: (raw: RawToolCall): string => {
                if (turn.interrupted) {
                  return 'ERROR: the user interrupted this turn — stop; nothing will commit.';
                }
                const gated = gateOne(raw, turn.stage, turnId);
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

  /** One raw call through both B6 gates: valid → staged (in-memory) + a
   * dev.tool_call frame; rejected → a dev.tool_rejected frame and nothing
   * else (I8: zero rows). Shared by the post-call loop (fake/legacy clients
   * return calls as data) and the mid-call gate executor (M6 part 2). */
  function gateOne(
    raw: RawToolCall,
    stage: ToolStage,
    turnId: string,
  ): Result<StagedToolEffect> {
    const parsed = parseToolCall(raw, logger);
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
    const staged = stage.apply(parsed.value);
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
    }
  }

  /** Both B6 gates over one call's raw tool calls — the post-call path for
   * clients that return mutating calls as data (no mid-call gate). */
  function runToolGates(
    rawCalls: readonly RawToolCall[],
    stage: ToolStage,
    turnId: string,
  ): void {
    for (const raw of rawCalls) {
      gateOne(raw, stage, turnId);
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
      const plans: CallPlan[] = [
        {
          kind: 'narrator',
          profile: narrator,
          instruction: `Narrate the next beat of the scene in 2-3 sentences, third person, present tense. End on a hook for Elias. You may call your scene tools when the fiction calls for it.${resolveInstruction} ${narratorToolContext(command.scene_id, sublocations)}`,
          toolset: 'narrator',
        },
        {
          kind: 'character',
          profile: elias,
          instruction:
            'Reply as Elias in 1-3 short sentences of dialogue, true to his voice. If the conversation touches something from your own past that your core memory does not hold, search your long-term memories with memoryquery before answering; if it touches a place you are not sure about, look it up with wikiquery. The scene already gave you where you are — query only when you genuinely need more.',
          toolset: 'character_scene',
        },
        {
          kind: 'narration',
          profile: narrator,
          instruction:
            'Close the beat in 1-2 sentences of narration reacting to what was just said.',
        },
      ];

      const stage = createToolStage(
        {
          storage,
          sublocations,
          startSublocationId,
          artSets,
          presentCharacterIds,
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
      ];
      const firstTurnText = [command.text ?? '', ...handoffNotes]
        .filter((line) => line !== '')
        .join('\n');

      const completion = (async (): Promise<void> => {
        const steps: TurnStep[] = [];
        for (const [index, plan] of plans.entries()) {
          const result = await runCall(
            plan,
            turn,
            turnId,
            command.scene_id,
            command.world_id,
            steps,
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
          steps.push(result.value.step);
          runToolGates(result.value.toolCalls, stage, turnId);
          if (index === 0) await faultPoint('between_calls');
        }
        await faultPoint('pre_commit');
        if (turn.interrupted || turn.closed) return;

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
            }
            // end_scene is appended LAST so clients see the turn + moves first.
          }
          const end = stage.endScene();
          if (end?.kind === 'end_scene') {
            const core = appendSceneEndWithFanOut(storage, knownCharacters, {
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
                    },
                  }),
            });
            appended.push(core.event);
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
