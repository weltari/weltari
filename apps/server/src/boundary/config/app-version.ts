// The running app's own version — what the updater compares release tags
// against. Read from the server package.json (shipped beside dist/ in every
// packaging layout). JSON.parse is confined to boundary modules (B1 exception)
// and its output enters a safeParse as unknown.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Logger } from '../../observability/logger.js';

const packageSchema = z.object({ version: z.string().min(1) });

export function readAppVersion(
  packageJsonPath: string,
  logger: Logger,
): string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (thrown) {
    // CATCH-OK: a missing/unreadable package.json only disables meaningful
    // version comparison — boot continues with the sentinel version.
    logger.warn(
      { packageJsonPath, err: thrown },
      'could not read app version — updates will compare against 0.0.0',
    );
    return '0.0.0';
  }
  const parsed = packageSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn({ packageJsonPath }, 'package.json has no version field');
    return '0.0.0';
  }
  return parsed.data.version;
}
