// interact_object through the PUBLIC turn seam (M7 part 3, Rev 4 §7):
// materialize-on-touch, (name, holder) dedup, the durable-consequence gate,
// the 2-ops-per-turn cap, and reach — all driven by fake-client markers at
// $0. V1 holders are sublocations only (owner ruling 2026-07-16).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { DevEvent } from '@weltari/protocol';
import {
  Bus,
  type DevBus,
  type EventBus,
  type StreamBus,
} from '../http/bus.js';
import { createFakeLlmClient } from '../llm/fake-client.js';
import { createRootLogger } from '../observability/logger.js';
import { openStorage, type Storage } from '../storage/db.js';
import { createEventSink } from './event-sink.js';
import { createTurnEngine } from './scene-turn.js';

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
  engine: ReturnType<typeof createTurnEngine>;
  devFrames: DevEvent[];
}

function setup(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'weltari-objturn-'));
  const logger = quietLogger();
  const storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
  const eventBus: EventBus = new Bus(logger);
  const streamBus: StreamBus = new Bus(logger);
  const devBus: DevBus = new Bus(logger);
  const devFrames: DevEvent[] = [];
  devBus.subscribe((frame) => devFrames.push(frame));
  const engine = createTurnEngine({
    storage,
    sink: createEventSink(storage, eventBus),
    streamBus,
    eventBus,
    devBus,
    llm: createFakeLlmClient(),
    logger,
  });
  storage.eventLog.append({
    world_id: 'w1',
    actor_id: 'system:engine',
    type: 'scene.started',
    payload: { scene_id: 's1', title: 'The Rainy Inn' },
  });
  return { storage, engine, devFrames };
}

async function runTurn(ctx: Ctx, text: string): Promise<void> {
  const started = await ctx.engine.startTurn({
    world_id: 'w1',
    actor_id: 'user:owner',
    scene_id: 's1',
    text,
  });
  expect(started.ok).toBe(true);
  if (started.ok) await started.value.completion;
}

function rejections(ctx: Ctx): { tool: string; reason: string }[] {
  return ctx.devFrames.flatMap((f) =>
    f.type === 'dev.tool_rejected' ? [{ tool: f.tool, reason: f.reason }] : [],
  );
}

describe('interact_object (materialize-on-touch)', () => {
  it('the first durable touch creates the row atomically with the turn — narrated scenery stays prose', async () => {
    const ctx = setup();
    await runTurn(ctx, 'I pick up the key by the hearth. !obj brass-key');

    const created = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'object.created');
    expect(created).toHaveLength(1);
    const event = created[0];
    if (event?.type === 'object.created') {
      expect(event.actor_id).toBe('char:elias');
      expect(event.payload.scene_id).toBe('s1');
      expect(event.payload.holder_sublocation_id).toBe('subloc:common_room');
      const row = ctx.storage.objects.byId(event.payload.object_id);
      expect(row?.name).toBe('brass key');
      expect(row?.payload).toBeUndefined();
    }
    // Everything merely narrated this turn stayed prose: exactly one row.
    expect(ctx.storage.objects.heldAt('w1', 'subloc:common_room')).toHaveLength(
      1,
    );
    ctx.storage.close();
  });

  it('a later ref by name resolves to the SAME row (dedup) — and a no-change touch is refused', async () => {
    const ctx = setup();
    await runTurn(ctx, '!obj brass-key');
    await runTurn(ctx, '!objwrite Brass-KEY Its teeth are filed flat.');

    const rows = ctx.storage.objects.heldAt('w1', 'subloc:common_room');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toContain('teeth are filed flat');
    expect(rows[0]?.version).toBe(2);

    // Bare touch of the existing object: nothing durable would change.
    await runTurn(ctx, '!obj brass-key');
    expect(
      rejections(ctx).some(
        (r) =>
          r.tool === 'interact_object' && r.reason.includes('express it in'),
      ),
    ).toBe(true);
    expect(ctx.storage.objects.heldAt('w1', 'subloc:common_room')).toHaveLength(
      1,
    );
    ctx.storage.close();
  });

  it('caps object ops at 2 per turn — the third call is refused, zero rows for it (I8)', async () => {
    const ctx = setup();
    await runTurn(
      ctx,
      '!obj a-stick !objwrite a-stick A stick someone whittled into a whistle. !objmove a-stick subloc:cellar',
    );
    const objectEvents = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type.startsWith('object.'));
    expect(objectEvents.map((e) => e.type)).toEqual([
      'object.created',
      'object.payload_written',
    ]);
    expect(
      rejections(ctx).some((r) => r.reason.includes('2 object operations')),
    ).toBe(true);
    ctx.storage.close();
  });

  it('reach is the scene locality: moving to a far sublocation is refused; a stub created THIS turn is reachable', async () => {
    const ctx = setup();
    await runTurn(ctx, '!obj torn-net');
    // subloc:shrine exists but is not within the common room's reach.
    await runTurn(ctx, '!objmove torn-net subloc:shrine');
    expect(rejections(ctx).some((r) => r.reason.includes('reach'))).toBe(true);

    // The narrator stages a child stub of the current sublocation in the
    // same reply; the character then moves the net into it (M6 creation
    // loop × M7 objects).
    await runTurn(
      ctx,
      '!create wine-nook subloc:common_room !objmove torn-net subloc:stub-wine-nook',
    );
    const row = ctx.storage.objects
      .heldAt('w1', 'subloc:stub-wine-nook')
      .find((r) => r.name === 'torn net');
    expect(row).toBeDefined();
    expect(row?.last_touched_scene_id).toBe('s1');
    ctx.storage.close();
  });

  it('an unknown name with move_to materializes AT the target; malformed input dies at gate 1', async () => {
    const ctx = setup();
    await runTurn(
      ctx,
      '!create wine-nook subloc:common_room !objmove storm-lantern subloc:stub-wine-nook !objbad',
    );
    const created = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'object.created');
    expect(created).toHaveLength(1);
    if (created[0]?.type === 'object.created') {
      expect(created[0].payload.holder_sublocation_id).toBe(
        'subloc:stub-wine-nook',
      );
    }
    expect(
      rejections(ctx).some(
        (r) => r.tool === 'interact_object' && r.reason.includes('object'),
      ),
    ).toBe(true);
    ctx.storage.close();
  });
});

describe('explore (the §14 listing)', () => {
  function characterText(ctx: Ctx): string {
    const turns = ctx.storage.eventLog
      .readSince(0)
      .filter((e) => e.type === 'turn.committed');
    const last = turns[turns.length - 1];
    if (last?.type !== 'turn.committed') return '';
    return last.payload.steps.find((s) => s.call === 'character')?.text ?? '';
  }

  it('lists the wiki line, the public objects (payload or none-yet), and nothing when empty', async () => {
    const ctx = setup();
    await runTurn(ctx, '!explore');
    expect(characterText(ctx)).toContain('Objects here: none recorded.');

    await runTurn(
      ctx,
      '!objwrite sealed-letter Meet me under the pier at low tide.',
    );
    await runTurn(ctx, '!obj dropped-stick');
    await runTurn(ctx, '!explore');
    const text = characterText(ctx);
    expect(text).toContain('The Common Room');
    expect(text).toContain('sealed letter');
    expect(text).toContain('under the pier at low tide');
    expect(text).toContain('dropped stick');
    expect(text).toContain('nothing written about it yet');
    ctx.storage.close();
  });

  it('explores a named sublocation, listing interiors one level deeper; unknown ids answer plainly', async () => {
    const ctx = setup();
    // A committed child of the common room (from an earlier turn).
    await runTurn(ctx, '!create wine-nook subloc:common_room');
    await runTurn(ctx, '!explore subloc:common_room');
    const text = characterText(ctx);
    expect(text).toContain('One level deeper:');
    expect(text).toContain('wine nook');

    await runTurn(ctx, '!explore subloc:nowhere');
    expect(characterText(ctx)).toContain(
      'No sublocation subloc:nowhere exists',
    );
    ctx.storage.close();
  });
});
