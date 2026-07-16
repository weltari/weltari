// The objects repository (M7 part 3, Rev 4 §7): the objects table as a
// projection of the object.* events — fed by the append in-transaction,
// rebuilt at boot. Outcome tests through the public repository seam only
// (Guide test rule 5). V1 holders are sublocations only (owner ruling
// 2026-07-16: backpacks are V2).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../db.js';
import { objectNameKey } from './objects.js';

function tempStorage(): { storage: Storage; dbPath: string } {
  const dbPath = join(
    mkdtempSync(join(tmpdir(), 'weltari-objects-')),
    'w.sqlite',
  );
  return { storage: openStorage({ dbPath }), dbPath };
}

function createObject(
  storage: Storage,
  objectId: string,
  name: string,
  holder: string,
  extras: { payload?: string; sceneId?: string; proposalId?: string } = {},
): void {
  storage.eventLog.append({
    world_id: 'w1',
    actor_id: 'char:elias',
    type: 'object.created',
    payload: {
      object_id: objectId,
      name,
      holder_sublocation_id: holder,
      ...(extras.payload === undefined
        ? {}
        : { object_payload: extras.payload }),
      ...(extras.proposalId === undefined
        ? { scene_id: extras.sceneId ?? 's1' }
        : { proposal_id: extras.proposalId }),
    },
  });
}

describe('objects repository (projection of object.* events)', () => {
  it('folds created / payload_written / moved / swept into the row, bumping version', () => {
    const { storage } = tempStorage();
    createObject(storage, 'obj:key', 'a brass key', 'subloc:tide-bell');
    let row = storage.objects.byId('obj:key');
    expect(row?.name).toBe('a brass key');
    expect(row?.holder_sublocation_id).toBe('subloc:tide-bell');
    expect(row?.payload).toBeUndefined();
    expect(row?.version).toBe(1);

    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:elias',
      type: 'object.payload_written',
      payload: {
        object_id: 'obj:key',
        object_payload: 'A worn brass key, teeth filed flat.',
        scene_id: 's2',
      },
    });
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:elias',
      type: 'object.moved',
      payload: {
        object_id: 'obj:key',
        from_sublocation_id: 'subloc:tide-bell',
        to_sublocation_id: 'subloc:long-pier',
        scene_id: 's2',
      },
    });
    row = storage.objects.byId('obj:key');
    expect(row?.payload).toContain('teeth filed flat');
    expect(row?.holder_sublocation_id).toBe('subloc:long-pier');
    expect(row?.last_touched_scene_id).toBe('s2');
    expect(row?.version).toBe(3);

    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:object-gc',
      type: 'object.swept',
      payload: { object_id: 'obj:key' },
    });
    expect(storage.objects.byId('obj:key')).toBeUndefined();
    storage.close();
  });

  it('heldAt lists a sublocation holdings in creation order — the explore listing', () => {
    const { storage } = tempStorage();
    createObject(storage, 'obj:net', 'a torn net', 'subloc:long-pier');
    createObject(storage, 'obj:crate', 'a sealed crate', 'subloc:long-pier');
    createObject(storage, 'obj:bell', 'the tide bell', 'subloc:tide-bell');
    expect(
      storage.objects.heldAt('w1', 'subloc:long-pier').map((r) => r.object_id),
    ).toEqual(['obj:net', 'obj:crate']);
    expect(storage.objects.heldAt('w1', 'subloc:nowhere')).toEqual([]);
    storage.close();
  });

  it('resolveName matches across reachable holders only, normalized (case/spacing)', () => {
    const { storage } = tempStorage();
    createObject(storage, 'obj:key-a', 'a brass key', 'subloc:tide-bell');
    createObject(storage, 'obj:key-b', 'A  Brass Key', 'subloc:long-pier');
    createObject(storage, 'obj:key-c', 'a brass key', 'subloc:far-away');
    // Ambiguous within reach: both matches return (IDs never duplicate).
    expect(
      storage.objects
        .resolveName('w1', ' a brass  KEY ', [
          'subloc:tide-bell',
          'subloc:long-pier',
        ])
        .map((r) => r.object_id),
    ).toEqual(['obj:key-a', 'obj:key-b']);
    // Out of reach = no match, even though the row exists.
    expect(
      storage.objects.resolveName('w1', 'a brass key', ['subloc:cottage']),
    ).toEqual([]);
    storage.close();
  });

  it('enforces (name, holder) dedup structurally — same key at one holder is corruption', () => {
    const { storage } = tempStorage();
    createObject(storage, 'obj:key-a', 'a brass key', 'subloc:tide-bell');
    expect(() => {
      createObject(storage, 'obj:key-dup', 'A BRASS KEY', 'subloc:tide-bell');
    }).toThrow();
    // Same normalized name at a DIFFERENT holder is fine.
    createObject(storage, 'obj:key-b', 'a brass key', 'subloc:long-pier');
    expect(objectNameKey(' A  Brass KEY ')).toBe('a brass key');
    storage.close();
  });

  it('strayCandidates = payload-less, scene-created, never touched outside the creating scene', () => {
    const { storage } = tempStorage();
    // Candidate: empty carrier, touched only in its creating scene.
    createObject(storage, 'obj:stick', 'a dropped stick', 'subloc:long-pier', {
      sceneId: 's1',
    });
    // Exempt: payload carrier.
    createObject(storage, 'obj:letter', 'a sealed letter', 'subloc:long-pier', {
      payload: 'Meet me under the pier. — P',
      sceneId: 's1',
    });
    // Exempt: proposal-applied (no creating scene).
    createObject(storage, 'obj:lamp', 'a storm lamp', 'subloc:long-pier', {
      proposalId: 'p-1',
    });
    // Exempt: touched again in a later scene.
    createObject(storage, 'obj:rope', 'a coil of rope', 'subloc:long-pier', {
      sceneId: 's1',
    });
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:elias',
      type: 'object.moved',
      payload: {
        object_id: 'obj:rope',
        from_sublocation_id: 'subloc:long-pier',
        to_sublocation_id: 'subloc:tide-bell',
        scene_id: 's2',
      },
    });
    expect(
      storage.objects.strayCandidates('w1').map((r) => r.object_id),
    ).toEqual(['obj:stick']);
    storage.close();
  });

  it('rebuild re-projects the identical table from the log at boot (kill-safety)', () => {
    const { storage, dbPath } = tempStorage();
    createObject(storage, 'obj:key', 'a brass key', 'subloc:tide-bell');
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:elias',
      type: 'object.payload_written',
      payload: {
        object_id: 'obj:key',
        object_payload: 'A worn brass key.',
        scene_id: 's1',
      },
    });
    createObject(storage, 'obj:stick', 'a dropped stick', 'subloc:long-pier');
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:object-gc',
      type: 'object.swept',
      payload: { object_id: 'obj:stick' },
    });
    const before = storage.objects.heldAt('w1', 'subloc:tide-bell');
    storage.close();

    const reopened = openStorage({ dbPath });
    expect(reopened.objects.heldAt('w1', 'subloc:tide-bell')).toEqual(before);
    expect(reopened.objects.byId('obj:stick')).toBeUndefined();
    reopened.close();
  });

  it('an object event naming a missing row is corruption, not input (C2)', () => {
    const { storage } = tempStorage();
    expect(() =>
      storage.eventLog.append({
        world_id: 'w1',
        actor_id: 'char:elias',
        type: 'object.payload_written',
        payload: {
          object_id: 'obj:ghost',
          object_payload: 'x',
          scene_id: 's1',
        },
      }),
    ).toThrow(/no such row/);
    storage.close();
  });
});
