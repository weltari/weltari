// The GM conversation invariants (M7 part 2, Rev 4 §9): the GM rides
// Weltari Chat but is NOT a character — no CACHE, no reflection, no idle
// close; a reply and the proposal cards it fired are durable TOGETHER or
// not at all; and the whole cold boot (interview → seed card → approval →
// seeded world) drives through public seams on the scripted fake at $0.
import { describe, expect, it } from 'vitest';
import {
  createChatEngine,
  conversationIdFor,
} from '../../apps/server/src/engine/chat.js';
import { createdCharactersOf } from '../../apps/server/src/engine/characters.js';
import { createEventSink } from '../../apps/server/src/engine/event-sink.js';
import {
  buildEliasProfile,
  buildMaraProfile,
} from '../../apps/server/src/engine/fixture/rainy-inn.js';
import { createGmChatEngine } from '../../apps/server/src/engine/gm-chat.js';
import { GM_CHARACTER_ID } from '../../apps/server/src/engine/gm.js';
import {
  createProposalEngine,
  pendingProposalsOf,
  worldSeeded,
} from '../../apps/server/src/engine/proposals.js';
import type { StreamSentence } from '@weltari/protocol';
import { createFakeLlmClient } from '../../apps/server/src/llm/fake-client.js';
import { ok } from '../../apps/server/src/errors.js';
import { Bus } from '../../apps/server/src/http/bus.js';
import type { Storage } from '../../apps/server/src/storage/db.js';
import { captureLogger } from '../helpers/capture-logger.js';
import { tempStorage } from '../helpers/temp-storage.js';

const WORLD = 'w1';
const OWNER = 'user:owner';

function setup(): {
  storage: Storage;
  gm: ReturnType<typeof createGmChatEngine>;
  proposals: ReturnType<typeof createProposalEngine>;
  /** Every `call: 'gm'` frame published while the test ran (0.20.0). */
  streamed: StreamSentence[];
} {
  const { logger } = captureLogger();
  const storage = tempStorage();
  const sink = createEventSink(storage, new Bus(logger));
  const proposals = createProposalEngine({
    storage,
    sink,
    logger,
    seedProfiles: [buildEliasProfile(100), buildMaraProfile()],
  });
  const streamBus = new Bus<StreamSentence>(logger);
  const streamed: StreamSentence[] = [];
  streamBus.subscribe((frame) => streamed.push(frame));
  const gm = createGmChatEngine({
    storage,
    sink,
    llm: createFakeLlmClient(),
    logger,
    proposals,
    modelConfigured: true,
    streamBus,
  });
  return { storage, gm, proposals, streamed };
}

async function say(
  gm: ReturnType<typeof createGmChatEngine>,
  text: string,
  requestId: string,
): Promise<void> {
  const sent = gm.sendMessage({
    world_id: WORLD,
    actor_id: OWNER,
    character_id: GM_CHARACTER_ID,
    text,
    request_id: requestId,
  });
  if (!sent.ok) throw new Error(sent.error.code);
  await sent.value.completion;
}

describe('the GM is not a character', () => {
  it('a GM reply commits a chat line with GM actor — no CACHE, no jobs', async () => {
    const { storage, gm } = setup();
    await say(gm, 'Hello, GM.', 'r-1');
    const events = storage.eventLog.readSince(0, 100000);
    const gmLines = events.filter(
      (e) =>
        e.type === 'chat.message_committed' &&
        e.payload.sender === 'character' &&
        e.actor_id === GM_CHARACTER_ID,
    );
    expect(gmLines).toHaveLength(1);
    expect(events.some((e) => e.type === 'cache.appended')).toBe(false);
    // No reflection-class job may ever exist for the GM.
    expect(
      storage.ledger.countByKey(
        `reflect_chat:${conversationIdFor(OWNER, GM_CHARACTER_ID)}:2`,
      ),
    ).toBe(0);
  });

  it('GM prose streams display-only gm frames matching the committed reply (0.20.0)', async () => {
    const { storage, gm, streamed } = setup();
    await say(gm, 'Hello, GM.', 'r-stream');
    const conversationId = conversationIdFor(OWNER, GM_CHARACTER_ID);
    expect(streamed.length).toBeGreaterThan(0);
    for (const frame of streamed) {
      expect(frame.call).toBe('gm');
      expect(frame.turn_id).toBe(conversationId);
      expect(frame.speaker).toBe('GM');
    }
    expect(streamed.map((f) => f.index)).toEqual(
      streamed.map((_, i) => i), // contiguous from 0 — one attempt, one stream
    );
    // The durable message is the authority (B6): the frames re-assemble it.
    const committed = storage.eventLog
      .readSince(0, 100000)
      .find(
        (e) =>
          e.type === 'chat.message_committed' && e.actor_id === GM_CHARACTER_ID,
      );
    expect(
      committed?.type === 'chat.message_committed'
        ? committed.payload.text
        : '',
    ).toBe(streamed.map((f) => f.text).join(' '));
  });

  it('a correction-loop retry restarts the stream at index 0', async () => {
    const { gm, streamed } = setup();
    // !badproposal fails gate 1 → the whole reply regenerates; each attempt
    // streams its own sentence sequence, index restarting per attempt.
    await say(gm, 'Please try this. !badproposal', 'r-retry');
    const zeroes = streamed.filter((f) => f.index === 0);
    expect(zeroes.length).toBeGreaterThan(1);
  });

  it('a duplicate request_id is a silent no-op', async () => {
    const { storage, gm } = setup();
    await say(gm, 'Hello.', 'r-dup');
    const before = storage.eventLog.readSince(0, 100000).length;
    const again = gm.sendMessage({
      world_id: WORLD,
      actor_id: OWNER,
      character_id: GM_CHARACTER_ID,
      text: 'Hello.',
      request_id: 'r-dup',
    });
    expect(again.ok && !again.value.replying).toBe(true);
    expect(storage.eventLog.readSince(0, 100000)).toHaveLength(before);
  });

  it('the idle sweep never closes the GM conversation', async () => {
    const { storage, gm } = setup();
    await say(gm, 'Hello.', 'r-idle');
    const { logger } = captureLogger();
    const chatEngine = createChatEngine({
      storage,
      sink: createEventSink(storage, new Bus(logger)),
      eventBus: new Bus(logger),
      llm: createFakeLlmClient(),
      logger,
      profiles: [buildEliasProfile(100)],
      // Cutoff far in the future: EVERYTHING idle-eligible closes.
      idleCutoffIso: () => '2999-01-01T00:00:00.000Z',
      openScene: () => ok({ opened: true as const }),
      endScene: () => ok({ jobsEnqueued: 0 }),
    });
    expect(chatEngine.sweepIdle()).toBe(0);
    expect(
      storage.eventLog
        .readSince(0, 100000)
        .some((e) => e.type === 'chat.ended'),
    ).toBe(false);
  });
});

describe('a GM reply and its proposal cards are atomic', () => {
  it('!proposeplace commits the reply + proposal.submitted together', async () => {
    const { storage, gm } = setup();
    await say(gm, 'I want a quiet yard. !proposeplace mossy-court', 'r-2');
    const events = storage.eventLog.readSince(0, 100000);
    const reply = events.find(
      (e) =>
        e.type === 'chat.message_committed' && e.payload.sender === 'character',
    );
    const proposal = events.find((e) => e.type === 'proposal.submitted');
    expect(reply).toBeDefined();
    expect(proposal).toBeDefined();
    // Same transaction = consecutive log ids (reply first, card second).
    expect((proposal?.id ?? 0) - (reply?.id ?? 0)).toBe(1);
    const pending = pendingProposalsOf(storage, WORLD);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.payload.action).toBe('create_place');
    expect(pending[0]?.payload.proposer).toBe(GM_CHARACTER_ID);
    expect(pending[0]?.payload.approvers).toEqual([OWNER]);
  });

  it('a gate-1-rejected proposal never lands — the reply commits alone (I8)', async () => {
    const { storage, gm } = setup();
    await say(gm, '!badproposal', 'r-3');
    const events = storage.eventLog.readSince(0, 100000);
    expect(events.some((e) => e.type === 'proposal.submitted')).toBe(false);
    expect(
      events.filter(
        (e) =>
          e.type === 'chat.message_committed' &&
          e.payload.sender === 'character',
      ),
    ).toHaveLength(1);
  });

  it('a gate-2-refused proposal (name collision) never lands', async () => {
    const { storage, gm, proposals } = setup();
    await say(gm, '!proposeplace mossy-court', 'r-4');
    const first = pendingProposalsOf(storage, WORLD)[0];
    if (first === undefined) throw new Error('no pending proposal');
    const resolved = await proposals.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: first.payload.proposal_id,
      resolution: 'approved',
    });
    expect(resolved.ok).toBe(true);
    // The same name again: gate 2 refuses at every correction round, the
    // ceiling commits the reply WITHOUT a card.
    await say(gm, 'Again please: !proposeplace mossy-court', 'r-5');
    expect(pendingProposalsOf(storage, WORLD)).toHaveLength(0);
  });
});

describe('cold boot end-to-end (Rev 4 §9, criterion b at $0)', () => {
  it('interview → seed card → approval → a seeded world', async () => {
    const { storage, gm, proposals } = setup();
    // The interview's close: the GM submits the completed form ONCE.
    await say(gm, 'That is everything. !proposeseed saltmarsh', 'r-seed');
    const pending = pendingProposalsOf(storage, WORLD);
    expect(pending).toHaveLength(1);
    const card = pending[0];
    if (card?.payload.action !== 'seed_world') {
      throw new Error('no seed card');
    }
    expect(worldSeeded(storage, WORLD)).toBe(false);

    const resolved = await proposals.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: card.payload.proposal_id,
      resolution: 'approved',
    });
    expect(resolved.ok).toBe(true);

    // Every named place a materialized row (binding), distinct squares,
    // the §9 public+private mix, characters created, world.seeded stamped.
    const events = storage.eventLog.readSince(0, 100000);
    const rows = events.flatMap((e) =>
      e.type === 'sublocation.materialized' ? [e.payload] : [],
    );
    expect(rows).toHaveLength(3);
    const spaces = new Set(rows.map((p) => p.space));
    expect(spaces.has('public') && spaces.has('private')).toBe(true);
    const squares = new Set(
      rows.map((p) => `${String(p.square.col)}:${String(p.square.row)}`),
    );
    expect(squares.size).toBe(3);
    expect(createdCharactersOf(storage, WORLD)).toHaveLength(2);
    expect(worldSeeded(storage, WORLD)).toBe(true);
    // A second seed proposal can never even be submitted now.
    await say(gm, '!proposeseed saltmarsh-again', 'r-seed-2');
    expect(pendingProposalsOf(storage, WORLD)).toHaveLength(0);
  });
});
