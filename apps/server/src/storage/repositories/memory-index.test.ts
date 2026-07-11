// The Search Index repository (M7 part 1, Rev 4 §4.2): FTS5 over memory
// deltas as a projection of the log. Outcome tests through the public
// repository seam only (Guide test rule 5).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../db.js';

function tempStorage(): { storage: Storage; dbPath: string } {
  const dbPath = join(
    mkdtempSync(join(tmpdir(), 'weltari-memidx-')),
    'w.sqlite',
  );
  return { storage: openStorage({ dbPath }), dbPath };
}

function appendDelta(
  storage: Storage,
  characterId: string,
  content: string,
): number {
  return storage.eventLog.append({
    world_id: 'w1',
    actor_id: characterId,
    type: 'memory.delta_committed',
    payload: {
      character_id: characterId,
      origin: 'scene',
      context_id: 's1',
      content,
    },
  }).id;
}

describe('memory index (FTS5 Search Index)', () => {
  it('indexes a delta at append and finds it by keyword, best match first', () => {
    const { storage } = tempStorage();
    appendDelta(
      storage,
      'char:elias',
      'The traveler lied about the ferry schedule — a small lie, but a pattern.',
    );
    const wanted = appendDelta(
      storage,
      'char:elias',
      'The shrine bell stayed silent past midnight again; someone is stopping it.',
    );
    const hits = storage.memoryIndex.search(
      'char:elias',
      'shrine bell midnight',
      3,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.event_id).toBe(wanted);
    expect(hits[0]?.content).toContain('shrine bell');
    storage.close();
  });

  it('is participation-gated by construction: a character never sees another character deltas', () => {
    const { storage } = tempStorage();
    appendDelta(
      storage,
      'char:elias',
      'The shrine bell stayed silent past midnight again.',
    );
    expect(storage.memoryIndex.search('char:mara', 'shrine bell', 3)).toEqual(
      [],
    );
    storage.close();
  });

  it('survives FTS5-hostile query syntax without throwing (LLM-written queries are data)', () => {
    const { storage } = tempStorage();
    appendDelta(
      storage,
      'char:elias',
      'A note about the north road milestone.',
    );
    for (const hostile of [
      'north-road "milestone',
      'char:elias AND (everything',
      'NEAR(x y)',
      '***',
      '',
    ]) {
      expect(() =>
        storage.memoryIndex.search('char:elias', hostile, 3),
      ).not.toThrow();
    }
    // Tokens inside hostile syntax still match content words.
    const hits = storage.memoryIndex.search(
      'char:elias',
      'north-road "milestone',
      3,
    );
    expect(hits.length).toBeGreaterThan(0);
    storage.close();
  });

  it('re-projects from the log: reopen rebuilds the identical index (boot discipline)', () => {
    const { storage, dbPath } = tempStorage();
    const id = appendDelta(
      storage,
      'char:elias',
      'Marta ledger shows the unpaid tab doubled during storm season.',
    );
    storage.close();
    const reopened = openStorage({ dbPath });
    const hits = reopened.memoryIndex.search(
      'char:elias',
      'unpaid tab ledger',
      3,
    );
    expect(hits.map((h) => h.event_id)).toContain(id);
    reopened.close();
  });

  it('non-delta events are never indexed', () => {
    const { storage } = tempStorage();
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'char:elias',
      type: 'cache.appended',
      payload: {
        character_id: 'char:elias',
        origin: 'chat',
        context_id: 'c1',
        line: 'Talked about the haunted lighthouse.',
      },
    });
    expect(
      storage.memoryIndex.search('char:elias', 'haunted lighthouse', 3),
    ).toEqual([]);
    storage.close();
  });
});
