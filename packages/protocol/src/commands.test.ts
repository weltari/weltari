import { describe, expect, it } from 'vitest';
import { StartTurnAcceptedSchema, StartTurnCommandSchema } from './commands.js';
import { StreamHelloSchema, StreamSentenceSchema } from './stream.js';

describe('StartTurnCommandSchema', () => {
  const valid: unknown = {
    world_id: 'w1',
    actor_id: 'user:owner',
    scene_id: 's1',
    text: 'I open the door.',
  };

  it('accepts a valid command, with and without text', () => {
    expect(StartTurnCommandSchema.safeParse(valid).success).toBe(true);
    const noText: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's1',
    };
    expect(StartTurnCommandSchema.safeParse(noText).success).toBe(true);
  });

  it('rejects an unknown key (strict — Guide B5)', () => {
    const withExtra: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's1',
      admin: true,
    };
    expect(StartTurnCommandSchema.safeParse(withExtra).success).toBe(false);
  });

  it('caps user text at 8 KB before it can reach a prompt (Guide B7)', () => {
    const oversized: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's1',
      text: 'x'.repeat(8193),
    };
    expect(StartTurnCommandSchema.safeParse(oversized).success).toBe(false);
  });
});

describe('response and stream frames', () => {
  it('accepts a valid 202 body and rejects accepted:false', () => {
    expect(
      StartTurnAcceptedSchema.safeParse({ accepted: true, turn_id: 't1' })
        .success,
    ).toBe(true);
    expect(
      StartTurnAcceptedSchema.safeParse({ accepted: false, turn_id: 't1' })
        .success,
    ).toBe(false);
  });

  it('hello frame carries protocol_version and last_event_id', () => {
    const hello: unknown = { protocol_version: '0.1.0', last_event_id: 0 };
    expect(StreamHelloSchema.safeParse(hello).success).toBe(true);
    const extra: unknown = {
      protocol_version: '0.1.0',
      last_event_id: 0,
      dev: true,
    };
    expect(StreamHelloSchema.safeParse(extra).success).toBe(false);
  });

  it('sentence frame validates and rejects negative index', () => {
    const ok: unknown = {
      turn_id: 't1',
      call: 'narrator',
      speaker: 'Narrator',
      text: 'Rain.',
      index: 0,
    };
    expect(StreamSentenceSchema.safeParse(ok).success).toBe(true);
    const bad: unknown = {
      turn_id: 't1',
      call: 'narrator',
      speaker: 'Narrator',
      text: 'Rain.',
      index: -1,
    };
    expect(StreamSentenceSchema.safeParse(bad).success).toBe(false);
  });
});
