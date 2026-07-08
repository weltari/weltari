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
 * the fixture trio. Scans the log like every other projection — the log is
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
    if (event.type !== 'sublocation.materialized') continue;
    if (event.world_id !== worldId) continue;
    byId.set(event.payload.sublocation_id, {
      sublocation_id: event.payload.sublocation_id,
      name: event.payload.name,
      description: event.payload.description,
      map_position: event.payload.map_position,
    });
  }
  return [...byId.values()];
}

/** The sublocation occupying a fog square, if any (fixture or materialized). */
export function sublocationAt(
  storage: Storage,
  worldId: string,
  square: MapSquare,
): SublocationDefinition | undefined {
  return knownSublocations(storage, worldId).find((s) => {
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
