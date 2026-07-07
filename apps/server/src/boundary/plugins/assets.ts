// Zero-build plugin asset serving (FINAL item 13): frontend/*.mjs custom
// elements and theme.css token overrides are served straight from the plugin
// folder — no bundler, no toolchain for authors. Only LOADED plugins serve
// assets (a refused plugin is invisible); resolved paths are contained to the
// plugin folder (traversal-guarded).
import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { LoadedPlugin } from './loader.js';

const CONTENT_TYPES: Record<string, string> = {
  mjs: 'text/javascript; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

export interface ResolvedAsset {
  file: string;
  contentType: string;
}

export type PluginAssetResolver = (
  pluginName: string,
  relativePath: string,
) => ResolvedAsset | null;

export function createPluginAssetResolver(
  loaded: readonly LoadedPlugin[],
): PluginAssetResolver {
  const dirByName = new Map(loaded.map((p) => [p.manifest.name, p.dir]));
  return (pluginName, relativePath) => {
    const dir = dirByName.get(pluginName);
    if (dir === undefined) return null;
    const root = resolve(dir);
    const file = resolve(root, relativePath);
    // Containment: the resolved path must stay inside the plugin folder.
    if (file !== root && !file.startsWith(root + sep)) return null;
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    const extension = file.split('.').pop()?.toLowerCase() ?? '';
    return {
      file,
      contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream',
    };
  };
}
