// The reflect_chat job handler (M6 part 2, Rev 4 §8): the chat analogue of
// scene reflection — runs when a conversation range closes (exit / idle /
// startscene), reads the range's messages, and commits ONE
// reflect_chat.committed. No scene-style summary product (sessionsummarist =
// FALSE per Rev 4 §8): the outcome is the character's own private note.
// Idempotent per (conversation, range_end_id) with the fused lease-overlap
// re-check (docs/ledger.md) — the week-7 painter bug class stays fixed here.
import { z } from 'zod';
import { CorruptStateError, BugError } from '../../errors.js';
import type {
  CharacterProfile,
  TurnLine,
} from '../../engine/context-assembler.js';
import { assembleContext } from '../../engine/context-assembler.js';
import type { EventSink } from '../../engine/event-sink.js';
import {
  gateReflectionMemory,
  liveProfile,
  memoryEventsFrom,
  type ReflectionMemoryOutput,
} from '../../engine/memory.js';
import {
  parseReflectionToolCall,
  type ValidatedReflectionToolCall,
} from '../../llm/tools.js';
import type { FaultPointHook } from '../../engine/fault-points.js';
import type { Logger } from '../../observability/logger.js';
import type { LlmClient } from '../../llm/types.js';
import type { Storage } from '../../storage/db.js';
import type { JobHandler } from '../runner.js';

const payloadSchema = z.strictObject({
  conversation_id: z.string().min(1),
  character_id: z.string().min(1),
  range_end_id: z.int().positive(),
});

export interface ReflectChatHandlerOptions {
  storage: Storage;
  sink: EventSink;
  llm: LlmClient;
  profiles: readonly CharacterProfile[];
  logger: Logger;
  faultPoint?: FaultPointHook;
}

/** The closed range's transcript: this conversation's messages up to and
 * including the range end (the previous range's lines age out of the slice).
 * Covers BOTH the DM shape and the group shape (M6 part 4): group lines are
 * labeled with each speaking member's name. */
function rangeTranscript(
  storage: Storage,
  conversationId: string,
  rangeEndId: number,
  characterName: string,
  nameOf: (characterId: string) => string,
): TurnLine[] {
  const lines: TurnLine[] = [];
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (event.id > rangeEndId) continue;
    if (
      event.type === 'chat.message_committed' &&
      event.payload.conversation_id === conversationId
    ) {
      lines.push({
        speaker: event.payload.sender === 'user' ? 'User' : characterName,
        text: event.payload.text,
      });
    } else if (
      event.type === 'chat.group_message_committed' &&
      event.payload.conversation_id === conversationId
    ) {
      lines.push({
        speaker:
          event.payload.sender === 'user'
            ? 'User'
            : nameOf(event.payload.character_id ?? ''),
        text: event.payload.text,
      });
    }
  }
  return lines.slice(-40);
}

export function createReflectChatHandler(
  options: ReflectChatHandlerOptions,
): JobHandler {
  const { storage, sink, llm, profiles, logger } = options;
  const faultPoint = options.faultPoint ?? ((): void => undefined);

  return async (job): Promise<void> => {
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      // Our own stored data failed its schema — corruption, not input (C2).
      throw new CorruptStateError(
        'reflect_chat_payload',
        `job ${String(job.id)} payload does not match {conversation_id, character_id, range_end_id}`,
      );
    }
    const { conversation_id, character_id, range_end_id } = payload.data;

    const profile = profiles.find((p) => p.character_id === character_id);
    if (profile === undefined) {
      throw new BugError(
        'unknown_character',
        `no profile for ${character_id} — enqueue and registry disagree`,
      );
    }

    // The character id is part of the key (M6 part 4): a GROUP range closes
    // with one reflect pass PER member over the same range — each must
    // commit exactly once without blocking its siblings.
    const alreadyCommitted = (): boolean =>
      storage.eventLog
        .readSince(0, 100000)
        .some(
          (e) =>
            e.type === 'reflect_chat.committed' &&
            e.payload.conversation_id === conversation_id &&
            e.payload.range_end_id === range_end_id &&
            e.payload.character_id === character_id,
        );

    // Idempotency gate: the retry after a kill -9 must not reflect twice.
    if (alreadyCommitted()) {
      logger.debug(
        { job_id: job.id, conversation_id, range_end_id },
        'reflect_chat already committed — idempotent no-op',
      );
      return;
    }

    const context = assembleContext(liveProfile(storage, profile), {
      scene_id: conversation_id,
      heading: 'Conversation',
      world_clock_text: 'The chat has just ended.',
      latest_turns: rangeTranscript(
        storage,
        conversation_id,
        range_end_id,
        profile.name,
        (id) => profiles.find((p) => p.character_id === id)?.name ?? 'Someone',
      ),
      wiki: [],
    });
    const result = await llm.streamCall({
      kind: 'reflect_chat',
      characterId: character_id,
      system: context.stablePrefix,
      prompt: `${context.dynamicTail}\n\n## Instruction\nThe chat above has ended. Reflect on it in 2-4 sentences from your own point of view: what you learned about the other person, what you intend to do. First person, private thoughts — nobody else reads this.\nThen curate your long-term memory (M7): call memory_delta 1-3 times — one lasting, self-contained note each. If this conversation changed what you must always remember, also call update_core with your FULL new core list. If it genuinely changed who you are, you may call evolve — rare and earned.`,
      onTextDelta: (): void => undefined, // reflections do not stream to clients
      toolset: 'reflection',
    });
    if (!result.ok) throw result.error; // operational -> runner retries (C7)

    // B6 gate 1 (shape) then gate 2 (caps, locked flag) over the memory
    // outputs — rejected calls drop with a trail entry, zero rows (I8).
    const validated: ValidatedReflectionToolCall[] = [];
    for (const raw of result.value.toolCalls) {
      const parsed = parseReflectionToolCall(raw, logger);
      if (parsed.ok) validated.push(parsed.value);
    }
    const memory: ReflectionMemoryOutput = gateReflectionMemory(
      validated,
      profile,
      logger,
    );

    await faultPoint('mid_reflect_chat');
    // The new memory-commit window (M7 part 1, criterion d).
    await faultPoint('mid_memory_commit');
    // Fused lease-overlap re-check: NO await between this check and the
    // append (executions interleave only at await points) — the loser of an
    // overlap no-ops here, one duplicate generation, zero duplicate events.
    if (alreadyCommitted()) {
      logger.warn(
        { job_id: job.id, conversation_id, range_end_id },
        'reflect_chat overlapped its own lease-expiry retry — one duplicate generation, zero duplicate events',
      );
      return;
    }
    // The memory outputs ride the SAME transaction as reflect_chat.committed
    // (M7 part 1, Rev 4 §11): replay rebuilds the identical memory state.
    sink.appendMany([
      {
        world_id: job.world_id,
        actor_id: character_id,
        type: 'reflect_chat.committed',
        payload: {
          conversation_id,
          character_id,
          range_end_id,
          summary: result.value.text,
        },
      },
      ...memoryEventsFrom(memory, {
        world_id: job.world_id,
        character_id,
        origin: 'chat',
        context_id: conversation_id,
      }),
    ]);
  };
}
