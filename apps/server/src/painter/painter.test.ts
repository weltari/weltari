import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { ImageSource, TileRequest } from './image-source.js';
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

  it('paints the injected source´s pixels and hands it the prompt (the seam)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-painter-'));
    const basePath = await ensureBaseImage(dir, 'map:w1');
    const requests: TileRequest[] = [];
    const redSource: ImageSource = {
      name: 'test-red',
      async generateTile(request): Promise<Buffer> {
        requests.push(request);
        // Odd size on purpose: the compositor's resize must handle it.
        return sharp({
          create: {
            width: 100,
            height: 100,
            channels: 3,
            background: { r: 255, g: 0, b: 0 },
          },
        })
          .png()
          .toBuffer();
      },
    };
    const result = await compositeRegion({
      imageId: 'map:w1',
      region: REGION,
      jobKey: 'painter:map:w1:red',
      imagesDir: dir,
      basePath,
      source: redSource,
      prompt: 'a crimson field',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.prompt).toBe('a crimson field');
    expect(requests[0]?.jobKey).toBe('painter:map:w1:red');
    const raw = await sharp(join(dir, result.path)).raw().toBuffer();
    const offset = ((REGION.y + 32) * BASE_IMAGE_SIZE + REGION.x + 32) * 3;
    expect(raw[offset]).toBe(255); // the source's red landed in the region
    expect(raw[offset + 1]).toBe(0);
  });

  it('a failing source aborts before any file becomes visible (composite-on-success)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-painter-'));
    const basePath = await ensureBaseImage(dir, 'map:w1');
    const baseHash = sha256File(basePath);
    const failing: ImageSource = {
      name: 'test-fail',
      async generateTile(): Promise<Buffer> {
        await Promise.resolve();
        throw new Error('provider 503');
      },
    };
    await expect(
      compositeRegion({
        imageId: 'map:w1',
        region: REGION,
        jobKey: 'painter:map:w1:fail',
        imagesDir: dir,
        basePath,
        source: failing,
      }),
    ).rejects.toThrow('provider 503');
    // The base is untouched and no composite appeared at all.
    expect(sha256File(basePath)).toBe(baseHash);
    expect(readdirSync(join(dir, 'map-w1'))).toEqual(['base.png']);
  });

  it('output files are content-addressed: the path always matches the bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-painter-'));
    const basePath = await ensureBaseImage(dir, 'map:w1');
    const result = await compositeRegion({
      imageId: 'map:w1',
      region: REGION,
      jobKey: 'painter:map:w1:addr',
      imagesDir: dir,
      basePath,
    });
    // The filename IS the bytes' hash prefix — a racing duplicate execution
    // with different pixels can never overwrite this file (week-7 fix).
    expect(result.path).toBe(`map-w1/${result.sha256.slice(0, 12)}.png`);
    expect(sha256File(join(dir, result.path))).toBe(result.sha256);
  });
});
