// The built frontend ships from this same process (FINAL item 2): Vite's
// dist output served as plain files, SPA-fallback to index.html. Same
// containment idiom as plugin assets and painter images — resolved paths must
// stay inside the web dist; a traversal attempt gets null, never a fallback.
import { existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json; charset=utf-8',
  woff2: 'font/woff2',
};

export interface ResolvedStaticAsset {
  file: string;
  contentType: string;
  cacheControl?: string;
}

export type StaticResolver = (urlPath: string) => ResolvedStaticAsset | null;

function assetFor(file: string, urlPath: string): ResolvedStaticAsset {
  const extension = file.split('.').pop()?.toLowerCase() ?? '';
  const contentType = CONTENT_TYPES[extension] ?? 'application/octet-stream';
  // Vite content-hashes everything under assets/ (safe to cache forever);
  // index.html is the mutable entry point — revalidate so a self-update's
  // new bundle is picked up on the next reload, never a mixed page.
  if (extension === 'html') {
    return { file, contentType, cacheControl: 'no-cache' };
  }
  if (urlPath.startsWith('assets/')) {
    return {
      file,
      contentType,
      cacheControl: 'public, max-age=31536000, immutable',
    };
  }
  return { file, contentType };
}

/**
 * Serves the built frontend from `webDir`. `urlPath` is the request path
 * without the leading slash ('' = the root). A contained miss falls back to
 * index.html (SPA routing); an escape attempt or a missing dist returns null.
 */
export function createStaticResolver(webDir: string): StaticResolver {
  const root = resolve(webDir);
  return (urlPath) => {
    const target = urlPath === '' ? 'index.html' : urlPath;
    const file = resolve(root, target);
    if (!file.startsWith(root + sep)) return null;
    if (existsSync(file) && statSync(file).isFile()) {
      return assetFor(file, target);
    }
    const index = join(root, 'index.html');
    if (!existsSync(index) || !statSync(index).isFile()) return null;
    return assetFor(index, 'index.html');
  };
}
