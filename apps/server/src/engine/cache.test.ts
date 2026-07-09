// The CACHE store first slice (M6 part 2, Rev 4 §11): latest-per-origin is a
// VIEW over append-only cache.appended events — a chat recap can never shadow
// a scene experience, and each character reads only its own entries.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../storage/db.js';
import {
  CACHE_LINE_MAX,
  cacheRecapText,
  capCacheLine,
  latestPerOrigin,
} from './cache.js';

function freshStorage(): Storage {
  const dir = mkdtempSync(join(tmpdir(), 'weltari-cache-'));
  return openStorage({ dbPath: join(dir, 'w.sqlite') });
}

function appendEntry(
  storage: Storage,
  characterId: string,
  origin: 'scene' | 'chat',
  contextId: string,
  line: string,
): void {
  storage.eventLog.append({
    world_id: 'w1',
    actor_id: characterId,
    type: 'cache.appended',
    payload: {
      character_id: characterId,
      origin,
      context_id: contextId,
      line,
    },
  });
}

describe('latestPerOrigin (the cross-context catch-up view)', () => {
  it('returns the NEWEST entry per origin, never mixing characters', () => {
    const storage = freshStorage();
    appendEntry(storage, 'char:elias', 'scene', 's1', 'Old scene note.');
    appendEntry(storage, 'char:elias', 'chat', 'c1', 'Old chat note.');
    appendEntry(storage, 'char:mara', 'scene', 's1', 'Not Elias.');
    appendEntry(storage, 'char:elias', 'scene', 's2', 'Fresh scene note.');
    appendEntry(storage, 'char:elias', 'chat', 'c1', 'Fresh chat note.');

    const view = latestPerOrigin(storage, 'char:elias');
    expect(view.scene?.line).toBe('Fresh scene note.');
    expect(view.scene?.context_id).toBe('s2');
    expect(view.chat?.line).toBe('Fresh chat note.');
    storage.close();
  });

  it('an origin with no entries stays absent (a fresh character has nothing)', () => {
    const storage = freshStorage();
    appendEntry(storage, 'char:elias', 'chat', 'c1', 'Only chat so far.');
    const view = latestPerOrigin(storage, 'char:elias');
    expect(view.scene).toBeUndefined();
    expect(view.chat?.line).toBe('Only chat so far.');
    storage.close();
  });
});

describe('capCacheLine (engine-side normalization)', () => {
  it('collapses whitespace and hard-caps at the wire limit', () => {
    expect(capCacheLine('  two\n words  ')).toBe('two words');
    const long = capCacheLine('x'.repeat(CACHE_LINE_MAX + 50));
    expect(long).toBeDefined();
    expect(long?.length).toBe(CACHE_LINE_MAX);
    expect(long?.endsWith('…')).toBe(true);
  });

  it('an effectively empty line returns undefined (nothing to recap)', () => {
    expect(capCacheLine('   \n  ')).toBeUndefined();
  });
});

describe('cacheRecapText (the chat dynamic-tail block)', () => {
  it('renders both origins when present, scene first', () => {
    const text = cacheRecapText({
      scene: {
        origin: 'scene',
        context_id: 's2',
        sublocation_id: 'subloc:common_room',
        line: 'Closed up the inn after the storm.',
        ts: '2026-07-09T12:00:00.000Z',
      },
      chat: {
        origin: 'chat',
        context_id: 'c1',
        line: 'The traveler asked about the ferry.',
        ts: '2026-07-09T13:00:00.000Z',
      },
    });
    expect(text).toBe(
      'Last scene experience (at subloc:common_room): Closed up the inn after the storm.\n' +
        'Last chat note: The traveler asked about the ferry.',
    );
  });

  it('an empty view renders an empty string', () => {
    expect(cacheRecapText({})).toBe('');
  });
});
