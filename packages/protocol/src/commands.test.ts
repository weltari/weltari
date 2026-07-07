import { describe, expect, it } from 'vitest';
import {
  AdvanceTimeCommandSchema,
  ApplyUpdateAcceptedSchema,
  ApplyUpdateCommandSchema,
  EndSceneCommandSchema,
  InterruptTurnCommandSchema,
  PaintRegionCommandSchema,
  OpenSceneCommandSchema,
  StartTurnAcceptedSchema,
  StartTurnCommandSchema,
} from './commands.js';
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

describe('InterruptTurnCommandSchema', () => {
  it('accepts an interrupt with and without a seen cut point', () => {
    const withSeen: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      turn_id: 't1',
      seen: { call: 'narrator', sentence_index: 2 },
    };
    expect(InterruptTurnCommandSchema.safeParse(withSeen).success).toBe(true);
    const noSeen: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      turn_id: 't1',
    };
    expect(InterruptTurnCommandSchema.safeParse(noSeen).success).toBe(true);
  });

  it('rejects an unknown call kind and an extra key (B5)', () => {
    const badCall: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      turn_id: 't1',
      seen: { call: 'whisper', sentence_index: 0 },
    };
    expect(InterruptTurnCommandSchema.safeParse(badCall).success).toBe(false);
    const extra: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      turn_id: 't1',
      force: true,
    };
    expect(InterruptTurnCommandSchema.safeParse(extra).success).toBe(false);
  });

  it('rejects a negative sentence index', () => {
    const negative: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      turn_id: 't1',
      seen: { call: 'narrator', sentence_index: -1 },
    };
    expect(InterruptTurnCommandSchema.safeParse(negative).success).toBe(false);
  });
});

describe('scene lifecycle commands', () => {
  it('end-scene accepts a valid body and rejects an extra key (B5)', () => {
    const valid: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's1',
    };
    expect(EndSceneCommandSchema.safeParse(valid).success).toBe(true);
    const extra: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's1',
      force: true,
    };
    expect(EndSceneCommandSchema.safeParse(extra).success).toBe(false);
  });

  it('open-scene requires a title and a participants array', () => {
    const valid: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's2',
      title: 'The Morning After',
      participants: ['char:elias'],
    };
    expect(OpenSceneCommandSchema.safeParse(valid).success).toBe(true);
    const noParticipants: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's2',
      title: 'The Morning After',
    };
    expect(OpenSceneCommandSchema.safeParse(noParticipants).success).toBe(
      false,
    );
  });
});

describe('advance-time command', () => {
  it('accepts positive minutes and rejects zero, negative and over-cap', () => {
    const base = { world_id: 'w1', actor_id: 'user:owner' };
    const valid: unknown = { ...base, minutes: 4320 };
    expect(AdvanceTimeCommandSchema.safeParse(valid).success).toBe(true);
    const zero: unknown = { ...base, minutes: 0 };
    expect(AdvanceTimeCommandSchema.safeParse(zero).success).toBe(false);
    const negative: unknown = { ...base, minutes: -5 };
    expect(AdvanceTimeCommandSchema.safeParse(negative).success).toBe(false);
    const overCap: unknown = { ...base, minutes: 527041 };
    expect(AdvanceTimeCommandSchema.safeParse(overCap).success).toBe(false);
  });
});

describe('paint-region command', () => {
  it('accepts a valid request and rejects zero-size or oversized regions', () => {
    const base = {
      world_id: 'w1',
      actor_id: 'user:owner',
      image_id: 'map:w1',
      request_id: 'r1',
    };
    const valid: unknown = {
      ...base,
      region: { x: 0, y: 0, width: 64, height: 64 },
    };
    expect(PaintRegionCommandSchema.safeParse(valid).success).toBe(true);
    const zeroSize: unknown = {
      ...base,
      region: { x: 0, y: 0, width: 0, height: 64 },
    };
    expect(PaintRegionCommandSchema.safeParse(zeroSize).success).toBe(false);
    const oversized: unknown = {
      ...base,
      region: { x: 0, y: 0, width: 5000, height: 64 },
    };
    expect(PaintRegionCommandSchema.safeParse(oversized).success).toBe(false);
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

  it('apply-update command validates; extra key rejected (B5)', () => {
    const ok: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      version: '0.2.0',
    };
    expect(ApplyUpdateCommandSchema.safeParse(ok).success).toBe(true);
    const extra: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      version: '0.2.0',
      url: 'https://evil.example/artifact',
    };
    expect(ApplyUpdateCommandSchema.safeParse(extra).success).toBe(false);
    const accepted: unknown = {
      accepted: true,
      job_key: 'update_apply:0.2.0',
    };
    expect(ApplyUpdateAcceptedSchema.safeParse(accepted).success).toBe(true);
  });
});
