/* The only function in the codebase allowed to exit (Guide C5). Crash on
 * purpose: log synchronously, exit 1 — exit 3 for corrupt_state, which tells
 * the launcher "do not blindly restart; check the data directory" (Guide §0.10).
 * No cleanup beyond the flush: startup IS recovery (Brief §2.4). */
import { AppError } from '../errors.js';
import type { Logger } from './logger.js';

export function fatal(logger: Logger, error: unknown): never {
  const kind = error instanceof AppError ? error.kind : 'bug';
  const code = error instanceof AppError ? error.code : 'uncaught';
  try {
    logger.fatal({ err: error, kind, code }, 'fatal: exiting');
  } catch {
    // CATCH-OK: the logger itself failed while dying — stderr is the last resort.
    console.error('fatal (logger unavailable):', error);
  }
  process.exit(kind === 'corrupt_state' ? 3 : 1);
}
