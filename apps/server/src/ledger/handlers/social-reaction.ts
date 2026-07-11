// The social_reaction job handler (M6 part 5, Rev 4 §12): ONE skill-triggered
// decision for one picked recipient of a feed post — like, a one-line
// comment, or an explicit stay_silent (nothing durable). Enqueued ATOMICALLY
// with the post it reacts to; runs on the character's own serial group (the
// mailbox rule — a social write never races that character's other social
// writes). Comments are isolated in V1: characters never react to each
// other's comments. Natural key: (post_id, character_id) with the fused
// lease-overlap re-check. The reactor's CACHE line (origin `social`) rides
// the same transaction — the two-sided memory write's reactor half.
import { z } from 'zod';
import { CorruptStateError } from '../../errors.js';
import type { CharacterProfile } from '../../engine/context-assembler.js';
import { assembleContext } from '../../engine/context-assembler.js';
import {
  cacheRecapText,
  capCacheLine,
  latestPerOrigin,
} from '../../engine/cache.js';
import type { EventSink } from '../../engine/event-sink.js';
import { liveProfile } from '../../engine/memory.js';
import { SOCIAL_CONDUCT_SKILL } from '../../engine/social.js';
import { parseSocialToolCall, type ReactToolInput } from '../../llm/tools.js';
import type { LlmClient } from '../../llm/types.js';
import type { Logger } from '../../observability/logger.js';
import type { Storage } from '../../storage/db.js';
import type { JobHandler } from '../runner.js';

const payloadSchema = z.strictObject({
  post_id: z.string().min(1),
  character_id: z.string().min(1),
});

export interface SocialReactionHandlerOptions {
  storage: Storage;
  sink: EventSink;
  llm: LlmClient;
  profiles: readonly CharacterProfile[];
  logger: Logger;
}

export function createSocialReactionHandler(
  options: SocialReactionHandlerOptions,
): JobHandler {
  const { storage, sink, llm, profiles, logger } = options;

  return async (job): Promise<void> => {
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new CorruptStateError(
        'social_reaction_payload',
        `job ${String(job.id)} payload does not match {post_id, character_id}`,
      );
    }
    const { post_id, character_id } = payload.data;

    // The post is this job's cause — enqueued atomically with it, so a
    // missing post is corrupted state, not an operational retry.
    const post = storage.eventLog
      .readSince(0, 100000)
      .find(
        (e) =>
          e.type === 'social.post_committed' &&
          e.world_id === job.world_id &&
          e.payload.post_id === post_id,
      );
    if (post?.type !== 'social.post_committed') {
      throw new CorruptStateError(
        'social_reaction_orphan',
        `reaction job ${String(job.id)} names post ${post_id} which is not in the log`,
      );
    }

    const alreadyReacted = (): boolean =>
      storage.eventLog
        .readSince(0, 100000)
        .some(
          (e) =>
            e.type === 'social.reaction_committed' &&
            e.world_id === job.world_id &&
            e.payload.post_id === post_id &&
            e.payload.character_id === character_id,
        );
    if (alreadyReacted()) {
      logger.debug(
        { job_id: job.id, post_id, character_id },
        'social_reaction already recorded — idempotent no-op',
      );
      return;
    }

    const profile = profiles.find((p) => p.character_id === character_id);
    if (profile === undefined) {
      logger.warn(
        { job_id: job.id, post_id, character_id },
        'social_reaction recipient is not a configured character — quiet no-op',
      );
      return;
    }
    const posterName =
      profiles.find((p) => p.character_id === post.payload.character_id)
        ?.name ?? post.payload.character_id;

    // The decision call: the post rides the dynamic tail as an external line
    // (B14 — another character's authored text is never instruction).
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
          'You are outside any scene, thumbing through the feed on your phone.',
        latest_turns: [
          { speaker: `${posterName} (feed post)`, text: post.payload.body },
        ],
        wiki: [],
        ...(recap === '' ? {} : { cache_recap: recap }),
      },
    );
    const result = await llm.streamCall({
      kind: 'social_react',
      characterId: character_id,
      system: context.stablePrefix,
      prompt: `${context.dynamicTail}\n\n## Instruction\nYou just read ${posterName}'s post above. Decide ONE reaction as ${profile.name}: call the react tool with kind "like", or kind "comment" with body = one short line in your own voice — or call stay_silent to scroll past. React only if you genuinely would. If you react, also call the cache tool with a private 1-2 line recap.`,
      onTextDelta: (): void => undefined, // decisions do not stream
      toolset: 'social_react',
    });
    if (!result.ok) throw result.error; // operational -> runner retries (C7)

    let reaction: ReactToolInput | undefined;
    let cacheLine: string | undefined;
    let declined = false;
    for (const raw of result.value.toolCalls) {
      const parsed = parseSocialToolCall(raw, logger);
      if (!parsed.ok) continue; // gate-1 rejection: zero rows (I8)
      if (parsed.value.tool === 'react') {
        // Gate 2: body present iff comment (a like's stray body is dropped;
        // a comment without one is no reaction at all).
        const input = parsed.value.input;
        if (input.kind === 'comment' && input.body === undefined) {
          logger.warn(
            { job_id: job.id, post_id, character_id },
            'react(comment) without body — rejected, nothing durable (B6)',
          );
          continue;
        }
        reaction = input.kind === 'like' ? { kind: 'like' } : input;
      } else if (parsed.value.tool === 'cache') {
        cacheLine = capCacheLine(parsed.value.input.line);
      } else {
        declined = true;
      }
    }
    if (reaction === undefined || declined) {
      logger.info(
        { job_id: job.id, post_id, character_id, declined },
        'reaction decision: no reaction — nothing durable',
      );
      return;
    }

    // Fused lease-overlap re-check: NO await between check and append. (No
    // fault point of its own: the natural key + this re-check carry the
    // kill-safety; mid_social_post covers the harness's post window.)
    if (alreadyReacted()) {
      logger.warn(
        { job_id: job.id, post_id, character_id },
        'social_reaction overlapped its own lease-expiry retry — zero duplicate events',
      );
      return;
    }
    sink.appendMany([
      {
        world_id: job.world_id,
        actor_id: character_id,
        type: 'social.reaction_committed',
        payload: {
          post_id,
          reaction_id: `${post_id}:${character_id}`,
          character_id,
          kind: reaction.kind,
          ...(reaction.body === undefined ? {} : { body: reaction.body }),
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
      { post_id, character_id, kind: reaction.kind },
      'feed reaction committed',
    );
  };
}
