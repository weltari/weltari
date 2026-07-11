// The manual wiki edit seam (M6 part 5, owner ruling 2026-07-11: applies
// immediately, USER actor provenance, latest-wins stays auditable).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createEventSink } from './event-sink.js';
import { Bus } from '../http/bus.js';
import { createRootLogger } from '../observability/logger.js';
import { openStorage, type Storage } from '../storage/db.js';
import { createSubwikiEditCommand } from './wiki-edit.js';
import { runWikiquery } from './chat-queries.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

describe('subwiki-edit command seam', () => {
  let storage: Storage | null = null;

  afterEach(() => {
    storage?.close();
    storage = null;
  });

  function setup(): {
    storage: Storage;
    edit: ReturnType<typeof createSubwikiEditCommand>;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-wiki-edit-'));
    storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    const sink = createEventSink(storage, new Bus(quietLogger()));
    return { storage, edit: createSubwikiEditCommand({ storage, sink }) };
  }

  it('an edit to a known sublocation lands durably with USER actor provenance', () => {
    const ctx = setup();
    const result = ctx.edit({
      world_id: 'w1',
      actor_id: 'user:owner',
      sublocation_id: 'subloc:common_room',
      entry:
        'Three rooms above the taproom; the stairs creak on the third step.',
    });
    expect(result.ok).toBe(true);
    const edited = ctx.storage.eventLog
      .readSince(0)
      .find((e) => e.type === 'subwiki.edited');
    if (edited?.type !== 'subwiki.edited') throw new Error('no edit event');
    expect(edited.actor_id).toBe('user:owner');
    expect(edited.payload.sublocation_id).toBe('subloc:common_room');
  });

  it('an unknown sublocation is refused as a value (409 shape)', () => {
    const ctx = setup();
    const result = ctx.edit({
      world_id: 'w1',
      actor_id: 'user:owner',
      sublocation_id: 'subloc:ghost',
      entry: 'Nothing here.',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown_sublocation');
    expect(
      ctx.storage.eventLog
        .readSince(0)
        .filter((e) => e.type === 'subwiki.edited'),
    ).toHaveLength(0);
  });

  it('latest-wins is auditable, never silent: an edit shadows the World Agent entry in every read, both stay in the log', () => {
    const ctx = setup();
    const logger = quietLogger();
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:world_agent',
      type: 'subwiki.updated',
      payload: {
        sublocation_id: 'subloc:common_room',
        scene_id: 's1',
        entry: 'A low-beamed common room; the fire is out.',
      },
    });
    ctx.edit({
      world_id: 'w1',
      actor_id: 'user:owner',
      sublocation_id: 'subloc:common_room',
      entry: 'A low-beamed common room; the famous kettle hangs by the fire.',
    });
    // The wiki read (wikiquery is the server-side read path) sees the edit.
    const answer = runWikiquery(ctx.storage, 'w1', logger, {
      query: 'common room',
    });
    expect(answer).toContain('famous kettle');
    expect(answer).not.toContain('the fire is out');
    // A LATER World Agent pass supersedes it — latest-wins — but both
    // writes remain in the append-only log with their authors (criterion d).
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:world_agent',
      type: 'subwiki.updated',
      payload: {
        sublocation_id: 'subloc:common_room',
        scene_id: 's2',
        entry: 'The common room again, rearranged after the storm.',
      },
    });
    const after = runWikiquery(ctx.storage, 'w1', logger, {
      query: 'common room',
    });
    expect(after).toContain('rearranged after the storm');
    const trail = ctx.storage.eventLog
      .readSince(0)
      .filter(
        (e) => e.type === 'subwiki.updated' || e.type === 'subwiki.edited',
      );
    expect(trail).toHaveLength(3);
    expect(trail.map((e) => e.actor_id)).toEqual([
      'system:world_agent',
      'user:owner',
      'system:world_agent',
    ]);
  });
});
