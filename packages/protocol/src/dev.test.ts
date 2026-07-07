import { describe, expect, it } from 'vitest';
import { DevEventSchema } from './dev.js';

const valid: unknown = {
  type: 'dev.gauges',
  loop_p99_ms: 12.4,
  rss_mb: 104,
  degraded: false,
};

describe('DevEventSchema', () => {
  it('accepts a valid dev.gauges frame', () => {
    const r = DevEventSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success && r.data.type === 'dev.gauges') {
      expect(r.data.degraded).toBe(false);
    }
  });

  it('rejects an unknown key (strict — Guide B5)', () => {
    const withExtra: unknown = {
      type: 'dev.gauges',
      loop_p99_ms: 12.4,
      rss_mb: 104,
      degraded: false,
      smuggled: 'nope',
    };
    expect(DevEventSchema.safeParse(withExtra).success).toBe(false);
  });

  it('rejects a frame type outside the closed union', () => {
    const unknownType: unknown = {
      type: 'dev.unknown',
      loop_p99_ms: 1,
      rss_mb: 1,
      degraded: false,
    };
    expect(DevEventSchema.safeParse(unknownType).success).toBe(false);
  });

  it('rejects a negative gauge value', () => {
    const negative: unknown = {
      type: 'dev.gauges',
      loop_p99_ms: -1,
      rss_mb: 104,
      degraded: false,
    };
    expect(DevEventSchema.safeParse(negative).success).toBe(false);
  });

  it('accepts a valid dev.tool_call frame and rejects an extra key (B5)', () => {
    const call: unknown = {
      type: 'dev.tool_call',
      turn_id: 't1',
      tool: 'switch_art',
      input_json: '{"character_id":"char:elias","art_id":"smile"}',
    };
    expect(DevEventSchema.safeParse(call).success).toBe(true);
    const extra: unknown = {
      type: 'dev.tool_call',
      turn_id: 't1',
      tool: 'switch_art',
      input_json: '{}',
      smuggled: true,
    };
    expect(DevEventSchema.safeParse(extra).success).toBe(false);
  });

  it('accepts both dev.tool_rejected gates and rejects an unknown gate', () => {
    const schemaGate: unknown = {
      type: 'dev.tool_rejected',
      turn_id: 't1',
      tool: 'change_sublocation',
      gate: 'schema',
      reason: 'sublocation_id: expected string',
    };
    expect(DevEventSchema.safeParse(schemaGate).success).toBe(true);
    const stateGate: unknown = {
      type: 'dev.tool_rejected',
      turn_id: 't1',
      tool: 'change_sublocation',
      gate: 'state',
      reason: 'unknown sublocation subloc:moon',
    };
    expect(DevEventSchema.safeParse(stateGate).success).toBe(true);
    const badGate: unknown = {
      type: 'dev.tool_rejected',
      turn_id: 't1',
      tool: 'change_sublocation',
      gate: 'vibes',
      reason: 'nope',
    };
    expect(DevEventSchema.safeParse(badGate).success).toBe(false);
  });
});
