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
});
export type EndSceneToolInput = z.infer<typeof EndSceneToolSchema>;

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
] as const;
export type NarratorToolName = (typeof NARRATOR_TOOL_NAMES)[number];

/** Static descriptions the real client hands the SDK (stable strings — never scene state). */
export const NARRATOR_TOOL_DESCRIPTIONS: Record<NarratorToolName, string> = {
  end_scene:
    'Softly close the current scene. type: rest (a natural pause), continuation (a next scene follows), travel (the party moves elsewhere). Optionally give a short divider line like "— evening falls —".',
  change_sublocation:
    'Move the scene to another sublocation of this location. Use a sublocation_id offered in the scene context.',
  switch_art:
    'Switch a present character to another named art pose from their art set listed in the scene context.',
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
  | { tool: 'switch_art'; input: SwitchArtToolInput };

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
    default:
      return err(
        new OperationalError(
          'unknown_tool',
          `no such narrator tool: ${raw.tool}`,
        ),
      );
  }
}
