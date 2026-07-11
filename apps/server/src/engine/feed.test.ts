// The feed-reply command seam (M6 part 5, owner ruling 2026-07-11): replies
// land in a feed-local thread under a CHARACTER COMMENT — durable at the
// seam, the answer job enqueued atomically, idempotent per request_id.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createEventSink } from './event-sink.js';
import { Bus } from '../http/bus.js';
import { createRootLogger } from '../observability/logger.js';
import { openStorage, type Storage } from '../storage/db.js';
import { createFeedReplyCommand } from './feed.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

const POST_ID = 'post-abc123';
const COMMENT_ID = `${POST_ID}:char:mara`;

describe('feed-reply command seam', () => {
  let storage: Storage | null = null;
  let kicks = 0;

  afterEach(() => {
    storage?.close();
    storage = null;
    kicks = 0;
  });

  function setup(): {
    storage: Storage;
    feedReply: ReturnType<typeof createFeedReplyCommand>;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-feed-'));
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    const sink = createEventSink(storage, new Bus(quietLogger()));
    const feedReply = createFeedReplyCommand({
      storage,
      sink,
      kick: (): void => {
        kicks += 1;
      },
    });
    return { storage, feedReply };
  }

  function seedThread(
    target: Storage,
    kind: 'comment' | 'like' = 'comment',
  ): void {
    target.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:elias',
      type: 'social.post_committed',
      payload: {
        post_id: POST_ID,
        occurrence_iso: '2000-01-02T00:00:00.000Z',
        game_time: '2000-01-02T08:00:00.000Z',
        character_id: 'char:elias',
        body: 'Roof beams up before the rain came back.',
        recipient_ids: ['char:mara'],
      },
    });
    target.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:mara',
      type: 'social.reaction_committed',
      payload: {
        post_id: POST_ID,
        reaction_id: COMMENT_ID,
        character_id: 'char:mara',
        kind,
        ...(kind === 'comment'
          ? { body: 'Rain never asks the river first.' }
          : {}),
      },
    });
  }

  function command(
    requestId = 'req-1',
  ): Parameters<ReturnType<typeof createFeedReplyCommand>>[0] {
    return {
      world_id: 'w1',
      actor_id: 'user:owner',
      post_id: POST_ID,
      reaction_id: COMMENT_ID,
      text: 'What did the eels say about it?',
      request_id: requestId,
    };
  }

  it('commits the reply AND its answer job atomically; a duplicate request is a silent no-op', () => {
    const ctx = setup();
    seedThread(ctx.storage);

    const first = ctx.feedReply(command());
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value.replyId).toBe('req-1');
    const replies = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'social.reply_posted');
    expect(replies).toHaveLength(1);
    if (replies[0]?.type === 'social.reply_posted') {
      expect(replies[0].actor_id).toBe('user:owner');
      expect(replies[0].payload.reply_id).toBe('req-1');
    }
    const job = ctx.storage.ledger.get(1);
    expect(job?.type).toBe('social_reply');
    expect(job?.idempotency_key).toBe('social_reply:req-1');
    expect(job?.serial_group).toBe('social:w1:char:mara');
    expect(kicks).toBe(1);

    const again = ctx.feedReply(command());
    expect(again.ok).toBe(true);
    expect(
      ctx.storage.eventLog
        .readSince(0)
        .filter((e) => e.type === 'social.reply_posted'),
    ).toHaveLength(1);
    expect(kicks).toBe(1); // no second kick — nothing new enqueued
  });

  it('rejects a reply to a like and a reply to a comment that does not exist', () => {
    const ctx = setup();
    seedThread(ctx.storage, 'like');
    const onLike = ctx.feedReply(command());
    expect(onLike.ok).toBe(false);
    if (!onLike.ok) expect(onLike.error.code).toBe('not_a_comment');

    const ghost = ctx.feedReply({ ...command(), reaction_id: 'r-ghost' });
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.error.code).toBe('unknown_comment');
  });
});
