// The plugin manifest contract (FINAL item 13) + the canonical content-hash
// rule (Guide B10: the hash is verified at install AND at every load; a
// tampered byte means the plugin is refused and the app boots without it).
// MIT: this file is the promise plugin authors build against.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * plugin.json, strict: unknown keys are rejected (an unexpected key in a
 * manifest is a bug or an attack — Guide B5).
 */
export const PluginManifestSchema = z.strictObject({
  /** Must equal the folder name under plugins/. Lowercase kebab-case. */
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Plugin semver. */
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  /**
   * Engine (protocol) major this plugin targets, e.g. "0.x" or "1.x".
   * V1 rule: the major must match the running engine's protocol major.
   */
  engine: z.string().regex(/^\d+\.x$/),
  capabilities: z.strictObject({
    /** Markdown skill files (later milestone). */
    skills: z.array(z.string().min(1)).optional(),
    /** CSS files of --wl-* token overrides, relative to the plugin folder. */
    themes: z.array(z.string().min(1)).optional(),
    /** ES modules that self-define <wl-*> custom elements on import. */
    components: z.array(z.string().min(1)).optional(),
    /** Names of GatewayConnectors the backend half registers. */
    connectors: z.array(z.string().min(1)).optional(),
  }),
  provenance: z.strictObject({
    source_url: z.string().min(1).max(500),
    /** The content hash (see computePluginContentHash) at publish time. */
    sha256: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]{64}$/),
  }),
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

function walkFiles(dir: string, base: string, out: string[]): void {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const relative = base === '' ? entry : `${base}/${entry}`;
    if (statSync(full).isDirectory()) {
      walkFiles(full, relative, out);
    } else {
      out.push(relative);
    }
  }
}

/**
 * The canonical content hash: sha256 over every file in the plugin folder
 * EXCEPT plugin.json itself (the manifest carries the hash, so it cannot be
 * part of it), in sorted relative-path order (posix separators), each
 * contribution being `<path>\0<bytes>\0`. Any renamed, added, removed or
 * edited byte changes the hash.
 */
export function computePluginContentHash(pluginDir: string): string {
  const files: string[] = [];
  walkFiles(pluginDir, '', files);
  const hash = createHash('sha256');
  for (const relative of files) {
    if (relative === 'plugin.json') continue;
    hash.update(relative);
    hash.update('\0');
    hash.update(readFileSync(join(pluginDir, relative)));
    hash.update('\0');
  }
  return hash.digest('hex');
}
