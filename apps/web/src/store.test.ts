// Pins the art projection's scene scoping (UI Spec §1.5): poses reset at
// scene.started and only the current scene's art.switched events project.
// Regression: a pose from an ended scene leaked into every later scene —
// live navigation and full replay alike showed the stale pose.
import { describe, expect, it } from 'vitest';
import type { StreamSentence, WeltariEvent } from '@weltari/protocol';
import { useSceneStore } from './store.js';

const TS = '2026-07-10T00:00:00.000Z';
let nextId = 1;

function sceneStarted(sceneId: string): WeltariEvent {
  return {
    id: nextId++,
    world_id: 'w1',
    actor_id: 'user:owner',
    ts: TS,
    type: 'scene.started',
    payload: { scene_id: sceneId, title: 'A scene' },
  };
}

function artSwitched(
  sceneId: string,
  characterId: string,
  artId: string,
): WeltariEvent {
  return {
    id: nextId++,
    world_id: 'w1',
    actor_id: 'char:narrator',
    ts: TS,
    type: 'art.switched',
    payload: { scene_id: sceneId, character_id: characterId, art_id: artId },
  };
}

function apply(event: WeltariEvent): void {
  useSceneStore.getState().applyEvent(event);
}

function subwikiUpdated(
  sublocationId: string,
  sceneId: string,
  entry: string,
): WeltariEvent {
  return {
    id: nextId++,
    world_id: 'w1',
    actor_id: 'system:world_agent',
    ts: TS,
    type: 'subwiki.updated',
    payload: { sublocation_id: sublocationId, scene_id: sceneId, entry },
  };
}

describe('subwiki.updated projection (the Wiki page source, M6 part 3)', () => {
  it('latest entry per sublocation wins; provenance rides along', () => {
    apply(subwikiUpdated('subloc:stub-camp', 's-old', 'Kilns smolder.'));
    apply(subwikiUpdated('subloc:stub-camp', 's-new', 'The kilns are cold.'));
    apply(subwikiUpdated('subloc:cellar', 's-old', 'Casks float upright.'));
    expect(useSceneStore.getState().subwikiBySublocation).toMatchObject({
      'subloc:stub-camp': { entry: 'The kilns are cold.', sceneId: 's-new' },
      'subloc:cellar': { entry: 'Casks float upright.', sceneId: 's-old' },
    });
  });

  it('stub names project so the Wiki never shows a raw id for an interior', () => {
    apply({
      id: nextId++,
      world_id: 'w1',
      actor_id: 'char:narrator',
      ts: TS,
      type: 'sublocation.stub_created',
      payload: {
        scene_id: 's-k1',
        sublocation_id: 'subloc:stub-the-inn-kitchen',
        name: 'the inn kitchen',
        description: 'Copper pots over a low fire.',
        parent_id: 'subloc:common_room',
      },
    });
    expect(useSceneStore.getState().stubNames).toMatchObject({
      'subloc:stub-the-inn-kitchen': 'the inn kitchen',
    });
  });
});

describe('art.switched projection is scene-scoped', () => {
  it('a switch in the current scene projects', () => {
    apply(sceneStarted('s-art-1'));
    apply(artSwitched('s-art-1', 'char:elias', 'smile'));
    expect(useSceneStore.getState().artByCharacter).toEqual({
      'char:elias': 'smile',
    });
  });

  it('scene.started resets every pose — no cross-scene leak', () => {
    apply(sceneStarted('s-art-2'));
    apply(artSwitched('s-art-2', 'char:elias', 'worried'));
    apply(sceneStarted('s-art-3'));
    expect(useSceneStore.getState().artByCharacter).toEqual({});
  });

  it('a switch naming another scene is ignored', () => {
    apply(sceneStarted('s-art-4'));
    apply(artSwitched('s-art-other', 'char:elias', 'working'));
    expect(useSceneStore.getState().artByCharacter).toEqual({});
  });

  it('replay rebuilds the same poses as the live path', () => {
    // The exact replayed order of the regression: old scene switches a pose,
    // a later scene opens — the line-up must land at the default pose.
    apply(sceneStarted('s-art-5'));
    apply(artSwitched('s-art-5', 'char:elias', 'smile'));
    apply(sceneStarted('s-art-6'));
    apply(artSwitched('s-art-5', 'char:elias', 'worried'));
    expect(useSceneStore.getState().artByCharacter).toEqual({});
  });
});

describe('invitation expiry + the red-line notice (0.13.0, M6 part 4)', () => {
  it('scene.expired closes the History entry with the expiry divider and clears a viewed scene', () => {
    apply(sceneStarted('s-invite-1'));
    apply({
      id: nextId++,
      world_id: 'w1',
      actor_id: 'char:elias',
      ts: TS,
      type: 'scene.expired',
      payload: {
        scene_id: 's-invite-1',
        character_id: 'char:elias',
        place: 'the shrine',
        expires_at_game: '2000-01-01T12:00:00.000Z',
        game_time: '2000-01-02T06:00:00.000Z',
      },
    });
    const state = useSceneStore.getState();
    expect(state.sceneId).toBeNull(); // back to the splash, never a soft close
    expect(state.sceneEnd).toBeNull();
    const entry = state.history.find((h) => h.scene_id === 's-invite-1');
    expect(entry?.ended).toBe(true);
    expect(entry?.divider_text).toBe('— the meeting expired —');
  });

  it('chat.notice lands in the thread as a notice line, idempotent per event id', () => {
    const notice: WeltariEvent = {
      id: nextId++,
      world_id: 'w1',
      actor_id: 'char:elias',
      ts: TS,
      type: 'chat.notice',
      payload: {
        conversation_id: 'chat:user:owner:char:elias',
        character_id: 'char:elias',
        code: 'startscene_rejected',
        text: 'Elias tried to open the meeting, but the invitation was rejected — no scene was opened.',
      },
    };
    apply(notice);
    apply(notice); // a replayed event must not twin the line
    const thread = useSceneStore.getState().chatThreads['char:elias'];
    const notices = (thread?.messages ?? []).filter(
      (m) => m.sender === 'notice',
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain('no scene was opened');
  });
});

function socialPost(postId: string, body = 'Roof beams up.'): WeltariEvent {
  return {
    id: nextId++,
    world_id: 'w1',
    actor_id: 'char:elias',
    ts: TS,
    type: 'social.post_committed',
    payload: {
      post_id: postId,
      occurrence_iso: '2000-01-02T00:00:00.000Z',
      game_time: '2000-01-02T08:00:00.000Z',
      character_id: 'char:elias',
      body,
      recipient_ids: ['char:mara'],
    },
  };
}

function socialComment(postId: string, reactionId: string): WeltariEvent {
  return {
    id: nextId++,
    world_id: 'w1',
    actor_id: 'char:mara',
    ts: TS,
    type: 'social.reaction_committed',
    payload: {
      post_id: postId,
      reaction_id: reactionId,
      character_id: 'char:mara',
      kind: 'comment',
      body: 'Rain never asks first.',
    },
  };
}

describe('the Feed projection (0.15.0, UI Spec §2.5)', () => {
  it('posts, reactions and reply threads fold; duplicates are no-ops; answers land in the bell', () => {
    const before = useSceneStore.getState().feedPosts.length;
    apply(socialPost('post-1'));
    apply(socialPost('post-1')); // replay duplicate
    apply(socialComment('post-1', 'post-1:char:mara'));
    apply(socialComment('post-1', 'post-1:char:mara')); // duplicate
    apply({
      id: nextId++,
      world_id: 'w1',
      actor_id: 'user:owner',
      ts: TS,
      type: 'social.reply_posted',
      payload: {
        post_id: 'post-1',
        reaction_id: 'post-1:char:mara',
        reply_id: 'req-1',
        body: 'What did the eels say?',
      },
    });
    const answerId = nextId;
    apply({
      id: nextId++,
      world_id: 'w1',
      actor_id: 'char:mara',
      ts: TS,
      type: 'social.reply_answered',
      payload: {
        post_id: 'post-1',
        reaction_id: 'post-1:char:mara',
        reply_id: 'answer-1',
        in_reply_to: 'req-1',
        character_id: 'char:mara',
        body: 'Eels keep their opinions under water.',
      },
    });

    const state = useSceneStore.getState();
    const posts = state.feedPosts.filter((p) => p.post_id === 'post-1');
    expect(state.feedPosts.length).toBe(before + 1);
    expect(posts).toHaveLength(1);
    const post = posts[0];
    expect(post?.reactions).toHaveLength(1);
    expect(post?.reactions[0]?.kind).toBe('comment');
    expect(post?.reactions[0]?.replies.map((r) => r.author)).toEqual([
      'user',
      'character',
    ]);
    // The bell holds the one thing directed at the user: the answer.
    const bell = state.feedNotifications.find((n) => n.reply_id === 'answer-1');
    expect(bell?.character_id).toBe('char:mara');
    expect(bell?.event_id).toBe(answerId);
    expect(state.feedLastEventId).toBeGreaterThanOrEqual(answerId);
  });
});

describe('subwiki.edited projection (0.15.0, manual edits)', () => {
  it('a manual edit wins the view with user provenance and never bumps the blue-dot counter', () => {
    apply(subwikiUpdated('subloc:edit-me', 's-1', 'The agent wrote this.'));
    const dotAfterAgent = useSceneStore.getState().wikiLastEventId;
    apply({
      id: nextId++,
      world_id: 'w1',
      actor_id: 'user:owner',
      ts: TS,
      type: 'subwiki.edited',
      payload: {
        sublocation_id: 'subloc:edit-me',
        entry: 'I rewrote this myself.',
      },
    });
    const state = useSceneStore.getState();
    expect(state.subwikiBySublocation['subloc:edit-me']).toEqual({
      entry: 'I rewrote this myself.',
      sceneId: null,
      editedByUser: true,
    });
    // The blue dot announces the WORLD writing — not the user's own edit.
    expect(state.wikiLastEventId).toBe(dotAfterAgent);
  });
});

describe('the GM consent projection (0.17.0, Rev 4 §16)', () => {
  function proposalSubmitted(proposalId: string): WeltariEvent {
    return {
      id: nextId++,
      world_id: 'w1',
      actor_id: 'char:gm',
      ts: TS,
      type: 'proposal.submitted',
      payload: {
        proposal_id: proposalId,
        rationale: 'The town needs a quiet spot.',
        proposer: 'char:gm',
        approvers: ['user:owner'],
        action: 'create_place',
        diff: {
          name: 'The Mossy Court',
          description: 'A small walled yard.',
          space: 'public',
        },
      },
    };
  }

  it('a resolution settles the card in place; a discuss marks it (0.20.0)', () => {
    apply(proposalSubmitted('p-a'));
    apply(proposalSubmitted('p-b'));
    expect(useSceneStore.getState().gmProposals).toHaveLength(2);
    apply({
      id: nextId++,
      world_id: 'w1',
      actor_id: 'user:owner',
      ts: TS,
      type: 'proposal.resolved',
      payload: { proposal_id: 'p-a', resolution: 'rejected' },
    });
    apply({
      id: nextId++,
      world_id: 'w1',
      actor_id: 'user:owner',
      ts: TS,
      type: 'proposal.discussed',
      payload: { proposal_id: 'p-b' },
    });
    // The UX contract: NOTHING disappears — the resolved card settles with
    // its verdict, the discussed card stays pending with the talk marked.
    const proposals = useSceneStore.getState().gmProposals;
    expect(proposals).toHaveLength(2);
    expect(proposals[0]?.status).toBe('rejected');
    expect(proposals[1]?.status).toBe('pending');
    expect(proposals[1]?.discussed).toBe(true);
    // Cards carry their exact log position for the inline interleave.
    expect(proposals.map((p) => p.event_id)).toEqual(
      [...proposals.map((p) => p.event_id)].sort((a, b) => a - b),
    );
  });

  it('config.flag_set folds latest-wins; character.lock_set per character; world.seeded latches', () => {
    apply({
      id: nextId++,
      world_id: 'w1',
      actor_id: 'user:owner',
      ts: TS,
      type: 'config.flag_set',
      payload: { flag: 'profiling_enabled', value: true },
    });
    expect(useSceneStore.getState().profilingEnabled).toBe(true);
    apply({
      id: nextId++,
      world_id: 'w1',
      actor_id: 'user:owner',
      ts: TS,
      type: 'config.flag_set',
      payload: { flag: 'profiling_enabled', value: false },
    });
    expect(useSceneStore.getState().profilingEnabled).toBe(false);

    apply({
      id: nextId++,
      world_id: 'w1',
      actor_id: 'user:owner',
      ts: TS,
      type: 'character.lock_set',
      payload: { character_id: 'char:elias', locked: true },
    });
    expect(useSceneStore.getState().characterLocks['char:elias']).toBe(true);

    apply({
      id: nextId++,
      world_id: 'w1',
      actor_id: 'char:gm',
      ts: TS,
      type: 'world.seeded',
      payload: {
        world_name: 'Saltmarsh',
        language: 'en',
        place_count: 3,
        character_count: 2,
      },
    });
    expect(useSceneStore.getState().worldSeeded).toBe(true);
  });
});

describe('the GM live stream buffer (0.20.0, the GM proposal UX contract)', () => {
  const CONV = 'chat:user:owner:char:gm';
  function gmFrame(index: number, text: string): StreamSentence {
    return { turn_id: CONV, call: 'gm', speaker: 'GM', text, index };
  }

  it('gm frames buffer apart from the scene, index 0 replaces, the committed reply clears', () => {
    const store = useSceneStore.getState();
    store.applyStream(gmFrame(0, 'One.'));
    store.applyStream(gmFrame(1, 'Two.'));
    expect(useSceneStore.getState().gmLiveSentences.map((f) => f.text)).toEqual(
      ['One.', 'Two.'],
    );
    // The scene pacing buffer never sees a gm frame.
    expect(useSceneStore.getState().liveSentences).toHaveLength(0);
    // A correction-loop retry restarts the stream: index 0 replaces.
    store.applyStream(gmFrame(0, 'Fresh.'));
    expect(useSceneStore.getState().gmLiveSentences.map((f) => f.text)).toEqual(
      ['Fresh.'],
    );
    // The durable message supersedes the live stream (B6).
    apply({
      id: nextId++,
      world_id: 'w1',
      actor_id: 'char:gm',
      ts: TS,
      type: 'chat.message_committed',
      payload: {
        conversation_id: CONV,
        character_id: 'char:gm',
        sender: 'character',
        text: 'Fresh.',
        message_id: 'm-gm-1',
      },
    });
    expect(useSceneStore.getState().gmLiveSentences).toHaveLength(0);
    expect(useSceneStore.getState().gmLiveConversationId).toBeNull();
  });
});
