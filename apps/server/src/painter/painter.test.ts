import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type {
  GeneratedTile,
  ImageSource,
  TileRequest,
} from './image-source.js';
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
      async generateTile(request): Promise<GeneratedTile> {
        requests.push(request);
        // Odd size on purpose: the compositor's resize must handle it.
        const image = await sharp({
          create: {
            width: 100,
            height: 100,
            channels: 3,
            background: { r: 255, g: 0, b: 0 },
          },
        })
          .png()
          .toBuffer();
        return { image, coverage: 'region' };
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
      async generateTile(): Promise<GeneratedTile> {
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

  it('context window: absent on all-fog surroundings, present once a neighbor is painted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-painter-'));
    const basePath = await ensureBaseImage(dir, 'map:w1');
    const requests: TileRequest[] = [];
    const probe: ImageSource = {
      name: 'test-probe',
      async generateTile(request): Promise<GeneratedTile> {
        requests.push(request);
        const image = await sharp({
          create: {
            width: 8,
            height: 8,
            channels: 3,
            background: { r: 200, g: 20, b: 20 },
          },
        })
          .png()
          .toBuffer();
        return { image, coverage: 'region' };
      },
    };
    // Pristine checkerboard = pure grey = NO painted neighbor to continue
    // from: the seeding tile must paint plain (no context) so edit mode
    // cannot anchor on nothing and drift.
    const seeded = await compositeRegion({
      imageId: 'map:w1',
      region: REGION,
      jobKey: 'painter:map:w1:seed',
      imagesDir: dir,
      basePath,
      source: probe,
    });
    expect(requests[0]?.context).toBeUndefined();

    // Now the neighbor to the right: its window (96..288 × 32..224) contains
    // the red seeded tile — context arrives with correct dims and target.
    await compositeRegion({
      imageId: 'map:w1',
      region: { x: 160, y: 96, width: 64, height: 64 },
      jobKey: 'painter:map:w1:next',
      imagesDir: dir,
      basePath: join(dir, seeded.path),
      source: probe,
    });
    const context = requests[1]?.context;
    expect(context?.width).toBe(192);
    expect(context?.height).toBe(192);
    expect(context?.target).toEqual({ x: 64, y: 64, width: 64, height: 64 });
    const meta = await sharp(context?.window ?? Buffer.of()).metadata();
    expect(meta.width).toBe(192);

    // Far corner (448,448), nowhere near the paint: window all fog → no
    // context (and the clamped-margin math still runs without throwing).
    await compositeRegion({
      imageId: 'map:w1',
      region: { x: 448, y: 448, width: 64, height: 64 },
      jobKey: 'painter:map:w1:corner',
      imagesDir: dir,
      basePath: join(dir, seeded.path),
      source: probe,
    });
    expect(requests[2]?.context).toBeUndefined();
  });

  it('window coverage: only the target rect of an edit-mode result enters the composite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weltari-painter-'));
    const basePath = await ensureBaseImage(dir, 'map:w1');
    // Seed a painted neighbor so the follow-up paint gets a context window.
    const seeded = await compositeRegion({
      imageId: 'map:w1',
      region: REGION,
      jobKey: 'painter:map:w1:w-seed',
      imagesDir: dir,
      basePath,
      source: {
        name: 'test-blue',
        async generateTile(): Promise<GeneratedTile> {
          const image = await sharp({
            create: {
              width: 16,
              height: 16,
              channels: 3,
              background: { r: 20, g: 20, b: 220 },
            },
          })
            .png()
            .toBuffer();
          return { image, coverage: 'region' };
        },
      },
    });
    // A window-covering result: green everywhere, red ONLY in the target
    // rect. If extraction is correct the region turns red; if the whole
    // window were pasted, green would leak outside the region.
    const windowSource: ImageSource = {
      name: 'test-window',
      async generateTile(request): Promise<GeneratedTile> {
        const ctx = request.context;
        if (ctx === undefined) throw new Error('expected context');
        const red = await sharp({
          create: {
            width: ctx.target.width,
            height: ctx.target.height,
            channels: 3,
            background: { r: 255, g: 0, b: 0 },
          },
        })
          .png()
          .toBuffer();
        const image = await sharp({
          create: {
            width: ctx.width,
            height: ctx.height,
            channels: 3,
            background: { r: 0, g: 255, b: 0 },
          },
        })
          .composite([{ input: red, left: ctx.target.x, top: ctx.target.y }])
          .png()
          .toBuffer();
        return { image, coverage: 'window' };
      },
    };
    const region = { x: 160, y: 96, width: 64, height: 64 }; // right neighbor
    const result = await compositeRegion({
      imageId: 'map:w1',
      region,
      jobKey: 'painter:map:w1:window',
      imagesDir: dir,
      basePath: join(dir, seeded.path),
      source: windowSource,
    });
    const raw = await sharp(join(dir, result.path)).raw().toBuffer();
    const px = (x: number, y: number): number[] => {
      const offset = (y * BASE_IMAGE_SIZE + x) * 3;
      return [raw[offset] ?? -1, raw[offset + 1] ?? -1, raw[offset + 2] ?? -1];
    };
    expect(px(region.x + 32, region.y + 32)).toEqual([255, 0, 0]); // target red
    // Right margin (inside window, outside region): still checkerboard grey,
    // never the window's green.
    const [r, g, b] = px(region.x + region.width + 32, region.y + 32);
    expect(g).not.toBe(255);
    expect(r).toBe(g);
    expect(g).toBe(b);
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
