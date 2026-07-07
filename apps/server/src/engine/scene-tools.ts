// Gate 2 of the B6 double gate: a shape-valid tool call must also be true
// against game state (a schema can't know whether Elias is in the room).
// Valid calls are STAGED, never applied — the turn engine appends their
// durable events atomically with turn.committed, so a killed or interrupted
// turn leaves no tool effect behind (I8: rejected calls write zero rows).
import { err, ok, OperationalError, type Result } from '../errors.js';
import type { Storage } from '../storage/db.js';
import type { ValidatedToolCall } from '../llm/tools.js';
import type { SublocationDefinition } from './fixture/rainy-inn.js';

export interface SceneToolsOptions {
  storage: Storage;
  sublocations: readonly SublocationDefinition[];
  startSublocationId: string;
  /** character_id → named art poses (fixture art sets). */
  artSets: ReadonlyMap<string, readonly string[]>;
  /** Character ids present in the scene (the switch_art presence rule). */
  presentCharacterIds: readonly string[];
}

export type StagedToolEffect =
  | { kind: 'sublocation'; sublocationId: string; name: string }
  | { kind: 'art'; characterId: string; artId: string }
  | {
      kind: 'end_scene';
      endType: 'rest' | 'continuation' | 'travel';
      dividerText: string | undefined;
    };

export interface ToolStage {
  /** Gate 2. ok = the effect is staged; err.message is the trail reason. */
  apply(call: ValidatedToolCall): Result<StagedToolEffect>;
  staged(): readonly StagedToolEffect[];
  /** The staged end_scene, if the Narrator closed the scene this turn. */
  endScene(): StagedToolEffect | undefined;
  /** Interrupt semantics: the user cut the Narrator off — world changes the
   * turn staged never become durable (Guide B6). */
  discard(): void;
}

/** The scene's current sublocation = the latest sublocation.changed event, else the start. */
export function currentSublocationId(
  storage: Storage,
  sceneId: string,
  startSublocationId: string,
): string {
  let current = startSublocationId;
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (
      event.type === 'sublocation.changed' &&
      event.payload.scene_id === sceneId
    ) {
      current = event.payload.sublocation_id;
    }
  }
  return current;
}

function sceneIsOpen(storage: Storage, sceneId: string): boolean {
  let started = false;
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (!('scene_id' in event.payload) || event.payload.scene_id !== sceneId)
      continue;
    if (event.type === 'scene.started') started = true;
    if (event.type === 'scene.ended') return false;
  }
  return started;
}

export function createToolStage(
  options: SceneToolsOptions,
  sceneId: string,
): ToolStage {
  const effects: StagedToolEffect[] = [];
  let stagedEnd: StagedToolEffect | undefined;
  let current = currentSublocationId(
    options.storage,
    sceneId,
    options.startSublocationId,
  );

  return {
    apply(call: ValidatedToolCall): Result<StagedToolEffect> {
      switch (call.tool) {
        case 'end_scene': {
          if (stagedEnd !== undefined) {
            return err(
              new OperationalError(
                'scene_already_ending',
                'end_scene was already called this turn',
              ),
            );
          }
          if (!sceneIsOpen(options.storage, sceneId)) {
            return err(
              new OperationalError(
                'scene_not_open',
                `scene ${sceneId} is not open`,
              ),
            );
          }
          const effect: StagedToolEffect = {
            kind: 'end_scene',
            endType: call.input.type,
            dividerText: call.input.divider_text,
          };
          stagedEnd = effect;
          effects.push(effect);
          return ok(effect);
        }
        case 'change_sublocation': {
          const target = options.sublocations.find(
            (s) => s.sublocation_id === call.input.sublocation_id,
          );
          if (target === undefined) {
            return err(
              new OperationalError(
                'unknown_sublocation',
                `no sublocation ${call.input.sublocation_id} in this world`,
              ),
            );
          }
          if (target.sublocation_id === current) {
            return err(
              new OperationalError(
                'already_there',
                `the scene is already at ${current}`,
              ),
            );
          }
          current = target.sublocation_id;
          const effect: StagedToolEffect = {
            kind: 'sublocation',
            sublocationId: target.sublocation_id,
            name: target.name,
          };
          effects.push(effect);
          return ok(effect);
        }
        case 'switch_art': {
          if (!options.presentCharacterIds.includes(call.input.character_id)) {
            return err(
              new OperationalError(
                'character_not_present',
                `${call.input.character_id} is not in this scene`,
              ),
            );
          }
          const artSet = options.artSets.get(call.input.character_id) ?? [];
          if (!artSet.includes(call.input.art_id)) {
            return err(
              new OperationalError(
                'unknown_art',
                `${call.input.character_id} has no art ${call.input.art_id}`,
              ),
            );
          }
          const effect: StagedToolEffect = {
            kind: 'art',
            characterId: call.input.character_id,
            artId: call.input.art_id,
          };
          effects.push(effect);
          return ok(effect);
        }
      }
    },
    staged(): readonly StagedToolEffect[] {
      return effects;
    },
    endScene(): StagedToolEffect | undefined {
      return stagedEnd;
    },
    discard(): void {
      effects.length = 0;
      stagedEnd = undefined;
    },
  };
}
