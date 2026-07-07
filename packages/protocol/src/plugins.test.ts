import { describe, expect, it } from 'vitest';
import { MapJumpDetailSchema, PluginListSchema } from './plugins.js';

const valid: unknown = {
  plugins: [
    {
      name: 'night-theme',
      version: '1.0.0',
      provenance: {
        source_url: 'https://example.com/night-theme',
        sha256: 'a'.repeat(64),
      },
      themes: ['/plugins/night-theme/theme.css'],
      components: [],
      connectors: [],
    },
  ],
};

describe('PluginListSchema', () => {
  it('accepts a valid plugin list', () => {
    expect(PluginListSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a short provenance hash and an extra key (B5)', () => {
    const shortHash: unknown = {
      plugins: [
        {
          name: 'x',
          version: '1.0.0',
          provenance: { source_url: 'https://e.com', sha256: 'abc' },
          themes: [],
          components: [],
          connectors: [],
        },
      ],
    };
    expect(PluginListSchema.safeParse(shortHash).success).toBe(false);
    const extra: unknown = {
      plugins: [
        {
          name: 'x',
          version: '1.0.0',
          provenance: { source_url: 'https://e.com', sha256: 'a'.repeat(64) },
          themes: [],
          components: [],
          connectors: [],
          smuggled: true,
        },
      ],
    };
    expect(PluginListSchema.safeParse(extra).success).toBe(false);
  });

  it('wl-map-jump detail validates; extra key rejected (B5)', () => {
    const detail: unknown = { sublocation_id: 'sub:cellar', name: 'Cellar' };
    expect(MapJumpDetailSchema.safeParse(detail).success).toBe(true);
    const extra: unknown = {
      sublocation_id: 'sub:cellar',
      name: 'Cellar',
      href: 'javascript:alert(1)',
    };
    expect(MapJumpDetailSchema.safeParse(extra).success).toBe(false);
    expect(MapJumpDetailSchema.safeParse({ name: 'x' }).success).toBe(false);
  });
});
