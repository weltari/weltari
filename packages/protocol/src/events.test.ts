import { describe, expect, it } from 'vitest';
import { WeltariEventSchema } from './events.js';

const envelope = {
  id: 9,
  world_id: 'w1',
  actor_id: 'user:owner',
  ts: '2026-07-09T12:00:00.000Z',
};

describe('chat event family (0.11.0, Rev 4 §8/§11)', () => {
  it('accepts a chat.message_committed from each sender', () => {
    for (const sender of ['user', 'character']) {
      const message: unknown = {
        ...envelope,
        type: 'chat.message_committed',
        payload: {
          conversation_id: 'chat:user:owner:char:elias',
          character_id: 'char:elias',
          sender,
          text: 'Evening. The roads are mud again.',
          message_id: 'm-1',
        },
      };
      expect(WeltariEventSchema.safeParse(message).success).toBe(true);
    }
  });

  it('rejects a chat message with empty text, oversized text, or an extra key (B5/B7)', () => {
    const base = {
      conversation_id: 'c1',
      character_id: 'char:elias',
      sender: 'user',
      message_id: 'm-1',
    };
    for (const payload of [
      { ...base, text: '' },
      { ...base, text: 'x'.repeat(8193) },
      { ...base, text: 'hi', admin: true },
    ]) {
      const event: unknown = {
        ...envelope,
        type: 'chat.message_committed',
        payload,
      };
      expect(WeltariEventSchema.safeParse(event).success).toBe(false);
    }
  });

  it('accepts chat.ended for each reason and rejects an unknown reason', () => {
    for (const reason of ['exit', 'idle', 'startscene']) {
      const ended: unknown = {
        ...envelope,
        type: 'chat.ended',
        payload: {
          conversation_id: 'c1',
          character_id: 'char:elias',
          reason,
          range_end_id: 41,
        },
      };
      expect(WeltariEventSchema.safeParse(ended).success).toBe(true);
    }
    const bad: unknown = {
      ...envelope,
      type: 'chat.ended',
      payload: {
        conversation_id: 'c1',
        character_id: 'char:elias',
        reason: 'rage_quit',
        range_end_id: 41,
      },
    };
    expect(WeltariEventSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts reflect_chat.committed and requires a positive range_end_id', () => {
    const reflected: unknown = {
      ...envelope,
      type: 'reflect_chat.committed',
      payload: {
        conversation_id: 'c1',
        character_id: 'char:elias',
        range_end_id: 41,
        summary: 'The traveler asked about the storm.',
      },
    };
    expect(WeltariEventSchema.safeParse(reflected).success).toBe(true);
    const zero: unknown = {
      ...envelope,
      type: 'reflect_chat.committed',
      payload: {
        conversation_id: 'c1',
        character_id: 'char:elias',
        range_end_id: 0,
        summary: 's',
      },
    };
    expect(WeltariEventSchema.safeParse(zero).success).toBe(false);
  });

  it('accepts cache.appended for both origins and caps the one-liner', () => {
    for (const origin of ['scene', 'chat']) {
      const entry: unknown = {
        ...envelope,
        type: 'cache.appended',
        payload: {
          character_id: 'char:elias',
          origin,
          context_id: origin === 'scene' ? 's1' : 'c1',
          line: 'Talked with the traveler about the storm.',
        },
      };
      expect(WeltariEventSchema.safeParse(entry).success).toBe(true);
    }
    const oversized: unknown = {
      ...envelope,
      type: 'cache.appended',
      payload: {
        character_id: 'char:elias',
        origin: 'chat',
        context_id: 'c1',
        line: 'x'.repeat(301),
      },
    };
    expect(WeltariEventSchema.safeParse(oversized).success).toBe(false);
  });

  it('accepts subwiki.updated and rejects an oversized entry or extra key (B5)', () => {
    const valid: unknown = {
      ...envelope,
      type: 'subwiki.updated',
      payload: {
        sublocation_id: 'subloc:stub-the-smokehouse',
        scene_id: 's1',
        entry: 'Hooks of fish and hams hang in cool smoke; the firepit glows.',
      },
    };
    expect(WeltariEventSchema.safeParse(valid).success).toBe(true);
    const oversized: unknown = {
      ...envelope,
      type: 'subwiki.updated',
      payload: {
        sublocation_id: 's',
        scene_id: 's1',
        entry: 'x'.repeat(4001),
      },
    };
    expect(WeltariEventSchema.safeParse(oversized).success).toBe(false);
    const extra: unknown = {
      ...envelope,
      type: 'subwiki.updated',
      payload: {
        sublocation_id: 's',
        scene_id: 's1',
        entry: 'ok',
        secret: true,
      },
    };
    expect(WeltariEventSchema.safeParse(extra).success).toBe(false);
  });

  it('accepts chat.outreach_recorded and rejects a missing stamp or extra key (B5)', () => {
    const payload = {
      conversation_id: 'chat:user:owner:char:elias',
      character_id: 'char:elias',
      occurrence_iso: '2026-07-10T10:00:00.000Z',
      game_time: '2000-01-03T18:00:00.000Z',
      message_id: 'outreach-abc123',
      unanswered_count: 1,
    };
    const valid: unknown = {
      ...envelope,
      type: 'chat.outreach_recorded',
      payload,
    };
    expect(WeltariEventSchema.safeParse(valid).success).toBe(true);
    // Both clock stamps are REQUIRED (owner ruling 2026-07-10: game_time is
    // the V2 trigger-base bridge — an outreach without it is malformed).
    const { game_time, ...withoutGameTime } = payload;
    void game_time;
    const missing: unknown = {
      ...envelope,
      type: 'chat.outreach_recorded',
      payload: withoutGameTime,
    };
    expect(WeltariEventSchema.safeParse(missing).success).toBe(false);
    const extra: unknown = {
      ...envelope,
      type: 'chat.outreach_recorded',
      payload: { ...payload, retries: 2 },
    };
    expect(WeltariEventSchema.safeParse(extra).success).toBe(false);
  });

  it('accepts chat.thread_frozen and rejects a non-positive count or extra key (B5)', () => {
    const payload = {
      conversation_id: 'chat:user:owner:char:elias',
      character_id: 'char:elias',
      message_id: 'outreach-abc123',
      unanswered_count: 3,
    };
    const valid: unknown = {
      ...envelope,
      type: 'chat.thread_frozen',
      payload,
    };
    expect(WeltariEventSchema.safeParse(valid).success).toBe(true);
    const zero: unknown = {
      ...envelope,
      type: 'chat.thread_frozen',
      payload: { ...payload, unanswered_count: 0 },
    };
    expect(WeltariEventSchema.safeParse(zero).success).toBe(false);
    const extra: unknown = {
      ...envelope,
      type: 'chat.thread_frozen',
      payload: { ...payload, visible: true },
    };
    expect(WeltariEventSchema.safeParse(extra).success).toBe(false);
  });

  it('scene.started accepts the 0.11.0 premise + place_request handoff fields', () => {
    const started: unknown = {
      ...envelope,
      type: 'scene.started',
      payload: {
        scene_id: 's2',
        title: 'Morning at the park',
        premise: 'Elias suggested meeting outside for once.',
        place_request: 'the park',
      },
    };
    expect(WeltariEventSchema.safeParse(started).success).toBe(true);
  });
});

const validCommitted: unknown = {
  id: 42,
  world_id: 'w1',
  actor_id: 'user:owner',
  ts: '2026-07-06T12:00:00.000Z',
  type: 'turn.committed',
  payload: {
    scene_id: 's1',
    turn_id: 't1',
    steps: [
      { call: 'narrator', speaker: 'Narrator', text: 'Rain taps the window.' },
      {
        call: 'character',
        speaker: 'Elias',
        text: '"Late again," he mutters.',
      },
      { call: 'narration', speaker: 'Narrator', text: 'He turns away.' },
    ],
  },
};

describe('WeltariEventSchema', () => {
  it('accepts a valid scene.ended event with participants', () => {
    const ended: unknown = {
      id: 7,
      world_id: 'w1',
      actor_id: 'user:owner',
      ts: '2026-07-06T12:00:00.000Z',
      type: 'scene.ended',
      payload: { scene_id: 's1', participants: ['char:elias'] },
    };
    expect(WeltariEventSchema.safeParse(ended).success).toBe(true);
  });

  it('accepts a scene.ended with a next_scene registration (0.10.0)', () => {
    const ended: unknown = {
      id: 7,
      world_id: 'w1',
      actor_id: 'char:narrator',
      ts: '2026-07-09T12:00:00.000Z',
      type: 'scene.ended',
      payload: {
        scene_id: 's1',
        participants: ['char:elias'],
        end_type: 'continuation',
        divider_text: '— evening falls —',
        next_scene: {
          sublocation_id: 'subloc:stub-the-old-cellar',
          premise_seed: 'The lamplighter waits below.',
        },
      },
    };
    expect(WeltariEventSchema.safeParse(ended).success).toBe(true);
  });

  it('rejects a next_scene with an empty sublocation_id or extra key (B5)', () => {
    const base = {
      id: 7,
      world_id: 'w1',
      actor_id: 'char:narrator',
      ts: '2026-07-09T12:00:00.000Z',
      type: 'scene.ended',
    };
    const empty: unknown = {
      ...base,
      payload: {
        scene_id: 's1',
        participants: [],
        end_type: 'continuation',
        next_scene: { sublocation_id: '' },
      },
    };
    const extra: unknown = {
      ...base,
      payload: {
        scene_id: 's1',
        participants: [],
        end_type: 'continuation',
        next_scene: { sublocation_id: 'subloc:cellar', smuggled: true },
      },
    };
    expect(WeltariEventSchema.safeParse(empty).success).toBe(false);
    expect(WeltariEventSchema.safeParse(extra).success).toBe(false);
  });

  it('accepts a sublocation.stub_created for a child and a parentless stub (0.10.0)', () => {
    const base = {
      id: 11,
      world_id: 'w1',
      actor_id: 'char:narrator',
      ts: '2026-07-09T12:00:00.000Z',
      type: 'sublocation.stub_created',
    };
    const child: unknown = {
      ...base,
      payload: {
        scene_id: 's1',
        sublocation_id: 'subloc:stub-the-inn-kitchen',
        name: 'The Inn Kitchen',
        description: 'Steam and copper pots behind the common room.',
        parent_id: 'subloc:common_room',
      },
    };
    const parentless: unknown = {
      ...base,
      payload: {
        scene_id: 's1',
        sublocation_id: 'subloc:stub-the-river-park',
        name: 'The River Park',
        description: 'Willows lean over slow water at the edge of town.',
        narrative_anchor: 'near the riverside, downstream of the mill',
      },
    };
    expect(WeltariEventSchema.safeParse(child).success).toBe(true);
    expect(WeltariEventSchema.safeParse(parentless).success).toBe(true);
  });

  it('rejects a sublocation.stub_created with an empty name or extra key (B5)', () => {
    const base = {
      id: 11,
      world_id: 'w1',
      actor_id: 'char:narrator',
      ts: '2026-07-09T12:00:00.000Z',
      type: 'sublocation.stub_created',
    };
    const emptyName: unknown = {
      ...base,
      payload: {
        scene_id: 's1',
        sublocation_id: 'subloc:stub-x',
        name: '',
        description: 'd',
      },
    };
    const extraKey: unknown = {
      ...base,
      payload: {
        scene_id: 's1',
        sublocation_id: 'subloc:stub-x',
        name: 'X',
        description: 'd',
        map_position: { x: 0.5, y: 0.5 },
      },
    };
    expect(WeltariEventSchema.safeParse(emptyName).success).toBe(false);
    expect(WeltariEventSchema.safeParse(extraKey).success).toBe(false);
  });

  it('accepts a valid character.joined event (roster projection)', () => {
    const joined: unknown = {
      id: 6,
      world_id: 'w1',
      actor_id: 'user:owner',
      ts: '2026-07-08T12:00:00.000Z',
      type: 'character.joined',
      payload: { scene_id: 's1', character_id: 'char:elias', name: 'Elias' },
    };
    expect(WeltariEventSchema.safeParse(joined).success).toBe(true);
  });

  it('rejects a character.joined with an empty name or extra key (B5)', () => {
    const base = {
      id: 6,
      world_id: 'w1',
      actor_id: 'user:owner',
      ts: '2026-07-08T12:00:00.000Z',
      type: 'character.joined',
    };
    const emptyName: unknown = {
      ...base,
      payload: { scene_id: 's1', character_id: 'char:elias', name: '' },
    };
    const extraKey: unknown = {
      ...base,
      payload: {
        scene_id: 's1',
        character_id: 'char:elias',
        name: 'Elias',
        art_id: 'smile',
      },
    };
    expect(WeltariEventSchema.safeParse(emptyName).success).toBe(false);
    expect(WeltariEventSchema.safeParse(extraKey).success).toBe(false);
  });

  it('accepts a valid reflection.committed event', () => {
    const reflection: unknown = {
      id: 8,
      world_id: 'w1',
      actor_id: 'char:elias',
      ts: '2026-07-06T12:00:00.000Z',
      type: 'reflection.committed',
      payload: {
        scene_id: 's1',
        character_id: 'char:elias',
        summary: 'The storm kept the regulars in; Marta owes nothing new.',
      },
    };
    expect(WeltariEventSchema.safeParse(reflection).success).toBe(true);
  });

  it('rejects a reflection.committed with an empty summary', () => {
    const empty: unknown = {
      id: 8,
      world_id: 'w1',
      actor_id: 'char:elias',
      ts: '2026-07-06T12:00:00.000Z',
      type: 'reflection.committed',
      payload: { scene_id: 's1', character_id: 'char:elias', summary: '' },
    };
    expect(WeltariEventSchema.safeParse(empty).success).toBe(false);
  });

  it('rejects a world_agent.committed with an extra payload key (B5)', () => {
    const extra: unknown = {
      id: 9,
      world_id: 'w1',
      actor_id: 'system:world_agent',
      ts: '2026-07-06T12:00:00.000Z',
      type: 'world_agent.committed',
      payload: { scene_id: 's1', note: 'ok', smuggled: true },
    };
    expect(WeltariEventSchema.safeParse(extra).success).toBe(false);
  });

  it('accepts world.time_advanced and world_cron.completed events', () => {
    const advanced: unknown = {
      id: 10,
      world_id: 'w1',
      actor_id: 'user:owner',
      ts: '2026-07-06T12:00:00.000Z',
      type: 'world.time_advanced',
      payload: {
        from: '2000-01-01T06:00:00.000Z',
        to: '2000-01-03T06:00:00.000Z',
        code_enqueued: 2,
        llm_enqueued: 2,
        llm_skipped: 0,
      },
    };
    expect(WeltariEventSchema.safeParse(advanced).success).toBe(true);

    const completed: unknown = {
      id: 11,
      world_id: 'w1',
      actor_id: 'system:world_cron',
      ts: '2026-07-06T12:00:00.000Z',
      type: 'world_cron.completed',
      payload: {
        cron_type: 'lamplighter',
        scheduled_for: '2000-01-02T06:00:00.000Z',
        job_class: 'code',
      },
    };
    expect(WeltariEventSchema.safeParse(completed).success).toBe(true);
  });

  it('rejects a world_cron.completed with an unknown job_class', () => {
    const bad: unknown = {
      id: 11,
      world_id: 'w1',
      actor_id: 'system:world_cron',
      ts: '2026-07-06T12:00:00.000Z',
      type: 'world_cron.completed',
      payload: {
        cron_type: 'lamplighter',
        scheduled_for: '2000-01-02T06:00:00.000Z',
        job_class: 'quantum',
      },
    };
    expect(WeltariEventSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts a valid painter.completed and rejects a short sha256', () => {
    const base = {
      id: 12,
      world_id: 'w1',
      actor_id: 'system:painter',
      ts: '2026-07-06T12:00:00.000Z',
      type: 'painter.completed',
    };
    const valid: unknown = {
      ...base,
      payload: {
        image_id: 'map:w1',
        region: { x: 10, y: 20, width: 64, height: 64 },
        path: 'map-w1/ab12cd34.png',
        sha256: 'a'.repeat(64),
        job_key: 'painter:map:w1:r1',
      },
    };
    expect(WeltariEventSchema.safeParse(valid).success).toBe(true);
    const shortHash: unknown = {
      ...base,
      payload: {
        image_id: 'map:w1',
        region: { x: 10, y: 20, width: 64, height: 64 },
        path: 'map-w1/ab12cd34.png',
        sha256: 'abc',
        job_key: 'painter:map:w1:r1',
      },
    };
    expect(WeltariEventSchema.safeParse(shortHash).success).toBe(false);
  });

  it('accepts a valid map_edit.requested and rejects a two-point polygon', () => {
    const base = {
      id: 20,
      world_id: 'w1',
      actor_id: 'user:owner',
      ts: '2026-07-08T12:00:00.000Z',
      type: 'map_edit.requested',
    };
    const triangle = [
      { x: 0.2, y: 0.2 },
      { x: 0.3, y: 0.2 },
      { x: 0.25, y: 0.3 },
    ];
    const valid: unknown = {
      ...base,
      payload: { edit_id: 'e1', points: triangle, intent: 'a mill pond here' },
    };
    expect(WeltariEventSchema.safeParse(valid).success).toBe(true);
    const line: unknown = {
      ...base,
      payload: {
        edit_id: 'e1',
        points: triangle.slice(0, 2),
        intent: 'a mill pond here',
      },
    };
    expect(WeltariEventSchema.safeParse(line).success).toBe(false);
  });

  it('accepts a valid sublocation.created and rejects a smuggled key (B5)', () => {
    const base = {
      id: 21,
      world_id: 'w1',
      actor_id: 'user:owner',
      ts: '2026-07-08T12:00:00.000Z',
      type: 'sublocation.created',
    };
    const payload = {
      sublocation_id: 'subloc:edit-e1',
      name: 'The Mill Pond',
      description: 'A quiet pond.',
      map_position: { x: 0.25, y: 0.23 },
      footprint: [
        { x: 0.2, y: 0.2 },
        { x: 0.3, y: 0.2 },
        { x: 0.25, y: 0.3 },
      ],
      edit_id: 'e1',
    };
    expect(WeltariEventSchema.safeParse({ ...base, payload }).success).toBe(
      true,
    );
    expect(
      WeltariEventSchema.safeParse({
        ...base,
        payload: { ...payload, backdrop_path: 'sneaky.webp' },
      }).success,
    ).toBe(false);
  });

  it('accepts map_click.resolved for both outcomes and rejects an unknown one', () => {
    const base = {
      id: 23,
      world_id: 'w1',
      actor_id: 'user:owner',
      ts: '2026-07-08T12:00:00.000Z',
      type: 'map_click.resolved',
    };
    const created: unknown = {
      ...base,
      payload: {
        click_id: 'c1',
        point: { x: 0.7, y: 0.3 },
        outcome: 'created',
        sublocation_id: 'subloc:click-c1',
        name: 'The Heron Shallows',
        description: 'A gravel shallows where herons stalk the reeds.',
      },
    };
    expect(WeltariEventSchema.safeParse(created).success).toBe(true);
    const transient: unknown = {
      ...base,
      payload: {
        click_id: 'c2',
        point: { x: 0.7, y: 0.3 },
        outcome: 'transient',
        name: 'A startled deer',
        description: 'It bolts before you can get close.',
      },
    };
    expect(WeltariEventSchema.safeParse(transient).success).toBe(true);
    const unknown: unknown = {
      ...base,
      payload: {
        click_id: 'c3',
        point: { x: 0.7, y: 0.3 },
        outcome: 'quantum',
        name: 'x',
        description: 'y',
      },
    };
    expect(WeltariEventSchema.safeParse(unknown).success).toBe(false);
  });

  it('accepts job.parked with and without the 0.9.0 job_key', () => {
    const base = {
      id: 22,
      world_id: 'w1',
      actor_id: 'system:ledger',
      ts: '2026-07-08T12:00:00.000Z',
      type: 'job.parked',
    };
    const payload = {
      job_id: 7,
      job_type: 'map_edit',
      attempts: 5,
      error: { kind: 'operational', code: 'llm_down', message: '503' },
    };
    // Pre-0.9.0 rows lack job_key — both must stay readable.
    expect(WeltariEventSchema.safeParse({ ...base, payload }).success).toBe(
      true,
    );
    expect(
      WeltariEventSchema.safeParse({
        ...base,
        payload: { ...payload, job_key: 'map_edit:w1:e1' },
      }).success,
    ).toBe(true);
  });

  it('accepts a valid turn.committed event', () => {
    const r = WeltariEventSchema.safeParse(validCommitted);
    expect(r.success).toBe(true);
    if (r.success && r.data.type === 'turn.committed') {
      expect(r.data.payload.steps).toHaveLength(3);
    }
  });

  it('accepts an interrupted turn.committed and rejects interrupted: false', () => {
    const base = {
      id: 43,
      world_id: 'w1',
      actor_id: 'user:owner',
      ts: '2026-07-07T12:00:00.000Z',
      type: 'turn.committed',
    };
    const interrupted: unknown = {
      ...base,
      payload: {
        scene_id: 's1',
        turn_id: 't1',
        steps: [{ call: 'narrator', speaker: 'Narrator', text: 'Rain falls.' }],
        interrupted: true,
      },
    };
    expect(WeltariEventSchema.safeParse(interrupted).success).toBe(true);
    // interrupted is a literal true: an uninterrupted turn omits the key.
    const explicitFalse: unknown = {
      ...base,
      payload: {
        scene_id: 's1',
        turn_id: 't1',
        steps: [{ call: 'narrator', speaker: 'Narrator', text: 'Rain falls.' }],
        interrupted: false,
      },
    };
    expect(WeltariEventSchema.safeParse(explicitFalse).success).toBe(false);
  });

  it('accepts scene.ended with end_type + divider and rejects unknown end_type', () => {
    const base = {
      id: 44,
      world_id: 'w1',
      actor_id: 'char:narrator',
      ts: '2026-07-07T12:00:00.000Z',
      type: 'scene.ended',
    };
    const soft: unknown = {
      ...base,
      payload: {
        scene_id: 's1',
        participants: ['char:elias'],
        end_type: 'continuation',
        divider_text: '— evening falls —',
      },
    };
    expect(WeltariEventSchema.safeParse(soft).success).toBe(true);
    const badType: unknown = {
      ...base,
      payload: {
        scene_id: 's1',
        participants: ['char:elias'],
        end_type: 'hard_cut',
      },
    };
    expect(WeltariEventSchema.safeParse(badType).success).toBe(false);
  });

  it('accepts a valid sublocation.changed and rejects an extra payload key (B5)', () => {
    const base = {
      id: 45,
      world_id: 'w1',
      actor_id: 'char:narrator',
      ts: '2026-07-07T12:00:00.000Z',
      type: 'sublocation.changed',
    };
    const valid: unknown = {
      ...base,
      payload: {
        scene_id: 's1',
        sublocation_id: 'subloc:cellar',
        name: 'The Flooded Cellar',
      },
    };
    expect(WeltariEventSchema.safeParse(valid).success).toBe(true);
    const extra: unknown = {
      ...base,
      payload: {
        scene_id: 's1',
        sublocation_id: 'subloc:cellar',
        name: 'The Flooded Cellar',
        smuggled: true,
      },
    };
    expect(WeltariEventSchema.safeParse(extra).success).toBe(false);
  });

  it('accepts a valid art.switched and rejects an empty art_id', () => {
    const base = {
      id: 46,
      world_id: 'w1',
      actor_id: 'char:narrator',
      ts: '2026-07-07T12:00:00.000Z',
      type: 'art.switched',
    };
    const valid: unknown = {
      ...base,
      payload: {
        scene_id: 's1',
        character_id: 'char:elias',
        art_id: 'smile',
      },
    };
    expect(WeltariEventSchema.safeParse(valid).success).toBe(true);
    const emptyArt: unknown = {
      ...base,
      payload: { scene_id: 's1', character_id: 'char:elias', art_id: '' },
    };
    expect(WeltariEventSchema.safeParse(emptyArt).success).toBe(false);
  });

  it('accepts a valid plugin.rejected and rejects an unknown reason', () => {
    const base = {
      id: 47,
      world_id: 'w1',
      actor_id: 'system:plugins',
      ts: '2026-07-07T12:00:00.000Z',
      type: 'plugin.rejected',
    };
    const valid: unknown = {
      ...base,
      payload: {
        plugin: 'night-theme',
        reason: 'hash_mismatch',
        detail: 'content hash 1a2b… does not match manifest provenance',
      },
    };
    expect(WeltariEventSchema.safeParse(valid).success).toBe(true);
    const badReason: unknown = {
      ...base,
      payload: { plugin: 'night-theme', reason: 'vibes', detail: 'x' },
    };
    expect(WeltariEventSchema.safeParse(badReason).success).toBe(false);
  });

  it('rejects an unknown envelope key (strict — Guide B5)', () => {
    const withExtra: unknown = {
      id: 1,
      world_id: 'w1',
      actor_id: 'user:owner',
      ts: '2026-07-06T12:00:00.000Z',
      type: 'turn.started',
      payload: { scene_id: 's1', turn_id: 't1' },
      smuggled: 'nope',
    };
    expect(WeltariEventSchema.safeParse(withExtra).success).toBe(false);
  });

  it('rejects an unknown payload key (strict — Guide B5)', () => {
    const withExtra: unknown = {
      id: 1,
      world_id: 'w1',
      actor_id: 'user:owner',
      ts: '2026-07-06T12:00:00.000Z',
      type: 'turn.started',
      payload: { scene_id: 's1', turn_id: 't1', smuggled: 'nope' },
    };
    expect(WeltariEventSchema.safeParse(withExtra).success).toBe(false);
  });

  it('rejects an event type outside the closed union', () => {
    const unknownType: unknown = {
      id: 1,
      world_id: 'w1',
      actor_id: 'user:owner',
      ts: '2026-07-06T12:00:00.000Z',
      type: 'turn.exploded',
      payload: {},
    };
    expect(WeltariEventSchema.safeParse(unknownType).success).toBe(false);
  });

  it('rejects a non-positive event id', () => {
    const badId: unknown = {
      id: 0,
      world_id: 'w1',
      actor_id: 'user:owner',
      ts: '2026-07-06T12:00:00.000Z',
      type: 'turn.started',
      payload: { scene_id: 's1', turn_id: 't1' },
    };
    expect(WeltariEventSchema.safeParse(badId).success).toBe(false);
  });

  it('rejects a missing actor_id (Brief §2.8: every event carries actor_id)', () => {
    const noActor: unknown = {
      id: 1,
      world_id: 'w1',
      ts: '2026-07-06T12:00:00.000Z',
      type: 'turn.started',
      payload: { scene_id: 's1', turn_id: 't1' },
    };
    expect(WeltariEventSchema.safeParse(noActor).success).toBe(false);
  });

  it('accepts update.available and update.staged events', () => {
    const available: unknown = {
      id: 20,
      world_id: 'w1',
      actor_id: 'system:updater',
      ts: '2026-07-07T12:00:00.000Z',
      type: 'update.available',
      payload: {
        version: '0.2.0',
        current_version: '0.1.0',
        release_url: 'https://github.com/weltari/weltari/releases/tag/v0.2.0',
      },
    };
    expect(WeltariEventSchema.safeParse(available).success).toBe(true);
    const staged: unknown = {
      id: 21,
      world_id: 'w1',
      actor_id: 'system:updater',
      ts: '2026-07-07T12:05:00.000Z',
      type: 'update.staged',
      payload: {
        version: '0.2.0',
        previous_version: '0.1.0',
        sha256: 'a'.repeat(64),
      },
    };
    expect(WeltariEventSchema.safeParse(staged).success).toBe(true);
  });

  it('rejects update.staged with a short hash or an extra key (B5)', () => {
    const shortHash: unknown = {
      id: 21,
      world_id: 'w1',
      actor_id: 'system:updater',
      ts: '2026-07-07T12:05:00.000Z',
      type: 'update.staged',
      payload: { version: '0.2.0', previous_version: '0.1.0', sha256: 'abc' },
    };
    expect(WeltariEventSchema.safeParse(shortHash).success).toBe(false);
    const extra: unknown = {
      id: 22,
      world_id: 'w1',
      actor_id: 'system:updater',
      ts: '2026-07-07T12:05:00.000Z',
      type: 'update.available',
      payload: { version: '0.2.0', current_version: '0.1.0', smuggled: true },
    };
    expect(WeltariEventSchema.safeParse(extra).success).toBe(false);
  });

  it('accepts a valid sublocation.materialized event (fog reveal)', () => {
    const materialized: unknown = {
      id: 30,
      world_id: 'w1',
      actor_id: 'system:engine',
      ts: '2026-07-08T12:00:00.000Z',
      type: 'sublocation.materialized',
      payload: {
        sublocation_id: 'subloc:sq-5-1',
        name: 'The Mill Pond',
        description: 'A quiet pond behind the mill; herons stand watch.',
        square: { col: 5, row: 1 },
        map_position: { x: 0.6875, y: 0.1875 },
      },
    };
    expect(WeltariEventSchema.safeParse(materialized).success).toBe(true);
  });

  it('rejects sublocation.materialized outside the fog grid or with extras (B5)', () => {
    const base = {
      id: 31,
      world_id: 'w1',
      actor_id: 'system:engine',
      ts: '2026-07-08T12:00:00.000Z',
      type: 'sublocation.materialized',
    };
    const payload = {
      sublocation_id: 'subloc:sq-5-1',
      name: 'The Mill Pond',
      description: 'A quiet pond behind the mill.',
      square: { col: 5, row: 1 },
      map_position: { x: 0.6875, y: 0.1875 },
    };
    const offGrid: unknown = {
      ...base,
      payload: { ...payload, square: { col: 8, row: 0 } },
    };
    const fractionalSquare: unknown = {
      ...base,
      payload: { ...payload, square: { col: 2.5, row: 0 } },
    };
    const emptyDescription: unknown = {
      ...base,
      payload: { ...payload, description: '' },
    };
    const extraKey: unknown = {
      ...base,
      payload: { ...payload, backdrop_path: 'sneaky.webp' },
    };
    expect(WeltariEventSchema.safeParse(offGrid).success).toBe(false);
    expect(WeltariEventSchema.safeParse(fractionalSquare).success).toBe(false);
    expect(WeltariEventSchema.safeParse(emptyDescription).success).toBe(false);
    expect(WeltariEventSchema.safeParse(extraKey).success).toBe(false);
  });
});

describe('invitation expiry family (0.13.0, Rev 4 §7)', () => {
  it('accepts a scene.started with an invitation and rejects a malformed one', () => {
    const withInvitation: unknown = {
      ...envelope,
      type: 'scene.started',
      payload: {
        scene_id: 's-chat-1',
        title: 'Meeting: the shrine',
        place_request: 'the shrine',
        invitation: {
          character_id: 'char:elias',
          place: 'the shrine',
          wait_hours: 6,
          expires_at_game: '2000-01-01T18:00:00.000Z',
        },
      },
    };
    expect(WeltariEventSchema.safeParse(withInvitation).success).toBe(true);
    for (const bad of [
      { character_id: 'char:elias', place: 'the shrine', wait_hours: 0, expires_at_game: 'x' },
      { character_id: 'char:elias', place: '', wait_hours: 6, expires_at_game: 'x' },
      { character_id: 'char:elias', place: 'p', wait_hours: 6, expires_at_game: 'x', extra: 1 },
    ]) {
      const event: unknown = {
        ...envelope,
        type: 'scene.started',
        payload: { scene_id: 's1', title: 't', invitation: bad },
      };
      expect(WeltariEventSchema.safeParse(event).success).toBe(false);
    }
  });

  it('accepts scene.expired and rejects a payload missing its clock stamps', () => {
    const expired: unknown = {
      ...envelope,
      type: 'scene.expired',
      payload: {
        scene_id: 's-chat-1',
        character_id: 'char:elias',
        place: 'the shrine',
        expires_at_game: '2000-01-01T18:00:00.000Z',
        game_time: '2000-01-02T06:00:00.000Z',
      },
    };
    expect(WeltariEventSchema.safeParse(expired).success).toBe(true);
    const missingStamp: unknown = {
      ...envelope,
      type: 'scene.expired',
      payload: {
        scene_id: 's-chat-1',
        character_id: 'char:elias',
        place: 'the shrine',
        expires_at_game: '2000-01-01T18:00:00.000Z',
      },
    };
    expect(WeltariEventSchema.safeParse(missingStamp).success).toBe(false);
  });

  it('accepts chat.notice and rejects oversized or LLM-shaped extras', () => {
    const notice: unknown = {
      ...envelope,
      type: 'chat.notice',
      payload: {
        conversation_id: 'chat:user:owner:char:elias',
        character_id: 'char:elias',
        code: 'startscene_rejected',
        text: 'Elias tried to open the meeting but the invitation could not be placed.',
      },
    };
    expect(WeltariEventSchema.safeParse(notice).success).toBe(true);
    for (const payload of [
      {
        conversation_id: 'c1',
        character_id: 'char:elias',
        code: 'startscene_rejected',
        text: 'x'.repeat(301),
      },
      {
        conversation_id: 'c1',
        character_id: 'char:elias',
        code: '',
        text: 'why',
      },
      {
        conversation_id: 'c1',
        character_id: 'char:elias',
        code: 'c',
        text: 'why',
        severity: 'red',
      },
    ]) {
      const event: unknown = { ...envelope, type: 'chat.notice', payload };
      expect(WeltariEventSchema.safeParse(event).success).toBe(false);
    }
  });
});
