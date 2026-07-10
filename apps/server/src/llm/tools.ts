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
});
export type StartSceneToolInput = z.infer<typeof StartSceneToolSchema>;

export const CHAT_TOOL_NAMES = ['cache', 'startscene'] as const;
export type ChatToolName = (typeof CHAT_TOOL_NAMES)[number];

/** Static descriptions for the chat toolset (stable strings — never state). */
export const CHAT_TOOL_DESCRIPTIONS: Record<ChatToolName, string> = {
  cache:
    'REQUIRED after every reply: record a private 1-2 line recap of what just happened in this conversation, in your own words ("line"). This is your own short-term memory pointer — nobody else reads it.',
  startscene:
    'Open the meeting you and the User agreed on: ends this chat and opens a live scene with you and the User. place (required): where to meet — a sublocation you know, or a short place description like "the park". premise (optional): one line on how the meeting starts. Fire it YOURSELF, in the same reply where the meeting is settled — the User cannot open it. Do not fire it before a place is agreed; ask for the missing piece first.',
};

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
  | { tool: 'startscene'; input: StartSceneToolInput };

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
    default:
      return err(
        new OperationalError('unknown_tool', `no such chat tool: ${raw.tool}`),
      );
  }
}
