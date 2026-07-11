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
 * (UI Spec §1.7): rest → Stay/Map, continuation → Stay/Jump/Map, travel → Map.
 */
export const EndSceneToolSchema = z.strictObject({
  type: z.enum(['rest', 'continuation', 'travel']),
  /** Soft-close divider line, e.g. "— evening falls —". */
  divider_text: z.string().min(1).max(200).optional(),
  /**
   * The next-scene registration (Rev 4 §6, M6 part 1) — REQUIRED when type
   * is `continuation` (the engine-state gate refuses one without it): where
   * "Jump to the next scene" opens. May name a stub created this very turn.
   */
  next_scene: z
    .strictObject({
      sublocation_id: z.string().min(1),
      /** Optional premise line the follow-up scene opens on. */
      premise_seed: z.string().min(1).max(500).optional(),
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

export const NARRATOR_TOOL_NAMES = [
  'end_scene',
  'change_sublocation',
  'switch_art',
  'create_sublocation',
  'query_sublocations',
] as const;
export type NarratorToolName = (typeof NARRATOR_TOOL_NAMES)[number];

/** Static descriptions the real client hands the SDK (stable strings — never scene state). */
export const NARRATOR_TOOL_DESCRIPTIONS: Record<NarratorToolName, string> = {
  end_scene:
    'Softly close the current scene. type: rest (a natural pause), continuation (a next scene follows), travel (the party moves elsewhere). Optionally give a short divider line like "— evening falls —". A continuation MUST include next_scene: the sublocation_id the follow-up scene opens at (it may be a stub you created this turn) and optionally a premise_seed.',
  change_sublocation:
    'Move the scene to another sublocation of this location. Use a sublocation_id offered in the scene context (a sublocation you created this turn works too).',
  switch_art:
    'Switch a present character to another named art pose from their art set listed in the scene context.',
  create_sublocation:
    'Create a new place mid-scene when the story commits to it (the scene moves there, or the next scene opens there) — mentioning a place in prose costs nothing and needs no tool call. One sublocation = one backdrop image: if a single background image can stage it, it is one sublocation (a park, a market square, a bridge); if only an aerial view could, name the stage inside it instead. An interior of the current location gets parent_id = the current exterior-atomic sublocation (always flat, never nested). A genuinely new parentless place requires calling query_sublocations with mode "parentless" first, in this same reply: if an existing sublocation plausibly fits, use change_sublocation instead of creating.',
  query_sublocations:
    'Look up existing sublocations before creating or moving. mode "parentless" lists every exterior-atomic place (REQUIRED before any parentless create_sublocation); mode "children" lists the interiors under parent_id; mode "search" matches keyword against names and descriptions. The result returns to you immediately.',
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

export const GM_TOOL_NAMES = [
  'propose_place',
  'propose_character',
  'propose_wiki_edit',
  'propose_world_seed',
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
};

/** A GM tool call that passed gate 1. The proposal engine's gate 2 (world
 * state) still applies at submit. */
export type ValidatedGmToolCall =
  | { tool: 'propose_place'; input: ProposePlaceToolInput }
  | { tool: 'propose_character'; input: ProposeCharacterToolInput }
  | { tool: 'propose_wiki_edit'; input: ProposeWikiEditToolInput }
  | { tool: 'propose_world_seed'; input: ProposeWorldSeedToolInput };

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

/** A tool call that passed gate 1 (shape). Gate 2 (state) still applies. */
export type ValidatedToolCall =
  | { tool: 'end_scene'; input: EndSceneToolInput }
  | { tool: 'change_sublocation'; input: ChangeSublocationToolInput }
  | { tool: 'switch_art'; input: SwitchArtToolInput }
  | { tool: 'create_sublocation'; input: CreateSublocationToolInput };

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
    case 'query_sublocations':
      // Queries execute DURING the call (LlmCall.queries) and are filtered
      // out of the returned tool calls; one arriving here means the client
      // mis-routed it. Reject as a value — nothing durable happens (I8).
      return err(
        new OperationalError(
          'query_not_stageable',
          'query_sublocations executes during the call and is never staged',
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
