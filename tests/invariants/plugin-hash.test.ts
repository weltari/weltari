// Invariant I10 (Guide B10): plugin manifests are strict-validated and
// sha256-verified at every load. A single tampered byte ⇒ the plugin is
// REFUSED, a durable plugin.rejected event is appended, and the app boots
// without it. Asserted through public seams: loader result + event-log reads.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computePluginContentHash } from '@weltari/plugin-sdk';
import { Bus, type EventBus } from '../../apps/server/src/http/bus.js';
import { createEventSink } from '../../apps/server/src/engine/event-sink.js';
import {
  loadPlugins,
  type LoadedPlugin,
} from '../../apps/server/src/boundary/plugins/loader.js';
import { createPluginAssetResolver } from '../../apps/server/src/boundary/plugins/assets.js';
import type { Storage } from '../../apps/server/src/storage/db.js';
import { captureLogger } from '../helpers/capture-logger.js';
import { tempStorage } from '../helpers/temp-storage.js';

interface Ctx {
  pluginsDir: string;
  storage: Storage;
  load: () => Promise<LoadedPlugin[]>;
}

function setup(): Ctx {
  const pluginsDir = mkdtempSync(join(tmpdir(), 'weltari-plugins-'));
  const { logger } = captureLogger();
  const storage = tempStorage();
  const eventBus: EventBus = new Bus(logger);
  const sink = createEventSink(storage, eventBus);
  return {
    pluginsDir,
    storage,
    load: async () => loadPlugins({ pluginsDir, sink, logger, worldId: 'w1' }),
  };
}

/** A minimal valid plugin: one theme + one component, manifest hash correct. */
function writePlugin(pluginsDir: string, name: string): string {
  const dir = join(pluginsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'theme.css'), ':root { --wl-accent: teal; }');
  mkdirSync(join(dir, 'frontend'), { recursive: true });
  writeFileSync(
    join(dir, 'frontend', 'wl-badge.mjs'),
    'customElements.define("wl-badge", class extends HTMLElement {});',
  );
  const manifest = {
    name,
    version: '1.0.0',
    engine: '0.x',
    capabilities: {
      themes: ['theme.css'],
      components: ['frontend/wl-badge.mjs'],
    },
    provenance: {
      source_url: 'https://example.com/plugin',
      sha256: computePluginContentHash(dir),
    },
  };
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

function rejectionEvents(
  storage: Storage,
): { plugin: string; reason: string }[] {
  const out: { plugin: string; reason: string }[] = [];
  for (const event of storage.eventLog.readSince(0)) {
    if (event.type === 'plugin.rejected') {
      out.push({
        plugin: event.payload.plugin,
        reason: event.payload.reason,
      });
    }
  }
  return out;
}

describe('I10 — plugin hash verification at load (B10)', () => {
  it('a valid plugin loads with its provenance and asset URLs', async () => {
    const ctx = setup();
    writePlugin(ctx.pluginsDir, 'teal-theme');
    const loaded = await ctx.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.info.name).toBe('teal-theme');
    expect(loaded[0]?.info.themes).toEqual(['/plugins/teal-theme/theme.css']);
    expect(loaded[0]?.info.provenance.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rejectionEvents(ctx.storage)).toEqual([]);
    ctx.storage.close();
  });

  it('a single tampered byte ⇒ refused + plugin.rejected, app boots without it', async () => {
    const ctx = setup();
    const dir = writePlugin(ctx.pluginsDir, 'teal-theme');
    // The tamper: one byte in the theme after the hash was sealed.
    writeFileSync(join(dir, 'theme.css'), ':root { --wl-accent: TEAL; }');
    const loaded = await ctx.load();
    expect(loaded).toEqual([]); // boots without it
    expect(rejectionEvents(ctx.storage)).toEqual([
      { plugin: 'teal-theme', reason: 'hash_mismatch' },
    ]);
    ctx.storage.close();
  });

  it('an invalid manifest and a wrong engine major are refused with reasons', async () => {
    const ctx = setup();
    const badManifestDir = join(ctx.pluginsDir, 'a-bad-manifest');
    mkdirSync(badManifestDir);
    writeFileSync(join(badManifestDir, 'plugin.json'), '{"name": 42}');

    const dir = writePlugin(ctx.pluginsDir, 'z-old-engine');
    const manifest = {
      name: 'z-old-engine',
      version: '1.0.0',
      engine: '9.x',
      capabilities: {},
      provenance: {
        source_url: 'https://example.com',
        sha256: computePluginContentHash(dir),
      },
    };
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest));

    const loaded = await ctx.load();
    expect(loaded).toEqual([]);
    expect(rejectionEvents(ctx.storage)).toEqual([
      { plugin: 'a-bad-manifest', reason: 'manifest_invalid' },
      { plugin: 'z-old-engine', reason: 'engine_mismatch' },
    ]);
    ctx.storage.close();
  });

  it('a throwing backend refuses the plugin (backend_failed)', async () => {
    const ctx = setup();
    const dir = join(ctx.pluginsDir, 'boom');
    mkdirSync(join(dir, 'backend'), { recursive: true });
    writeFileSync(
      join(dir, 'backend', 'index.mjs'),
      'throw new Error("boom on import");',
    );
    const manifest = {
      name: 'boom',
      version: '1.0.0',
      engine: '0.x',
      capabilities: {},
      provenance: {
        source_url: 'https://example.com',
        sha256: computePluginContentHash(dir),
      },
    };
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest));
    const loaded = await ctx.load();
    expect(loaded).toEqual([]);
    expect(rejectionEvents(ctx.storage)).toEqual([
      { plugin: 'boom', reason: 'backend_failed' },
    ]);
    ctx.storage.close();
  });

  it('the asset resolver contains paths and hides unknown plugins', async () => {
    const ctx = setup();
    writePlugin(ctx.pluginsDir, 'teal-theme');
    const loaded = await ctx.load();
    const resolve = createPluginAssetResolver(loaded);
    expect(resolve('teal-theme', 'theme.css')).not.toBeNull();
    expect(resolve('teal-theme', '../../../etc/passwd')).toBeNull();
    expect(resolve('teal-theme', '..\\..\\secrets.txt')).toBeNull();
    expect(resolve('ghost-plugin', 'theme.css')).toBeNull();
    ctx.storage.close();
  });
});
