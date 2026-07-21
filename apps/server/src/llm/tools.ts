// Narrator tool definitions + gate 1 of the B6 double gate. Tool defs live in
// src/llm/ (Guide §0.6 layout; the AI SDK's tool() helper is fenced here — the
// real client builds SDK tools from these same schemas). Gate 2 — validating a
// well-formed call against game state — lives in engine/scene-tools.ts.
// Provider-returned tool inputs are boundary data (B-llm): re-checked with our
// own safeParse even when the SDK "guarantees" the shape (Guide B6).
import { z } from 'zod';
import { validateAt } from '../boundary/validate.js';
import { err, OperationalError, type Result } from '../errors.js';
import type { Logger } from '../observability/logger.js';

/**
 * end_scene — the scene's real closer (replaces the bare end-scene HTTP
 * command as the in-fiction path). `type` drives the soft-close button set
 * (UI Spec §1.7): rest → Stay/Map, continuation → Stay/Jump/Map, travel →
 * Map, context_limit_reached (0.21.0, Rev 4 §6: the engine's context-budget
 * warning told the Narrator to wind down) → like rest.
 */
export const EndSceneToolSchema = z.strictObject({
  type: z.enum(['rest', 'continuation', 'travel', 'context_limit_reached']),
  /** Soft-close divider line, e.g. "— evening falls —". */
  divider_text: z.string().min(1).max(200).optional(),
  /**
   * The FULL next-scene registration (Rev 4 §6, 0.21.0) — REQUIRED when type
   * is `continuation` (the engine-state gate refuses one without it): where
   * and how "Jump to the next scene" opens as a real continuation. Every
   * field except premise_seed is required HERE at gate 1, so a partial
   * registration fails with the missing fields named and the Narrator
   * re-calls (the correction loop). May name a stub created this very turn.
   */
  next_scene: z
    .strictObject({
      sublocation_id: z.string().min(1),
      /** Optional premise line the follow-up scene opens on. */
      premise_seed: z.string().min(1).max(500).optional(),
      /** Game-time the continuation skips ("see you tomorrow" ≈ 16; 0 = it
       * follows immediately). */
      time_offset_hours: z.number().nonnegative().max(720),
      /** Character ids expected in the follow-up scene (may be empty). */
      expected_participants: z.array(z.string().min(1)).max(8),
      /** What just happened — carried verbatim into the next scene's
       * context so the jump is a continuation, never a cold open. */
      brief_history: z.string().min(1).max(2000),
      /** Story goals the continuation keeps chasing (may be empty). */
      carried_goals: z.array(z.string().min(1).max(300)).max(8),
    })
    .optional(),
  /**
   * The follow-up chance-encounter marker (M7 part 4, Rev 4 §14): the ending
   * scene may leave a lazy "!" on the map — a place and a premise seed,
   * nothing generated until clicked. Valid with every end type; a scene that
   * leaves none still keeps the map alive via the engine top-up.
   */
  follow_up_marker: z
    .strictObject({
      sublocation_id: z.string().min(1),
      /** The intent seed the click-time Narrator grounds in current state. */
      premise_seed: z.string().min(1).max(500),
    })
    .optional(),
});
export type EndSceneToolInput = z.infer<typeof EndSceneToolSchema>;

/**
 * create_sublocation — the in-scene creation loop's hot path (Rev 4 §6): the
 * engine commits an identity stub atomically with the turn; the backdrop job
 * fires immediately; a parentless stub also enqueues materialization. The
 * engine-state gate enforces the parentless query-first rule and the
 * did-you-mean near-duplicate rejection.
 */
export const CreateSublocationToolSchema = z.strictObject({
  name: z.string().min(1).max(120),
  /** The Narrator's one-line brief — becomes the stub's description. */
  brief: z.string().min(1).max(2000),
  /** The exterior-atomic parent for an interior (always flat, Rev 4 §6).
   * Absent = parentless: a genuinely new exterior-atomic place. */
  parent_id: z.string().min(1).optional(),
  /** Prose placement hint for parentless creates ("near the riverside") —
   * recorded; placement itself is code-owned (Rev 4 §14). */
  narrative_anchor: z.string().min(1).max(200).optional(),
});
export type CreateSublocationToolInput = z.infer<
  typeof CreateSublocationToolSchema
>;

/**
 * query_sublocations — hard-coded read-only lookup (Rev 4 §6), executed by
 * the ENGINE during the call (queries route context, they never mutate — the
 * B6 double gate applies to mutations). Mode `parentless` is the strict
 * prerequisite for any parentless create.
 */
export const QuerySublocationsToolSchema = z.strictObject({
  mode: z.enum(['parentless', 'children', 'search']),
  /** mode `children`: the parentless parent whose interiors to list. */
  parent_id: z.string().min(1).optional(),
  /** mode `search`: keyword matched against names and descriptions. */
  keyword: z.string().min(1).max(120).optional(),
});

/** change_sublocation — moves the scene backdrop (UI Spec §1.6). */
export const ChangeSublocationToolSchema = z.strictObject({
  sublocation_id: z.string().min(1),
});
export type ChangeSublocationToolInput = z.infer<
  typeof ChangeSublocationToolSchema
>;

/** switch_art — swaps a present character's displayed pose (UI Spec §1.5). */
export const SwitchArtToolSchema = z.strictObject({
  character_id: z.string().min(1),
  art_id: z.string().min(1),
});
export type SwitchArtToolInput = z.infer<typeof SwitchArtToolSchema>;

/**
 * describe_object — write-on-first-read (M7 part 3, Rev 4 §7): a public
 * object examined with NO payload gets the Narrator's improvised content
 * persisted exactly once — the engine gate refuses a write over an existing
 * payload, so the second read returns the SAME content by construction. The
 * Narrator can never create or move objects (write authority preserved);
 * this is its one object surface.
 */
export const DescribeObjectToolSchema = z.strictObject({
  /** The object: its id from the scene context, or its name. */
  object: z.string().min(1).max(120),
  /** The improvised content — what the object is and/or contains. */
  payload: z.string().min(1).max(4000),
});
export type DescribeObjectToolInput = z.infer<typeof DescribeObjectToolSchema>;

/**
 * determine_who_next — the agentic scene's routing declaration (0.21.0,
 * Rev 4 §6): the Narrator declares WHO speaks next as a SET of character ids.
 * Mid-call-only (an engine executor, never staged): the set type is the
 * contract that keeps V2 group fan-out open at zero cost — the V1 POLICY
 * (engine-enforced) is always size one, strictly sequential.
 */
export const DetermineWhoNextToolSchema = z.strictObject({
  /** The characters who should act next (V1: exactly one). */
  character_ids: z.array(z.string().min(1)).min(1).max(4),
});

/**
 * charactercall — run a present character's turn mid-loop (0.21.0, Rev 4
 * §6/§7): the ENGINE builds the character prompt and runs the C-Module; the
 * reply (message + attempt) returns to the Narrator as this tool's result —
 * the same mid-call seam the GM's wikiquery and the durable tool-result turn
 * use. Mid-call-only; the engine's turn budget refuses calls past the cap.
 */
export const CharactercallToolSchema = z.strictObject({
  character_id: z.string().min(1),
  /** What this call should accomplish, in one line ("react to the knock";
   * a scene-end leave seed goes here too — Rev 4 §6 soft close). */
  seed: z.string().min(1).max(500).optional(),
});

/**
 * make_character — a character enters the story (0.21.0, Rev 4 §6): an
 * EXISTING character joins the scene (`presence: 'present'`), or a genuinely
 * new character is minted into the world (character.created — the same event
 * the consent-gated GM path appends) present or offstage (`'absent'`).
 * Mutating — both B6 gates; presence gates apply (a character reserved by
 * another scene cannot join).
 */
export const MakeCharacterToolSchema = z.strictObject({
  /** The character: an id (`char:...`) or name for existing ones; the new
   * character's name when minting. */
  character: z.string().min(1).max(120),
  presence: z.enum(['present', 'absent']),
  /** REQUIRED when minting a new character (the engine gate refuses a mint
   * without it): their full personality text. */
  personality: z.string().min(1).max(1000).optional(),
  /** REQUIRED when minting: 1-8 short goal lines. */
  goals: z.array(z.string().min(1).max(300)).min(1).max(8).optional(),
  /** Optional seed memories a minted character starts life knowing. */
  core: z.array(z.string().min(1).max(300)).max(12).optional(),
});
export type MakeCharacterToolInput = z.infer<typeof MakeCharacterToolSchema>;

/**
 * character_leave — a present character exits the scene (0.21.0, Rev 4 §6):
 * commits character.left atomically with the turn — presence releases for
 * this scene only (chat shows them available; CRON movement may pick them),
 * while the scene stays open. Mutating — both B6 gates.
 */
export const CharacterLeaveToolSchema = z.strictObject({
  character_id: z.string().min(1),
  /** Optional in-fiction reason ("headed home before the rain"). */
  reason: z.string().min(1).max(300).optional(),
});
export type CharacterLeaveToolInput = z.infer<typeof CharacterLeaveToolSchema>;

/**
 * move_character — reposition a character on the world map (0.21.0, Rev 4
 * §6/§14): commits character.location_changed atomically with the turn
 * (actor = the narrator — the documented hot-path exception CRON movement
 * already uses). For characters NOT in any scene; a character present HERE
 * must character_leave first, and one reserved by another scene is refused.
 */
export const MoveCharacterToolSchema = z.strictObject({
  character_id: z.string().min(1),
  to_sublocation_id: z.string().min(1),
});
export type MoveCharacterToolInput = z.infer<typeof MoveCharacterToolSchema>;

/**
 * update_goals — the storytelling subgoal snapshot (0.21.0, Rev 4 §6): the
 * FULL structured state, written out explicitly (the opposite of semantic
 * key-compression — code just stores it). Commits scene.goals_updated
 * atomically with the turn; the engine reinjects the latest snapshot every
 * Narrator turn, so resume restores the exact story position. Mutating —
 * both B6 gates; a later call in the same turn replaces the earlier one.
 */
export const UpdateGoalsToolSchema = z.strictObject({
  goals: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(60),
        text: z.string().min(1).max(300),
        status: z.enum(['pending', 'active', 'done']),
      }),
    )
    .min(1)
    .max(12),
});
export type UpdateGoalsToolInput = z.infer<typeof UpdateGoalsToolSchema>;

/**
 * query_wiki — the Narrator's scene-side wiki read (0.21.0, Rev 4 §6):
 * the same engine executor chat, the GM and character scene turns already
 * use (runWikiquery), offered under the §6 tool name. Mid-call-only.
 */
export const QueryWikiToolSchema = z.strictObject({
  /** Keywords about a place ("the flooded cellar", "charcoal camp"). */
  query: z.string().min(1).max(200),
});

export const NARRATOR_TOOL_NAMES = [
  'end_scene',
  'change_sublocation',
  'switch_art',
  'create_sublocation',
  'query_sublocations',
  'query_wiki',
  'describe_object',
  'determine_who_next',
  'charactercall',
  'make_character',
  'character_leave',
  'move_character',
  'update_goals',
] as const;
export type NarratorToolName = (typeof NARRATOR_TOOL_NAMES)[number];

/** Static descriptions the real client hands the SDK (stable strings — never scene state). */
export const NARRATOR_TOOL_DESCRIPTIONS: Record<NarratorToolName, string> = {
  end_scene:
    'Softly close the current scene. type: rest (a natural pause), continuation (a next scene follows), travel (the party moves elsewhere), context_limit_reached (ONLY after the engine warned you the context budget is near — wind the scene down naturally first). If the fiction agreed on a next meeting ("see you tomorrow", "meet me at the stilt-house"), close with continuation and register it — rest is only for scenes with no agreed follow-up. Optionally give a short divider line like "— evening falls —". A continuation MUST include the full next_scene registration: sublocation_id (may be a stub you created this turn), time_offset_hours (game time the jump skips; 0 = immediately), expected_participants (character ids, may be empty), brief_history (what just happened, 1-3 sentences — the next scene opens on it), carried_goals (story goals still in play, may be empty), and optionally a premise_seed. A partial registration is refused with the missing fields named — call again complete. Optionally leave a follow_up_marker: a sublocation_id plus a one-line premise_seed for a later chance encounter growing out of this scene — it becomes a lazy "!" on the map the user may visit (or ignore) while its window lasts.',
  determine_who_next:
    'Declare who acts next: character_ids = the present characters who should respond to the current beat (this version accepts exactly ONE id per declaration — declare, call the character, then declare again if someone else should follow). The engine confirms the declaration; then call charactercall for that character. Declare only characters present in the scene.',
  charactercall:
    'Run a present character\'s turn NOW: the engine builds their private prompt and their reply (speech and action) returns to you as this tool\'s result — narrate its observable surface into the scene, keeping spoken words verbatim. seed (optional): one line on what this call should accomplish ("react to the knock"; when the scene is winding down, a gentle reason they might leave). Declare the character with determine_who_next first. The engine enforces a per-turn budget — when it says the budget is spent, stop calling characters and close your narration.',
  make_character:
    'Bring a character into the story. An EXISTING character (give their id or name) with presence "present" joins this scene — they must not be busy in another scene. A genuinely NEW character is minted into the world: give their name, personality (their full personality text) and goals (1-8 short lines), plus optional core seed memories; presence "present" also joins them here, "absent" creates them offstage for later. Most background figures stay prose — mint only characters the story will genuinely use again.',
  character_leave:
    'A present character exits the scene: narrate their exit and call this with their character_id (and an optional one-line reason). They become available elsewhere in the world; the scene continues without them.',
  move_character:
    'Reposition a character on the world map: character_id + to_sublocation_id. For characters who are NOT in a scene right now — someone present here must character_leave first (their exit narrated), and a character busy in another scene cannot be moved. Use it to send people where the story needs them next.',
  update_goals:
    'Persist your storytelling subgoal state: goals = the FULL current list, each {id, text, status: pending|active|done}. Call it whenever a subgoal advances or the plan changes — the engine reinjects your latest snapshot every turn, and after a restart this snapshot is exactly where the story resumes. Write the complete list every time; it replaces the previous snapshot whole.',
  change_sublocation:
    'Move the scene to another sublocation of this location. Use a sublocation_id offered in the scene context (a sublocation you created this turn works too).',
  switch_art:
    'Switch a present character to another named art pose from their art set listed in the scene context.',
  create_sublocation:
    'Create a new place mid-scene when the story commits to it (the scene moves there, or the next scene opens there) — mentioning a place in prose costs nothing and needs no tool call. One sublocation = one backdrop image: if a single background image can stage it, it is one sublocation (a park, a market square, a bridge); if only an aerial view could, name the stage inside it instead. An interior of the current location gets parent_id = the current exterior-atomic sublocation (always flat, never nested). A genuinely new parentless place requires calling query_sublocations with mode "parentless" first, in this same reply: if an existing sublocation plausibly fits, use change_sublocation instead of creating.',
  query_sublocations:
    'Look up existing sublocations before creating or moving. mode "parentless" lists every exterior-atomic place (REQUIRED before any parentless create_sublocation); mode "children" lists the interiors under parent_id; mode "search" matches keyword against names and descriptions. The result returns to you immediately.',
  query_wiki:
    'Look up what is publicly known about a place: searches the world wiki (place names, descriptions, latest entries). Use it when the scene needs a detail your context does not hold. The result returns to you immediately.',
  describe_object:
    'Persist your improvised content for a durable object that has NONE yet (the scene context marks these "nothing written yet"): when someone examines such an object, improvise what it is or contains in your narration AND record exactly that here, so every later read returns the same content. Only works once per object — an object that already has content must be narrated from its existing content instead.',
};

/**
 * cache — the character's mandatory 1–2 line private recap after every chat
 * reply (M6 part 2, Rev 4 §11: CACHE is written every trigger; the character
 * authors ONLY the one-liner — every structured field is engine-written).
 * Data-only: the chat engine gates and appends it, never the SDK.
 */
export const CacheToolSchema = z.strictObject({
  line: z.string().min(1).max(300),
});
export type CacheToolInput = z.infer<typeof CacheToolSchema>;

/**
 * startscene — the chat-side bridge (Rev 4 §8: THE way back into scenes).
 * The character proposes ending the chat into a live scene; the engine ends
 * the conversation range and opens the scene. `place` is required (Rev 4 §7):
 * an existing sublocation or a free-text place string — the Narrator resolves
 * it at scene open via the standard workflow. Characters can never create
 * sublocations themselves.
 */
export const StartSceneToolSchema = z.strictObject({
  place: z.string().min(1).max(200),
  /** Optional one-line premise the scene opens on. */
  premise: z.string().min(1).max(500).optional(),
  /**
   * REQUIRED (0.13.0, Rev 4 §7, owner ruling 2026-07-10/11): how many
   * in-world hours the character will wait at the place before giving up —
   * the character's own model decision, never an env default. The engine
   * stamps the resulting game-clock expiry at scene open; a call without it
   * is rejected with a hardcoded correction and the character resubmits.
   */
  wait_hours: z.number().positive().max(720),
});
export type StartSceneToolInput = z.infer<typeof StartSceneToolSchema>;

/**
 * stay_silent — the character's explicit decline of a proactive fire (M6
 * part 4, owner ruling 2026-07-11: never an empty reply or a silent skip —
 * the decision is a tool call). Data-only; the proactive handler treats it
 * as "this fire stays quiet" and nothing durable happens.
 */
export const StaySilentToolSchema = z.strictObject({
  /** Optional one-line private reason (log-only). */
  reason: z.string().min(1).max(200).optional(),
});
export type StaySilentToolInput = z.infer<typeof StaySilentToolSchema>;

export const CHAT_TOOL_NAMES = ['cache', 'startscene', 'stay_silent'] as const;
export type ChatToolName = (typeof CHAT_TOOL_NAMES)[number];

/**
 * The chat query escalation (M6 part 3, Rev 4 §11): "latest-per-origin
 * instantly; escalate to scene-query → session read for specifics". Both are
 * READ-ONLY mid-call executors on the chat toolset — they run through the
 * proven LlmCall.queries seam (week 9/10) and are never staged as data.
 * memoryquery waits for the real memory store (M7) — deferred, not stubbed.
 */
export const WikiqueryToolSchema = z.strictObject({
  /** Keywords about a place ("the flooded cellar", "charcoal camp"). */
  query: z.string().min(1).max(200),
});

export const SessionqueryToolSchema = z.strictObject({
  /** Keywords about a past scene you took part in. */
  query: z.string().min(1).max(200),
});

/** memoryquery (M7 part 1, Rev 4 §11): the FTS5 deep dive into the
 * character's OWN memory deltas — the escalation past the always-injected
 * core. Mid-call-only like every query. */
export const MemoryqueryToolSchema = z.strictObject({
  /** Keywords about the character's own past experiences. */
  query: z.string().min(1).max(200),
});

/**
 * explore (M7 part 3, Rev 4 §14): pure retrieval, no LLM call — the
 * sublocation's wiki + the objects publicly held there + the sublocations one
 * level deeper. Exploring is the character's choice; the information is open
 * to anyone present. Mid-call-only like every query.
 */
export const ExploreToolSchema = z.strictObject({
  /** The sublocation to explore; omit for the scene's current one. */
  sublocation_id: z.string().min(1).optional(),
});

/**
 * interact_object (M7 part 3, Rev 4 §7): the character's ONE mutating scene
 * tool — create/move an item or author its written content. Engine gate:
 * accepted only if it changes a holder or writes a payload; anything else is
 * rejected with "express it in your attempt instead" — prose stays prose by
 * construction. Max 2 object ops per turn; a ref matching an existing name at
 * a reachable holder resolves to the existing row (dedup). V1 holders are
 * sublocations only (owner ruling 2026-07-16: backpacks are V2).
 */
export const InteractObjectToolSchema = z.strictObject({
  /** The object: a name ("the brass key") or an object id from an earlier
   * staged-ack / explore result. */
  object: z.string().min(1).max(120),
  /** Written/authored content — what the object is and/or contains. */
  payload: z.string().min(1).max(4000).optional(),
  /** Move the object to this sublocation (must be within the scene's reach). */
  move_to: z.string().min(1).optional(),
});
export type InteractObjectToolInput = z.infer<typeof InteractObjectToolSchema>;

export const CHARACTER_SCENE_TOOL_NAMES = ['interact_object'] as const;
export type CharacterSceneToolName =
  (typeof CHARACTER_SCENE_TOOL_NAMES)[number];

/** Static descriptions for the character's scene toolset (stable strings). */
export const CHARACTER_SCENE_TOOL_DESCRIPTIONS: Record<
  CharacterSceneToolName,
  string
> = {
  interact_object:
    "Make a physical object durable — use it ONLY when the interaction has a lasting consequence: you place or drop an item somewhere, move it elsewhere, or author written content into it (a letter's text goes in payload). An important object directly impacts goals, alters relationships, has utility, shifts the story, or holds high intrinsic value — everything else stays prose and needs no tool call. object: its name, or an id you were given. payload: the authored content. move_to: the sublocation_id it moves to. A call that would change nothing durable is rejected — express it in your attempt instead. At most 2 object operations per turn.",
};

/** Static description for the explore listing (M7 part 3 — character scene
 * turns only; stable string, never state). */
export const EXPLORE_QUERY_DESCRIPTION =
  'Look around a place: returns what is publicly known about the sublocation (its wiki), the objects lying there openly (anyone present may take or read them), and the places one level deeper inside it. Omit sublocation_id for where you are now. The result returns to you immediately; the information is open to everyone present.';

export const CHAT_QUERY_DESCRIPTIONS = {
  wikiquery:
    'Look up what is publicly known about a place: searches the world wiki (place names, descriptions, latest entries). Use it when the User asks about a location and your instant recall is not enough. The result returns to you immediately.',
  sessionquery:
    'Recall a past scene YOU took part in: searches your scenes by their recaps and returns the best match with its final lines. You can only read scenes you were present in. Use it when the User asks about something specific that happened. The result returns to you immediately.',
  memoryquery:
    'Search your OWN long-term memories: your permanent private notes about things you experienced and learned, back to the very beginning. Use it when something from your past is referenced and your always-present core memory does not hold the detail. Only your own memories are searchable. The result returns to you immediately.',
} as const;

/** Static descriptions for the chat toolset (stable strings — never state). */
export const CHAT_TOOL_DESCRIPTIONS: Record<ChatToolName, string> = {
  cache:
    'REQUIRED after every reply: record a private 1-2 line recap of what just happened in this conversation, in your own words ("line"). This is your own short-term memory pointer — nobody else reads it.',
  startscene:
    'Open the meeting you and the User agreed on: ends this chat and opens a live scene with you and the User. place (required): where to meet — a sublocation you know, or a short place description like "the park". wait_hours (required): how many in-world hours you will wait at the place before giving up — your own choice, whatever fits your character and the plan (someone eager may wait long; a busy person may not). premise (optional): one line on how the meeting starts. Fire it YOURSELF, in the same reply where the meeting is settled — the User cannot open it. Do not fire it before a place is agreed; ask for the missing piece first.',
  stay_silent:
    'Choose to send nothing right now. Use it when you were free to reach out but have nothing you genuinely want to say — entirely your choice. reason (optional): one short private line on why.',
};

/**
 * memory_delta — one curated recall note for the character's permanent
 * archive (M7 part 1, Rev 4 §11). 1–3 per reflection (the engine gate caps);
 * data-only — the reflection handler gates and appends.
 */
export const MemoryDeltaToolSchema = z.strictObject({
  content: z.string().min(1).max(1000),
});
export type MemoryDeltaToolInput = z.infer<typeof MemoryDeltaToolSchema>;

/**
 * update_core — the FULL replacement snapshot of the character's durable
 * memory core (M7 part 1, Rev 4 §11): small, always injected. At most one
 * per reflection (the engine gate keeps the last). Data-only.
 */
export const UpdateCoreToolSchema = z.strictObject({
  core: z.array(z.string().min(1).max(300)).min(1).max(12),
});
export type UpdateCoreToolInput = z.infer<typeof UpdateCoreToolSchema>;

/**
 * evolve — personality/goals evolution (M7 part 1, Rev 4 §7, owner ruling
 * 2026-07-11): full replacements, at least one field (the engine gate
 * refuses an empty call, and refuses EVERYTHING for a locked character).
 * Data-only.
 */
export const EvolveToolSchema = z.strictObject({
  personality: z.string().min(1).max(1000).optional(),
  goals: z.array(z.string().min(1).max(300)).min(1).max(8).optional(),
});
export type EvolveToolInput = z.infer<typeof EvolveToolSchema>;

export const REFLECTION_TOOL_NAMES = [
  'memory_delta',
  'update_core',
  'evolve',
] as const;
export type ReflectionToolName = (typeof REFLECTION_TOOL_NAMES)[number];

/** Static descriptions for the reflection toolset (stable strings). */
export const REFLECTION_TOOL_DESCRIPTIONS: Record<ReflectionToolName, string> =
  {
    memory_delta:
      'Record ONE lasting memory from what just happened: a self-contained first-person note your future self will search for (who, what, where — names matter). Call it 1-3 times, one distinct memory each. These notes are permanent; only record what genuinely matters to you.',
    update_core:
      'Rewrite your always-remembered core: the FULL list of identity-defining facts, active relationships and open threads you must never lose (max 12 short lines). Only call this when something changed what you fundamentally know or pursue — the new list REPLACES the old one entirely, so carry forward everything still true.',
    evolve:
      'Evolve who you are, only if this experience genuinely changed you: personality = your full rewritten personality text, and/or goals = your full new goals list. Both are complete replacements. Most reflections should NOT call this — character change is rare and earned.',
  };

/** A reflection tool call that passed gate 1. Gate 2 (state) still applies. */
export type ValidatedReflectionToolCall =
  | { tool: 'memory_delta'; input: MemoryDeltaToolInput }
  | { tool: 'update_core'; input: UpdateCoreToolInput }
  | { tool: 'evolve'; input: EvolveToolInput };

/**
 * Gate 1 for the reflection toolset (M7 part 1): shape-validate one raw call
 * from a reflection. Same contract as every parse here — reject as a value,
 * zero rows (I8).
 */
export function parseReflectionToolCall(
  raw: RawToolCall,
  logger: Logger,
): Result<ValidatedReflectionToolCall> {
  switch (raw.tool) {
    case 'memory_delta': {
      const input = validateAt(
        'llm',
        'tool:memory_delta',
        MemoryDeltaToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? { ok: true, value: { tool: 'memory_delta', input: input.value } }
        : input;
    }
    case 'update_core': {
      const input = validateAt(
        'llm',
        'tool:update_core',
        UpdateCoreToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? { ok: true, value: { tool: 'update_core', input: input.value } }
        : input;
    }
    case 'evolve': {
      const input = validateAt(
        'llm',
        'tool:evolve',
        EvolveToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? { ok: true, value: { tool: 'evolve', input: input.value } }
        : input;
    }
    default:
      return err(
        new OperationalError(
          'unknown_tool',
          `no such reflection tool: ${raw.tool}`,
        ),
      );
  }
}

/**
 * react — one recipient's reaction decision on a feed post (M6 part 5,
 * Rev 4 §12): like, or a one-line comment. Data-only like every chat tool —
 * the social_reaction handler gates and appends; the engine enforces
 * "body present iff comment". Declining is the existing stay_silent.
 */
export const ReactToolSchema = z.strictObject({
  kind: z.enum(['like', 'comment']),
  /** The one-line comment text — required for kind `comment`, forbidden
   * for `like` (the engine-state gate enforces it). */
  body: z.string().min(1).max(300).optional(),
});
export type ReactToolInput = z.infer<typeof ReactToolSchema>;

export const SOCIAL_REACT_TOOL_NAMES = [
  'react',
  'stay_silent',
  'cache',
] as const;
export type SocialReactToolName = (typeof SOCIAL_REACT_TOOL_NAMES)[number];

/** Static descriptions for the social-react toolset (stable strings). */
export const SOCIAL_REACT_TOOL_DESCRIPTIONS: Record<
  SocialReactToolName,
  string
> = {
  react:
    'React to the post you just read: kind "like" (a simple like, no text) or kind "comment" with body = ONE short line in your own voice. React at most once. Comments are public to the poster\'s acquaintances and do not thread — nobody can reply to your comment except the User.',
  stay_silent:
    'Choose not to react to this post. Use it when you would realistically scroll past — entirely your choice. reason (optional): one short private line on why.',
  cache: CHAT_TOOL_DESCRIPTIONS.cache,
};

/**
 * The Group-chat Narrator toolset (M6 part 4, Rev 4 §8): routes turns ONLY —
 * it NEVER narrates (any text it produces is dropped un-surfaced); the
 * engine enforces the turn budget on top. Data-only, like every chat tool.
 */
export const RouteToolSchema = z.strictObject({
  /** The member who speaks next — a character id from the Members list. */
  next_character_id: z.string().min(1).max(100),
});
export type RouteToolInput = z.infer<typeof RouteToolSchema>;

export const EndSubsessionToolSchema = z.strictObject({});

export const GROUP_ROUTER_TOOL_DESCRIPTIONS = {
  route:
    'Pick which member speaks next: next_character_id must be a character id from the Members list. Call it when that character would naturally respond to the last line.',
  endsubsession:
    'End this group round: the conversation reached a natural resting point and nobody else would realistically jump in right now.',
} as const;

export type ValidatedGroupRouterCall =
  { tool: 'route'; input: RouteToolInput } | { tool: 'endsubsession' };

/** Gate 1 for the Group-chat Narrator's routing calls (same contract as
 * every parse here: reject as a value, zero rows). */
export function parseGroupRouterCall(
  raw: RawToolCall,
  logger: Logger,
): Result<ValidatedGroupRouterCall> {
  switch (raw.tool) {
    case 'route': {
      const input = validateAt(
        'llm',
        'tool:route',
        RouteToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? { ok: true, value: { tool: 'route', input: input.value } }
        : input;
    }
    case 'endsubsession': {
      const input = validateAt(
        'llm',
        'tool:endsubsession',
        EndSubsessionToolSchema,
        raw.input,
        logger,
      );
      return input.ok ? { ok: true, value: { tool: 'endsubsession' } } : input;
    }
    default:
      return err(
        new OperationalError(
          'unknown_tool',
          `no such group-router tool: ${raw.tool}`,
        ),
      );
  }
}

/**
 * The GM toolset (M7 part 2, Rev 4 §9/§16): every authoring tool is a
 * PROPOSAL — data-only here, gate-1 parsed, then re-shaped through the wire
 * union and gate-2 checked by the proposal engine; nothing the GM says is
 * durable world change until the user approves the card. The diff shapes
 * mirror the protocol's ProposalPlaceDiff / ProposalCharacterDiff on
 * purpose: a tool input that drifts from the wire union is refused at the
 * submit seam, visibly.
 */
export const ProposePlaceToolSchema = z.strictObject({
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
  space: z.enum(['public', 'private']),
  wiki_entry: z.string().min(1).max(4000).optional(),
  rationale: z.string().min(1).max(1000),
});
export type ProposePlaceToolInput = z.infer<typeof ProposePlaceToolSchema>;

export const ProposeCharacterToolSchema = z.strictObject({
  name: z.string().min(1).max(120),
  personality: z.string().min(1).max(1000),
  goals: z.array(z.string().min(1).max(300)).min(1).max(8),
  /** Optional — the submit seam normalizes absence to []. */
  core: z.array(z.string().min(1).max(300)).max(12).optional(),
  skills: z.array(z.string().min(1).max(300)).max(8).optional(),
  rationale: z.string().min(1).max(1000),
});
export type ProposeCharacterToolInput = z.infer<
  typeof ProposeCharacterToolSchema
>;

export const ProposeWikiEditToolSchema = z.strictObject({
  sublocation_id: z.string().min(1).max(200),
  entry: z.string().min(1).max(4000),
  rationale: z.string().min(1).max(1000),
});
export type ProposeWikiEditToolInput = z.infer<
  typeof ProposeWikiEditToolSchema
>;

export const ProposeWorldSeedToolSchema = z.strictObject({
  world_name: z.string().min(1).max(120),
  language: z.string().min(1).max(35),
  chapter_seed: z.string().min(1).max(2000).optional(),
  places: z
    .array(ProposePlaceToolSchema.omit({ rationale: true }))
    .min(2)
    .max(8),
  characters: z
    .array(ProposeCharacterToolSchema.omit({ rationale: true }))
    .min(1)
    .max(6),
  rationale: z.string().min(1).max(1000),
});
export type ProposeWorldSeedToolInput = z.infer<
  typeof ProposeWorldSeedToolSchema
>;

/** M7 part 3 (Rev 4 §7): GM-authored objects — consent-gated like every GM
 * write; holder = a sublocation (owner ruling 2026-07-16: backpacks are V2). */
export const ProposeObjectToolSchema = z.strictObject({
  name: z.string().min(1).max(120),
  holder_sublocation_id: z.string().min(1).max(200),
  object_payload: z.string().min(1).max(4000).optional(),
  rationale: z.string().min(1).max(1000),
});
export type ProposeObjectToolInput = z.infer<typeof ProposeObjectToolSchema>;

export const GM_TOOL_NAMES = [
  'propose_place',
  'propose_character',
  'propose_wiki_edit',
  'propose_world_seed',
  'propose_object',
] as const;
export type GmToolName = (typeof GM_TOOL_NAMES)[number];

/** Static descriptions for the GM toolset (stable strings — I5). */
export const GM_TOOL_DESCRIPTIONS: Record<GmToolName, string> = {
  propose_place:
    'Propose a new place for this world. Nothing is created yet: the user sees your proposal as a card with your rationale and decides. name + description; space = "public" (anyone can wander in — squares, taverns, markets) or "private" (someone\'s own space — a home, a workshop); wiki_entry (optional) = the opening wiki text documenting the place; rationale = one honest paragraph on why the world wants it.',
  propose_character:
    'Propose a new character for this world. Nothing is created until the user approves the card. name, personality (their full personality text), goals (1-8 short lines), core (optional, up to 12 short lines of seed memories they start life knowing), skills (optional), rationale = why this character belongs.',
  propose_wiki_edit:
    "Propose replacing a place's wiki entry with new text. Use the wikiquery tool FIRST to read what stands there now — your entry replaces it whole. sublocation_id must be the real id from wikiquery. The user sees old vs new as a diff card.",
  propose_world_seed:
    'Submit the completed world-creation form ONCE, when the interview has covered everything: world_name, language (what the user chose), chapter_seed (optional: the opening story situation), places (2-8; every place you deliberately name — at least one public AND one private), characters (1-6). The user reviews the whole world as one card; approval creates all of it at once. Do not call this while anything essential is still unasked.',
  propose_object:
    "Propose a durable object lying at a place. Nothing is created until the user approves the card. name; holder_sublocation_id = the real id of the place it lies at (wikiquery to find ids); object_payload (optional) = the authored content — what it is and/or contains (a letter's text goes here); rationale = why the world wants it. Objects you author are public: anyone present can find them via exploration.",
};

/** Per-tool shape recaps for the GM correction loop (M7 part 2): a gate-1
 * refusal quotes the exact expected shape so the model can fix its call —
 * the week-15 real run showed a generic "did not match" is not enough. */
export const GM_TOOL_SCHEMA_HINTS: Record<GmToolName, string> = {
  propose_place:
    'propose_place needs: name, description, space ("public" or "private", lowercase), rationale; wiki_entry optional.',
  propose_character:
    'propose_character needs: name, personality, goals (array of 1-8 short strings), rationale; core and skills optional string arrays.',
  propose_wiki_edit:
    'propose_wiki_edit needs: sublocation_id (the real id from wikiquery), entry, rationale.',
  propose_world_seed:
    'propose_world_seed needs ALL of: world_name; language; places (array of 2-8 objects, EACH {name, description, space: "public"|"private" lowercase}); characters (array of 1-6 objects, EACH {name, personality, goals: array of short strings}); rationale. chapter_seed optional. ONE call carrying the whole form.',
  propose_object:
    'propose_object needs: name, holder_sublocation_id (the real id of the place it lies at), rationale; object_payload optional.',
};

/** A GM tool call that passed gate 1. The proposal engine's gate 2 (world
 * state) still applies at submit. */
export type ValidatedGmToolCall =
  | { tool: 'propose_place'; input: ProposePlaceToolInput }
  | { tool: 'propose_character'; input: ProposeCharacterToolInput }
  | { tool: 'propose_wiki_edit'; input: ProposeWikiEditToolInput }
  | { tool: 'propose_world_seed'; input: ProposeWorldSeedToolInput }
  | { tool: 'propose_object'; input: ProposeObjectToolInput };

/** Gate 1 for the GM toolset — same contract as every parse here: reject as
 * a value, zero rows (I8). */
export function parseGmToolCall(
  raw: RawToolCall,
  logger: Logger,
): Result<ValidatedGmToolCall> {
  switch (raw.tool) {
    case 'propose_place': {
      const input = validateAt(
        'llm',
        'tool:propose_place',
        ProposePlaceToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? { ok: true, value: { tool: 'propose_place', input: input.value } }
        : input;
    }
    case 'propose_character': {
      const input = validateAt(
        'llm',
        'tool:propose_character',
        ProposeCharacterToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? {
            ok: true,
            value: { tool: 'propose_character', input: input.value },
          }
        : input;
    }
    case 'propose_wiki_edit': {
      const input = validateAt(
        'llm',
        'tool:propose_wiki_edit',
        ProposeWikiEditToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? {
            ok: true,
            value: { tool: 'propose_wiki_edit', input: input.value },
          }
        : input;
    }
    case 'propose_world_seed': {
      const input = validateAt(
        'llm',
        'tool:propose_world_seed',
        ProposeWorldSeedToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? {
            ok: true,
            value: { tool: 'propose_world_seed', input: input.value },
          }
        : input;
    }
    case 'propose_object': {
      const input = validateAt(
        'llm',
        'tool:propose_object',
        ProposeObjectToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? { ok: true, value: { tool: 'propose_object', input: input.value } }
        : input;
    }
    default:
      return err(
        new OperationalError('unknown_tool', `no such GM tool: ${raw.tool}`),
      );
  }
}

/** A tool call as the provider (or the fake) returned it — unvalidated. */
export interface RawToolCall {
  tool: string;
  input: unknown;
}

/** A tool call that passed gate 1 (shape). Gate 2 (state) still applies.
 * interact_object (M7 part 3) is produced ONLY by parseCharacterSceneToolCall
 * — the narrator parser rejects it as unknown, so the Narrator can never
 * stage an object (Rev 4 §7: Narrator/World Agent never create directly). */
export type ValidatedToolCall =
  | { tool: 'end_scene'; input: EndSceneToolInput }
  | { tool: 'change_sublocation'; input: ChangeSublocationToolInput }
  | { tool: 'switch_art'; input: SwitchArtToolInput }
  | { tool: 'create_sublocation'; input: CreateSublocationToolInput }
  | { tool: 'describe_object'; input: DescribeObjectToolInput }
  | { tool: 'interact_object'; input: InteractObjectToolInput }
  | { tool: 'make_character'; input: MakeCharacterToolInput }
  | { tool: 'character_leave'; input: CharacterLeaveToolInput }
  | { tool: 'move_character'; input: MoveCharacterToolInput }
  | { tool: 'update_goals'; input: UpdateGoalsToolInput };

/**
 * Gate 1: shape-validate one raw tool call. Unknown names and malformed
 * inputs are rejected as values (the caller mirrors the rejection onto the
 * dev trail; nothing durable happens for a rejected call — I8).
 */
export function parseToolCall(
  raw: RawToolCall,
  logger: Logger,
): Result<ValidatedToolCall> {
  switch (raw.tool) {
    case 'end_scene': {
      const input = validateAt(
        'llm',
        'tool:end_scene',
        EndSceneToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? { ok: true, value: { tool: 'end_scene', input: input.value } }
        : input;
    }
    case 'change_sublocation': {
      const input = validateAt(
        'llm',
        'tool:change_sublocation',
        ChangeSublocationToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? {
            ok: true,
            value: { tool: 'change_sublocation', input: input.value },
          }
        : input;
    }
    case 'switch_art': {
      const input = validateAt(
        'llm',
        'tool:switch_art',
        SwitchArtToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? { ok: true, value: { tool: 'switch_art', input: input.value } }
        : input;
    }
    case 'create_sublocation': {
      const input = validateAt(
        'llm',
        'tool:create_sublocation',
        CreateSublocationToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? {
            ok: true,
            value: { tool: 'create_sublocation', input: input.value },
          }
        : input;
    }
    case 'describe_object': {
      const input = validateAt(
        'llm',
        'tool:describe_object',
        DescribeObjectToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? { ok: true, value: { tool: 'describe_object', input: input.value } }
        : input;
    }
    case 'make_character': {
      const input = validateAt(
        'llm',
        'tool:make_character',
        MakeCharacterToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? { ok: true, value: { tool: 'make_character', input: input.value } }
        : input;
    }
    case 'character_leave': {
      const input = validateAt(
        'llm',
        'tool:character_leave',
        CharacterLeaveToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? { ok: true, value: { tool: 'character_leave', input: input.value } }
        : input;
    }
    case 'move_character': {
      const input = validateAt(
        'llm',
        'tool:move_character',
        MoveCharacterToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? { ok: true, value: { tool: 'move_character', input: input.value } }
        : input;
    }
    case 'update_goals': {
      const input = validateAt(
        'llm',
        'tool:update_goals',
        UpdateGoalsToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? { ok: true, value: { tool: 'update_goals', input: input.value } }
        : input;
    }
    case 'query_sublocations':
    case 'query_wiki':
    case 'determine_who_next':
    case 'charactercall':
      // Queries and the loop pair execute DURING the call (LlmCall.queries /
      // LlmCall.loop) and are filtered out of the returned tool calls; one
      // arriving here means the client mis-routed it. Reject as a value —
      // nothing durable happens (I8).
      return err(
        new OperationalError(
          'query_not_stageable',
          `${raw.tool} executes during the call and is never staged`,
        ),
      );
    default:
      return err(
        new OperationalError(
          'unknown_tool',
          `no such narrator tool: ${raw.tool}`,
        ),
      );
  }
}

/**
 * Gate 1 for the character's scene toolset (M7 part 3): interact_object is
 * its only mutating tool (explore/memoryquery/wikiquery execute mid-call and
 * are never staged). Same contract as parseToolCall — reject as a value,
 * zero rows (I8).
 */
export function parseCharacterSceneToolCall(
  raw: RawToolCall,
  logger: Logger,
): Result<ValidatedToolCall> {
  switch (raw.tool) {
    case 'interact_object': {
      const input = validateAt(
        'llm',
        'tool:interact_object',
        InteractObjectToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? { ok: true, value: { tool: 'interact_object', input: input.value } }
        : input;
    }
    case 'explore':
    case 'memoryquery':
    case 'wikiquery':
      return err(
        new OperationalError(
          'query_not_stageable',
          `${raw.tool} executes during the call and is never staged`,
        ),
      );
    default:
      return err(
        new OperationalError(
          'unknown_tool',
          `no such character scene tool: ${raw.tool}`,
        ),
      );
  }
}

/** A chat tool call that passed gate 1 (shape). Gate 2 (state) still applies. */
export type ValidatedChatToolCall =
  | { tool: 'cache'; input: CacheToolInput }
  | { tool: 'startscene'; input: StartSceneToolInput }
  | { tool: 'stay_silent'; input: StaySilentToolInput };

/**
 * Gate 1 for the chat toolset (M6 part 2): shape-validate one raw call from a
 * chat reply. Same contract as parseToolCall — reject as a value, zero rows.
 */
export function parseChatToolCall(
  raw: RawToolCall,
  logger: Logger,
): Result<ValidatedChatToolCall> {
  switch (raw.tool) {
    case 'cache': {
      const input = validateAt(
        'llm',
        'tool:cache',
        CacheToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? { ok: true, value: { tool: 'cache', input: input.value } }
        : input;
    }
    case 'startscene': {
      const input = validateAt(
        'llm',
        'tool:startscene',
        StartSceneToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? { ok: true, value: { tool: 'startscene', input: input.value } }
        : input;
    }
    case 'stay_silent': {
      const input = validateAt(
        'llm',
        'tool:stay_silent',
        StaySilentToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? { ok: true, value: { tool: 'stay_silent', input: input.value } }
        : input;
    }
    case 'wikiquery':
    case 'sessionquery':
    case 'memoryquery':
      // Queries execute DURING the call (LlmCall.queries) and are filtered
      // out of the returned tool calls; one arriving here means the client
      // mis-routed it. Reject as a value — nothing durable happens (I8).
      return err(
        new OperationalError(
          'query_not_stageable',
          `${raw.tool} executes during the call and is never staged`,
        ),
      );
    default:
      return err(
        new OperationalError('unknown_tool', `no such chat tool: ${raw.tool}`),
      );
  }
}

/** A social-react tool call that passed gate 1. Gate 2 (state) still applies. */
export type ValidatedSocialToolCall =
  | { tool: 'react'; input: ReactToolInput }
  | { tool: 'cache'; input: CacheToolInput }
  | { tool: 'stay_silent'; input: StaySilentToolInput };

/**
 * Gate 1 for the social-react toolset (M6 part 5): shape-validate one raw
 * call from a reaction decision. Same contract — reject as a value, zero rows.
 */
export function parseSocialToolCall(
  raw: RawToolCall,
  logger: Logger,
): Result<ValidatedSocialToolCall> {
  switch (raw.tool) {
    case 'react': {
      const input = validateAt(
        'llm',
        'tool:react',
        ReactToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? { ok: true, value: { tool: 'react', input: input.value } }
        : input;
    }
    case 'cache': {
      const input = validateAt(
        'llm',
        'tool:cache',
        CacheToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? { ok: true, value: { tool: 'cache', input: input.value } }
        : input;
    }
    case 'stay_silent': {
      const input = validateAt(
        'llm',
        'tool:stay_silent',
        StaySilentToolSchema,
        raw.input,
        logger,
      );
      return input.ok
        ? { ok: true, value: { tool: 'stay_silent', input: input.value } }
        : input;
    }
    default:
      return err(
        new OperationalError(
          'unknown_tool',
          `no such social tool: ${raw.tool}`,
        ),
      );
  }
}
