// The sanctioned home for intentionally detached promises (Guide A8): never
// `void promise` — route the rejection to a logger so nothing fails silently.
import type { Logger } from './logger.js';

export function catchAndLog(
  promise: Promise<unknown>,
  logger: Logger,
  what: string,
): void {
  promise.catch((thrown: unknown) => {
    logger.error({ err: thrown, what }, 'detached task failed');
  });
}
