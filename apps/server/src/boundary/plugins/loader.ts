// B-plugin (Guide B10): plugins are folders in plugins/. The manifest is
// strict-validated, the content hash is verified at EVERY load, the engine
// major must match — any failure refuses that plugin, appends a durable
// plugin.rejected event, and the app boots without it. Honest security line
// (documented as such): plugins run in-process in V1 — this validation limits
// accidents and corruption, not a malicious plugin; the real protections are
// the manifest hash + provenance display.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  computePluginContentHash,
  PluginManifestSchema,
  type GatewayConnector,
  type PluginManifest,
} from '@weltari/plugin-sdk';
import { PROTOCOL_VERSION, type PluginInfo } from '@weltari/protocol';
import { validateAt } from '../validate.js';
import type { EventSink } from '../../engine/event-sink.js';
import type { Logger } from '../../observability/logger.js';

export interface LoadedPlugin {
  manifest: PluginManifest;
  /** Absolute folder path — the asset route serves from here. */
  dir: string;
  /** Wire shape for GET /v1/plugins (asset URL paths, provenance). */
  info: PluginInfo;
  /** Connectors the backend half registered (host validates all traffic, B7). */
  connectors: { name: string; connector: GatewayConnector }[];
}

export interface PluginLoaderOptions {
  pluginsDir: string;
  sink: EventSink;
  logger: Logger;
  worldId: string;
}

type RejectReason =
  | 'manifest_missing'
  | 'manifest_invalid'
  | 'engine_mismatch'
  | 'hash_mismatch'
  | 'backend_failed';

export interface PluginRegisterApi {
  registerConnector(name: unknown, connector: unknown): void;
}

type RegisterFn = (api: PluginRegisterApi) => unknown;

function isRegisterFn(value: unknown): value is RegisterFn {
  return typeof value === 'function';
}

/** Minimal duck-type gate for a connector handed back by plugin code —
 * boundary data like everything else a plugin returns (B10). */
function isGatewayConnector(value: unknown): value is GatewayConnector {
  if (typeof value !== 'object' || value === null) return false;
  const record: Record<string, unknown> = { ...value };
  return ['start', 'stop', 'send', 'onInbound', 'health'].every(
    (key) => typeof record[key] === 'function',
  );
}

export async function loadPlugins(
  options: PluginLoaderOptions,
): Promise<LoadedPlugin[]> {
  const { pluginsDir, sink, logger, worldId } = options;
  const loaded: LoadedPlugin[] = [];
  if (!existsSync(pluginsDir)) return loaded;

  function reject(plugin: string, reason: RejectReason, detail: string): void {
    sink.append({
      world_id: worldId,
      actor_id: 'system:plugins',
      type: 'plugin.rejected',
      payload: { plugin, reason, detail },
    });
    logger.warn({ plugin, reason, detail }, 'plugin refused (B10)');
  }

  const engineMajor = PROTOCOL_VERSION.split('.')[0] ?? '0';

  for (const entry of readdirSync(pluginsDir).sort()) {
    const dir = join(pluginsDir, entry);
    if (!statSync(dir).isDirectory()) continue;

    const manifestPath = join(dir, 'plugin.json');
    if (!existsSync(manifestPath)) {
      reject(entry, 'manifest_missing', 'no plugin.json in the folder');
      continue;
    }
    let manifestRaw: unknown;
    try {
      manifestRaw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (thrown) {
      reject(
        entry,
        'manifest_invalid',
        thrown instanceof Error ? thrown.message : 'plugin.json is not JSON',
      );
      continue;
    }
    const manifest = validateAt(
      'plugin',
      'plugin.json',
      PluginManifestSchema,
      manifestRaw,
      logger,
    );
    if (!manifest.ok) {
      reject(entry, 'manifest_invalid', 'plugin.json failed strict validation');
      continue;
    }
    if (manifest.value.name !== entry) {
      reject(
        entry,
        'manifest_invalid',
        `manifest name ${manifest.value.name} != folder name ${entry}`,
      );
      continue;
    }
    if (manifest.value.engine !== `${engineMajor}.x`) {
      reject(
        entry,
        'engine_mismatch',
        `plugin targets engine ${manifest.value.engine}, running ${engineMajor}.x`,
      );
      continue;
    }

    // The B10 core: a single tampered byte anywhere in the content refuses
    // the plugin — at install AND at every load (this runs at every boot).
    const contentHash = computePluginContentHash(dir);
    if (contentHash !== manifest.value.provenance.sha256) {
      reject(
        entry,
        'hash_mismatch',
        `content hash ${contentHash.slice(0, 12)}… != manifest ${manifest.value.provenance.sha256.slice(0, 12)}…`,
      );
      continue;
    }

    // Backend half: optional backend/index.mjs exporting register(api).
    const connectors: LoadedPlugin['connectors'] = [];
    const backendEntry = join(dir, 'backend', 'index.mjs');
    if (existsSync(backendEntry)) {
      try {
        const moduleUrl = pathToFileURL(backendEntry).href;
        const backend: unknown = await import(moduleUrl);
        const register =
          typeof backend === 'object' &&
          backend !== null &&
          'register' in backend
            ? backend.register
            : undefined;
        if (!isRegisterFn(register)) {
          reject(
            entry,
            'backend_failed',
            'backend/index.mjs has no register()',
          );
          continue;
        }
        const api: PluginRegisterApi = {
          registerConnector(name: unknown, connector: unknown): void {
            if (typeof name !== 'string' || name.length === 0) return;
            if (!isGatewayConnector(connector)) {
              logger.warn(
                { plugin: entry, connector: name },
                'plugin connector rejected: missing lifecycle methods',
              );
              return;
            }
            connectors.push({ name, connector });
          },
        };
        register(api);
      } catch (thrown) {
        reject(
          entry,
          'backend_failed',
          thrown instanceof Error ? thrown.message : 'backend import threw',
        );
        continue;
      }
    }

    const capabilities = manifest.value.capabilities;
    loaded.push({
      manifest: manifest.value,
      dir,
      info: {
        name: manifest.value.name,
        version: manifest.value.version,
        provenance: manifest.value.provenance,
        themes: (capabilities.themes ?? []).map(
          (file) => `/plugins/${entry}/${file}`,
        ),
        components: (capabilities.components ?? []).map(
          (file) => `/plugins/${entry}/${file}`,
        ),
        connectors: connectors.map((c) => c.name),
      },
      connectors,
    });
    logger.info(
      { plugin: entry, version: manifest.value.version, hash: contentHash },
      'plugin loaded',
    );
  }
  return loaded;
}
