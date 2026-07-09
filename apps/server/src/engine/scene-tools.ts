// Gate 2 of the B6 double gate: a shape-valid tool call must also be true
// against game state (a schema can't know whether Elias is in the room).
// Valid calls are STAGED, never applied — the turn engine appends their
// durable events atomically with turn.committed, so a killed or interrupted
// turn leaves no tool effect behind (I8: rejected calls write zero rows).
//
// M6 part 1 (Rev 4 §6): create_sublocation joins the pipeline — identity
// stubs stage like any other effect; the engine-state gate enforces the
// parentless query-first rule (V1: the all-parentless query must run in this
// same turn — strictly within Rev 4's "in this scene") and the did-you-mean
// near-duplicate rejection. query_sublocations is NOT staged: it executes
// mid-call through the stage's read-only executor (queries route context,
// they never mutate).
import { err, ok, OperationalError, type Result } from '../errors.js';
import type { Storage } from '../storage/db.js';
import {
  QuerySublocationsToolSchema,
  type ValidatedToolCall,
} from '../llm/tools.js';
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
  | {
      kind: 'sublocation';
      sublocationId: string;
      name: string;
      /** Absent for interiors/stubs without their own map presence yet. */
      mapPosition?: { x: number; y: number };
    }
  | { kind: 'art'; characterId: string; artId: string }
  | {
      kind: 'create';
      sublocationId: string;
      name: string;
      brief: string;
      /** Present = interior of that exterior-atomic parent (Rev 4 §6). */
      parentId?: string;
      narrativeAnchor?: string;
    }
  | {
      kind: 'end_scene';
      endType: 'rest' | 'continuation' | 'travel';
      dividerText: string | undefined;
      /** Present exactly when endType is `continuation` (gate-enforced). */
      nextScene?: { sublocationId: string; premiseSeed?: string };
    };

export interface ToolStage {
  /** Gate 2. ok = the effect is staged; err.message is the trail reason. */
  apply(call: ValidatedToolCall): Result<StagedToolEffect>;
  staged(): readonly StagedToolEffect[];
  /** The staged end_scene, if the Narrator closed the scene this turn. */
  endScene(): StagedToolEffect | undefined;
  /**
   * The engine-owned read-only query executor (Rev 4 §6) the turn engine
   * offers to the LLM client (LlmCall.queries). Running mode `parentless`
   * arms this turn's parentless creates (the query-first rule). Input is
   * unvalidated provider JSON — malformed input answers with an error string
   * the model can react to; nothing durable ever happens here.
   */
  querySublocations(input: unknown): string;
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

/**
 * The name→id normalization the did-you-mean resolver and the deterministic
 * stub id share: lowercase, every non-alphanumeric run collapsed to one
 * hyphen. Two names that normalize identically ARE the same place (Rev 4 §6:
 * near-duplicates are rejected with a did-you-mean).
 */
export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
}

/** Deterministic id for a Narrator-created stub — retries and duplicate
 * calls can never mint twins (the slug collides instead, and gate 2 rejects). */
export function sublocationIdForStub(name: string): string {
  return `subloc:stub-${slugifyName(name)}`;
}

/** The fixed refusal Rev 4 §6 mandates for an unqueried parentless create —
 * the Narrator reads it on the trail and is expected to query, then retry. */
const PARENTLESS_QUERY_INSTRUCTION =
  'Before creating a sublocation that has no parent sublocation, you have ' +
  'to use the query tool to lookup for existing sublocations. If the ' +
  'sublocation you are looking for can refer to an already existing ' +
  'sublocation, please use the change_sublocation tool; otherwise, create ' +
  'a new one.';

export function createToolStage(
  options: SceneToolsOptions,
  sceneId: string,
): ToolStage {
  const effects: StagedToolEffect[] = [];
  let stagedEnd: StagedToolEffect | undefined;
  /** Stubs created earlier in THIS turn — visible to change_sublocation and
   * end_scene the way committed registry entries are (the creation loop:
   * create → change in one reply). */
  const stagedCreates = new Map<string, SublocationDefinition>();
  /** The query-first flag (Rev 4 §6): armed by a mode-`parentless` query
   * through the executor below, consumed by parentless creates this turn. */
  let parentlessQueried = false;
  let current = currentSublocationId(
    options.storage,
    sceneId,
    options.startSublocationId,
  );

  function findKnown(sublocationId: string): SublocationDefinition | undefined {
    return (
      options.sublocations.find((s) => s.sublocation_id === sublocationId) ??
      stagedCreates.get(sublocationId)
    );
  }

  function allKnown(): SublocationDefinition[] {
    return [...options.sublocations, ...stagedCreates.values()];
  }

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
          if (call.input.type === 'continuation') {
            if (call.input.next_scene === undefined) {
              return err(
                new OperationalError(
                  'continuation_needs_next_scene',
                  'a continuation must register next_scene: the sublocation_id the follow-up scene opens at',
                ),
              );
            }
            if (findKnown(call.input.next_scene.sublocation_id) === undefined) {
              return err(
                new OperationalError(
                  'unknown_sublocation',
                  `next_scene names ${call.input.next_scene.sublocation_id}, which is not a sublocation of this world (create_sublocation it first)`,
                ),
              );
            }
          } else if (call.input.next_scene !== undefined) {
            return err(
              new OperationalError(
                'next_scene_without_continuation',
                `next_scene is only valid with type continuation, not ${call.input.type}`,
              ),
            );
          }
          const next = call.input.next_scene;
          const effect: StagedToolEffect = {
            kind: 'end_scene',
            endType: call.input.type,
            dividerText: call.input.divider_text,
            ...(next === undefined
              ? {}
              : {
                  nextScene: {
                    sublocationId: next.sublocation_id,
                    ...(next.premise_seed === undefined
                      ? {}
                      : { premiseSeed: next.premise_seed }),
                  },
                }),
          };
          stagedEnd = effect;
          effects.push(effect);
          return ok(effect);
        }
        case 'change_sublocation': {
          const target = findKnown(call.input.sublocation_id);
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
            ...(target.map_position === undefined
              ? {}
              : { mapPosition: target.map_position }),
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
        case 'create_sublocation': {
          if (!sceneIsOpen(options.storage, sceneId)) {
            return err(
              new OperationalError(
                'scene_not_open',
                `scene ${sceneId} is not open`,
              ),
            );
          }
          const slug = slugifyName(call.input.name);
          if (slug === '') {
            return err(
              new OperationalError(
                'invalid_name',
                'the name must contain at least one letter or digit',
              ),
            );
          }
          // The did-you-mean resolver (Rev 4 §6): a name that normalizes to
          // an existing sublocation's name IS that sublocation — reject with
          // the alternative instead of minting a twin.
          const twin = allKnown().find(
            (s) =>
              slugifyName(s.name) === slug ||
              s.sublocation_id === sublocationIdForStub(call.input.name),
          );
          if (twin !== undefined) {
            return err(
              new OperationalError(
                'duplicate_sublocation',
                `"${call.input.name}" already exists as ${twin.sublocation_id} ("${twin.name}") — did you mean change_sublocation?`,
              ),
            );
          }
          const parentId = call.input.parent_id;
          if (parentId !== undefined) {
            const parent = findKnown(parentId);
            if (parent === undefined) {
              return err(
                new OperationalError(
                  'unknown_sublocation',
                  `parent ${parentId} is not a sublocation of this world`,
                ),
              );
            }
            // Always flat (Rev 4 §6): interiors parent to the exterior-atomic
            // location, never to another interior.
            if (parent.parent_id !== undefined) {
              return err(
                new OperationalError(
                  'parent_not_atomic',
                  `${parentId} is itself an interior — parent to its exterior-atomic location ${parent.parent_id} instead`,
                ),
              );
            }
          } else if (!parentlessQueried) {
            return err(
              new OperationalError(
                'parentless_query_first',
                PARENTLESS_QUERY_INSTRUCTION,
              ),
            );
          }
          const effect: StagedToolEffect = {
            kind: 'create',
            sublocationId: sublocationIdForStub(call.input.name),
            name: call.input.name,
            brief: call.input.brief,
            ...(parentId === undefined ? {} : { parentId }),
            ...(call.input.narrative_anchor === undefined
              ? {}
              : { narrativeAnchor: call.input.narrative_anchor }),
          };
          stagedCreates.set(effect.sublocationId, {
            sublocation_id: effect.sublocationId,
            name: call.input.name,
            description: call.input.brief,
            ...(parentId === undefined ? {} : { parent_id: parentId }),
            // An interior inherits its parent's anchor the way the committed
            // registry will fold it (sublocations.ts).
            ...((): { map_position?: { x: number; y: number } } => {
              const parentPosition =
                parentId === undefined
                  ? undefined
                  : findKnown(parentId)?.map_position;
              return parentPosition === undefined
                ? {}
                : { map_position: parentPosition };
            })(),
          });
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
    querySublocations(input: unknown): string {
      const parsed = QuerySublocationsToolSchema.safeParse(input);
      if (!parsed.success) {
        return (
          'query_sublocations: malformed input. Use {"mode": "parentless"} ' +
          'to list every exterior-atomic place, {"mode": "children", ' +
          '"parent_id": "..."} for interiors, or {"mode": "search", ' +
          '"keyword": "..."} for a keyword match.'
        );
      }
      const known = allKnown();
      const line = (s: SublocationDefinition): string =>
        `${s.sublocation_id} — ${s.name}: ${s.description}`;
      switch (parsed.data.mode) {
        case 'parentless': {
          // THE strict prerequisite for a parentless create (Rev 4 §6).
          parentlessQueried = true;
          const list = known.filter((s) => s.parent_id === undefined);
          return list.length === 0
            ? 'No parentless sublocations exist yet.'
            : `All parentless sublocations:\n${list.map(line).join('\n')}`;
        }
        case 'children': {
          if (parsed.data.parent_id === undefined) {
            return 'query_sublocations: mode "children" needs parent_id.';
          }
          const parentId = parsed.data.parent_id;
          const list = known.filter((s) => s.parent_id === parentId);
          return list.length === 0
            ? `No interiors exist under ${parentId} yet.`
            : `Interiors of ${parentId}:\n${list.map(line).join('\n')}`;
        }
        case 'search': {
          if (parsed.data.keyword === undefined) {
            return 'query_sublocations: mode "search" needs keyword.';
          }
          const needle = parsed.data.keyword.toLowerCase();
          const list = known.filter(
            (s) =>
              s.name.toLowerCase().includes(needle) ||
              s.description.toLowerCase().includes(needle),
          );
          return list.length === 0
            ? `No sublocation matches "${parsed.data.keyword}".`
            : `Matches for "${parsed.data.keyword}":\n${list.map(line).join('\n')}`;
        }
      }
    },
    discard(): void {
      effects.length = 0;
      stagedEnd = undefined;
      stagedCreates.clear();
      parentlessQueried = false;
    },
  };
}
