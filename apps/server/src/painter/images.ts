// Read-only serving of painter outputs (GET /v1/images/*). The event log's
// painter.completed rows name path + sha256 — this resolver only hands out
// pixels under the images dir, traversal-contained, never truth by itself
// (Brief §2.1: rendered artifacts are never truth).
import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export type ImageResolver = (
  relativePath: string,
) => { file: string; contentType: string } | null;

export function createImageResolver(imagesDir: string): ImageResolver {
  const root = resolve(imagesDir);
  return (relativePath) => {
    const file = resolve(root, relativePath);
    if (!file.startsWith(root + sep)) return null;
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    const extension = file.split('.').pop()?.toLowerCase() ?? '';
    const contentType = CONTENT_TYPES[extension];
    if (contentType === undefined) return null; // images only, ever
    return { file, contentType };
  };
}
