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
});
