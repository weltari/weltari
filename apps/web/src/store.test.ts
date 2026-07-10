// Pins the art projection's scene scoping (UI Spec §1.5): poses reset at
// scene.started and only the current scene's art.switched events project.
// Regression: a pose from an ended scene leaked into every later scene —
// live navigation and full replay alike showed the stale pose.
import { describe, expect, it } from 'vitest';
import type { WeltariEvent } from '@weltari/protocol';
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
