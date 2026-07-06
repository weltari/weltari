// The one sanctioned validation helper (Guide B3). Every trust boundary calls
// this; the closed union means adding a data source without writing it down
// does not compile. On failure it logs shape only — never the raw payload.
import type { ZodType } from 'zod';
import { OperationalError, type Result } from '../errors.js';
import type { Logger } from '../observability/logger.js';

export type Boundary =
  | 'llm'
  | 'telegram'
  | 'wechat'
  | 'http'
  | 'plugin'
  | 'config'
  | 'env'
  | 'update'
  | 'upload';

export function validateAt<T>(
  boundary: Boundary,
  schemaName: string,
  schema: ZodType<T>,
  raw: unknown,
  logger: Logger,
): Result<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  const rawSize =
    typeof raw === 'string' ? raw.length : JSON.stringify(raw ?? null).length;
  logger.warn(
    {
      boundary,
      schema: schemaName,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        code: i.code,
        message: i.message,
      })),
      raw_size: rawSize,
    },
    'boundary validation rejected',
  );
  return {
    ok: false,
    error: new OperationalError(
      'boundary_rejected',
      `${boundary}:${schemaName} failed validation`,
    ),
  };
}
