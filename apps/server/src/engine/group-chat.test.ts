// Group chats (M6 part 4, Rev 4 §8): the Group-chat Narrator routes turns
// with ZERO narration of its own, the ENGINE cuts at the turn budget, and a
// range close fans out exactly one reflect pass per member (criterion b).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Bus, type EventBus } from '../http/bus.js';
import { createReflectChatHandler } from '../ledger/handlers/reflect-chat.js';
import { createFakeLlmClient } from '../llm/fake-client.js';
import { createRootLogger } from '../observability/logger.js';
import { openStorage, type Storage } from '../storage/db.js';
import { buildEliasProfile, buildMaraProfile } from './fixture/rainy-inn.js';
import { createEventSink } from './event-sink.js';
import { createGroupChatEngine } from './group-chat.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sinkStream = new Writable({
    write(_c, _e, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sinkStream });
}

const ELIAS = buildEliasProfile(100);
const MARA = buildMaraProfile();

interface Ctx {
  storage: Storage;
  eventBus: EventBus;
  engine: ReturnType<typeof createGroupChatEngine>;
}

function setup(turnBudget = 3): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'weltari-group-'));
  const logger = quietLogger();
  const storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
  const eventBus: EventBus = new Bus(logger);
  const engine = createGroupChatEngine({
    storage,
    sink: createEventSink(storage, eventBus),
    eventBus,
    llm: createFakeLlmClient(),
    logger,
    profiles: [ELIAS, MARA],
    turnBudget,
  });
  return { storage, eventBus, engine };
}

const START = {
  world_id: 'w1',
  actor_id: 'user:owner',
  member_ids: ['char:elias', 'char:mara'],
  title: 'The ferry crowd',
  request_id: 'g-1',
};

async function sendAndAwait(
  ctx: Ctx,
  conversationId: string,
  text: string,
  requestId: string,
): Promise<void> {
  const sent = ctx.engine.sendMessage({
    world_id: 'w1',
    actor_id: 'user:owner',
    conversation_id: conversationId,
    text,
    request_id: requestId,
  });
  expect(sent.ok).toBe(true);
  if (sent.ok) await sent.value.completion;
}

describe('group chats (criterion b)', () => {
  it('the engine cuts the router off at the turn budget — zero narration text ever surfaces', async () => {
    const ctx = setup(3);
    const started = ctx.engine.startGroup(START);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const conversationId = started.value.conversationId;

    // The fake router routes the FIRST member every step (deliberate
    // ping-pong shape) — only the ENGINE budget stops it.
    await sendAndAwait(ctx, conversationId, 'Evening, both of you.', 'm-1');

    const events = ctx.storage.eventLog.readSince(0);
    const characterLines = events.flatMap((e) =>
      e.type === 'chat.group_message_committed' &&
      e.payload.sender === 'character'
        ? [e.payload]
        : [],
    );
    expect(characterLines).toHaveLength(3); // budget, not the router's appetite
    // NO narration: every transcript line belongs to the user or a member —
    // the router's own text never became durable anywhere.
    for (const line of characterLines) {
      expect(START.member_ids).toContain(line.character_id);
    }
    // The round yielded at budget; the range is still open (no group_ended).
    expect(events.some((e) => e.type === 'chat.group_ended')).toBe(false);
    ctx.storage.close();
  });

  it('!route scripts an explicit member pick; a second start is idempotent', async () => {
    const ctx = setup(1);
    const started = ctx.engine.startGroup(START);
    const again = ctx.engine.startGroup(START);
    expect(again.ok && started.ok && again.value.conversationId).toBe(
      started.ok ? started.value.conversationId : '',
    );
    expect(
      ctx.storage.eventLog
        .readSince(0)
        .filter((e) => e.type === 'chat.group_started'),
    ).toHaveLength(1);
    if (!started.ok) return;

    await sendAndAwait(
      ctx,
      started.value.conversationId,
      'Mara, tell him. !route char:mara',
      'm-2',
    );
    const characterLines = ctx.storage.eventLog
      .readSince(0)
      .filter(
        (e) =>
          e.type === 'chat.group_message_committed' &&
          e.payload.sender === 'character',
      );
    expect(characterLines).toHaveLength(1);
    if (characterLines[0]?.type === 'chat.group_message_committed') {
      expect(characterLines[0].payload.character_id).toBe('char:mara');
    }
    ctx.storage.close();
  });

  it('ENDSUBSESSION and exit close the range with exactly one reflect pass per member', async () => {
    const ctx = setup(3);
    const started = ctx.engine.startGroup(START);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const conversationId = started.value.conversationId;

    // The router ends the round itself — the scripted ENDSUBSESSION.
    await sendAndAwait(ctx, conversationId, 'Right, all set. !endsub', 'm-3');
    const events = ctx.storage.eventLog.readSince(0);
    const ended = events.find((e) => e.type === 'chat.group_ended');
    expect(ended).toBeDefined();
    if (ended?.type === 'chat.group_ended') {
      expect(ended.payload.reason).toBe('endsubsession');
    }
    // Exactly ONE reflect_chat job per member, atomically with the close.
    for (const memberId of START.member_ids) {
      const matching = ctx.storage.ledger
        .listActive('w1')
        .filter(
          (job) =>
            job.type === 'reflect_chat' &&
            job.idempotency_key.includes(`:${memberId}:`),
        );
      expect(matching).toHaveLength(1);
    }

    // Both members reflect over the SAME range without blocking each other
    // (the per-character idempotency fix): run the real handler on each job.
    const handler = createReflectChatHandler({
      storage: ctx.storage,
      sink: createEventSink(ctx.storage, ctx.eventBus),
      llm: createFakeLlmClient(),
      profiles: [ELIAS, MARA],
      logger: quietLogger(),
    });
    for (;;) {
      const job = ctx.storage.ledger.claimNext('test', 60);
      if (job === null) break;
      await handler(job);
      ctx.storage.ledger.markCommitted(job.id);
    }
    const reflected = ctx.storage.eventLog
      .readSince(0)
      .flatMap((e) => (e.type === 'reflect_chat.committed' ? [e.payload] : []));
    expect(reflected).toHaveLength(2);
    expect(new Set(reflected.map((r) => r.character_id))).toEqual(
      new Set(START.member_ids),
    );

    // A user exit with nothing new to reflect is a no-op close.
    const exited = ctx.engine.exitGroup({
      world_id: 'w1',
      actor_id: 'user:owner',
      conversation_id: conversationId,
    });
    expect(exited.ok && exited.value.ended).toBe(false);
    ctx.storage.close();
  });

  it('refuses unknown members and duplicate members at start', () => {
    const ctx = setup();
    const unknown = ctx.engine.startGroup({
      ...START,
      request_id: 'g-bad-1',
      member_ids: ['char:elias', 'char:ghost'],
    });
    expect(unknown.ok).toBe(false);
    const duplicated = ctx.engine.startGroup({
      ...START,
      request_id: 'g-bad-2',
      member_ids: ['char:elias', 'char:elias'],
    });
    expect(duplicated.ok).toBe(false);
    ctx.storage.close();
  });
});
