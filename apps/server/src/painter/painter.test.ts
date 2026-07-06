import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  BASE_IMAGE_SIZE,
  compositeRegion,
  ensureBaseImage,
  safeName,
} from './painter.js';

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const REGION = { x: 96, y: 96, width: 64, height: 64 };

describe('painter pipeline (crop -> feather composite -> resize, kill-safe files)', () => {
  it('creates the deterministic base image once and only once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-painter-'));
    const first = await ensureBaseImage(dir, 'map:w1');
    expect(existsSync(first)).toBe(true);
    const hash = sha256File(first);
    const second = await ensureBaseImage(dir, 'map:w1');
    expect(second).toBe(first);
    expect(sha256File(second)).toBe(hash);
    const meta = await sharp(first).metadata();
    expect(meta.width).toBe(BASE_IMAGE_SIZE);
    expect(meta.height).toBe(BASE_IMAGE_SIZE);
  });

  it('composites deterministically: same job key -> byte-identical output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-painter-'));
    const basePath = await ensureBaseImage(dir, 'map:w1');
    const spec = {
      imageId: 'map:w1',
      region: REGION,
      jobKey: 'painter:map:w1:r1',
      imagesDir: dir,
      basePath,
    };
    const first = await compositeRegion(spec);
    // The idempotent-retry shape: rerun after a kill between rename and event
    // append regenerates the SAME file — no throw, no second artifact.
    const second = await compositeRegion(spec);
    expect(second.path).toBe(first.path);
    expect(second.sha256).toBe(first.sha256);
    expect(sha256File(join(dir, first.path))).toBe(first.sha256);
  });

  it('changes pixels inside the region, never outside the feather margin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-painter-'));
    const basePath = await ensureBaseImage(dir, 'map:w1');
    const result = await compositeRegion({
      imageId: 'map:w1',
      region: REGION,
      jobKey: 'painter:map:w1:r1',
      imagesDir: dir,
      basePath,
    });
    const outPath = join(dir, result.path);
    expect(sha256File(outPath)).not.toBe(sha256File(basePath));

    const rawBase = await sharp(basePath).raw().toBuffer();
    const rawOut = await sharp(outPath).raw().toBuffer();
    expect(rawOut.length).toBe(rawBase.length); // dimensions preserved

    const px = (raw: Buffer, x: number, y: number): number[] => {
      const offset = (y * BASE_IMAGE_SIZE + x) * 3;
      return [raw[offset] ?? -1, raw[offset + 1] ?? -1, raw[offset + 2] ?? -1];
    };
    // Center of the region: the stub tile replaced the checkerboard.
    const cx = REGION.x + 32;
    const cy = REGION.y + 32;
    expect(px(rawOut, cx, cy)).not.toEqual(px(rawBase, cx, cy));
    // Far corner: untouched by the composite.
    expect(px(rawOut, 5, 5)).toEqual(px(rawBase, 5, 5));
    expect(px(rawOut, 500, 500)).toEqual(px(rawBase, 500, 500));
  });

  it('rejects an out-of-bounds region loudly (extract throws)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-painter-'));
    const basePath = await ensureBaseImage(dir, 'map:w1');
    await expect(
      compositeRegion({
        imageId: 'map:w1',
        region: { x: 500, y: 500, width: 64, height: 64 },
        jobKey: 'painter:map:w1:oob',
        imagesDir: dir,
        basePath,
      }),
    ).rejects.toThrow();
  });

  it('safeName strips path-hostile characters', () => {
    expect(safeName('map:w1')).toBe('map-w1');
    expect(safeName('../evil')).toBe('---evil');
  });
});
