// paint-region command seam: durable intent before work (Brief §2.4) — the
// command only writes the ledger row; every pixel is the job handler's
// business. Image lease = serial_group per IMAGE: painter jobs CHAIN — each
// composites onto the latest completed composite for its image — so two
// paints for one image must never run concurrently, same region or not.
// (M2 shipped per-region granularity; week-7's first real-backend run proved
// that loses tiles: three ~10 s generations claimed together, all read the
// same base, last writer won. Invisible on the ~5 ms stub.)
import {
  MAP_FOG_GRID,
  type ImageRegion,
  type MapPosition,
  type MapSquare,
  type PaintRegionCommand,
} from '@weltari/protocol';
import { ok, type Result } from '../errors.js';
import type { Storage } from '../storage/db.js';
import type { NewLedgerJob } from '../storage/repositories/ledger.js';
import { BASE_IMAGE_SIZE, type MaskPoint } from './painter.js';

export function createPaintRegionCommand(
  storage: Storage,
): (command: PaintRegionCommand) => Result<{ jobKey: string }> {
  return (command: PaintRegionCommand): Result<{ jobKey: string }> => {
    const jobKey = `painter:${command.image_id}:${command.request_id}`;
    storage.ledger.enqueue({
      idempotency_key: jobKey,
      world_id: command.world_id,
      type: 'painter',
      payload: { image_id: command.image_id, region: command.region },
      serial_group: `painter:${command.image_id}`,
    });
    // A duplicate request_id is a silent no-op (I3) — still a 202: the job exists.
    return ok({ jobKey });
  };
}

/** The pixel rect of one fog square on the world-map base (painter-owned
 * geometry: code places, the model only fills — Rev 4 §14). */
export function squareRegion(square: MapSquare): ImageRegion {
  const px = BASE_IMAGE_SIZE / MAP_FOG_GRID;
  return {
    x: square.col * px,
    y: square.row * px,
    width: px,
    height: px,
  };
}

/**
 * Eagerly enqueue THE paint job for one fog square of a world's map (M5:
 * materialization = the map-presence job). Deterministic key per square, so
 * the materialize handler's post-kill retry, the fixture-trio boot enqueue
 * and any future caller converge on one job — the ledger dedupes forever.
 */
export function enqueueSquarePaint(
  storage: Storage,
  worldId: string,
  square: MapSquare,
): void {
  const imageId = `map:${worldId}`;
  const region = squareRegion(square);
  storage.ledger.enqueue({
    idempotency_key: `painter:${imageId}:sq-${String(square.col)}-${String(square.row)}`,
    world_id: worldId,
    type: 'painter',
    payload: { image_id: imageId, region },
    serial_group: `painter:${imageId}`,
  });
}

/**
 * THE backdrop paint job for one sublocation (M6 part 1, Rev 4 §6: the
 * backdrop-image job fires immediately at creation). Deterministic key per
 * sublocation, so the create tool's commit, any retry and any heal path
 * converge on one job — the ledger dedupes forever. Its own image id
 * (`backdrop:<sublocation_id>`) = its own lease: backdrops never contend
 * with the world map's paint chain, and interiors never touch the map.
 */
export function enqueueBackdropPaint(
  storage: Storage,
  worldId: string,
  sublocationId: string,
): void {
  storage.ledger.enqueue(backdropPaintJob(worldId, sublocationId));
}

/** The same job as a row (M7 part 2): proposal applies enqueue it through
 * sink.appendManyWithJobs so the backdrop intent rides the apply's own
 * transaction — one shape, two enqueue paths, identical key. */
export function backdropPaintJob(
  worldId: string,
  sublocationId: string,
): NewLedgerJob {
  const imageId = `backdrop:${sublocationId}`;
  return {
    idempotency_key: `painter:${imageId}:initial`,
    world_id: worldId,
    type: 'painter',
    payload: {
      image_id: imageId,
      region: { x: 0, y: 0, width: BASE_IMAGE_SIZE, height: BASE_IMAGE_SIZE },
    },
    serial_group: `painter:${imageId}`,
  };
}

/** The VLM's view of a Flow-B click: a two-square window centered on the
 * click, clamped to the canvas (painter-owned geometry, Rev 4 §14). */
export function clickWindow(point: MapPosition): ImageRegion {
  const size = (2 * BASE_IMAGE_SIZE) / MAP_FOG_GRID;
  const x = Math.min(
    BASE_IMAGE_SIZE - size,
    Math.max(0, Math.round(point.x * BASE_IMAGE_SIZE) - size / 2),
  );
  const y = Math.min(
    BASE_IMAGE_SIZE - size,
    Math.max(0, Math.round(point.y * BASE_IMAGE_SIZE) - size / 2),
  );
  return { x, y, width: size, height: size };
}

/** Feather clearance around a Flow-A edit's bounding box, image pixels. */
const EDIT_PAD_PX = 8;
/** A drawn sliver still gets a paintable crop (provider + resize sanity). */
const EDIT_MIN_PX = 32;

export interface EditGeometry {
  /** The paint region: the polygon's padded bounding box, clamped. */
  region: ImageRegion;
  /** The polygon in image pixels — PaintSpec.mask. */
  mask: MaskPoint[];
  /** The polygon centroid, world coordinates — the pin anchor (Rev 4 §14). */
  centroid: MapPosition;
}

/**
 * All Flow-A geometry in one code-owned place (Rev 4 §14: code owns
 * placement, masks, coordinates, sizes; the model only fills pixels): the
 * drawn world-coordinate polygon becomes the mask (image pixels), its padded
 * bounding box becomes the paint region, its area centroid the pin anchor.
 */
export function editGeometry(points: readonly MapPosition[]): EditGeometry {
  const mask = points.map((p) => ({
    x: p.x * BASE_IMAGE_SIZE,
    y: p.y * BASE_IMAGE_SIZE,
  }));
  const xs = mask.map((p) => p.x);
  const ys = mask.map((p) => p.y);
  let x0 = Math.max(0, Math.floor(Math.min(...xs)) - EDIT_PAD_PX);
  let y0 = Math.max(0, Math.floor(Math.min(...ys)) - EDIT_PAD_PX);
  let x1 = Math.min(BASE_IMAGE_SIZE, Math.ceil(Math.max(...xs)) + EDIT_PAD_PX);
  let y1 = Math.min(BASE_IMAGE_SIZE, Math.ceil(Math.max(...ys)) + EDIT_PAD_PX);
  if (x1 - x0 < EDIT_MIN_PX) {
    const grow = EDIT_MIN_PX - (x1 - x0);
    x0 = Math.max(0, x0 - Math.ceil(grow / 2));
    x1 = Math.min(BASE_IMAGE_SIZE, x0 + EDIT_MIN_PX);
    x0 = Math.max(0, x1 - EDIT_MIN_PX);
  }
  if (y1 - y0 < EDIT_MIN_PX) {
    const grow = EDIT_MIN_PX - (y1 - y0);
    y0 = Math.max(0, y0 - Math.ceil(grow / 2));
    y1 = Math.min(BASE_IMAGE_SIZE, y0 + EDIT_MIN_PX);
    y0 = Math.max(0, y1 - EDIT_MIN_PX);
  }

  // Shoelace area centroid; a degenerate (zero-area) scribble falls back to
  // the vertex average. Result clamped to the unit square like every anchor.
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a === undefined || b === undefined) continue;
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  let centroid: MapPosition;
  if (Math.abs(area) < 1e-9) {
    centroid = {
      x: points.reduce((s, p) => s + p.x, 0) / points.length,
      y: points.reduce((s, p) => s + p.y, 0) / points.length,
    };
  } else {
    centroid = { x: cx / (3 * area), y: cy / (3 * area) };
  }
  centroid = {
    x: Math.min(1, Math.max(0, centroid.x)),
    y: Math.min(1, Math.max(0, centroid.y)),
  };
  return {
    region: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    mask,
    centroid,
  };
}

/**
 * THE paint job for one Flow-A edit — deterministic key per edit_id, so the
 * map_edit handler's post-kill retry, its heal path and its lease-expiry
 * loser all converge on one job (the ledger dedupes forever). Runs under the
 * same per-image lease as every other paint: the drawn region is locked
 * while the job is in flight (Rev 4 §14 step 6, a fortiori — the whole
 * image serializes).
 */
export function enqueueEditPaint(
  storage: Storage,
  worldId: string,
  editId: string,
  geometry: EditGeometry,
): void {
  const imageId = `map:${worldId}`;
  storage.ledger.enqueue({
    idempotency_key: `painter:${imageId}:edit-${editId}`,
    world_id: worldId,
    type: 'painter',
    payload: {
      image_id: imageId,
      region: geometry.region,
      mask: geometry.mask,
    },
    serial_group: `painter:${imageId}`,
  });
}
