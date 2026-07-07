import { describe, expect, it } from 'vitest';
import { WeltariEventSchema } from './events.js';

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
});
