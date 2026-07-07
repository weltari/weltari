import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computePluginContentHash, PluginManifestSchema } from './manifest.js';

const validManifest = {
  name: 'night-theme',
  version: '1.0.0',
  engine: '0.x',
  capabilities: { themes: ['theme.css'] },
  provenance: {
    source_url: 'https://example.com/night-theme',
    sha256: 'a'.repeat(64),
  },
};

describe('PluginManifestSchema', () => {
  it('accepts a valid manifest', () => {
    expect(PluginManifestSchema.safeParse(validManifest).success).toBe(true);
  });

  it('rejects extra keys, bad names, bad engine ranges (B5/B10)', () => {
    const extra: unknown = { ...validManifest, smuggled: true };
    expect(PluginManifestSchema.safeParse(extra).success).toBe(false);
    const badName: unknown = { ...validManifest, name: '../escape' };
    expect(PluginManifestSchema.safeParse(badName).success).toBe(false);
    const badEngine: unknown = { ...validManifest, engine: '>=0.1.0' };
    expect(PluginManifestSchema.safeParse(badEngine).success).toBe(false);
  });
});

describe('computePluginContentHash', () => {
  function pluginDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-plugin-'));
    writeFileSync(join(dir, 'plugin.json'), '{"name":"x"}');
    writeFileSync(join(dir, 'theme.css'), ':root { --wl-bg: black; }');
    mkdirSync(join(dir, 'frontend'));
    writeFileSync(join(dir, 'frontend', 'wl-x.mjs'), 'export {};');
    return dir;
  }

  it('is deterministic and excludes plugin.json', () => {
    const dir = pluginDir();
    const first = computePluginContentHash(dir);
    expect(computePluginContentHash(dir)).toBe(first);
    // Editing the manifest must NOT change the content hash…
    writeFileSync(join(dir, 'plugin.json'), '{"name":"y"}');
    expect(computePluginContentHash(dir)).toBe(first);
  });

  it('a single tampered byte changes the hash (the B10 guarantee)', () => {
    const dir = pluginDir();
    const before = computePluginContentHash(dir);
    writeFileSync(join(dir, 'theme.css'), ':root { --wl-bg: white; }');
    expect(computePluginContentHash(dir)).not.toBe(before);
  });
});
