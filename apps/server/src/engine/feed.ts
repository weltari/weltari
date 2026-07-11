// The feed-reply command seam (M6 part 5, owner ruling 2026-07-11): the user
// replies to a CHARACTER COMMENT on a feed post — a feed-local thread under
// that comment, never routed into Weltari Chat. The reply commits durably at
// the seam; the comment's author answers DETACHED via the social_reply job
// (enqueued atomically with the reply — the standing intent-with-fact shape)
// and arrives as social.reply_answered. Uncapped: user-triggered spend.
import type { FeedReplyCommand } from '@weltari/protocol';
import { err, ok, OperationalError, type Result } from '../errors.js';
import type { Storage } from '../storage/db.js';
import type { EventSink } from './event-sink.js';

export interface FeedReplyOptions {
  storage: Storage;
  sink: EventSink;
  /** Start the answer job now — the reply box should track generation
   * latency, not the runner's poll. */
  kick: () => void;
}

export interface FeedReplyOutcome {
  replyId: string;
}

export function createFeedReplyCommand(
  options: FeedReplyOptions,
): (command: FeedReplyCommand) => Result<FeedReplyOutcome> {
  const { storage, sink, kick } = options;
  return (command): Result<FeedReplyOutcome> => {
    const events = storage.eventLog.readSince(0, 100000);
    // The reply target must be a real COMMENT on the named post (likes have
    // no text to answer; clicking one never opens the reply box — a request
    // naming one is a stale or hand-crafted client).
    const comment = events.find(
      (e) =>
        e.type === 'social.reaction_committed' &&
        e.world_id === command.world_id &&
        e.payload.post_id === command.post_id &&
        e.payload.reaction_id === command.reaction_id,
    );
    if (comment?.type !== 'social.reaction_committed') {
      return err(new OperationalError('unknown_comment', 'no such comment'));
    }
    if (comment.payload.kind !== 'comment') {
      return err(
        new OperationalError('not_a_comment', 'likes cannot be replied to'),
      );
    }
    // Idempotent per request_id: a duplicate send is a silent 202 no-op.
    const duplicate = events.some(
      (e) =>
        e.type === 'social.reply_posted' &&
        e.world_id === command.world_id &&
        e.payload.reply_id === command.request_id,
    );
    if (!duplicate) {
      sink.appendManyWithJobs(
        [
          {
            world_id: command.world_id,
            actor_id: command.actor_id,
            type: 'social.reply_posted',
            payload: {
              post_id: command.post_id,
              reaction_id: command.reaction_id,
              reply_id: command.request_id,
              body: command.text,
            },
          },
        ],
        [
          {
            idempotency_key: `social_reply:${command.request_id}`,
            world_id: command.world_id,
            type: 'social_reply',
            payload: {
              post_id: command.post_id,
              reaction_id: command.reaction_id,
              reply_id: command.request_id,
              character_id: comment.payload.character_id,
            },
            // The answer rides the character's own social mailbox lane —
            // never racing its reaction/answer writes elsewhere.
            serial_group: `social:${command.world_id}:${comment.payload.character_id}`,
          },
        ],
      );
      kick();
    }
    return ok({ replyId: command.request_id });
  };
}
