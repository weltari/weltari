import { describe, expect, it } from 'vitest';
import {
  AdvanceTimeCommandSchema,
  ApplyUpdateAcceptedSchema,
  ApplyUpdateCommandSchema,
  DeleteProfileAcceptedSchema,
  DeleteProfileCommandSchema,
  DiscussProposalAcceptedSchema,
  DiscussProposalCommandSchema,
  EndSceneCommandSchema,
  ExitChatCommandSchema,
  ResolveProposalAcceptedSchema,
  ResolveProposalCommandSchema,
  SetCharacterLockCommandSchema,
  SetConfigFlagCommandSchema,
  SendChatMessageAcceptedSchema,
  SendChatMessageCommandSchema,
  StartSceneFromChatCommandSchema,
  ExploreAcceptedSchema,
  ExploreCommandSchema,
  FeedReplyAcceptedSchema,
  FeedReplyCommandSchema,
  InterruptTurnCommandSchema,
  MapClickCommandSchema,
  MapEditCommandSchema,
  MarkerClickAcceptedSchema,
  MarkerClickCommandSchema,
  PaintRegionCommandSchema,
  OpenSceneCommandSchema,
  StartTurnAcceptedSchema,
  StartTurnCommandSchema,
  SubwikiEditCommandSchema,
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

describe('chat commands (0.11.0, Rev 4 §8)', () => {
  it('send-chat-message accepts a valid DM and enforces the B7 text cap', () => {
    const valid: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      character_id: 'char:elias',
      text: 'Evening, Elias.',
      request_id: 'r-1',
    };
    expect(SendChatMessageCommandSchema.safeParse(valid).success).toBe(true);
    const oversized: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      character_id: 'char:elias',
      text: 'x'.repeat(8193),
      request_id: 'r-1',
    };
    expect(SendChatMessageCommandSchema.safeParse(oversized).success).toBe(
      false,
    );
  });

  it('send-chat-message rejects empty text and an extra key (B5)', () => {
    const empty: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      character_id: 'char:elias',
      text: '',
      request_id: 'r-1',
    };
    expect(SendChatMessageCommandSchema.safeParse(empty).success).toBe(false);
    const extra: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      character_id: 'char:elias',
      text: 'hi',
      request_id: 'r-1',
      admin: true,
    };
    expect(SendChatMessageCommandSchema.safeParse(extra).success).toBe(false);
  });

  it('send-chat-message 202 carries the presence answer (UI Spec §2.4)', () => {
    const accepted: unknown = {
      accepted: true,
      conversation_id: 'chat:user:owner:char:elias',
      message_id: 'r-1',
      replying: false,
      presence: 'in_scene',
    };
    expect(SendChatMessageAcceptedSchema.safeParse(accepted).success).toBe(
      true,
    );
    const badPresence: unknown = {
      accepted: true,
      conversation_id: 'c1',
      message_id: 'r-1',
      replying: true,
      presence: 'asleep',
    };
    expect(SendChatMessageAcceptedSchema.safeParse(badPresence).success).toBe(
      false,
    );
  });

  it('exit-chat accepts a valid exit and rejects an extra key (B5)', () => {
    const valid: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      character_id: 'char:elias',
    };
    expect(ExitChatCommandSchema.safeParse(valid).success).toBe(true);
    const extra: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      character_id: 'char:elias',
      force: true,
    };
    expect(ExitChatCommandSchema.safeParse(extra).success).toBe(false);
  });

  it('start-scene-from-chat accepts an id, a name, or free text as place', () => {
    for (const place of ['subloc:common_room', 'The Common Room', 'the park']) {
      const valid: unknown = {
        world_id: 'w1',
        actor_id: 'user:owner',
        character_id: 'char:elias',
        scene_id: 's2',
        title: 'A walk outside',
        place,
      };
      expect(StartSceneFromChatCommandSchema.safeParse(valid).success).toBe(
        true,
      );
    }
    const emptyPlace: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      character_id: 'char:elias',
      scene_id: 's2',
      title: 'A walk outside',
      place: '',
    };
    expect(StartSceneFromChatCommandSchema.safeParse(emptyPlace).success).toBe(
      false,
    );
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

describe('map-edit command', () => {
  it('accepts a valid lasso edit and rejects short polygons and long intents', () => {
    const base = {
      world_id: 'w1',
      actor_id: 'user:owner',
      request_id: 'e1',
    };
    const triangle = [
      { x: 0.2, y: 0.2 },
      { x: 0.3, y: 0.2 },
      { x: 0.25, y: 0.3 },
    ];
    const valid: unknown = {
      ...base,
      points: triangle,
      intent: 'a mill pond with a heron',
    };
    expect(MapEditCommandSchema.safeParse(valid).success).toBe(true);
    const line: unknown = {
      ...base,
      points: triangle.slice(0, 2),
      intent: 'a mill pond',
    };
    expect(MapEditCommandSchema.safeParse(line).success).toBe(false);
    const longIntent: unknown = {
      ...base,
      points: triangle,
      intent: 'x'.repeat(501),
    };
    expect(MapEditCommandSchema.safeParse(longIntent).success).toBe(false);
    const offMap: unknown = {
      ...base,
      points: [{ x: 1.2, y: 0.2 }, ...triangle.slice(1)],
      intent: 'a mill pond',
    };
    expect(MapEditCommandSchema.safeParse(offMap).success).toBe(false);
  });
});

describe('map-click command', () => {
  it('accepts a valid click and rejects off-map points', () => {
    const base = { world_id: 'w1', actor_id: 'user:owner', request_id: 'c1' };
    expect(
      MapClickCommandSchema.safeParse({
        ...base,
        point: { x: 0.7, y: 0.3 },
      }).success,
    ).toBe(true);
    expect(
      MapClickCommandSchema.safeParse({
        ...base,
        point: { x: 1.3, y: 0.3 },
      }).success,
    ).toBe(false);
  });
});

describe('marker-click command (0.19.0, M7 part 4)', () => {
  it('accepts a valid click and rejects a missing marker or extra key (B5)', () => {
    const base = {
      world_id: 'w1',
      actor_id: 'user:owner',
      marker_id: 'marker:harbor-1',
    };
    expect(MarkerClickCommandSchema.safeParse(base).success).toBe(true);
    expect(
      MarkerClickCommandSchema.safeParse({
        world_id: 'w1',
        actor_id: 'user:owner',
      }).success,
    ).toBe(false);
    expect(
      MarkerClickCommandSchema.safeParse({ ...base, force: true }).success,
    ).toBe(false);
  });

  it('202 answers instantiated or join with the one scene, never other outcomes', () => {
    const base = {
      accepted: true,
      marker_id: 'marker:harbor-1',
      scene_id: 's-marker-harbor-1',
      sublocation_id: 'subloc:tide-bell',
    };
    for (const outcome of ['instantiated', 'join']) {
      expect(
        MarkerClickAcceptedSchema.safeParse({ ...base, outcome }).success,
      ).toBe(true);
    }
    expect(
      MarkerClickAcceptedSchema.safeParse({ ...base, outcome: 'twin' }).success,
    ).toBe(false);
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
    // 0.20.0: a GM reply streams into the GM thread — turn_id carries the
    // conversation id.
    const gm: unknown = {
      turn_id: 'chat:user:owner:char:gm',
      call: 'gm',
      speaker: 'GM',
      text: 'Let me look at the existing characters first.',
      index: 0,
    };
    expect(StreamSentenceSchema.safeParse(gm).success).toBe(true);
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

  it('explore command validates; off-grid square and extra key rejected (B5)', () => {
    const ok: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      square: { col: 5, row: 1 },
    };
    expect(ExploreCommandSchema.safeParse(ok).success).toBe(true);
    const offGrid: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      square: { col: 0, row: 9 },
    };
    expect(ExploreCommandSchema.safeParse(offGrid).success).toBe(false);
    const extra: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      square: { col: 5, row: 1 },
      name: 'I pick my own name',
    };
    expect(ExploreCommandSchema.safeParse(extra).success).toBe(false);
    const accepted: unknown = {
      accepted: true,
      job_key: 'materialize:w1:5:1',
    };
    expect(ExploreAcceptedSchema.safeParse(accepted).success).toBe(true);
  });

  it('open-scene accepts an optional sublocation_id (0.8.0, additive)', () => {
    const at: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's2',
      title: 'The Old Shrine',
      participants: ['char:elias'],
      sublocation_id: 'subloc:shrine',
    };
    expect(OpenSceneCommandSchema.safeParse(at).success).toBe(true);
    const empty: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      scene_id: 's2',
      title: 'The Old Shrine',
      participants: ['char:elias'],
      sublocation_id: '',
    };
    expect(OpenSceneCommandSchema.safeParse(empty).success).toBe(false);
  });

  it('hello frame accepts an optional app_version (0.8.0, additive)', () => {
    const withVersion: unknown = {
      protocol_version: '0.8.0',
      last_event_id: 4,
      app_version: '0.1.0',
    };
    expect(StreamHelloSchema.safeParse(withVersion).success).toBe(true);
    const without: unknown = { protocol_version: '0.8.0', last_event_id: 4 };
    expect(StreamHelloSchema.safeParse(without).success).toBe(true);
  });
});

describe('feed-reply + subwiki-edit commands (0.15.0, M6 part 5)', () => {
  it('feed-reply validates; empty text, oversized text, and extra key rejected (B5)', () => {
    const ok: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      post_id: 'post-1',
      reaction_id: 'post-1:char:mara',
      text: 'What did the eels say about it?',
      request_id: 'req-1',
    };
    expect(FeedReplyCommandSchema.safeParse(ok).success).toBe(true);
    const base = {
      world_id: 'w1',
      actor_id: 'user:owner',
      post_id: 'post-1',
      reaction_id: 'r1',
      request_id: 'req-1',
    };
    for (const bad of [
      { ...base, text: '' },
      { ...base, text: 'x'.repeat(2001) },
      { ...base, text: 'hi', pin: true },
    ]) {
      expect(FeedReplyCommandSchema.safeParse(bad).success).toBe(false);
    }
    const accepted: unknown = { accepted: true, reply_id: 'req-1' };
    expect(FeedReplyAcceptedSchema.safeParse(accepted).success).toBe(true);
  });

  it('subwiki-edit validates; empty and oversized entries rejected', () => {
    const ok: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      sublocation_id: 'subloc:rainy-inn',
      entry: 'Three rooms above the taproom; the stairs creak.',
    };
    expect(SubwikiEditCommandSchema.safeParse(ok).success).toBe(true);
    for (const entry of ['', 'x'.repeat(4001)]) {
      const bad: unknown = {
        world_id: 'w1',
        actor_id: 'user:owner',
        sublocation_id: 'subloc:rainy-inn',
        entry,
      };
      expect(SubwikiEditCommandSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('GM command family (0.17.0, M7 part 2, Rev 4 §9/§15/§16)', () => {
  it('resolve-proposal validates both resolutions and rejects others', () => {
    for (const resolution of ['approved', 'rejected']) {
      const ok: unknown = {
        world_id: 'w1',
        actor_id: 'user:owner',
        proposal_id: 'p-1',
        resolution,
      };
      expect(ResolveProposalCommandSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of [
      {
        world_id: 'w1',
        actor_id: 'user:owner',
        proposal_id: 'p-1',
        resolution: 'maybe',
      },
      { world_id: 'w1', actor_id: 'user:owner', resolution: 'approved' },
      {
        world_id: 'w1',
        actor_id: 'user:owner',
        proposal_id: 'p-1',
        resolution: 'approved',
        force: true,
      },
    ]) {
      expect(ResolveProposalCommandSchema.safeParse(bad).success).toBe(false);
    }
    const accepted: unknown = {
      accepted: true,
      proposal_id: 'p-1',
      resolution: 'approved',
      applied: 4,
    };
    expect(ResolveProposalAcceptedSchema.safeParse(accepted).success).toBe(
      true,
    );
  });

  it('discuss-proposal validates and rejects a resolution field (B5)', () => {
    const ok: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      proposal_id: 'p-1',
    };
    expect(DiscussProposalCommandSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { world_id: 'w1', actor_id: 'user:owner' },
      {
        world_id: 'w1',
        actor_id: 'user:owner',
        proposal_id: 'p-1',
        resolution: 'approved',
      },
    ]) {
      expect(DiscussProposalCommandSchema.safeParse(bad).success).toBe(false);
    }
    const accepted: unknown = { accepted: true, proposal_id: 'p-1' };
    expect(DiscussProposalAcceptedSchema.safeParse(accepted).success).toBe(
      true,
    );
  });

  it('set-config-flag accepts profiling_enabled and rejects unknown flags', () => {
    const ok: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      flag: 'profiling_enabled',
      value: true,
    };
    expect(SetConfigFlagCommandSchema.safeParse(ok).success).toBe(true);
    const bad: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      flag: 'sudo_mode',
      value: true,
    };
    expect(SetConfigFlagCommandSchema.safeParse(bad).success).toBe(false);
  });

  it('set-character-lock validates', () => {
    const ok: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      character_id: 'char:elias',
      locked: true,
    };
    expect(SetCharacterLockCommandSchema.safeParse(ok).success).toBe(true);
    const bad: unknown = {
      world_id: 'w1',
      actor_id: 'user:owner',
      character_id: '',
      locked: true,
    };
    expect(SetCharacterLockCommandSchema.safeParse(bad).success).toBe(false);
  });

  it('delete-profile validates; removed count answers', () => {
    const ok: unknown = { world_id: 'w1', actor_id: 'user:owner' };
    expect(DeleteProfileCommandSchema.safeParse(ok).success).toBe(true);
    const accepted: unknown = { accepted: true, removed: 0 };
    expect(DeleteProfileAcceptedSchema.safeParse(accepted).success).toBe(true);
    const negative: unknown = { accepted: true, removed: -1 };
    expect(DeleteProfileAcceptedSchema.safeParse(negative).success).toBe(false);
  });
});
