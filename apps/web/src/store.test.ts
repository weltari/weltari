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
