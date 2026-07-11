// The cache_prune job handler (M7 part 1, Rev 4 §11 retention: "keep the
// last N entries per character"). Pure code, no LLM. The event log is
// append-only, so pruning is a WATERMARK event — cache.pruned — that every
// CACHE view respects; replay rebuilds the identical pruned view. Safe by
// construction: reflection reads session history, never CACHE history.
// Idempotent by recomputation: the handler re-derives the watermark from the
// CURRENT log — a retry after the record landed finds nothing left to prune
// and no-ops (natural key character+watermark_id backs it in the sink).
import { z } from 'zod';
import { CorruptStateError } from '../../errors.js';
import { cachePruneDue } from '../../engine/cache.js';
import type { EventSink } from '../../engine/event-sink.js';
import type { Logger } from '../../observability/logger.js';
import type { Storage } from '../../storage/db.js';
import type { JobHandler } from '../runner.js';

const payloadSchema = z.strictObject({
  character_id: z.string().min(1),
  /** Entries to keep (env WELTARI_CACHE_KEEP at enqueue time). */
  keep: z.int().positive(),
});

export interface CachePruneHandlerOptions {
  storage: Storage;
  sink: EventSink;
  logger: Logger;
}

export function createCachePruneHandler(
  options: CachePruneHandlerOptions,
): JobHandler {
  const { storage, sink, logger } = options;

  return async (job): Promise<void> => {
    await Promise.resolve(); // pure-code job — keep the handler shape uniform
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      throw new CorruptStateError(
        'cache_prune_payload',
        `job ${String(job.id)} payload does not match {character_id, keep}`,
      );
    }
    const { character_id, keep } = payload.data;

    // Recompute from the CURRENT log — after a kill-retry (or a racing
    // sweep's earlier pass) the due-check itself is the idempotency gate:
    // nothing over the limit ⇒ nothing to append. No await between the
    // check and the append (the fused-re-check discipline).
    const due = cachePruneDue(storage, character_id, keep);
    if (due === undefined) {
      logger.debug(
        { job_id: job.id, character_id },
        'cache retention finds nothing over the limit — idempotent no-op',
      );
      return;
    }
    sink.append({
      world_id: job.world_id,
      actor_id: character_id,
      type: 'cache.pruned',
      payload: {
        character_id,
        watermark_id: due.watermark_id,
        kept: due.kept,
      },
    });
    logger.info(
      { character_id, watermark_id: due.watermark_id, kept: due.kept },
      'cache retention advanced the watermark (a view rule — nothing deleted)',
    );
  };
}
