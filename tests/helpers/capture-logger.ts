import { Writable } from 'node:stream';
import {
  createRootLogger,
  type Logger,
} from '../../apps/server/src/observability/logger.js';

/** A real root logger whose NDJSON lines land in an array (I12 redaction tests). */
export function captureLogger(level = 'debug'): {
  logger: Logger;
  lines: string[];
} {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { logger: createRootLogger({ level, stream }), lines };
}
