// The update_check job (FINAL item 12): poll the release channel (startup +
// croner), announce a strictly-newer version as ONE durable update.available
// event. Metadata is untrusted (B12) — this job never downloads anything;
// trusting happens in update_apply's verifier. Idempotent projection: a
// version already announced is a no-op, so retries after kill -9 are safe.
import { OperationalError } from '../../errors.js';
import type { EventSink } from '../../engine/event-sink.js';
import type { Logger } from '../../observability/logger.js';
import type { Storage } from '../../storage/db.js';
import { validateAt } from '../../boundary/validate.js';
import { ReleaseSchema } from '../../boundary/update/release.js';
import type { FetchLike } from '../../boundary/update/stage.js';
import {
  isNewerVersion,
  normalizeVersion,
} from '../../boundary/update/version.js';
import type { JobHandler } from '../runner.js';

export interface UpdateCheckOptions {
  storage: Storage;
  sink: EventSink;
  logger: Logger;
  currentVersion: string;
  releasesUrl: string;
  fetchFn: FetchLike;
}

export function createUpdateCheckHandler(
  options: UpdateCheckOptions,
): JobHandler {
  const { storage, sink, logger, currentVersion, releasesUrl, fetchFn } =
    options;

  return async (job): Promise<void> => {
    let raw: unknown;
    try {
      const response = await fetchFn(releasesUrl);
      if (!response.ok) {
        throw new OperationalError(
          'update_check_failed',
          `release check returned ${String(response.status)}`,
        );
      }
      raw = await response.json();
    } catch (thrown) {
      // CATCH-OK: network/JSON failure on a poll is operational — rethrow as
      // typed so the runner retries with backoff (C2/C7).
      if (thrown instanceof OperationalError) throw thrown;
      throw new OperationalError(
        'update_check_failed',
        'release check request failed',
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
    if (release.value.draft === true || release.value.prerelease === true) {
      logger.debug(
        { tag: release.value.tag_name },
        'release is draft/prerelease — ignored',
      );
      return;
    }
    const version = normalizeVersion(release.value.tag_name);
    if (version === null) {
      logger.debug(
        { tag: release.value.tag_name },
        'release tag is not plain semver — ignored (untrusted metadata)',
      );
      return;
    }
    if (!isNewerVersion(version, currentVersion)) {
      logger.debug({ version, currentVersion }, 'no newer release');
      return;
    }

    const alreadyAnnounced = storage.eventLog
      .readSince(0, 100000)
      .some(
        (event) =>
          event.type === 'update.available' &&
          event.payload.version === version,
      );
    if (alreadyAnnounced) return;

    sink.append({
      world_id: job.world_id,
      actor_id: 'system:updater',
      type: 'update.available',
      payload: {
        version,
        current_version: currentVersion,
        ...(release.value.html_url === undefined
          ? {}
          : { release_url: release.value.html_url }),
      },
    });
    logger.info({ version, currentVersion }, 'update available');
  };
}
