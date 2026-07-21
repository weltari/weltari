// The durable tool-result turn (the GM proposal UX contract, Rev 4 §9/§16,
// owner ruling 2026-07-11): resolving a consent card feeds the verdict BACK
// to the GM as the tool call's result — exactly ONE follow-up generation per
// resolution (natural key = the deterministic message id), eager trigger +
// boot sweep converging like the invitation pattern, and the GM transcript
// fold interleaving chat lines with tool calls and results in log order.
// All on the scripted fake at $0.
import { describe, expect, it } from 'vitest';
import type { StreamSentence } from '@weltari/protocol';
import { conversationIdFor } from '../../apps/server/src/engine/chat.js';
import { createEventSink } from '../../apps/server/src/engine/event-sink.js';
import type { FaultPointHook } from '../../apps/server/src/engine/fault-points.js';
import {
  buildEliasProfile,
  buildMaraProfile,
} from '../../apps/server/src/engine/fixture/rainy-inn.js';
import {
  createGmChatEngine,
  followupMessageIdFor,
  gmTranscriptOf,
} from '../../apps/server/src/engine/gm-chat.js';
import { GM_CHARACTER_ID } from '../../apps/server/src/engine/gm.js';
import { createProposalEngine } from '../../apps/server/src/engine/proposals.js';
import { createFakeLlmClient } from '../../apps/server/src/llm/fake-client.js';
import { Bus } from '../../apps/server/src/http/bus.js';
import type { Storage } from '../../apps/server/src/storage/db.js';
import { captureLogger } from '../helpers/capture-logger.js';
import { tempStorage } from '../helpers/temp-storage.js';

const WORLD = 'w1';
const OWNER = 'user:owner';
const CONVERSATION = conversationIdFor(OWNER, GM_CHARACTER_ID);

function setup(
  storage = tempStorage(),
  faultPoint?: FaultPointHook,
): {
  storage: Storage;
  gm: ReturnType<typeof createGmChatEngine>;
  proposals: ReturnType<typeof createProposalEngine>;
} {
  const { logger } = captureLogger();
  const sink = createEventSink(storage, new Bus(logger));
  const proposals = createProposalEngine({
    storage,
    sink,
    logger,
    seedProfiles: [buildEliasProfile(100), buildMaraProfile()],
  });
  const gm = createGmChatEngine({
    storage,
    sink,
    llm: createFakeLlmClient(),
    logger,
    proposals,
    modelConfigured: true,
    streamBus: new Bus<StreamSentence>(logger),
    ...(faultPoint === undefined ? {} : { faultPoint }),
  });
  return { storage, gm, proposals };
}

/** Drive one proposal onto the board and return its id. */
async function propose(
  gm: ReturnType<typeof createGmChatEngine>,
  storage: Storage,
  requestId: string,
  marker: string,
): Promise<string> {
  const sent = gm.sendMessage({
    world_id: WORLD,
    actor_id: OWNER,
    character_id: GM_CHARACTER_ID,
    text: marker,
    request_id: requestId,
  });
  if (!sent.ok) throw new Error(sent.error.code);
  await sent.value.completion;
  const submitted = storage.eventLog
    .readSince(0, 100000)
    .filter((e) => e.type === 'proposal.submitted')
    .at(-1);
  if (submitted?.type !== 'proposal.submitted') throw new Error('no proposal');
  return submitted.payload.proposal_id;
}

function followupsOf(storage: Storage, messageId: string): number {
  return storage.eventLog
    .readSince(0, 100000)
    .filter(
      (e) =>
        e.type === 'chat.message_committed' &&
        e.payload.message_id === messageId,
    ).length;
}

describe('the durable tool-result turn', () => {
  it('consent feeds back: exactly one follow-up reacting to the verdict, after the resolution', async () => {
    const { storage, gm, proposals } = setup();
    const proposalId = await propose(
      gm,
      storage,
      'r-1',
      '!proposeplace mossy-court',
    );
    const resolved = await proposals.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
      resolution: 'approved',
    });
    expect(resolved.ok).toBe(true);
    await gm.noteProposalOutcome({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
      outcome: 'approved',
    }).completion;
    const messageId = followupMessageIdFor(proposalId, 'approved');
    expect(followupsOf(storage, messageId)).toBe(1);
    const events = storage.eventLog.readSince(0, 100000);
    const resolution = events.find((e) => e.type === 'proposal.resolved');
    const followup = events.find(
      (e) =>
        e.type === 'chat.message_committed' &&
        e.payload.message_id === messageId,
    );
    expect((followup?.id ?? 0) > (resolution?.id ?? 0)).toBe(true);
    expect(
      followup?.type === 'chat.message_committed' ? followup.payload.text : '',
    ).toContain('it is real now');
  });

  it('rejection feeds back too — and the follow-up never re-proposes (I8)', async () => {
    const { storage, gm, proposals } = setup();
    const proposalId = await propose(
      gm,
      storage,
      'r-2',
      '!proposeplace dusty-mill',
    );
    const before = storage.eventLog
      .readSince(0, 100000)
      .filter((e) => e.type === 'proposal.submitted').length;
    const resolved = await proposals.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
      resolution: 'rejected',
    });
    expect(resolved.ok).toBe(true);
    await gm.noteProposalOutcome({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
      outcome: 'rejected',
    }).completion;
    expect(
      followupsOf(storage, followupMessageIdFor(proposalId, 'rejected')),
    ).toBe(1);
    // The rejected place's name is free again — only the follow-up guard
    // keeps the fake from minting a twin card off the stale marker.
    expect(
      storage.eventLog
        .readSince(0, 100000)
        .filter((e) => e.type === 'proposal.submitted').length,
    ).toBe(before);
  });

  it('duplicate outcome notes converge on the natural key', async () => {
    const { storage, gm, proposals } = setup();
    const proposalId = await propose(
      gm,
      storage,
      'r-3',
      '!proposeplace twin-yard',
    );
    await proposals.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
      resolution: 'approved',
    });
    const note = {
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
      outcome: 'approved' as const,
    };
    // Same-tick double enqueue AND a later re-note: all converge.
    const first = gm.noteProposalOutcome(note).completion;
    const second = gm.noteProposalOutcome(note).completion;
    await Promise.all([first, second]);
    await gm.noteProposalOutcome(note).completion;
    expect(
      followupsOf(storage, followupMessageIdFor(proposalId, 'approved')),
    ).toBe(1);
  });

  it('the boot sweep heals a resolution that never got its turn (the hours-later case)', async () => {
    const { storage, gm, proposals } = setup();
    const proposalId = await propose(
      gm,
      storage,
      'r-4',
      '!proposeplace quiet-dock',
    );
    await proposals.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
      resolution: 'approved',
    });
    // The eager trigger died with the process: a FRESH engine on the same
    // storage (the restart) sweeps the log and generates the turn.
    const rebooted = setup(storage);
    await rebooted.gm.sweepFollowups(WORLD);
    const messageId = followupMessageIdFor(proposalId, 'approved');
    expect(followupsOf(storage, messageId)).toBe(1);
    // A second sweep is a no-op — the natural key is already settled.
    const total = storage.eventLog.readSince(0, 100000).length;
    await rebooted.gm.sweepFollowups(WORLD);
    expect(storage.eventLog.readSince(0, 100000)).toHaveLength(total);
  });

  it('an overlapped generation loses cleanly at the fused re-check', async () => {
    const { storage, gm, proposals } = setup();
    const proposalId = await propose(
      gm,
      storage,
      'r-5',
      '!proposeplace race-court',
    );
    await proposals.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
      resolution: 'approved',
    });
    // Engine A stalls inside the mid_gm_followup window while engine B (a
    // second process on the same log) commits first — A must refuse.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stalled = setup(storage, (point): Promise<void> | undefined =>
      point === 'mid_gm_followup' ? gate : undefined,
    );
    const note = {
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
      outcome: 'approved' as const,
    };
    const slow = stalled.gm.noteProposalOutcome(note).completion;
    await gm.noteProposalOutcome(note).completion;
    release();
    await slow;
    expect(
      followupsOf(storage, followupMessageIdFor(proposalId, 'approved')),
    ).toBe(1);
  });

  it('the GM transcript fold interleaves tool calls and results in log order', async () => {
    const { storage, gm, proposals } = setup();
    const proposalId = await propose(
      gm,
      storage,
      'r-6',
      '!proposeplace fold-yard',
    );
    await proposals.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
      resolution: 'approved',
    });
    const lines = gmTranscriptOf(storage, WORLD, CONVERSATION);
    const callIndex = lines.findIndex(
      (l) =>
        l.speaker === 'Tool' && l.text.includes(`[tool call ${proposalId}]`),
    );
    const resultIndex = lines.findIndex(
      (l) =>
        l.speaker === 'Tool' && l.text.includes(`[tool result ${proposalId}]`),
    );
    expect(callIndex).toBeGreaterThan(-1);
    expect(resultIndex).toBeGreaterThan(callIndex);
    expect(lines[resultIndex]?.text).toContain('approved');
    // The user line sits before its reply's tool call — plain log order.
    expect(lines.findIndex((l) => l.speaker === 'User')).toBeLessThan(
      callIndex,
    );
  });
});

describe('the chat-about-this signal', () => {
  it('is durable, acknowledged by the GM, and leaves the card pending AND resolvable', async () => {
    const { storage, gm, proposals } = setup();
    const proposalId = await propose(
      gm,
      storage,
      'r-7',
      '!proposeplace talk-court',
    );
    const discussed = gm.discussProposal({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
    });
    expect(discussed.ok).toBe(true);
    if (discussed.ok) await discussed.value.completion;
    // The durable signal + the GM's acknowledgement turn.
    expect(
      storage.eventLog
        .readSince(0, 100000)
        .some(
          (e) =>
            e.type === 'proposal.discussed' &&
            e.payload.proposal_id === proposalId &&
            e.actor_id === OWNER,
        ),
    ).toBe(true);
    const ackId = followupMessageIdFor(proposalId, 'discuss');
    expect(followupsOf(storage, ackId)).toBe(1);
    const ack = storage.eventLog
      .readSince(0, 100000)
      .find(
        (e) =>
          e.type === 'chat.message_committed' && e.payload.message_id === ackId,
      );
    expect(
      ack?.type === 'chat.message_committed' ? ack.payload.text : '',
    ).toContain('the card can wait');
    // The card stays PENDING — and still resolves later (the owner ruling),
    // with the resolution's own follow-up riding the same machinery.
    expect(
      proposals
        .pending(WORLD)
        .some((p) => p.payload.proposal_id === proposalId),
    ).toBe(true);
    const resolved = await proposals.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
      resolution: 'approved',
    });
    expect(resolved.ok).toBe(true);
    await gm.noteProposalOutcome({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
      outcome: 'approved',
    }).completion;
    expect(
      followupsOf(storage, followupMessageIdFor(proposalId, 'approved')),
    ).toBe(1);
  });

  it('refuses a second discuss, a non-approver, and a settled card — zero rows (I8)', async () => {
    const { storage, gm, proposals } = setup();
    const proposalId = await propose(
      gm,
      storage,
      'r-8',
      '!proposeplace once-court',
    );
    const first = gm.discussProposal({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
    });
    expect(first.ok).toBe(true);
    if (first.ok) await first.value.completion;
    const before = storage.eventLog.readSince(0, 100000).length;
    const again = gm.discussProposal({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
    });
    expect(!again.ok && again.error.code === 'already_discussed').toBe(true);
    const stranger = gm.discussProposal({
      world_id: WORLD,
      actor_id: 'user:someone-else',
      proposal_id: proposalId,
    });
    expect(!stranger.ok && stranger.error.code === 'not_an_approver').toBe(
      true,
    );
    const ghost = gm.discussProposal({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: 'prop-ghost',
    });
    expect(!ghost.ok && ghost.error.code === 'unknown_proposal').toBe(true);
    expect(storage.eventLog.readSince(0, 100000)).toHaveLength(before);
    await proposals.resolve({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
      resolution: 'rejected',
    });
    const settled = gm.discussProposal({
      world_id: WORLD,
      actor_id: OWNER,
      proposal_id: proposalId,
    });
    expect(!settled.ok && settled.error.code === 'already_resolved').toBe(true);
  });
});
