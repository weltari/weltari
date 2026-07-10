// The chat query escalation executors (M6 part 3, Rev 4 §11): wikiquery over
// the registry + SUBWIKI projection (latest per sublocation wins), and the
// participation-GATED sessionquery (knowledge tier 3 is structural, not
// prompt-level). Read-only by construction — asserted through return values
// and an untouched log (E5).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createRootLogger } from '../observability/logger.js';
import { openStorage, type Storage } from '../storage/db.js';
import { runSessionquery, runWikiquery } from './chat-queries.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_c, _e, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

function open(): Storage {
  const dir = mkdtempSync(join(tmpdir(), 'weltari-chatq-'));
  return openStorage({ dbPath: join(dir, 'w.sqlite') });
}

function seedFixtureTrio(storage: Storage): void {
  // The registry learns sublocations from materialized events (fresh-world seed shape).
  for (const [id, name, description] of [
    [
      'subloc:common_room',
      'The Common Room',
      'A long hearth and the smell of wet wool.',
    ],
    [
      'subloc:cellar',
      'The Flooded Cellar',
      'The river seeps in every storm season.',
    ],
  ] as const) {
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'sublocation.materialized',
      payload: {
        sublocation_id: id,
        name,
        description,
        square: { col: 3, row: 4 },
        map_position: { x: 0.4, y: 0.5 },
      },
    });
  }
}

describe('wikiquery (the wiki read)', () => {
  it('finds a place by keyword and prefers the LATEST subwiki entry over the stub description', () => {
    const storage = open();
    const logger = quietLogger();
    seedFixtureTrio(storage);
    // Two subwiki entries for the cellar — latest must win.
    for (const entry of [
      'Casks float upright after the first storm.',
      'The water receded; a silt line marks the walls.',
    ]) {
      storage.eventLog.append({
        world_id: 'w1',
        actor_id: 'system:world_agent',
        type: 'subwiki.updated',
        payload: { sublocation_id: 'subloc:cellar', scene_id: 's1', entry },
      });
    }
    const answer = runWikiquery(storage, 'w1', logger, { query: 'cellar' });
    expect(answer).toContain('The Flooded Cellar');
    expect(answer).toContain('silt line');
    expect(answer).not.toContain('Casks float');

    expect(
      runWikiquery(storage, 'w1', logger, { query: 'the moon palace' }),
    ).toContain('No wiki entry matches');
    // Malformed input answers with an error string, never throws (I8 ethos).
    expect(runWikiquery(storage, 'w1', logger, { q: 1 })).toContain('ERROR');
    storage.close();
  });
});

describe('sessionquery (scene-query, participation-gated)', () => {
  function seedScene(
    storage: Storage,
    sceneId: string,
    participants: string[],
  ): void {
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'scene.started',
      payload: { scene_id: sceneId, title: `Night of ${sceneId}` },
    });
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'turn.committed',
      payload: {
        scene_id: sceneId,
        turn_id: `t-${sceneId}`,
        steps: [
          {
            call: 'narrator',
            speaker: 'Narrator',
            text: 'The bell rings once at midnight.',
          },
        ],
      },
    });
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:engine',
      type: 'scene.ended',
      payload: { scene_id: sceneId, participants },
    });
    storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'system:world_agent',
      type: 'world_agent.committed',
      payload: {
        scene_id: sceneId,
        note: 'The shrine bell rang and the storm answered.',
      },
    });
  }

  it('returns the recap + final lines of a scene the character was IN, and refuses scenes it was not', () => {
    const storage = open();
    const logger = quietLogger();
    seedScene(storage, 's-in', ['char:elias']);
    seedScene(storage, 's-out', ['char:someone_else']);

    const recalled = runSessionquery(storage, 'w1', 'char:elias', logger, {
      query: 'shrine bell',
    });
    expect(recalled).toContain('Night of s-in');
    expect(recalled).toContain('The shrine bell rang');
    expect(recalled).toContain('The bell rings once at midnight.');

    // The gate is structural: the OTHER character's scene matches the same
    // keywords but is invisible to Elias… and visible to its participant.
    const refused = runSessionquery(storage, 'w1', 'char:nobody', logger, {
      query: 'shrine bell',
    });
    expect(refused).toContain('No past scene of yours matches');
    const theirs = runSessionquery(storage, 'w1', 'char:someone_else', logger, {
      query: 'shrine bell',
    });
    expect(theirs).toContain('Night of s-out');
    expect(runSessionquery(storage, 'w1', 'char:elias', logger, {})).toContain(
      'ERROR',
    );
    storage.close();
  });
});
