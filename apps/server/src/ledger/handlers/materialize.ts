// The materialize job (M4 part 2, Rev 4 §14): give one explored fog square a
// sublocation stub. LLM work is confined to inventing the name + description;
// placement is code-owned (the square came from the user's Explore click) and
// the output passes the full B6 double gate — schema gate (validateAt over
// the parsed stub), then engine-state gate (square still empty, world exists)
// — before the ONLY durable write, sublocation.materialized. Idempotent per
// square: the deterministic sublocation id + the already-materialized check
// make the post-kill lease retry converge instead of minting twins (I4,
// mid_materialize).
import { MapPositionSchema, MapSquareSchema } from '@weltari/protocol';
import { z } from 'zod';
import { CorruptStateError, OperationalError } from '../../errors.js';
import type { CharacterProfile } from '../../engine/context-assembler.js';
import { assembleContext } from '../../engine/context-assembler.js';
import type { EventSink } from '../../engine/event-sink.js';
import type { FaultPointHook } from '../../engine/fault-points.js';
import {
  knownSublocations,
  solveFrontierSquare,
  squareCenter,
  squareOf,
  sublocationAt,
  sublocationIdForSquare,
  worldExists,
} from '../../engine/sublocations.js';
import { parseLlmJson } from '../../llm/structured.js';
import type { LlmClient } from '../../llm/types.js';
import type { Logger } from '../../observability/logger.js';
import { enqueueSquarePaint } from '../../painter/commands.js';
import type { Storage } from '../../storage/db.js';
import { validateAt } from '../../boundary/validate.js';
import type { JobHandler } from '../runner.js';

/** Two job shapes converge on one handler: an Explore click names its square
 * (placement = the click); a Narrator stub (M6 part 1) names the stub and
 * its anchor — the frontier solver picks the square at execution time. */
const payloadSchema = z.union([
  z.strictObject({ square: MapSquareSchema }),
  z.strictObject({
    stub_sublocation_id: z.string().min(1),
    anchor: MapPositionSchema,
  }),
]);

/** Gate 1 subject: the stub the LLM must return, and nothing else. */
const stubSchema = z.strictObject({
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(2000),
});

export interface MaterializeHandlerOptions {
  storage: Storage;
  sink: EventSink;
  llm: LlmClient;
  /** The narrator-class profile the stub generation speaks with. */
  narrator: CharacterProfile;
  logger: Logger;
  faultPoint?: FaultPointHook;
}

export function createMaterializeHandler(
  options: MaterializeHandlerOptions,
): JobHandler {
  const { storage, sink, llm, narrator, logger } = options;
  const faultPoint = options.faultPoint ?? ((): void => undefined);

  return async (job): Promise<void> => {
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new CorruptStateError(
        'materialize_payload',
        `job ${String(job.id)} payload matches neither {square} nor {stub_sublocation_id, anchor}`,
      );
    }

    // The Narrator-stub branch (M6 part 1, Rev 4 §14): the stub already has
    // its identity — NO LLM call; this job is pure code-owned placement.
    if ('stub_sublocation_id' in payload.data) {
      const stubId = payload.data.stub_sublocation_id;
      const anchor = payload.data.anchor;
      const stub = knownSublocations(storage, job.world_id).find(
        (s) => s.sublocation_id === stubId,
      );
      if (stub === undefined) {
        // The stub event commits in the same transaction as this row — a
        // missing stub means a torn log, never a normal race.
        throw new CorruptStateError(
          'materialize_stub_missing',
          `no sublocation.stub_created for ${stubId}`,
        );
      }
      const alreadyAt = ((): boolean =>
        storage.eventLog
          .readSince(0, 100000)
          .some(
            (event) =>
              event.type === 'sublocation.materialized' &&
              event.world_id === job.world_id &&
              event.payload.sublocation_id === stubId,
          ))();
      if (alreadyAt) {
        // Heal path (I4): a kill between the event append and the paint
        // enqueue lands here on the lease retry — re-enqueue (deduped).
        if (stub.map_position !== undefined) {
          enqueueSquarePaint(
            storage,
            job.world_id,
            squareOf(stub.map_position),
          );
        }
        logger.debug(
          { job_id: job.id, stub_id: stubId },
          'stub already materialized — idempotent no-op',
        );
        return;
      }
      const solved = solveFrontierSquare(storage, job.world_id, anchor);
      if (solved === undefined) {
        // A full map is a legitimate terminal state: the stub stays map-less
        // (scenes still reach it via its backdrop) — never a retry storm.
        logger.warn(
          { job_id: job.id, stub_id: stubId },
          'no free frontier square — stub stays map-less',
        );
        return;
      }
      await faultPoint('mid_materialize');
      // Last-instant idempotency re-check fused to the append (the week-7
      // lease-expiry overlap class): NO await between here and the append.
      const committedMeanwhile = storage.eventLog
        .readSince(0, 100000)
        .some(
          (event) =>
            event.type === 'sublocation.materialized' &&
            event.world_id === job.world_id &&
            event.payload.sublocation_id === stubId,
        );
      if (committedMeanwhile) {
        logger.warn(
          { job_id: job.id, stub_id: stubId },
          'stub materialize overlapped its own lease-expiry retry — zero duplicate rows',
        );
        return;
      }
      // The solver only returns free squares and executions interleave only
      // at await points — the square check rides the same fused window.
      if (sublocationAt(storage, job.world_id, solved) !== undefined) {
        throw new OperationalError(
          'square_taken_midflight',
          'the solved square was claimed during the fault window — retry re-solves',
        );
      }
      sink.append({
        world_id: job.world_id,
        actor_id: 'system:engine',
        type: 'sublocation.materialized',
        payload: {
          sublocation_id: stubId,
          name: stub.name,
          description: stub.description,
          square: solved,
          map_position: squareCenter(solved),
        },
      });
      enqueueSquarePaint(storage, job.world_id, solved);
      return;
    }

    const { square } = payload.data;
    if (sublocationAt(storage, job.world_id, square) !== undefined) {
      // Re-enqueue the paint too (deduped by key): a kill between the event
      // append and the paint enqueue lands here on the lease retry — the
      // square must never stay materialized-but-unpainted (I4).
      enqueueSquarePaint(storage, job.world_id, square);
      logger.debug(
        { job_id: job.id, square },
        'square already occupied — idempotent no-op',
      );
      return;
    }

    // Nearby known sublocations anchor the invention (Rev 4 §14 flavor) —
    // dynamic scene state stays in the tail, never the stable prefix (I5).
    const anchors = knownSublocations(storage, job.world_id)
      .map((s) => `${s.name}: ${s.description}`)
      .join('\n');
    const context = assembleContext(narrator, {
      scene_id: `materialize:${sublocationIdForSquare(square)}`,
      world_clock_text: 'The map grows at its explored frontier.',
      latest_turns: [],
      wiki: [],
    });
    const result = await llm.streamCall({
      kind: 'materialize',
      characterId: narrator.character_id,
      system: context.stablePrefix,
      prompt: `${context.dynamicTail}\n\n## Instruction\nA traveler explores an uncharted map square near these known places:\n${anchors}\nInvent ONE new sublocation that fits this world. Respond with ONLY a JSON object: {"name": "...", "description": "..."} — name under 120 characters, description 1-2 sentences.`,
      onTextDelta: (): void => undefined,
    });
    if (!result.ok) throw result.error; // operational -> runner retries (C7)

    // B6 gate 1 (schema): the stub must parse — reject, never repair (B4).
    const stub = validateAt(
      'llm',
      'materialize.stub',
      stubSchema,
      parseLlmJson(result.value.text),
      logger,
    );
    if (!stub.ok) {
      throw new OperationalError(
        'materialize_bad_stub',
        'LLM stub failed the schema gate — retrying regenerates it',
      );
    }

    // B6 gate 2 (engine state): the world must exist and the square must
    // still be empty — a schema can't know either.
    if (!worldExists(storage, job.world_id)) {
      throw new OperationalError(
        'world_not_found',
        `no events exist for world ${job.world_id}`,
      );
    }
    if (sublocationAt(storage, job.world_id, square) !== undefined) {
      logger.debug(
        { job_id: job.id, square },
        'square materialized while generating — idempotent no-op',
      );
      return;
    }

    await faultPoint('mid_materialize');
    // Last-instant idempotency re-check, NO await between it and the append
    // (the week-7 painter lease-expiry overlap class, docs/painter.md): the
    // gate-2 occupied check above sits BEFORE the faultPoint await, so an
    // overlapped lease-expiry retry could commit in between. The loser lands
    // here, re-enqueues the (deduped) paint like the occupied path, and no-ops.
    if (sublocationAt(storage, job.world_id, square) !== undefined) {
      enqueueSquarePaint(storage, job.world_id, square);
      logger.warn(
        { job_id: job.id, square },
        'materialize overlapped its own lease-expiry retry — one duplicate generation, zero duplicate rows',
      );
      return;
    }
    sink.append({
      world_id: job.world_id,
      actor_id: 'system:engine',
      type: 'sublocation.materialized',
      payload: {
        sublocation_id: sublocationIdForSquare(square),
        name: stub.value.name,
        description: stub.value.description,
        square,
        map_position: squareCenter(square),
      },
    });
    // Materialization = the map-presence job (Rev 4 §14): the square paints
    // eagerly. Not atomic with the event — a kill in between converges via
    // the occupied path above, which re-enqueues under the same key.
    enqueueSquarePaint(storage, job.world_id, square);
  };
}
