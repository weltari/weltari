// The acquaintance fold (M6 part 5, Rev 4 §12; owner ruling 2026-07-11:
// shared scene session OR shared group chat = having met) — a pure fold,
// asserted through the public seam (E5).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../storage/db.js';
import {
  acquaintancesOf,
  pickReactionCandidates,
  SOCIAL_POST_SKIP_CAP,
} from './social.js';

function open(): Storage {
  const dir = mkdtempSync(join(tmpdir(), 'weltari-social-'));
  return openStorage({ dbPath: join(dir, 'w.sqlite') });
}

function joinScene(
  storage: Storage,
  worldId: string,
  sceneId: string,
  characterId: string,
): void {
  storage.eventLog.append({
    world_id: worldId,
    actor_id: 'system:scene',
    type: 'character.joined',
    payload: {
      scene_id: sceneId,
      character_id: characterId,
      name: characterId.replace('char:', ''),
    },
  });
}

function startGroup(
  storage: Storage,
  worldId: string,
  conversationId: string,
  memberIds: string[],
): void {
  storage.eventLog.append({
    world_id: worldId,
    actor_id: 'user:owner',
    type: 'chat.group_started',
    payload: {
      conversation_id: conversationId,
      member_ids: memberIds,
      title: 'The riverside crowd',
    },
  });
}

describe('acquaintancesOf (the delivery rule fold)', () => {
  it('characters who shared a scene are mutually acquainted; strangers are not', () => {
    const storage = open();
    joinScene(storage, 'w1', 's1', 'char:elias');
    joinScene(storage, 'w1', 's1', 'char:mara');
    joinScene(storage, 'w1', 's2', 'char:hermit');
    expect(acquaintancesOf(storage, 'w1', 'char:elias')).toEqual(['char:mara']);
    expect(acquaintancesOf(storage, 'w1', 'char:mara')).toEqual(['char:elias']);
    expect(acquaintancesOf(storage, 'w1', 'char:hermit')).toEqual([]);
    storage.close();
  });

  it('a shared group chat counts as having met (owner ruling 2026-07-11)', () => {
    const storage = open();
    startGroup(storage, 'w1', 'g1', ['char:elias', 'char:mara']);
    expect(acquaintancesOf(storage, 'w1', 'char:elias')).toEqual(['char:mara']);
    expect(acquaintancesOf(storage, 'w1', 'char:mara')).toEqual(['char:elias']);
    storage.close();
  });

  it('scene and group sources union; the result is sorted and never contains self', () => {
    const storage = open();
    joinScene(storage, 'w1', 's1', 'char:elias');
    joinScene(storage, 'w1', 's1', 'char:zed');
    startGroup(storage, 'w1', 'g1', ['char:elias', 'char:aria']);
    expect(acquaintancesOf(storage, 'w1', 'char:elias')).toEqual([
      'char:aria',
      'char:zed',
    ]);
    storage.close();
  });

  it('is world-scoped: co-presence in another world never acquaints here', () => {
    const storage = open();
    joinScene(storage, 'w2', 's1', 'char:elias');
    joinScene(storage, 'w2', 's1', 'char:mara');
    expect(acquaintancesOf(storage, 'w1', 'char:elias')).toEqual([]);
    storage.close();
  });
});

describe('SOCIAL_POST_SKIP_CAP', () => {
  it('is the Rev 4 §12 ceiling of 10 posts per skip', () => {
    expect(SOCIAL_POST_SKIP_CAP).toBe(10);
  });
});

describe('pickReactionCandidates (the deterministic cap pick)', () => {
  const recipients = ['char:a', 'char:b', 'char:c', 'char:d', 'char:e'];

  it('is deterministic per salt, capped, and a subset of the recipients', () => {
    const first = pickReactionCandidates(recipients, 3, 'occ-1');
    expect(first).toHaveLength(3);
    expect(pickReactionCandidates(recipients, 3, 'occ-1')).toEqual(first);
    for (const id of first) expect(recipients).toContain(id);
  });

  it('different salts rotate through different subsets (no fixed favorites)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      for (const id of pickReactionCandidates(
        recipients,
        2,
        `occ-${String(i)}`,
      )) {
        seen.add(id);
      }
    }
    expect(seen.size).toBe(recipients.length);
  });

  it('cap 0 picks nobody; a cap past the pool returns everyone', () => {
    expect(pickReactionCandidates(recipients, 0, 's')).toEqual([]);
    expect(pickReactionCandidates(recipients, 99, 's')).toHaveLength(
      recipients.length,
    );
  });
});
