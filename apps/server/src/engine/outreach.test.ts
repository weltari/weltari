// Proactive-DM projections (M6 part 3, Rev 4 §8): the unanswered counter,
// the freeze cap, the growing backoff, and the deterministic pick — all pure
// folds/math, asserted through public seams (E5).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../storage/db.js';
import {
  OUTREACH_FREEZE_CAP,
  outreachEligible,
  outreachState,
  pickIndex,
} from './outreach.js';

const CONVERSATION = 'chat:user:owner:char:elias';

function open(): Storage {
  const dir = mkdtempSync(join(tmpdir(), 'weltari-outreach-'));
  return openStorage({ dbPath: join(dir, 'w.sqlite') });
}

function appendMessage(storage: Storage, sender: 'user' | 'character'): void {
  storage.eventLog.append({
    world_id: 'w1',
    actor_id: sender === 'user' ? 'user:owner' : 'char:elias',
    type: 'chat.message_committed',
    payload: {
      conversation_id: CONVERSATION,
      character_id: 'char:elias',
      sender,
      text: sender === 'user' ? 'Hello?' : 'Storm broke another shutter.',
      message_id: `m-${String(storage.eventLog.lastId() + 1)}`,
    },
  });
}

function appendOutreach(storage: Storage, occurrenceIso: string): void {
  appendMessage(storage, 'character');
  storage.eventLog.append({
    world_id: 'w1',
    actor_id: 'char:elias',
    type: 'chat.outreach_recorded',
    payload: {
      conversation_id: CONVERSATION,
      character_id: 'char:elias',
      occurrence_iso: occurrenceIso,
      game_time: '2000-01-01T06:00:00.000Z',
      message_id: `m-${String(storage.eventLog.lastId())}`,
      unanswered_count: 1, // the projection recomputes; the field is a record
    },
  });
}

function endRange(storage: Storage): void {
  storage.eventLog.append({
    world_id: 'w1',
    actor_id: 'system:chat',
    type: 'chat.ended',
    payload: {
      conversation_id: CONVERSATION,
      character_id: 'char:elias',
      reason: 'idle',
      range_end_id: storage.eventLog.lastId(),
    },
  });
}

describe('outreachState (the unanswered projection)', () => {
  it('counts outreaches after the last user line; a reply resets to zero', () => {
    const storage = open();
    expect(outreachState(storage, CONVERSATION).unanswered).toBe(0);
    appendOutreach(storage, '2026-07-10T10:00:00.000Z');
    appendOutreach(storage, '2026-07-10T12:00:00.000Z');
    const before = outreachState(storage, CONVERSATION);
    expect(before.unanswered).toBe(2);
    expect(before.lastOccurrenceIso).toBe('2026-07-10T12:00:00.000Z');
    expect(before.frozen).toBe(false);

    appendMessage(storage, 'user'); // the reply — resets by construction
    const after = outreachState(storage, CONVERSATION);
    expect(after.unanswered).toBe(0);
    expect(after.frozen).toBe(false);
    storage.close();
  });

  it(`freezes at ${String(OUTREACH_FREEZE_CAP)} unanswered and thaws on a user line`, () => {
    const storage = open();
    appendOutreach(storage, '2026-07-10T10:00:00.000Z');
    appendOutreach(storage, '2026-07-10T12:00:00.000Z');
    appendOutreach(storage, '2026-07-10T16:00:00.000Z');
    expect(outreachState(storage, CONVERSATION).frozen).toBe(true);
    appendMessage(storage, 'user');
    expect(outreachState(storage, CONVERSATION).frozen).toBe(false);
    storage.close();
  });
});

describe('outreachEligible (quiet rule + growing backoff)', () => {
  it('an answered thread is eligible only when QUIET (no open range)', () => {
    const storage = open();
    // Fresh thread: quiet, eligible.
    expect(
      outreachEligible(
        outreachState(storage, CONVERSATION),
        '2026-07-10T10:00:00.000Z',
        60,
      ),
    ).toBe(true);
    // An open conversation: not eligible (don't barge in).
    appendMessage(storage, 'user');
    expect(
      outreachEligible(
        outreachState(storage, CONVERSATION),
        '2026-07-10T10:00:00.000Z',
        60,
      ),
    ).toBe(false);
    // The idle sweep closed it: quiet again.
    endRange(storage);
    expect(
      outreachEligible(
        outreachState(storage, CONVERSATION),
        '2026-07-10T10:00:00.000Z',
        60,
      ),
    ).toBe(true);
    storage.close();
  });

  it('re-asks wait base × 2^n after the previous outreach (×2, then ×4)', () => {
    const storage = open();
    appendOutreach(storage, '2026-07-10T10:00:00.000Z'); // n=1 → next waits 2×60m
    const state1 = outreachState(storage, CONVERSATION);
    expect(outreachEligible(state1, '2026-07-10T11:00:00.000Z', 60)).toBe(
      false,
    );
    expect(outreachEligible(state1, '2026-07-10T12:00:00.000Z', 60)).toBe(true);

    appendOutreach(storage, '2026-07-10T12:00:00.000Z'); // n=2 → next waits 4×60m
    const state2 = outreachState(storage, CONVERSATION);
    expect(outreachEligible(state2, '2026-07-10T14:00:00.000Z', 60)).toBe(
      false,
    );
    expect(outreachEligible(state2, '2026-07-10T16:00:00.000Z', 60)).toBe(true);

    appendOutreach(storage, '2026-07-10T16:00:00.000Z'); // n=3 → frozen for good
    const state3 = outreachState(storage, CONVERSATION);
    expect(outreachEligible(state3, '2099-01-01T00:00:00.000Z', 60)).toBe(
      false,
    );
    storage.close();
  });
});

describe('pickIndex (deterministic "random in V1")', () => {
  it('same seed → same pick; stays inside bounds', () => {
    const seed = '2026-07-10T10:00:00.000Z';
    const first = pickIndex(seed, 5);
    expect(pickIndex(seed, 5)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(5);
    expect(pickIndex(seed, 1)).toBe(0);
  });
});
