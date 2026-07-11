// The character memory fold (M7 part 1, Rev 4 §11): projections of the log —
// seed + latest core snapshot, evolved personality/goals, the compaction-
// preferring archive view. Outcomes through public seams only.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../storage/db.js';
import { buildEliasProfile } from './fixture/rainy-inn.js';
import { archiveView, liveProfile, memoryStateOf } from './memory.js';

function tempStorage(): Storage {
  return openStorage({
    dbPath: join(mkdtempSync(join(tmpdir(), 'weltari-mem-')), 'w.sqlite'),
  });
}

function appendDelta(storage: Storage, content: string): number {
  return storage.eventLog.append({
    world_id: 'w1',
    actor_id: 'char:elias',
    type: 'memory.delta_committed',
    payload: {
      character_id: 'char:elias',
      origin: 'scene',
      context_id: 's1',
      content,
    },
  }).id;
}

describe('memory fold (Rev 4 §11)', () => {
  it('a fresh character has seed-only memory: liveProfile returns the profile unchanged', () => {
    const storage = tempStorage();
    const seed = buildEliasProfile(200);
    const live = liveProfile(storage, seed);
    expect(live.memory_core).toEqual(seed.memory_core);
    expect(live.personality).toBe(seed.personality);
    expect(live.goals).toEqual(seed.goals);
    storage.close();
  });

  it('the latest core snapshot lays on top of the seed; a later snapshot fully supersedes', () => {
    const storage = tempStorage();
    const seed = buildEliasProfile(200);
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:elias',
      type: 'memory.core_updated',
      payload: {
        character_id: 'char:elias',
        core: ['First durable fact.'],
        origin: 'scene',
        context_id: 's1',
      },
    });
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:elias',
      type: 'memory.core_updated',
      payload: {
        character_id: 'char:elias',
        core: ['Second snapshot, alone.'],
        origin: 'chat',
        context_id: 'c1',
      },
    });
    const live = liveProfile(storage, seed);
    expect(live.memory_core).toEqual([
      ...seed.memory_core,
      'Second snapshot, alone.',
    ]);
    expect(live.memory_core).not.toContain('First durable fact.');
    storage.close();
  });

  it('evolution replaces personality/goals latest-wins, per field independently', () => {
    const storage = tempStorage();
    const seed = buildEliasProfile(200);
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:elias',
      type: 'character.evolved',
      payload: {
        character_id: 'char:elias',
        personality: 'Warmer now, but still counts things.',
        origin: 'scene',
        context_id: 's1',
      },
    });
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:elias',
      type: 'character.evolved',
      payload: {
        character_id: 'char:elias',
        goals: ['Find who silences the bell — tonight.'],
        origin: 'chat',
        context_id: 'c1',
      },
    });
    const live = liveProfile(storage, seed);
    // The goals-only evolution did NOT reset the earlier personality change.
    expect(live.personality).toBe('Warmer now, but still counts things.');
    expect(live.goals).toEqual(['Find who silences the bell — tonight.']);
    storage.close();
  });

  it('memory events of another character never touch this profile', () => {
    const storage = tempStorage();
    const seed = buildEliasProfile(200);
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:mara',
      type: 'memory.core_updated',
      payload: {
        character_id: 'char:mara',
        core: ['Mara-only fact.'],
        origin: 'chat',
        context_id: 'c9',
      },
    });
    expect(liveProfile(storage, seed).memory_core).toEqual(seed.memory_core);
    storage.close();
  });

  it('archiveView prefers the latest compaction and lays newer deltas on top', () => {
    const storage = tempStorage();
    const a = appendDelta(storage, 'Old note one.');
    const b = appendDelta(storage, 'Old note two.');
    const c = appendDelta(storage, 'Fresh note after the pass.');
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:elias',
      type: 'memory.compacted',
      payload: {
        character_id: 'char:elias',
        up_to_id: b,
        delta_count: 2,
        summary: 'Two old notes, summarized.',
      },
    });
    const view = archiveView(storage, 'char:elias');
    expect(view.summary).toBe('Two old notes, summarized.');
    expect(view.deltas.map((d) => d.event_id)).toEqual([c]);
    expect(view.deltas.map((d) => d.event_id)).not.toContain(a);
    storage.close();
  });

  it('a re-run compaction for the same range supersedes the old record (repair for free)', () => {
    const storage = tempStorage();
    const a = appendDelta(storage, 'Only note.');
    for (const summary of ['A bad first pass.', 'The repaired pass.']) {
      storage.eventLog.append({
        world_id: 'w1',
        actor_id: 'char:elias',
        type: 'memory.compacted',
        payload: {
          character_id: 'char:elias',
          up_to_id: a,
          delta_count: 1,
          summary,
        },
      });
    }
    expect(archiveView(storage, 'char:elias').summary).toBe(
      'The repaired pass.',
    );
    // Deltas stay in the log regardless — the raw material is never lost.
    expect(memoryStateOf(storage, 'char:elias').deltas).toHaveLength(1);
    storage.close();
  });
});
