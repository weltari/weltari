// Invariant I12 (Guide B15/C12): secrets never serialize — a planted apiKey
// comes out as [Redacted] on every path pino writes.
import { expect, it } from 'vitest';
import { captureLogger } from '../helpers/capture-logger.js';

it('a planted apiKey/token/secret emits [Redacted], never the value', () => {
  const { logger, lines } = captureLogger();
  const secret = 'sk-or-v1-PLANTED-SECRET-VALUE';
  logger.info({ apiKey: secret }, 'direct key');
  logger.info(
    { provider: { apiKey: secret, token: secret, secret } },
    'nested',
  );
  logger.warn({ headers: { authorization: `Bearer ${secret}` } }, 'header');

  const output = lines.join('');
  expect(output).not.toContain(secret);
  expect(output).toContain('[Redacted]');
});
