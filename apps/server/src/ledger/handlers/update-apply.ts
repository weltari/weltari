// The update_apply job (FINAL item 12, Guide B12): re-fetch the release,
// download the platform artifact trio, verify SHA-256 + minisign, extract,
// flip the `current` pointer, and append update.staged. Serial (one apply at
// a time via serial_group) and idempotent: a version already staged is a
// no-op — the post-kill lease retry converges instead of double-applying.
import { z } from 'zod';
import { CorruptStateError, OperationalError } from '../../errors.js';
import type { EventSink } from '../../engine/event-sink.js';
import type { FaultPointHook } from '../../engine/fault-points.js';
import type { Logger } from '../../observability/logger.js';
import type { Storage } from '../../storage/db.js';
import { validateAt } from '../../boundary/validate.js';
import {
  pickUpdateAssets,
  ReleaseSchema,
} from '../../boundary/update/release.js';
import { stageUpdate, type FetchLike } from '../../boundary/update/stage.js';
import { normalizeVersion } from '../../boundary/update/version.js';
import type { JobHandler } from '../runner.js';

const payloadSchema = z.strictObject({
  version: z.string().min(1),
});

export interface UpdateApplyOptions {
  storage: Storage;
  sink: EventSink;
  logger: Logger;
  currentVersion: string;
  releasesUrl: string;
  fetchFn: FetchLike;
  versionsDir: string;
  publicKeyBase64: string;
  maxArtifactBytes: number;
  faultPoint?: FaultPointHook;
}

export function createUpdateApplyHandler(
  options: UpdateApplyOptions,
): JobHandler {
  const { storage, sink, logger, currentVersion, releasesUrl, fetchFn } =
    options;

  return async (job): Promise<void> => {
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) {
      // Our own stored data failed its schema — corruption, not input (C2).
      throw new CorruptStateError(
        'update_apply_payload',
        `job ${String(job.id)} payload does not match {version}`,
      );
    }
    const version = payload.data.version;

    // Idempotency gate: the retry after a kill -9 must not stage twice.
    const alreadyStaged = storage.eventLog
      .readSince(0, 100000)
      .some(
        (event) =>
          event.type === 'update.staged' && event.payload.version === version,
      );
    if (alreadyStaged) {
      logger.debug({ version }, 'update already staged — idempotent no-op');
      return;
    }

    let raw: unknown;
    try {
      const response = await fetchFn(releasesUrl);
      if (!response.ok) {
        throw new OperationalError(
          'update_apply_failed',
          `release fetch returned ${String(response.status)}`,
        );
      }
      raw = await response.json();
    } catch (thrown) {
      // CATCH-OK: network/JSON failure is operational — rethrow typed so the
      // runner retries with backoff (C2/C7).
      if (thrown instanceof OperationalError) throw thrown;
      throw new OperationalError(
        'update_apply_failed',
        'release fetch request failed',
        { cause: thrown },
      );
    }
    const release = validateAt(
      'update',
      'github_release',
      ReleaseSchema,
      raw,
      logger,
    );
    if (!release.ok) throw release.error;
    if (normalizeVersion(release.value.tag_name) !== version) {
      throw new OperationalError(
        'update_version_not_available',
        `release channel now offers ${release.value.tag_name}, not ${version}`,
      );
    }
    const assets = pickUpdateAssets(release.value, version);
    if (assets === null) {
      throw new OperationalError(
        'update_assets_missing',
        `release ${version} lacks the artifact/.minisig/.sha256 trio for this platform`,
      );
    }

    const staged = await stageUpdate(
      {
        versionsDir: options.versionsDir,
        publicKeyBase64: options.publicKeyBase64,
        maxArtifactBytes: options.maxArtifactBytes,
        fetchFn,
        logger,
        faultPoint: options.faultPoint,
      },
      { version, assets },
    );
    if (!staged.ok) throw staged.error;

    sink.append({
      world_id: job.world_id,
      actor_id: 'system:updater',
      type: 'update.staged',
      payload: {
        version,
        previous_version: staged.value.previousPointer ?? currentVersion,
        sha256: staged.value.sha256,
      },
    });
  };
}
