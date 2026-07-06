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

  it('accepts a valid turn.committed event', () => {
    const r = WeltariEventSchema.safeParse(validCommitted);
    expect(r.success).toBe(true);
    if (r.success && r.data.type === 'turn.committed') {
      expect(r.data.payload.steps).toHaveLength(3);
    }
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
