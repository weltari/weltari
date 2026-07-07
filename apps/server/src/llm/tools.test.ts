// Gate 1 of the B6 double gate (I8): shape validation of raw tool calls.
// Fixtures that need wrong-shaped data are declared unknown (Guide §0.12).
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createRootLogger } from '../observability/logger.js';
import { parseToolCall, type RawToolCall } from './tools.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_c, _e, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

const logger = quietLogger();

function raw(tool: string, input: unknown): RawToolCall {
  return { tool, input };
}

describe('parseToolCall (B6 gate 1)', () => {
  it('accepts well-formed calls for all three narrator tools', () => {
    expect(parseToolCall(raw('end_scene', { type: 'rest' }), logger).ok).toBe(
      true,
    );
    expect(
      parseToolCall(
        raw('end_scene', { type: 'continuation', divider_text: '— dusk —' }),
        logger,
      ).ok,
    ).toBe(true);
    expect(
      parseToolCall(
        raw('change_sublocation', { sublocation_id: 'subloc:cellar' }),
        logger,
      ).ok,
    ).toBe(true);
    expect(
      parseToolCall(
        raw('switch_art', { character_id: 'char:elias', art_id: 'smile' }),
        logger,
      ).ok,
    ).toBe(true);
  });

  it('rejects malformed inputs (wrong type, missing key, unknown enum)', () => {
    expect(
      parseToolCall(raw('switch_art', { character_id: 42 }), logger).ok,
    ).toBe(false);
    expect(parseToolCall(raw('change_sublocation', {}), logger).ok).toBe(false);
    expect(
      parseToolCall(raw('end_scene', { type: 'hard_cut' }), logger).ok,
    ).toBe(false);
  });

  it('rejects extra keys — our own tool formats are strict (B5)', () => {
    expect(
      parseToolCall(raw('end_scene', { type: 'rest', force: true }), logger).ok,
    ).toBe(false);
  });

  it('rejects unknown tool names', () => {
    const result = parseToolCall(raw('summon_dragon', {}), logger);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown_tool');
  });
});
