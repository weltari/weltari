// Invitation expiry (M6 part 4, Rev 4 §7, owner rulings 2026-07-10/11).
// Everything asserts through public seams — events, folds — never internals.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Bus, type EventBus } from '../http/bus.js';
import { createRootLogger } from '../observability/logger.js';
import { openStorage, type Storage } from '../storage/db.js';
import { latestPerOrigin } from './cache.js';
import { presenceOf } from './chat.js';
import {
  createInvitationExpiry,
  pendingInvitations,
  pendingInvitationWorlds,
} from './invitation.js';
import { createSceneLifecycle } from './scene-lifecycle.js';
import { WORLD_EPOCH } from './world-clock.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sinkStream = new Writable({
    write(_c, _e, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sinkStream });
}

interface Ctx {
  storage: Storage;
  eventBus: EventBus;
  expiry: ReturnType<typeof createInvitationExpiry>;
  openInvitation: (sceneId: string, waitHours: number) => void;
  /** Move the fictional clock forward by appending world.time_advanced —
   * the ONLY way it moves (owner ruling 2026-07-10). */
  advanceTo: (to: string) => void;
}

const ELIAS = { character_id: 'char:elias', name: 'Elias' };

function setup(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'weltari-invite-'));
  const logger = quietLogger();
  const storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
  const eventBus: EventBus = new Bus(logger);
  const lifecycle = createSceneLifecycle({
    storage,
    eventBus,
    logger,
    knownCharacters: [ELIAS],
  });
  const expiry = createInvitationExpiry({ storage, eventBus, logger });
  return {
    storage,
    eventBus,
    expiry,
    openInvitation: (sceneId, waitHours): void => {
      const opened = lifecycle.openScene({
        world_id: 'w1',
        actor_id: 'user:owner',
        scene_id: sceneId,
        title: 'Meeting: the shrine',
        participants: [ELIAS.character_id],
        place_request: 'the shrine',
        invitation: {
          character_id: ELIAS.character_id,
          place: 'the shrine',
          wait_hours: waitHours,
        },
      });
      expect(opened.ok).toBe(true);
    },
    advanceTo: (to): void => {
      storage.eventLog.append({
        world_id: 'w1',
        actor_id: 'user:owner',
        type: 'world.time_advanced',
        payload: {
          from: WORLD_EPOCH,
          to,
          code_enqueued: 0,
          llm_enqueued: 0,
          llm_skipped: 0,
        },
      });
    },
  };
}

describe('invitation expiry (criterion a: the stood-up meeting)', () => {
  it('a pending invitation survives real time and expires only when the clock passes its window', async () => {
    const ctx = setup();
    ctx.openInvitation('s-invite-1', 6); // epoch 06:00 + 6h → 12:00

    // The world is paused: no matter how much real time passes, nothing is
    // due — the character has fictionally waited no time at all.
    expect(await ctx.expiry.expireDue('w1')).toBe(0);
    expect(pendingInvitations(ctx.storage, 'w1')).toHaveLength(1);
    expect(presenceOf(ctx.storage, 'w1', ELIAS.character_id).state).toBe(
      'in_scene',
    );

    // The user's own play moves the clock past the deadline → expiry.
    ctx.advanceTo('2000-01-02T06:00:00.000Z');
    expect(await ctx.expiry.expireDue('w1')).toBe(1);

    const events = ctx.storage.eventLog.readSince(0);
    const expired = events.find((e) => e.type === 'scene.expired');
    expect(expired).toBeDefined();
    if (expired?.type === 'scene.expired') {
      expect(expired.payload.scene_id).toBe('s-invite-1');
      expect(expired.payload.character_id).toBe(ELIAS.character_id);
      expect(expired.payload.expires_at_game).toBe(
        '2000-01-01T12:00:00.000Z',
      );
      expect(expired.payload.game_time).toBe('2000-01-02T06:00:00.000Z');
    }
    // The release half: presence is available again — DMs unfreeze.
    expect(presenceOf(ctx.storage, 'w1', ELIAS.character_id).state).toBe(
      'available',
    );
    // The complaint half: the hardcoded absence entry is the character's
    // latest scene-origin CACHE line — the next chat recap injects it.
    const view = latestPerOrigin(ctx.storage, ELIAS.character_id);
    expect(view.scene?.line).toContain('the User never came');
    expect(view.scene?.line).toContain('the shrine');
    expect(view.scene?.line).toContain('day 2000-01-02');
    ctx.storage.close();
  });

  it('the pair is atomic and single: a second sweep and a replayed sweep commit nothing (natural key)', async () => {
    const ctx = setup();
    ctx.openInvitation('s-invite-2', 2);
    ctx.advanceTo('2000-01-01T09:00:00.000Z');

    expect(await ctx.expiry.expireDue('w1')).toBe(1);
    expect(await ctx.expiry.expireDue('w1')).toBe(0); // idempotent re-run

    const events = ctx.storage.eventLog.readSince(0);
    expect(events.filter((e) => e.type === 'scene.expired')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'cache.appended')).toHaveLength(1);
    // The pair rides one transaction: the absence entry directly follows.
    const expiredAt = events.findIndex((e) => e.type === 'scene.expired');
    expect(events[expiredAt + 1]?.type).toBe('cache.appended');
    ctx.storage.close();
  });

  it('an entered scene never expires: one committed turn makes the meeting real', async () => {
    const ctx = setup();
    ctx.openInvitation('s-invite-3', 2);
    // The user showed up: the scene's first turn committed.
    ctx.storage.eventLog.append({
      world_id: 'w1',
      actor_id: 'user:owner',
      type: 'turn.committed',
      payload: {
        scene_id: 's-invite-3',
        turn_id: 't-1',
        steps: [{ call: 'narrator', speaker: 'Narrator', text: 'You arrive.' }],
      },
    });
    ctx.advanceTo('2000-01-03T06:00:00.000Z');

    expect(pendingInvitations(ctx.storage, 'w1')).toHaveLength(0);
    expect(await ctx.expiry.expireDue('w1')).toBe(0);
    expect(
      ctx.storage.eventLog.readSince(0).some((e) => e.type === 'scene.expired'),
    ).toBe(false);
    ctx.storage.close();
  });

  it('a normally ended invitation scene never expires, and world scoping holds', async () => {
    const ctx = setup();
    ctx.openInvitation('s-invite-4', 2);
    // The lifecycle end (e.g. the bridge's end-before-open transition).
    const lifecycle = createSceneLifecycle({
      storage: ctx.storage,
      eventBus: ctx.eventBus,
      logger: quietLogger(),
      knownCharacters: [ELIAS],
    });
    expect(
      lifecycle.endScene({
        world_id: 'w1',
        actor_id: 'user:owner',
        scene_id: 's-invite-4',
      }).ok,
    ).toBe(true);
    ctx.advanceTo('2000-01-03T06:00:00.000Z');

    expect(await ctx.expiry.expireDue('w1')).toBe(0);
    // The boot sweep's world list is empty once nothing is pending.
    expect(pendingInvitationWorlds(ctx.storage)).toHaveLength(0);
    ctx.storage.close();
  });
});
