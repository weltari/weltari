// The social_post job handler (M6 part 5, Rev 4 §12): a cadence fire picks
// one poster and EAGERLY generates its feed post — content is durable at
// fire time and arrives over the stream like any event. Occurrences are
// GAME-time boundaries, enqueued only when the world clock advances (owner
// ruling 2026-07-10/11) and capped at SOCIAL_POST_SKIP_CAP per skip with
// the freshest window surviving. Delivery rides the acquaintance fold; the
// picked recipients' reaction decisions are enqueued ATOMICALLY with the
// post (the scene-end fan-out shape), so a kill between post and reactions
// cannot exist. Idempotent per (world, occurrence_iso) with the fused
// lease-overlap re-check — the standing triad (proactive-dm is the sibling).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CorruptStateError } from '../../errors.js';
import type { CharacterProfile } from '../../engine/context-assembler.js';
import { assembleContext } from '../../engine/context-assembler.js';
import {
  cacheRecapText,
  capCacheLine,
  latestPerOrigin,
} from '../../engine/cache.js';
import { presenceOf } from '../../engine/chat.js';
import type { EventSink } from '../../engine/event-sink.js';
import type { FaultPointHook } from '../../engine/fault-points.js';
import { liveProfile } from '../../engine/memory.js';
import { pickIndex } from '../../engine/outreach.js';
import {
  acquaintancesOf,
  pickReactionCandidates,
  SOCIAL_CONDUCT_SKILL,
} from '../../engine/social.js';
import { worldTimeOf } from '../../engine/world-clock.js';
import { parseChatToolCall } from '../../llm/tools.js';
import type { LlmClient } from '../../llm/types.js';
import type { Logger } from '../../observability/logger.js';
import type { Storage } from '../../storage/db.js';
import { characterProfilesOf } from '../../engine/characters.js';
import type { JobHandler } from '../runner.js';

const payloadSchema = z.strictObject({
  occurrence_iso: z.string().min(1),
});

/** Same pick-retry ceiling as the proactive DMs (owner ruling 2026-07-11):
 * 5 salted hash picks over ALL characters, then the occurrence stays quiet. */
const PICK_ATTEMPTS = 5;

export interface SocialPostHandlerOptions {
  storage: Storage;
  sink: EventSink;
  llm: LlmClient;
  profiles: readonly CharacterProfile[];
  /** Max recipients who get the ONE reaction decision (env, default 4). */
  reactionCap: number;
  logger: Logger;
  faultPoint?: FaultPointHook;
}

export function createSocialPostHandler(
  options: SocialPostHandlerOptions,
): JobHandler {
  const { storage, sink, llm, profiles, reactionCap, logger } = options;
  const faultPoint = options.faultPoint ?? ((): void => undefined);

  return async (job): Promise<void> => {
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new CorruptStateError(
        'social_post_payload',
        `job ${String(job.id)} payload does not match {occurrence_iso}`,
      );
    }
    // Week 19 (audit item 2, the 6a657d9 pattern): the roster folds LIVE
    // — seeds ∪ character.created — so minted characters take part
    // without a restart.
    const roster = characterProfilesOf(storage, job.world_id, profiles);
    const { occurrence_iso } = payload.data;

    const alreadyPosted = (): boolean =>
      storage.eventLog
        .readSince(0, 100000)
        .some(
          (e) =>
            e.type === 'social.post_committed' &&
            e.world_id === job.world_id &&
            e.payload.occurrence_iso === occurrence_iso,
        );

    // Idempotency gate: one boundary = at most one post, ever.
    if (alreadyPosted()) {
      logger.debug(
        { job_id: job.id, occurrence_iso },
        'social_post occurrence already recorded — idempotent no-op',
      );
      return;
    }

    // Deterministic pick, 5 salted attempts over ALL characters (never a
    // pre-filtered pool). Eligible = not in a scene (a character living a
    // scene is not on its phone — same presence rule the DMs use). A
    // character with no acquaintances may still post: the user reads every
    // post (viewer-only feed); delivery is what acquaintance gates.
    const eligible = (candidate: CharacterProfile): boolean =>
      presenceOf(storage, job.world_id, candidate.character_id).state ===
      'available';
    let profile: CharacterProfile | undefined;
    for (let attempt = 0; attempt < PICK_ATTEMPTS; attempt++) {
      const candidate =
        roster[
          pickIndex(
            `social:${occurrence_iso}:${String(attempt)}`,
            roster.length,
          )
        ];
      if (candidate !== undefined && eligible(candidate)) {
        profile = candidate;
        break;
      }
    }
    if (profile === undefined) {
      logger.debug(
        { job_id: job.id, occurrence_iso },
        'social_post fire found no eligible character in 5 picks — quiet no-op',
      );
      return;
    }

    // Eager generation, grounded like a proactive DM: the character's own
    // CACHE recap + goals live in the assembled context; the feed framing
    // stays in the dynamic tail. The chat toolset serves here (cache +
    // stay_silent; startscene is prompted away and ignored if fired — B6).
    const recap = cacheRecapText(
      latestPerOrigin(storage, profile.character_id),
    );
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
        latest_turns: [],
        wiki: [],
        ...(recap === '' ? {} : { cache_recap: recap }),
      },
    );
    const result = await llm.streamCall({
      kind: 'social_post',
      characterId: profile.character_id,
      system: context.stablePrefix,
      prompt: `${context.dynamicTail}\n\n## Instruction\nWrite ${profile.name}'s short feed post (1-3 sentences, first person, no narration) — something you actually experienced or care about right now, grounded in your own recent memory or goals, not filler. If you have nothing you genuinely want to post, call the stay_silent tool instead — entirely your choice. Do NOT promise meetings or actions (the feed cannot arrange anything). After writing the post, call the cache tool with a private 1-2 line recap.`,
      onTextDelta: (): void => undefined, // posts do not stream
      toolset: 'chat',
    });
    if (!result.ok) throw result.error; // operational -> runner retries (C7)
    let cacheLine: string | undefined;
    let declined = false;
    for (const raw of result.value.toolCalls) {
      const parsed = parseChatToolCall(raw, logger);
      if (!parsed.ok) continue;
      if (parsed.value.tool === 'cache') {
        cacheLine = capCacheLine(parsed.value.input.line);
      } else if (parsed.value.tool === 'stay_silent') {
        declined = true;
      } else {
        logger.warn(
          { job_id: job.id, character_id: profile.character_id },
          'feed post tried startscene — ignored (the feed cannot open scenes)',
        );
      }
    }
    if (declined) {
      logger.info(
        { job_id: job.id, occurrence_iso, character_id: profile.character_id },
        'feed post declined via stay_silent — this fire stays quiet',
      );
      return;
    }
    const body = result.value.text.trim();
    if (body === '') {
      logger.warn(
        { job_id: job.id, occurrence_iso },
        'feed post came back empty — this fire stays quiet',
      );
      return;
    }

    const postId = `post-${randomUUID().slice(0, 12)}`;
    const gameTime = worldTimeOf(storage, job.world_id);
    const recipients = acquaintancesOf(
      storage,
      job.world_id,
      profile.character_id,
    );
    const reactors = pickReactionCandidates(
      recipients,
      reactionCap,
      occurrence_iso,
    );

    await faultPoint('mid_social_post');
    // Fused lease-overlap re-check: NO await between this check and the
    // append — the loser of an overlap no-ops with zero duplicate events.
    if (alreadyPosted()) {
      logger.warn(
        { job_id: job.id, occurrence_iso },
        'social_post overlapped its own lease-expiry retry — one duplicate generation, zero duplicate events',
      );
      return;
    }
    sink.appendManyWithJobs(
      [
        {
          world_id: job.world_id,
          actor_id: profile.character_id,
          type: 'social.post_committed',
          payload: {
            post_id: postId,
            occurrence_iso,
            game_time: gameTime,
            character_id: profile.character_id,
            body: body.slice(0, 1000),
            recipient_ids: recipients,
          },
        },
        ...(cacheLine === undefined
          ? []
          : [
              {
                world_id: job.world_id,
                actor_id: profile.character_id,
                type: 'cache.appended' as const,
                payload: {
                  character_id: profile.character_id,
                  origin: 'social' as const,
                  context_id: postId,
                  line: cacheLine,
                },
              },
            ]),
      ],
      // The reaction fan-out (Rev 4 §12): one decision job per picked
      // recipient, atomic with the post — the two-sided memory writes ride
      // each character's own serial group (the mailbox rule: a social write
      // never races that character's other social writes).
      reactors.map((characterId) => ({
        idempotency_key: `social_reaction:${postId}:${characterId}`,
        world_id: job.world_id,
        type: 'social_reaction',
        payload: { post_id: postId, character_id: characterId },
        serial_group: `social:${job.world_id}:${characterId}`,
      })),
    );
    logger.info(
      {
        post_id: postId,
        occurrence_iso,
        character_id: profile.character_id,
        recipients: recipients.length,
        reaction_jobs: reactors.length,
      },
      'feed post committed at fire time (eager generation)',
    );
  };
}
