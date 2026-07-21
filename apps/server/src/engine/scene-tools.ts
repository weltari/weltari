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
import { randomUUID } from 'node:crypto';
import { err, ok, OperationalError, type Result } from '../errors.js';
import type { Storage } from '../storage/db.js';
import { objectNameKey } from '../storage/repositories/objects.js';
import {
  DetermineWhoNextToolSchema,
  QuerySublocationsToolSchema,
  type ValidatedToolCall,
} from '../llm/tools.js';
import type { SublocationDefinition } from './fixture/rainy-inn.js';

/** A world-registry character as the stage needs it (id + display name) —
 * a local shape so scene-tools stays import-cycle-free (chat.ts imports us). */
export interface SceneCharacter {
  character_id: string;
  name: string;
}

export interface SceneToolsOptions {
  storage: Storage;
  /** The world the scene plays in — object reads are world-scoped (M7 part 3). */
  worldId: string;
  sublocations: readonly SublocationDefinition[];
  startSublocationId: string;
  /** character_id → named art poses (fixture art sets). */
  artSets: ReadonlyMap<string, readonly string[]>;
  /** Character ids present in the scene AT TURN START (the roster fold);
   * staged joins/leaves overlay it inside the stage (0.21.0). */
  presentCharacterIds: readonly string[];
  /** The world's full character registry (seeds ∪ character.created) —
   * make_character/move_character resolve ids and names against it. */
  worldCharacters?: readonly SceneCharacter[];
  /** World-scoped presence lookup (0.21.0, injected to avoid the chat.ts
   * import cycle): gates joins and moves — a character reserved by ANOTHER
   * scene can neither join nor be moved. */
  presence?: (
    characterId: string,
  ) => { state: 'available' } | { state: 'in_scene'; scene_id: string };
  /** True when the engine's context-budget warning stands for this scene
   * (0.21.0, Rev 4 §6) — the only state in which end_scene may use type
   * context_limit_reached. Recomputed per turn from the same estimate that
   * issues the warning, so it survives restarts for free. */
  contextWarned?: boolean;
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
      endType: 'rest' | 'continuation' | 'travel' | 'context_limit_reached';
      /** M7 part 4 (Rev 4 §14): the ending scene's follow-up marker. */
      followUpMarker?: { sublocationId: string; premiseSeed: string };
      dividerText: string | undefined;
      /** Present exactly when endType is `continuation` (gate-enforced) —
       * the FULL Rev 4 §6 registration since 0.21.0 (gate 1 requires it). */
      nextScene?: {
        sublocationId: string;
        premiseSeed?: string;
        timeOffsetHours?: number;
        expectedParticipants?: readonly string[];
        briefHistory?: string;
        carriedGoals?: readonly string[];
      };
    }
  // The agentic-scene cast effects (0.21.0, Rev 4 §6) — staged only by the
  // Narrator's make_character / character_leave / move_character.
  | { kind: 'character_join'; characterId: string; name: string }
  | {
      kind: 'character_mint';
      characterId: string;
      name: string;
      personality: string;
      goals: readonly string[];
      core: readonly string[];
      /** True = the minted character also joins THIS scene. */
      present: boolean;
    }
  | { kind: 'character_leave'; characterId: string; reason?: string }
  | { kind: 'character_move'; characterId: string; toSublocationId: string }
  /** The update_goals structured snapshot (0.21.0) — at most one per turn
   * (a later call replaces the earlier one whole). */
  | {
      kind: 'goals';
      goals: readonly {
        id: string;
        text: string;
        status: 'pending' | 'active' | 'done';
      }[];
    }
  // The object effects (M7 part 3, Rev 4 §7) — staged ONLY by a character's
  // interact_object; each carries its actor (the touching character) because
  // the commit writes actor_id per event and the stage outlives the call.
  | {
      kind: 'object_create';
      objectId: string;
      name: string;
      holderSublocationId: string;
      payload?: string;
      actorId: string;
    }
  | {
      kind: 'object_payload';
      objectId: string;
      payload: string;
      actorId: string;
    }
  | {
      kind: 'object_move';
      objectId: string;
      fromSublocationId: string;
      toSublocationId: string;
      actorId: string;
    }
  // Write-on-first-read (Rev 4 §7): the Narrator's improvised content for a
  // payload-less object — no actor field; the commit stamps the Narrator.
  | {
      kind: 'object_improv';
      objectId: string;
      payload: string;
    };

export interface ToolStage {
  /** Gate 2. ok = the effect is staged; err.message is the trail reason.
   * `actorId` names the calling character — required by interact_object
   * (M7 part 3: object events carry the touching character as actor). */
  apply(call: ValidatedToolCall, actorId?: string): Result<StagedToolEffect>;
  staged(): readonly StagedToolEffect[];
  /** The staged end_scene, if the Narrator closed the scene this turn. */
  endScene(): StagedToolEffect | undefined;
  /** The scene's sublocation as THIS turn sees it (staged moves included) —
   * the explore executor's default place (M7 part 3). */
  currentSublocation(): string;
  /**
   * The engine-owned read-only query executor (Rev 4 §6) the turn engine
   * offers to the LLM client (LlmCall.queries). Running mode `parentless`
   * arms this turn's parentless creates (the query-first rule). Input is
   * unvalidated provider JSON — malformed input answers with an error string
   * the model can react to; nothing durable ever happens here.
   */
  querySublocations(input: unknown): string;
  /** The scene's cast as THIS turn sees it (staged joins/leaves included) —
   * the loop's charactercall validation and switch_art read it (0.21.0). */
  presentCharacters(): readonly string[];
  /**
   * The determine_who_next executor (0.21.0, Rev 4 §6): validates the
   * Narrator's routing declaration — set-typed input, V1 policy exactly ONE
   * id, every id present in the scene — and arms the declared set the next
   * charactercall consumes. Mid-call, teaching error strings, never staged.
   */
  declareNext(input: unknown): string;
  /** Consume a declared speaker for charactercall: ok = the id was declared
   * (and is removed); an undeclared id gets the teaching refusal. */
  consumeDeclared(characterId: string): Result<void>;
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

/** The fixed refusal Rev 4 §7 mandates for an interact_object that would
 * change nothing durable — prose stays prose by construction. */
const NOTHING_DURABLE_REFUSAL =
  'interact_object changes nothing here: give it a payload to author ' +
  'content, or move_to to move the object — otherwise express it in your ' +
  'attempt instead.';

/** Max accepted object operations per turn (Rev 4 §7). */
const OBJECT_OPS_PER_TURN = 2;

/** An object as the stage sees it: a committed row or one staged this turn. */
interface StagedObjectView {
  objectId: string;
  name: string;
  holderSublocationId: string;
  hasPayload: boolean;
}

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
  /** Object state as this turn has already changed it (M7 part 3): staged
   * creates/moves/payload writes overlay the committed rows, so a second
   * interact_object in the same reply sees the first one's world. */
  const stagedObjects = new Map<string, StagedObjectView>();
  let objectOps = 0;
  /** The cast as this turn sees it (0.21.0): the turn-start roster overlaid
   * with staged joins/leaves — switch_art, charactercall and the leave gate
   * all read this live view. */
  const present = new Set<string>(options.presentCharacterIds);
  /** Characters minted THIS turn (staged character.created) — resolvable by
   * make_character/move_character like committed registry entries. */
  const stagedMints = new Map<string, SceneCharacter>();
  /** The armed determine_who_next declaration (0.21.0): charactercall
   * consumes from it; empty = nothing declared. */
  const declaredNext = new Set<string>();
  const presence =
    options.presence ??
    ((): { state: 'available' } => ({ state: 'available' }));

  /** Resolve a make_character/move_character ref: staged mints, then the
   * registry — by exact id, then by normalized name (the did-you-mean rule). */
  function resolveCharacter(ref: string): SceneCharacter | undefined {
    const minted =
      stagedMints.get(ref) ??
      [...stagedMints.values()].find(
        (c) => slugifyName(c.name) === slugifyName(ref),
      );
    if (minted !== undefined) return minted;
    const known = options.worldCharacters ?? [];
    return (
      known.find((c) => c.character_id === ref) ??
      known.find((c) => slugifyName(c.name) === slugifyName(ref))
    );
  }

  function findKnown(sublocationId: string): SublocationDefinition | undefined {
    return (
      options.sublocations.find((s) => s.sublocation_id === sublocationId) ??
      stagedCreates.get(sublocationId)
    );
  }

  function allKnown(): SublocationDefinition[] {
    return [...options.sublocations, ...stagedCreates.values()];
  }

  /** The scene's reach (Rev 4 §7 reachable holders, V1): the current
   * sublocation, its parent, and its children — including stubs staged this
   * very turn. */
  function reachableSublocationIds(): string[] {
    const ids = new Set<string>([current]);
    const currentDef = findKnown(current);
    if (currentDef?.parent_id !== undefined) ids.add(currentDef.parent_id);
    for (const def of allKnown()) {
      if (def.parent_id === current) ids.add(def.sublocation_id);
    }
    return [...ids];
  }

  /** Resolve an interact_object ref against committed rows AND this turn's
   * staged objects (dedup by normalized name per holder — Rev 4 §7). */
  function resolveObjectRef(
    ref: string,
    reachable: readonly string[],
  ): StagedObjectView[] {
    const staged = stagedObjects.get(ref);
    if (staged !== undefined) return [staged];
    const committedById = options.storage.objects.byId(ref);
    if (committedById !== undefined) {
      const overlaid = stagedObjects.get(committedById.object_id);
      const view = overlaid ?? {
        objectId: committedById.object_id,
        name: committedById.name,
        holderSublocationId: committedById.holder_sublocation_id,
        hasPayload: committedById.payload !== undefined,
      };
      return reachable.includes(view.holderSublocationId) ? [view] : [];
    }
    const key = objectNameKey(ref);
    const byName = new Map<string, StagedObjectView>();
    for (const row of options.storage.objects.resolveName(
      options.worldId,
      ref,
      [...reachable],
    )) {
      byName.set(row.object_id, {
        objectId: row.object_id,
        name: row.name,
        holderSublocationId: row.holder_sublocation_id,
        hasPayload: row.payload !== undefined,
      });
    }
    // Staged views overlay committed rows of the same id and add this turn's
    // creations; a staged move can also carry an object out of reach.
    for (const view of stagedObjects.values()) {
      if (objectNameKey(view.name) !== key) continue;
      if (reachable.includes(view.holderSublocationId)) {
        byName.set(view.objectId, view);
      } else {
        byName.delete(view.objectId);
      }
    }
    return [...byName.values()];
  }

  return {
    apply(call: ValidatedToolCall, actorId?: string): Result<StagedToolEffect> {
      switch (call.tool) {
        case 'interact_object': {
          if (actorId === undefined) {
            // Only character calls pass an actor — the Narrator can never
            // stage an object (Rev 4 §7: write authority preserved).
            return err(
              new OperationalError(
                'object_needs_actor',
                'interact_object is a character tool',
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
          if (objectOps >= OBJECT_OPS_PER_TURN) {
            return err(
              new OperationalError(
                'object_op_limit',
                `at most ${String(OBJECT_OPS_PER_TURN)} object operations per turn — express the rest in your attempt instead`,
              ),
            );
          }
          const reachable = reachableSublocationIds();
          const moveTo = call.input.move_to;
          if (moveTo !== undefined) {
            if (findKnown(moveTo) === undefined) {
              return err(
                new OperationalError(
                  'unknown_sublocation',
                  `no sublocation ${moveTo} in this world`,
                ),
              );
            }
            if (!reachable.includes(moveTo)) {
              return err(
                new OperationalError(
                  'sublocation_out_of_reach',
                  `${moveTo} is not within this scene's reach`,
                ),
              );
            }
          }
          const payload = call.input.payload;
          const matches = resolveObjectRef(call.input.object, reachable);
          const [target, ambiguous] = matches;
          if (ambiguous !== undefined) {
            const listing = matches
              .map((m) => `${m.objectId} (at ${m.holderSublocationId})`)
              .join(', ');
            return err(
              new OperationalError(
                'object_ambiguous',
                `"${call.input.object}" matches several objects: ${listing} — call again with the object id`,
              ),
            );
          }
          if (target !== undefined) {
            // The existing row (dedup — Rev 4 §7): exactly one durable change
            // per call, or the fixed refusal.
            if (payload !== undefined && moveTo !== undefined) {
              return err(
                new OperationalError(
                  'object_one_op_per_call',
                  'one operation per call: author the payload OR move the object — call twice for both',
                ),
              );
            }
            if (payload !== undefined) {
              stagedObjects.set(target.objectId, {
                ...target,
                hasPayload: true,
              });
              const effect: StagedToolEffect = {
                kind: 'object_payload',
                objectId: target.objectId,
                payload,
                actorId,
              };
              effects.push(effect);
              objectOps += 1;
              return ok(effect);
            }
            if (moveTo !== undefined && moveTo !== target.holderSublocationId) {
              stagedObjects.set(target.objectId, {
                ...target,
                holderSublocationId: moveTo,
              });
              const effect: StagedToolEffect = {
                kind: 'object_move',
                objectId: target.objectId,
                fromSublocationId: target.holderSublocationId,
                toSublocationId: moveTo,
                actorId,
              };
              effects.push(effect);
              objectOps += 1;
              return ok(effect);
            }
            return err(
              new OperationalError(
                'object_nothing_durable',
                NOTHING_DURABLE_REFUSAL,
              ),
            );
          }
          // No match: materialize-on-touch (Rev 4 §7) — the first durable
          // interaction creates the row. An id-shaped ref that resolved to
          // nothing is a stale pointer, not a name to mint.
          if (call.input.object.startsWith('obj:')) {
            return err(
              new OperationalError(
                'unknown_object',
                `no object ${call.input.object} within reach — use its name to materialize a new one`,
              ),
            );
          }
          const name = call.input.object.trim();
          if (objectNameKey(name) === '') {
            return err(
              new OperationalError(
                'invalid_name',
                'the object name must contain at least one letter or digit',
              ),
            );
          }
          const holder = moveTo ?? current;
          const objectId = `obj:${slugifyName(name)}-${randomUUID().slice(0, 8)}`;
          stagedObjects.set(objectId, {
            objectId,
            name,
            holderSublocationId: holder,
            hasPayload: payload !== undefined,
          });
          const effect: StagedToolEffect = {
            kind: 'object_create',
            objectId,
            name,
            holderSublocationId: holder,
            ...(payload === undefined ? {} : { payload }),
            actorId,
          };
          effects.push(effect);
          objectOps += 1;
          return ok(effect);
        }
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
          // context_limit_reached is legal ONLY after the engine's warning
          // (0.21.0, Rev 4 §6) — recomputed per turn, so it survives kills.
          if (
            call.input.type === 'context_limit_reached' &&
            options.contextWarned !== true
          ) {
            return err(
              new OperationalError(
                'no_context_warning',
                'the engine has not warned about the context budget — close with rest, continuation or travel instead',
              ),
            );
          }
          if (call.input.type === 'continuation') {
            if (call.input.next_scene === undefined) {
              return err(
                new OperationalError(
                  'continuation_needs_next_scene',
                  'a continuation must register the full next_scene payload: sublocation_id, time_offset_hours, expected_participants, brief_history, carried_goals (premise_seed optional)',
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
            // Every expected participant must be a real character (staged
            // mints of this very turn included) — the registration opens the
            // next scene's cast, and an unknown id would ghost-join (B6).
            const unknown = call.input.next_scene.expected_participants.find(
              (id) => resolveCharacter(id) === undefined,
            );
            if (unknown !== undefined) {
              return err(
                new OperationalError(
                  'unknown_character',
                  `next_scene expects ${unknown}, which is not a character of this world`,
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
          // The follow-up marker's anchor must exist (M7 part 4, Rev 4 §14)
          // — a teaching refusal here; the drop gate re-checks materialized-
          // only at commit (a stub anchor is silently refused there and the
          // top-up keeps the map alive instead).
          if (
            call.input.follow_up_marker !== undefined &&
            findKnown(call.input.follow_up_marker.sublocation_id) === undefined
          ) {
            return err(
              new OperationalError(
                'unknown_sublocation',
                `follow_up_marker names ${call.input.follow_up_marker.sublocation_id}, which is not a sublocation of this world`,
              ),
            );
          }
          const next = call.input.next_scene;
          const followUp = call.input.follow_up_marker;
          const effect: StagedToolEffect = {
            kind: 'end_scene',
            endType: call.input.type,
            dividerText: call.input.divider_text,
            ...(next === undefined
              ? {}
              : {
                  // Gate 1 requires the full registration (0.21.0) — the
                  // effect carries it whole.
                  nextScene: {
                    sublocationId: next.sublocation_id,
                    ...(next.premise_seed === undefined
                      ? {}
                      : { premiseSeed: next.premise_seed }),
                    timeOffsetHours: next.time_offset_hours,
                    expectedParticipants: next.expected_participants,
                    briefHistory: next.brief_history,
                    carriedGoals: next.carried_goals,
                  },
                }),
            ...(followUp === undefined
              ? {}
              : {
                  followUpMarker: {
                    sublocationId: followUp.sublocation_id,
                    premiseSeed: followUp.premise_seed,
                  },
                }),
          };
          stagedEnd = effect;
          effects.push(effect);
          return ok(effect);
        }
        case 'describe_object': {
          // Write-on-first-read (M7 part 3, Rev 4 §7): Narrator improv is
          // persisted EXACTLY once — an existing payload refuses the write,
          // so the second read returns the same content by construction.
          if (!sceneIsOpen(options.storage, sceneId)) {
            return err(
              new OperationalError(
                'scene_not_open',
                `scene ${sceneId} is not open`,
              ),
            );
          }
          const reachable = reachableSublocationIds();
          const matches = resolveObjectRef(call.input.object, reachable);
          const [target, ambiguous] = matches;
          if (ambiguous !== undefined) {
            const listing = matches
              .map((m) => `${m.objectId} (at ${m.holderSublocationId})`)
              .join(', ');
            return err(
              new OperationalError(
                'object_ambiguous',
                `"${call.input.object}" matches several objects: ${listing} — call again with the object id`,
              ),
            );
          }
          if (target === undefined) {
            // The Narrator can never create objects (Rev 4 §7: write
            // authority preserved) — only fill ones a touch materialized.
            return err(
              new OperationalError(
                'unknown_object',
                `no object "${call.input.object}" within reach — objects only exist once a character's interaction materialized them`,
              ),
            );
          }
          if (target.hasPayload) {
            return err(
              new OperationalError(
                'payload_exists',
                `${target.objectId} already has written content — narrate its existing content instead`,
              ),
            );
          }
          stagedObjects.set(target.objectId, { ...target, hasPayload: true });
          const effect: StagedToolEffect = {
            kind: 'object_improv',
            objectId: target.objectId,
            payload: call.input.payload,
          };
          effects.push(effect);
          return ok(effect);
        }
        case 'make_character': {
          if (!sceneIsOpen(options.storage, sceneId)) {
            return err(
              new OperationalError(
                'scene_not_open',
                `scene ${sceneId} is not open`,
              ),
            );
          }
          const existing = resolveCharacter(call.input.character);
          if (existing !== undefined) {
            // An existing character: 'present' joins them here; 'absent'
            // changes nothing durable (they already exist offstage).
            if (call.input.presence === 'absent') {
              return err(
                new OperationalError(
                  'character_exists',
                  `${existing.character_id} ("${existing.name}") already exists — absent mints a NEW character; to remove someone from the scene use character_leave`,
                ),
              );
            }
            if (present.has(existing.character_id)) {
              return err(
                new OperationalError(
                  'already_present',
                  `${existing.character_id} is already in this scene`,
                ),
              );
            }
            const where = presence(existing.character_id);
            if (where.state === 'in_scene' && where.scene_id !== sceneId) {
              return err(
                new OperationalError(
                  'character_reserved',
                  `${existing.character_id} is busy in another scene — they cannot join here`,
                ),
              );
            }
            present.add(existing.character_id);
            const effect: StagedToolEffect = {
              kind: 'character_join',
              characterId: existing.character_id,
              name: existing.name,
            };
            effects.push(effect);
            return ok(effect);
          }
          // A genuinely new character (Rev 4 §6): minted into the world —
          // the same character.created the consent-gated GM path appends.
          // A mint needs enough profile to be callable (C-Module inputs).
          if (
            call.input.personality === undefined ||
            call.input.goals === undefined
          ) {
            return err(
              new OperationalError(
                'mint_needs_profile',
                `no character "${call.input.character}" exists — minting a new one requires personality and goals (most background figures should stay prose)`,
              ),
            );
          }
          const name = call.input.character.trim();
          const slug = slugifyName(name);
          if (slug === '') {
            return err(
              new OperationalError(
                'invalid_name',
                'the character name must contain at least one letter or digit',
              ),
            );
          }
          const characterId = `char:${slug}`;
          const isPresent = call.input.presence === 'present';
          stagedMints.set(characterId, { character_id: characterId, name });
          if (isPresent) present.add(characterId);
          const effect: StagedToolEffect = {
            kind: 'character_mint',
            characterId,
            name,
            personality: call.input.personality,
            goals: call.input.goals,
            core: call.input.core ?? [],
            present: isPresent,
          };
          effects.push(effect);
          return ok(effect);
        }
        case 'character_leave': {
          if (!sceneIsOpen(options.storage, sceneId)) {
            return err(
              new OperationalError(
                'scene_not_open',
                `scene ${sceneId} is not open`,
              ),
            );
          }
          if (!present.has(call.input.character_id)) {
            return err(
              new OperationalError(
                'character_not_present',
                `${call.input.character_id} is not in this scene`,
              ),
            );
          }
          present.delete(call.input.character_id);
          const effect: StagedToolEffect = {
            kind: 'character_leave',
            characterId: call.input.character_id,
            ...(call.input.reason === undefined
              ? {}
              : { reason: call.input.reason }),
          };
          effects.push(effect);
          return ok(effect);
        }
        case 'move_character': {
          const moved = resolveCharacter(call.input.character_id);
          if (moved === undefined) {
            return err(
              new OperationalError(
                'unknown_character',
                `no character ${call.input.character_id} in this world`,
              ),
            );
          }
          if (present.has(moved.character_id)) {
            return err(
              new OperationalError(
                'character_present',
                `${moved.character_id} is in this scene — narrate their exit and call character_leave first, then move them`,
              ),
            );
          }
          const where = presence(moved.character_id);
          if (where.state === 'in_scene' && where.scene_id !== sceneId) {
            return err(
              new OperationalError(
                'character_reserved',
                `${moved.character_id} is busy in another scene — they cannot be moved`,
              ),
            );
          }
          if (findKnown(call.input.to_sublocation_id) === undefined) {
            return err(
              new OperationalError(
                'unknown_sublocation',
                `no sublocation ${call.input.to_sublocation_id} in this world`,
              ),
            );
          }
          const effect: StagedToolEffect = {
            kind: 'character_move',
            characterId: moved.character_id,
            toSublocationId: call.input.to_sublocation_id,
          };
          effects.push(effect);
          return ok(effect);
        }
        case 'update_goals': {
          if (!sceneIsOpen(options.storage, sceneId)) {
            return err(
              new OperationalError(
                'scene_not_open',
                `scene ${sceneId} is not open`,
              ),
            );
          }
          // A later snapshot in the same turn replaces the earlier one whole
          // (the tool's contract: the full list, every time).
          const previous = effects.findIndex((e) => e.kind === 'goals');
          if (previous !== -1) effects.splice(previous, 1);
          const effect: StagedToolEffect = {
            kind: 'goals',
            goals: call.input.goals,
          };
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
          if (!present.has(call.input.character_id)) {
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
    currentSublocation(): string {
      return current;
    },
    presentCharacters(): readonly string[] {
      return [...present];
    },
    declareNext(input: unknown): string {
      const parsed = DetermineWhoNextToolSchema.safeParse(input);
      if (!parsed.success) {
        return (
          'determine_who_next: malformed input. Use {"character_ids": ' +
          '["char:..."]} — the characters who should act next.'
        );
      }
      // The set-typed contract, V1 policy size one (Rev 4 §6): the type
      // keeps V2 group fan-out open; the POLICY keeps V1 strictly serial.
      const [first, second] = parsed.data.character_ids;
      if (second !== undefined || first === undefined) {
        return 'determine_who_next: this engine runs characters strictly one at a time — declare exactly ONE character_id, call charactercall, then declare the next.';
      }
      if (!present.has(first)) {
        const cast = [...present].join(', ');
        return `determine_who_next: ${first} is not in this scene. Present: ${cast === '' ? 'nobody' : cast}.`;
      }
      declaredNext.clear();
      declaredNext.add(first);
      return `declared: ${first} acts next — call charactercall with this character_id.`;
    },
    consumeDeclared(characterId: string): Result<void> {
      if (!declaredNext.has(characterId)) {
        return err(
          new OperationalError(
            'not_declared',
            `${characterId} was not declared — call determine_who_next first (and make sure they are present in the scene)`,
          ),
        );
      }
      declaredNext.delete(characterId);
      return ok(undefined);
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
      stagedObjects.clear();
      objectOps = 0;
      parentlessQueried = false;
      // The cast rolls back to the turn-start roster (0.21.0): staged
      // joins/mints/leaves never happened.
      present.clear();
      for (const id of options.presentCharacterIds) present.add(id);
      stagedMints.clear();
      declaredNext.clear();
    },
  };
}
