import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createRootLogger } from '../observability/logger.js';
import { validateAt } from './validate.js';

function capture(): {
  logger: ReturnType<typeof createRootLogger>;
  lines: string[];
} {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { logger: createRootLogger({ level: 'debug', stream }), lines };
}

const schema = z.strictObject({ name: z.string() });

describe('validateAt (B3)', () => {
  it('returns ok with the parsed value', () => {
    const { logger } = capture();
    const result = validateAt(
      'http',
      'test.schema',
      schema,
      { name: 'elias' },
      logger,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe('elias');
  });

  it('on failure logs boundary/schema/issues/raw_size — never the raw payload', () => {
    const { logger, lines } = capture();
    const hostile: unknown = { name: 42, injected: 'SECRET-PAYLOAD-CONTENT' };
    const result = validateAt('llm', 'test.schema', schema, hostile, logger);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('operational');

    const output = lines.join('');
    expect(output).toContain('"boundary":"llm"');
    expect(output).toContain('"schema":"test.schema"');
    expect(output).toContain('raw_size');
    expect(output).not.toContain('SECRET-PAYLOAD-CONTENT');
  });
});
