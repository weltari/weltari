// Invariant I5 over the M7 memory fold (Rev 4 §11): the stable prefix built
// from liveProfile() is byte-stable for a given log state — it changes ONLY
// when a reflection-class job commits a memory event (between calls, never
// within one), and only for the character the event belongs to.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assembleContext,
  type SceneContext,
} from '../../../apps/server/src/engine/context-assembler.js';
import { buildEliasProfile } from '../../../apps/server/src/engine/fixture/rainy-inn.js';
import { liveProfile } from '../../../apps/server/src/engine/memory.js';
import {
  openStorage,
  type Storage,
} from '../../../apps/server/src/storage/db.js';

function tempStorage(): Storage {
  return openStorage({
    dbPath: join(mkdtempSync(join(tmpdir(), 'weltari-i5mem-')), 'w.sqlite'),
  });
}

const scene: SceneContext = {
  scene_id: 's1',
  world_clock_text: 'Day 3, early evening, heavy rain',
  latest_turns: [],
  wiki: [],
};

describe('live-profile prefix stability (I5, M7 part 1)', () => {
  it('same log state twice ⇒ byte-identical prefix', () => {
    const storage = tempStorage();
    const seed = buildEliasProfile(400);
    const a = assembleContext(liveProfile(storage, seed), scene);
    const b = assembleContext(liveProfile(storage, seed), scene);
    expect(
      Buffer.compare(
        Buffer.from(a.stablePrefix, 'utf8'),
        Buffer.from(b.stablePrefix, 'utf8'),
      ),
    ).toBe(0);
    storage.close();
  });

  it('a core update changes the prefix exactly between calls and injects the new line after the seed', () => {
    const storage = tempStorage();
    const seed = buildEliasProfile(400);
    const before = assembleContext(liveProfile(storage, seed), scene);
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:elias',
      type: 'memory.core_updated',
      payload: {
        character_id: 'char:elias',
        core: ['The shrine bell is silenced by a person, not the weather.'],
        origin: 'scene',
        context_id: 's1',
      },
    });
    const after = assembleContext(liveProfile(storage, seed), scene);
    expect(after.stablePrefix).not.toBe(before.stablePrefix);
    expect(after.stablePrefix).toContain(
      'The shrine bell is silenced by a person, not the weather.',
    );
    // Seed lines survive verbatim, ahead of the durable snapshot.
    const firstSeedLine = seed.memory_core[0] ?? '';
    expect(after.stablePrefix.indexOf(firstSeedLine)).toBeLessThan(
      after.stablePrefix.indexOf('silenced by a person'),
    );
    // And the new state is itself byte-stable across repeated calls.
    const again = assembleContext(liveProfile(storage, seed), scene);
    expect(again.stablePrefix).toBe(after.stablePrefix);
    storage.close();
  });

  it("another character's memory events leave this prefix untouched", () => {
    const storage = tempStorage();
    const seed = buildEliasProfile(400);
    const before = assembleContext(liveProfile(storage, seed), scene);
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:mara',
      type: 'memory.core_updated',
      payload: {
        character_id: 'char:mara',
        core: ['Mara-only durable fact.'],
        origin: 'chat',
        context_id: 'c1',
      },
    });
    const after = assembleContext(liveProfile(storage, seed), scene);
    expect(after.stablePrefix).toBe(before.stablePrefix);
    storage.close();
  });

  it('evolution swaps personality/goals in the prefix deterministically', () => {
    const storage = tempStorage();
    const seed = buildEliasProfile(400);
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:elias',
      type: 'character.evolved',
      payload: {
        character_id: 'char:elias',
        personality: 'Warmer now, but still counts things.',
        goals: ['Find who silences the bell — tonight.'],
        origin: 'scene',
        context_id: 's1',
      },
    });
    const out = assembleContext(liveProfile(storage, seed), scene);
    expect(out.stablePrefix).toContain('Warmer now, but still counts things.');
    expect(out.stablePrefix).toContain('Find who silences the bell — tonight.');
    expect(out.stablePrefix).not.toContain(seed.personality);
    storage.close();
  });
});
