// The scripted Week-1 scene turn (FINAL §6): Narrator → character → narration,
// three sequential LLM calls streamed sentence-by-sentence. Crash-only shape:
// turn.started is durable BEFORE any LLM work; streamed text is display-only;
// the ONLY durable narration is turn.committed at close (Guide B6). A kill or
// failure anywhere in between voids the turn — nothing partial persists.
import { randomUUID } from 'node:crypto';
import type { StartTurnCommand, TurnStep } from '@weltari/protocol';
import { ok, type AppError, type Result } from '../errors.js';
import type { Logger } from '../observability/logger.js';
import type { StreamBus } from '../http/bus.js';
import type { LlmClient, CallKind } from '../llm/types.js';
import type { Storage } from '../storage/db.js';
import {
  assembleContext,
  type CharacterProfile,
  type TurnLine,
} from './context-assembler.js';
import type { EventSink } from './event-sink.js';
import { buildEliasProfile, NARRATOR_PROFILE } from './fixture/rainy-inn.js';
import { createSentenceSplitter } from './sentences.js';

/** Kill-harness hooks (I4). Names are the contract with tools/kill-harness.mjs. */
export type FaultPoint = 'mid_stream' | 'between_calls' | 'pre_commit';

export interface TurnEngineOptions {
  storage: Storage;
  sink: EventSink;
  streamBus: StreamBus;
  llm: LlmClient;
  logger: Logger;
  /** Emits FAULT_POINT lines when the harness env flag is set; no-op otherwise. */
  faultPoint?: (point: FaultPoint) => void;
  /** Fixture world clock — engine-owned fictional time, injected (A16). */
  worldClockText?: string;
  stablePrefixTokens?: number;
}

export interface TurnEngine {
  /**
   * Opens the turn envelope durably, then runs the three calls detached.
   * `completion` resolves when the turn commits or voids (tests/harness await it).
   */
  startTurn(
    command: StartTurnCommand,
  ): Promise<Result<{ turnId: string; completion: Promise<void> }>>;
}

interface CallPlan {
  kind: CallKind;
  profile: CharacterProfile;
  instruction: string;
}

export function createTurnEngine(options: TurnEngineOptions): TurnEngine {
  const {
    storage,
    sink,
    streamBus,
    llm,
    logger,
    faultPoint = (): void => undefined,
    worldClockText = 'Day 1, evening, heavy rain',
    stablePrefixTokens = 800,
  } = options;

  const elias = buildEliasProfile(stablePrefixTokens);

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
    turnId: string,
    sceneId: string,
    priorSteps: readonly TurnStep[],
    userInput: string | undefined,
  ): Promise<Result<TurnStep>> {
    const transcript = [
      ...recentTurns(sceneId),
      ...priorSteps.map((s) => ({ speaker: s.speaker, text: s.text })),
    ];
    const context = assembleContext(plan.profile, {
      scene_id: sceneId,
      world_clock_text: worldClockText,
      latest_turns: transcript,
      ...(userInput === undefined ? {} : { user_input: userInput }),
      wiki: [],
    });

    let sentenceIndex = 0;
    let firstSentenceSeen = false;
    const splitter = createSentenceSplitter((sentence) => {
      streamBus.publish({
        turn_id: turnId,
        call: plan.kind,
        speaker: plan.profile.name,
        text: sentence,
        index: sentenceIndex,
      });
      sentenceIndex += 1;
      if (!firstSentenceSeen) {
        firstSentenceSeen = true;
        if (plan.kind === 'narrator') faultPoint('mid_stream');
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
    });
    if (!result.ok) return result;
    splitter.flush();
    return ok({
      call: plan.kind,
      speaker: plan.profile.name,
      text: result.value.text,
    });
  }

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

      const plans: CallPlan[] = [
        {
          kind: 'narrator',
          profile: NARRATOR_PROFILE,
          instruction:
            'Narrate the next beat of the scene in 2-3 sentences, third person, present tense. End on a hook for Elias.',
        },
        {
          kind: 'character',
          profile: elias,
          instruction:
            'Reply as Elias in 1-3 short sentences of dialogue, true to his voice.',
        },
        {
          kind: 'narration',
          profile: NARRATOR_PROFILE,
          instruction:
            'Close the beat in 1-2 sentences of narration reacting to what was just said.',
        },
      ];

      const completion = (async (): Promise<void> => {
        const steps: TurnStep[] = [];
        for (const [index, plan] of plans.entries()) {
          const step = await runCall(
            plan,
            turnId,
            command.scene_id,
            steps,
            index === 0 ? command.text : undefined,
          );
          if (!step.ok) {
            voidTurn(turnId, step.error);
            return;
          }
          steps.push(step.value);
          if (index === 0) faultPoint('between_calls');
        }
        faultPoint('pre_commit');
        sink.append({
          world_id: command.world_id,
          actor_id: command.actor_id,
          type: 'turn.committed',
          payload: { scene_id: command.scene_id, turn_id: turnId, steps },
        });
      })();

      return Promise.resolve(ok({ turnId, completion }));
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
