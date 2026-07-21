// The social_reply job handler (M6 part 5, owner ruling 2026-07-11): the
// comment's author answers the user's reply in the feed-local thread —
// ANSWER-ONLY: the toolset carries nothing but cache, so the character
// physically cannot promise a meeting or an action from here (the conduct
// skill says so out loud too). Characters always answer (availability is
// the product — Rev 4 §16); uncapped because every fire is user-triggered.
// Natural key: in_reply_to (one answer per user reply, kill-retry safe);
// the answerer's CACHE line (origin `social`) rides the same transaction.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CorruptStateError, OperationalError } from '../../errors.js';
import type { CharacterProfile } from '../../engine/context-assembler.js';
import { assembleContext } from '../../engine/context-assembler.js';
import type { TurnLine } from '../../engine/context-assembler.js';
import {
  cacheRecapText,
  capCacheLine,
  latestPerOrigin,
} from '../../engine/cache.js';
import type { EventSink } from '../../engine/event-sink.js';
import { liveProfile } from '../../engine/memory.js';
import { SOCIAL_CONDUCT_SKILL } from '../../engine/social.js';
import { parseSocialToolCall } from '../../llm/tools.js';
import type { LlmClient } from '../../llm/types.js';
import type { Logger } from '../../observability/logger.js';
import type { Storage } from '../../storage/db.js';
import { characterProfilesOf } from '../../engine/characters.js';
import type { JobHandler } from '../runner.js';

const payloadSchema = z.strictObject({
  post_id: z.string().min(1),
  reaction_id: z.string().min(1),
  reply_id: z.string().min(1),
  character_id: z.string().min(1),
});

export interface SocialReplyHandlerOptions {
  storage: Storage;
  sink: EventSink;
  llm: LlmClient;
  profiles: readonly CharacterProfile[];
  logger: Logger;
}

export function createSocialReplyHandler(
  options: SocialReplyHandlerOptions,
): JobHandler {
  const { storage, sink, llm, profiles, logger } = options;

  return async (job): Promise<void> => {
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new CorruptStateError(
        'social_reply_payload',
        `job ${String(job.id)} payload does not match {post_id, reaction_id, reply_id, character_id}`,
      );
    }
    // Week 19 (audit item 2, the 6a657d9 pattern): the roster folds LIVE
    // — seeds ∪ character.created — so minted characters take part
    // without a restart.
    const roster = characterProfilesOf(storage, job.world_id, profiles);
    const { post_id, reaction_id, reply_id, character_id } = payload.data;

    const alreadyAnswered = (): boolean =>
      storage.eventLog
        .readSince(0, 100000)
        .some(
          (e) =>
            e.type === 'social.reply_answered' &&
            e.world_id === job.world_id &&
            e.payload.in_reply_to === reply_id,
        );
    if (alreadyAnswered()) {
      logger.debug(
        { job_id: job.id, reply_id },
        'social_reply already answered — idempotent no-op',
      );
      return;
    }

    // The thread this answer lands in — post, comment, and every reply
    // exchange so far, in log order. All enqueued atomically with their
    // causes, so a missing piece is corrupted state.
    const events = storage.eventLog.readSince(0, 100000);
    const post = events.find(
      (e) =>
        e.type === 'social.post_committed' &&
        e.world_id === job.world_id &&
        e.payload.post_id === post_id,
    );
    const comment = events.find(
      (e) =>
        e.type === 'social.reaction_committed' &&
        e.world_id === job.world_id &&
        e.payload.reaction_id === reaction_id,
    );
    if (
      post?.type !== 'social.post_committed' ||
      comment?.type !== 'social.reaction_committed'
    ) {
      throw new CorruptStateError(
        'social_reply_orphan',
        `reply job ${String(job.id)} names a post/comment not in the log`,
      );
    }
    const profile = roster.find((p) => p.character_id === character_id);
    if (profile === undefined) {
      logger.warn(
        { job_id: job.id, reply_id, character_id },
        'social_reply author is not a configured character — quiet no-op',
      );
      return;
    }
    const nameOf = (id: string): string =>
      roster.find((p) => p.character_id === id)?.name ?? id;

    const thread: TurnLine[] = [
      {
        speaker: `${nameOf(post.payload.character_id)} (feed post)`,
        text: post.payload.body,
      },
      {
        speaker: `${profile.name} (your comment)`,
        text: comment.payload.body ?? '',
      },
    ];
    for (const e of events) {
      if (
        e.type === 'social.reply_posted' &&
        e.payload.reaction_id === reaction_id
      ) {
        thread.push({ speaker: 'User', text: e.payload.body });
      } else if (
        e.type === 'social.reply_answered' &&
        e.payload.reaction_id === reaction_id
      ) {
        thread.push({ speaker: profile.name, text: e.payload.body });
      }
    }

    const recap = cacheRecapText(latestPerOrigin(storage, character_id));
    const context = assembleContext(
      {
        ...liveProfile(storage, profile),
        skills: [...profile.skills, SOCIAL_CONDUCT_SKILL],
      },
      {
        scene_id: `feed:${job.world_id}`,
        heading: 'The Feed',
        world_clock_text:
          'You are outside any scene, answering under your own feed comment.',
        latest_turns: thread,
        wiki: [],
        ...(recap === '' ? {} : { cache_recap: recap }),
      },
    );
    const result = await llm.streamCall({
      kind: 'social_reply',
      characterId: character_id,
      system: context.stablePrefix,
      prompt: `${context.dynamicTail}\n\n## Instruction\nThe User replied to your comment (the last User line above). Answer them as ${profile.name} in ONE short line, in your own voice, staying inside the thread — you can only answer here: never promise meetings or actions (you have no way to arrange anything from the feed; if something needs doing, say you will bring it up when you next see or text them). After answering, call the cache tool with a private 1-2 line recap.`,
      onTextDelta: (): void => undefined, // answers do not stream
      toolset: 'social_reply',
    });
    if (!result.ok) throw result.error; // operational -> runner retries (C7)
    let cacheLine: string | undefined;
    for (const raw of result.value.toolCalls) {
      const parsed = parseSocialToolCall(raw, logger);
      if (parsed.ok && parsed.value.tool === 'cache') {
        cacheLine = capCacheLine(parsed.value.input.line);
      }
    }
    const body = result.value.text.trim();
    if (body === '') {
      // Answer-only means an empty generation is a FAILURE to answer, not a
      // choice — operational, so the runner retries with backoff (C7):
      // availability is the product; the user is waiting under the comment.
      throw new OperationalError(
        'social_reply_empty',
        `reply job ${String(job.id)} generated an empty answer`,
      );
    }

    const answerId = `answer-${randomUUID().slice(0, 12)}`;
    // Fused lease-overlap re-check: NO await between check and append.
    if (alreadyAnswered()) {
      logger.warn(
        { job_id: job.id, reply_id },
        'social_reply overlapped its own lease-expiry retry — zero duplicate events',
      );
      return;
    }
    sink.appendMany([
      {
        world_id: job.world_id,
        actor_id: character_id,
        type: 'social.reply_answered',
        payload: {
          post_id,
          reaction_id,
          reply_id: answerId,
          in_reply_to: reply_id,
          character_id,
          body: body.slice(0, 1000),
        },
      },
      ...(cacheLine === undefined
        ? []
        : [
            {
              world_id: job.world_id,
              actor_id: character_id,
              type: 'cache.appended' as const,
              payload: {
                character_id,
                origin: 'social' as const,
                context_id: post_id,
                line: cacheLine,
              },
            },
          ]),
    ]);
    logger.info(
      { post_id, reply_id, character_id },
      'feed reply answered in the comment thread',
    );
  };
}
