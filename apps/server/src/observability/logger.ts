// The ONE root logger (Guide C8/C10). NDJSON to stdout, synchronous destination
// so fatal() can flush before exit. Deep code receives child loggers bound to
// correlation ids at context creation — never re-pass ids by hand.
import { pino, destination, type Logger } from 'pino';

export type { Logger };

export interface LoggerOptions {
  level?: string;
  /** Test seam: capture NDJSON lines instead of writing to stdout. */
  stream?: NodeJS.WritableStream;
}

export function createRootLogger(options: LoggerOptions = {}): Logger {
  return pino(
    {
      level: options.level ?? 'info',
      // C12: keys/tokens/credentials never serialize at any level (structural).
      redact: {
        paths: [
          'apiKey',
          '*.apiKey',
          'api_key',
          '*.api_key',
          'token',
          '*.token',
          'secret',
          '*.secret',
          'authorization',
          '*.authorization',
          'headers.authorization',
        ],
        censor: '[Redacted]',
      },
    },
    options.stream ?? destination({ sync: true }),
  );
}
