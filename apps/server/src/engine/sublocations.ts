// The world's sublocation registry (M4 part 2): a projection, never a table.
// Known sublocations = the fixture trio ∪ every sublocation.materialized
// event for the world — so the change_sublocation state gate, the open-scene
// sublocation_id gate and the explore occupancy gate all read one truth.
// The fog grid is MAP_FOG_GRID × MAP_FOG_GRID over the unit map extent
// (UI Spec §1.8); explored = materialized.
import { MAP_FOG_GRID, type MapSquare } from '@weltari/protocol';
import type { Storage } from '../storage/db.js';
import {
  FIXTURE_SUBLOCATIONS,
  type SublocationDefinition,
} from './fixture/rainy-inn.js';

/** The fog square a world-coordinate anchor falls in. */
export function squareOf(position: { x: number; y: number }): MapSquare {
  return {
    col: Math.min(MAP_FOG_GRID - 1, Math.floor(position.x * MAP_FOG_GRID)),
    row: Math.min(MAP_FOG_GRID - 1, Math.floor(position.y * MAP_FOG_GRID)),
  };
}

/** The pin anchor for a materialized square: its center, in world coordinates. */
export function squareCenter(square: MapSquare): { x: number; y: number } {
  return {
    x: (square.col + 0.5) / MAP_FOG_GRID,
    y: (square.row + 0.5) / MAP_FOG_GRID,
  };
}

/** Deterministic id per square — retries and replays can never mint a twin. */
export function sublocationIdForSquare(square: MapSquare): string {
  return `subloc:sq-${String(square.col)}-${String(square.row)}`;
}

/**
 * Every sublocation the engine accepts for this world, in event order after
 * the fixture trio: materialized fog reveals AND Flow-A created ones (M5
 * part 2 — those carry a footprint and may share a square with the reveal
 * sublocation). Scans the log like every other projection — the log is
 * the source of truth and stays small in V1.
 */
export function knownSublocations(
  storage: Storage,
  worldId: string,
): SublocationDefinition[] {
  const byId = new Map<string, SublocationDefinition>(
    FIXTURE_SUBLOCATIONS.map((s) => [s.sublocation_id, s]),
  );
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (event.world_id !== worldId) continue;
    if (event.type === 'sublocation.materialized') {
      byId.set(event.payload.sublocation_id, {
        sublocation_id: event.payload.sublocation_id,
        name: event.payload.name,
        description: event.payload.description,
        map_position: event.payload.map_position,
      });
    } else if (event.type === 'sublocation.created') {
      byId.set(event.payload.sublocation_id, {
        sublocation_id: event.payload.sublocation_id,
        name: event.payload.name,
        description: event.payload.description,
        map_position: event.payload.map_position,
        footprint: event.payload.footprint,
      });
    } else if (
      event.type === 'map_click.resolved' &&
      event.payload.outcome === 'created' &&
      event.payload.sublocation_id !== undefined
    ) {
      // A persistent Flow-B spawn: the resolved event IS its row (Rev 4 §14
      // persistence rules); transient outcomes never appear here.
      byId.set(event.payload.sublocation_id, {
        sublocation_id: event.payload.sublocation_id,
        name: event.payload.name,
        description: event.payload.description,
        map_position: event.payload.point,
      });
    }
  }
  return [...byId.values()];
}

/**
 * The Flow-B enter radius (Rev 4 §14 step 1): half a fog square around a
 * sublocation's anchor. Clicks inside it enter the existing sublocation with
 * ZERO model calls; a square's corners fall outside on purpose — that is the
 * "jump in anywhere" granularity. The default wl-map plugin carries the same
 * documented value (it cannot import).
 */
export const SUBLOCATION_RADIUS = 1 / (2 * MAP_FOG_GRID);

/** Ray-cast point-in-polygon over world coordinates (Flow-A footprints). */
function inPolygon(
  point: { x: number; y: number },
  polygon: readonly { x: number; y: number }[],
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a === undefined || b === undefined) continue;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * The sublocation a clicked point lands IN, if any (Rev 4 §14 Flow B step 1):
 * a Flow-A footprint containing the point wins, else the nearest anchor
 * within SUBLOCATION_RADIUS. Both the map-click command (authoritative) and
 * the default map plugin (instant UI) run this same rule.
 */
export function sublocationNear(
  storage: Storage,
  worldId: string,
  point: { x: number; y: number },
): SublocationDefinition | undefined {
  const known = knownSublocations(storage, worldId);
  const byFootprint = known.find(
    (s) => s.footprint !== undefined && inPolygon(point, s.footprint),
  );
  if (byFootprint !== undefined) return byFootprint;
  let best: SublocationDefinition | undefined;
  let bestDistance = SUBLOCATION_RADIUS;
  for (const s of known) {
    const distance = Math.hypot(
      s.map_position.x - point.x,
      s.map_position.y - point.y,
    );
    if (distance <= bestDistance) {
      best = s;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The sublocation occupying a fog square, if any. Square-grain occupancy is
 * a fog concept: only fixture/materialized sublocations count — Flow-A
 * created ones (footprint carriers) are sub-square features and never block
 * an Explore or claim a square.
 */
export function sublocationAt(
  storage: Storage,
  worldId: string,
  square: MapSquare,
): SublocationDefinition | undefined {
  return knownSublocations(storage, worldId).find((s) => {
    if (s.footprint !== undefined) return false;
    const at = squareOf(s.map_position);
    return at.col === square.col && at.row === square.row;
  });
}

/** A world exists once anything durable happened in it (append-only log —
 * a world can appear but never vanish). */
export function worldExists(storage: Storage, worldId: string): boolean {
  return storage.eventLog
    .readSince(0, 100000)
    .some((event) => event.world_id === worldId);
}
