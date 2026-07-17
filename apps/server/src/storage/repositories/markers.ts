// The markers repository (M7 part 4, Rev 4 §14/§17): chance-encounter
// markers as lazy intents. The markers table is a PROJECTION of the marker.*
// event family — rebuilt from the log at boot, kept fresh by the event-log
// repository applying each marker event inside the SAME transaction as its
// append, so a kill can never commit a marker event without its row. Unlike
// the objects table, terminal rows STAY: an `instantiated` row answers the
// join race with its one scene; an `expired` row is the audit trail. "Live"
// always means state = 'dropped'. Sole SQL site for the markers table.
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { WeltariEventSchema, type WeltariEvent } from '@weltari/protocol';
import { CorruptStateError } from '../../errors.js';

/** The marker events the projection folds — the repository's whole input. */
export type MarkerEvent = Extract<
  WeltariEvent,
  { type: 'marker.dropped' | 'marker.instantiated' | 'marker.expired' }
>;

export type MarkerState = 'dropped' | 'instantiated' | 'expired';

export interface MarkerRow {
  marker_id: string;
  world_id: string;
  kind: 'map_event';
  sublocation_id: string;
  involved_characters: string[];
  premise_seed: string;
  dropped_at_game_time: string;
  ttl_game_minutes: number;
  expires_at_game_time: string;
  source: 'scene_end' | 'cron' | 'engine_topup';
  /** scene_end only: the ending scene that proposed the follow-up. */
  proposed_by_scene_id: string | undefined;
  state: MarkerState;
  /** instantiated only: the ONE scene the first click opened. */
  instantiated_scene_id: string | undefined;
  version: number;
}

export interface MarkersRepository {
  /** Fold one committed marker event — called by the event-log append,
   * in-transaction. */
  apply(event: MarkerEvent): void;
  byId(markerId: string): MarkerRow | undefined;
  /** The live set (state = 'dropped'), oldest drop first — the 1–5
   * invariant, the sweep and the client pins all read this. */
  live(worldId: string): MarkerRow[];
  /** Drop and re-project the whole table from the events table (boot). */
  rebuild(): void;
}

const rowSchema = z.object({
  marker_id: z.string().min(1),
  world_id: z.string().min(1),
  kind: z.literal('map_event'),
  sublocation_id: z.string().min(1),
  involved_characters: z.string(),
  premise_seed: z.string().min(1),
  dropped_at_game_time: z.string().min(1),
  ttl_game_minutes: z.int().positive(),
  expires_at_game_time: z.string().min(1),
  source: z.enum(['scene_end', 'cron', 'engine_topup']),
  proposed_by_scene_id: z.string().nullable(),
  state: z.enum(['dropped', 'instantiated', 'expired']),
  instantiated_scene_id: z.string().nullable(),
  version: z.int().positive(),
});

const castSchema = z.array(z.string().min(1));

function toMarkerRow(raw: unknown): MarkerRow {
  const row = rowSchema.safeParse(raw);
  if (!row.success) {
    throw new CorruptStateError(
      'marker_row_shape',
      'markers row does not match the table shape',
    );
  }
  let castRaw: unknown;
  try {
    castRaw = JSON.parse(row.data.involved_characters);
  } catch (cause) {
    throw new CorruptStateError(
      'marker_cast_json',
      `marker ${row.data.marker_id} involved_characters is not JSON`,
      { cause },
    );
  }
  const cast = castSchema.safeParse(castRaw);
  if (!cast.success) {
    throw new CorruptStateError(
      'marker_cast_shape',
      `marker ${row.data.marker_id} involved_characters is not a string array`,
    );
  }
  return {
    marker_id: row.data.marker_id,
    world_id: row.data.world_id,
    kind: row.data.kind,
    sublocation_id: row.data.sublocation_id,
    involved_characters: cast.data,
    premise_seed: row.data.premise_seed,
    dropped_at_game_time: row.data.dropped_at_game_time,
    ttl_game_minutes: row.data.ttl_game_minutes,
    expires_at_game_time: row.data.expires_at_game_time,
    source: row.data.source,
    proposed_by_scene_id: row.data.proposed_by_scene_id ?? undefined,
    state: row.data.state,
    instantiated_scene_id: row.data.instantiated_scene_id ?? undefined,
    version: row.data.version,
  };
}

const sourceRowSchema = z.object({
  id: z.int().positive(),
  world_id: z.string(),
  actor_id: z.string(),
  type: z.string(),
  payload: z.string(),
  ts: z.string(),
});

function toMarkerEvent(raw: unknown): MarkerEvent {
  const row = sourceRowSchema.safeParse(raw);
  if (!row.success) {
    throw new CorruptStateError(
      'marker_source_row',
      'events row does not match the table shape',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data.payload);
  } catch (cause) {
    throw new CorruptStateError(
      'marker_source_json',
      `event ${String(row.data.id)} payload is not JSON`,
      { cause },
    );
  }
  // Own stored data failing validation is corruption, not a boundary
  // rejection (Guide C2).
  const event = WeltariEventSchema.safeParse({ ...row.data, payload: parsed });
  if (!event.success) {
    throw new CorruptStateError(
      'marker_source_event',
      `event ${String(row.data.id)} does not validate against the protocol schema`,
    );
  }
  const data = event.data;
  if (
    data.type === 'marker.dropped' ||
    data.type === 'marker.instantiated' ||
    data.type === 'marker.expired'
  ) {
    return data;
  }
  throw new CorruptStateError(
    'marker_source_event',
    `event ${String(row.data.id)} is not a marker event`,
  );
}

export function createMarkersRepository(
  db: Database.Database,
): MarkersRepository {
  const insert = db.prepare(
    `INSERT INTO markers (marker_id, world_id, kind, sublocation_id,
       involved_characters, premise_seed, dropped_at_game_time,
       ttl_game_minutes, expires_at_game_time, source, proposed_by_scene_id,
       state, instantiated_scene_id, created_event_id, last_event_id, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dropped', NULL, ?, ?, 1)`,
  );
  // State transitions guard on state = 'dropped' IN SQL: an event replaying
  // onto a settled row is corruption the guard turns into changes === 0.
  const instantiate = db.prepare(
    `UPDATE markers SET state = 'instantiated', instantiated_scene_id = ?,
       last_event_id = ?, version = version + 1
     WHERE marker_id = ? AND state = 'dropped'`,
  );
  const expire = db.prepare(
    `UPDATE markers SET state = 'expired', last_event_id = ?,
       version = version + 1
     WHERE marker_id = ? AND state = 'dropped'`,
  );
  const selectById = db.prepare('SELECT * FROM markers WHERE marker_id = ?');
  const selectLive = db.prepare(
    `SELECT * FROM markers WHERE world_id = ? AND state = 'dropped'
     ORDER BY created_event_id ASC`,
  );
  const wipe = db.prepare('DELETE FROM markers');
  const selectSource = db.prepare(
    `SELECT * FROM events
     WHERE type IN ('marker.dropped', 'marker.instantiated', 'marker.expired')
     ORDER BY id ASC`,
  );

  function corrupt(eventType: string, markerId: string): never {
    // The engine's fused re-check settles the race BEFORE the append, so an
    // event landing on a missing or already-settled row is corruption, not
    // input (Guide C2).
    throw new CorruptStateError(
      'marker_event_orphaned',
      `${eventType} names marker ${markerId} but no live row accepts it`,
    );
  }

  const repository: MarkersRepository = {
    apply(event: MarkerEvent): void {
      switch (event.type) {
        case 'marker.dropped': {
          insert.run(
            event.payload.marker_id,
            event.world_id,
            event.payload.kind,
            event.payload.sublocation_id,
            JSON.stringify(event.payload.involved_characters),
            event.payload.premise_seed,
            event.payload.dropped_at_game_time,
            event.payload.ttl_game_minutes,
            event.payload.expires_at_game_time,
            event.payload.source,
            event.payload.scene_id ?? null,
            event.id,
            event.id,
          );
          return;
        }
        case 'marker.instantiated': {
          const info = instantiate.run(
            event.payload.scene_id,
            event.id,
            event.payload.marker_id,
          );
          if (info.changes === 0) corrupt(event.type, event.payload.marker_id);
          return;
        }
        case 'marker.expired': {
          const info = expire.run(event.id, event.payload.marker_id);
          if (info.changes === 0) corrupt(event.type, event.payload.marker_id);
          return;
        }
      }
    },
    byId(markerId: string): MarkerRow | undefined {
      const raw: unknown = selectById.get(markerId);
      return raw === undefined ? undefined : toMarkerRow(raw);
    },
    live(worldId: string): MarkerRow[] {
      const rows: unknown[] = selectLive.all(worldId);
      return rows.map(toMarkerRow);
    },
    rebuild(): void {
      const run = db.transaction(() => {
        wipe.run();
        const rows: unknown[] = selectSource.all();
        for (const raw of rows) {
          repository.apply(toMarkerEvent(raw));
        }
      });
      run();
    },
  };
  return repository;
}
