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
 * sublocation) AND Narrator-created identity stubs (M6 part 1 — interiors
 * anchor to their parent's point; parentless stubs have no position until
 * their materialization lands). Scans the log like every other projection —
 * the log is the source of truth and stays small in V1.
 */
export function knownSublocations(
  storage: Storage,
  worldId: string,
): SublocationDefinition[] {
  // Week 19 (audit item 1): a GM-built world carries `world.seeded` from its
  // approved seed card and owns its WHOLE geography — the fixture trio never
  // enters its registry (a blank world could otherwise legally move scenes
  // into the Rainy Inn). Fixture/dev/test worlds (no world.seeded) keep the
  // fixture base that seeds their map.
  const gmBuilt = storage.eventLog
    .readSince(0, 100000)
    .some((e) => e.world_id === worldId && e.type === 'world.seeded');
  const byId = new Map<string, SublocationDefinition>(
    gmBuilt ? [] : FIXTURE_SUBLOCATIONS.map((s) => [s.sublocation_id, s]),
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
    } else if (event.type === 'sublocation.stub_created') {
      const parent =
        event.payload.parent_id === undefined
          ? undefined
          : byId.get(event.payload.parent_id);
      byId.set(event.payload.sublocation_id, {
        sublocation_id: event.payload.sublocation_id,
        name: event.payload.name,
        description: event.payload.description,
        // An interior's anchor is its parent's point (Rev 4 §14); a
        // parentless stub stays position-less until materialized (the later
        // sublocation.materialized for this id overwrites this entry).
        ...(parent?.map_position === undefined
          ? {}
          : { map_position: parent.map_position }),
        ...(event.payload.parent_id === undefined
          ? {}
          : { parent_id: event.payload.parent_id }),
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
 * The map's mechanical registry (M7 part 4, Rev 4 §14 "materialized-only
 * anchoring"): CRON movement, chance-encounter markers and Hang Around land
 * only where the painter has landed. Known minus stub-only entries — a stub
 * that later materialized counts (its latest definer is the materialize
 * event); interiors stay excluded even though they inherit their parent's
 * anchor (they never touch the map's loops).
 */
export function materializedSublocations(
  storage: Storage,
  worldId: string,
): SublocationDefinition[] {
  const stubOnly = new Set<string>();
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (event.world_id !== worldId) continue;
    if (event.type === 'sublocation.stub_created') {
      stubOnly.add(event.payload.sublocation_id);
    } else if (
      event.type === 'sublocation.materialized' ||
      event.type === 'sublocation.created'
    ) {
      stubOnly.delete(event.payload.sublocation_id);
    } else if (
      event.type === 'map_click.resolved' &&
      event.payload.outcome === 'created' &&
      event.payload.sublocation_id !== undefined
    ) {
      stubOnly.delete(event.payload.sublocation_id);
    }
  }
  return knownSublocations(storage, worldId).filter(
    (s) => !stubOnly.has(s.sublocation_id),
  );
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
    // Interiors and unmaterialized stubs have no own map presence — clicks
    // never land IN them (Rev 4 §14: reachable through scenes only).
    if (s.map_position === undefined || s.parent_id !== undefined) continue;
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
    // Interiors anchor to their parent's point but never claim the square;
    // position-less stubs claim nothing until materialized (M6 part 1).
    if (s.map_position === undefined || s.parent_id !== undefined) return false;
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

/**
 * The code-owned frontier solver (M6 part 1, Rev 4 §14: no LLM ever picks a
 * coordinate). Scores every free fog square that touches the explored area
 * (8-neighborhood — the map grows contiguously) by distance to the anchor
 * (the sublocation the creating scene was in); nearest wins, ties break
 * deterministically by row then column. A world with no explored square yet
 * falls back to the anchor's own square; a full map returns undefined — the
 * stub simply stays map-less (scenes still reach it via its backdrop).
 */
export function solveFrontierSquare(
  storage: Storage,
  worldId: string,
  anchor: { x: number; y: number },
): MapSquare | undefined {
  return solveFrontierFrom(occupiedSquaresOf(storage, worldId), anchor);
}

/** The square-grain occupancy set solveFrontierSquare scores against —
 * exposed (M7 part 2) so a multi-place apply (cold-boot seeding) can extend
 * it square by square inside one transaction. */
export function occupiedSquaresOf(
  storage: Storage,
  worldId: string,
): Set<string> {
  const occupied = new Set<string>();
  for (const s of knownSublocations(storage, worldId)) {
    if (
      s.footprint !== undefined ||
      s.map_position === undefined ||
      s.parent_id !== undefined
    ) {
      continue;
    }
    const at = squareOf(s.map_position);
    occupied.add(squareKey(at));
  }
  return occupied;
}

/** The `col:row` key occupiedSquaresOf uses. */
export function squareKey(square: MapSquare): string {
  return `${String(square.col)}:${String(square.row)}`;
}

/** The pure core of the frontier solver (same scoring, injected occupancy). */
export function solveFrontierFrom(
  occupied: ReadonlySet<string>,
  anchor: { x: number; y: number },
): MapSquare | undefined {
  if (occupied.size === 0) return squareOf(anchor);

  let best: MapSquare | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let row = 0; row < MAP_FOG_GRID; row++) {
    for (let col = 0; col < MAP_FOG_GRID; col++) {
      if (occupied.has(`${String(col)}:${String(row)}`)) continue;
      let touchesExplored = false;
      for (let dr = -1; dr <= 1 && !touchesExplored; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          if (occupied.has(`${String(col + dc)}:${String(row + dr)}`)) {
            touchesExplored = true;
            break;
          }
        }
      }
      if (!touchesExplored) continue;
      const center = squareCenter({ col, row });
      const distance = Math.hypot(center.x - anchor.x, center.y - anchor.y);
      if (distance < bestDistance) {
        best = { col, row };
        bestDistance = distance;
      }
    }
  }
  return best;
}

/**
 * The current backdrop image for a sublocation, if its painter job has
 * landed: the latest painter.completed for image id
 * `backdrop:<sublocation_id>` — the event, never the file, is the truth
 * (Brief §2.1). Absent = clients render their themed placeholder (UI Spec
 * §1.6: the slide transition plays the moment the real backdrop arrives).
 */
export function latestBackdropPath(
  storage: Storage,
  sublocationId: string,
): string | undefined {
  let path: string | undefined;
  for (const event of storage.eventLog.readSince(0, 100000)) {
    if (
      event.type === 'painter.completed' &&
      event.payload.image_id === `backdrop:${sublocationId}`
    ) {
      path = event.payload.path;
    }
  }
  return path;
}
