// The objects repository (M7 part 3, Rev 4 §7): durable items, materialized
// only on touch. The objects table is a PROJECTION of the object.* event
// family — rebuilt from the log at boot, kept fresh by the event-log
// repository applying each object event inside the SAME transaction as its
// append, so a kill can never commit an object event without its row. V1
// holders are sublocations only (owner ruling 2026-07-16: backpacks are V2),
// so every row is public. object.swept deletes the row while its tombstone
// event keeps the log append-only (I1). Sole SQL site for the objects table.
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { WeltariEventSchema, type WeltariEvent } from '@weltari/protocol';
import { CorruptStateError } from '../../errors.js';

/** The object events the projection folds — the repository's whole input. */
export type ObjectEvent = Extract<
  WeltariEvent,
  {
    type:
      | 'object.created'
      | 'object.payload_written'
      | 'object.moved'
      | 'object.swept';
  }
>;

export interface ObjectRow {
  object_id: string;
  world_id: string;
  /** Display form, exactly as the creating touch named it. */
  name: string;
  holder_sublocation_id: string;
  /** Prose: what the object is and/or contains. Undefined = empty carrier. */
  payload: string | undefined;
  /** The scene whose touch materialized the row; undefined on
   * proposal-applied objects (they have no creating scene and are never
   * GC candidates). */
  created_scene_id: string | undefined;
  last_touched_scene_id: string | undefined;
  version: number;
}

/**
 * The shared dedup/resolution key (Rev 4 §7: dedup by (name, holder); a
 * later prose reference resolves by name across reachable holders). Models
 * vary case and spacing on re-mention — normalize both sides so "The Brass
 * Key" touches the row "a brass key" created. Exported so the engine gates
 * and the repository can never disagree on what "the same name" means.
 */
export function objectNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface ObjectsRepository {
  /** Fold one committed object event — called by the event-log append,
   * in-transaction. */
  apply(event: ObjectEvent): void;
  byId(objectId: string): ObjectRow | undefined;
  /** Everything publicly held at a sublocation — the explore listing. */
  heldAt(worldId: string, sublocationId: string): ObjectRow[];
  /**
   * Reachable-holder name resolution (Rev 4 §7): rows matching the name
   * across the given holders. One match resolves the reference; several =
   * ambiguous, all returned (IDs never duplicate, so the caller stays safe).
   */
  resolveName(
    worldId: string,
    name: string,
    reachableSublocationIds: string[],
  ): ObjectRow[];
  /**
   * GC-sweep candidates (Rev 4 §7): payload-less, sublocation-held, and
   * never touched outside their creating scene. The object-gc job overlays
   * the one check the table cannot answer — that the creating scene has
   * actually ended.
   */
  strayCandidates(worldId: string): ObjectRow[];
  /** Drop and re-project the whole table from the events table (boot). */
  rebuild(): void;
}

const rowSchema = z.object({
  object_id: z.string().min(1),
  world_id: z.string().min(1),
  name: z.string().min(1),
  holder_sublocation_id: z.string().min(1),
  payload: z.string().nullable(),
  created_scene_id: z.string().nullable(),
  last_touched_scene_id: z.string().nullable(),
  version: z.int().positive(),
});

function toObjectRow(raw: unknown): ObjectRow {
  const row = rowSchema.safeParse(raw);
  if (!row.success) {
    throw new CorruptStateError(
      'object_row_shape',
      'objects row does not match the table shape',
    );
  }
  return {
    object_id: row.data.object_id,
    world_id: row.data.world_id,
    name: row.data.name,
    holder_sublocation_id: row.data.holder_sublocation_id,
    payload: row.data.payload ?? undefined,
    created_scene_id: row.data.created_scene_id ?? undefined,
    last_touched_scene_id: row.data.last_touched_scene_id ?? undefined,
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

function toObjectEvent(raw: unknown): ObjectEvent {
  const row = sourceRowSchema.safeParse(raw);
  if (!row.success) {
    throw new CorruptStateError(
      'object_source_row',
      'events row does not match the table shape',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data.payload);
  } catch (cause) {
    throw new CorruptStateError(
      'object_source_json',
      `event ${String(row.data.id)} payload is not JSON`,
      { cause },
    );
  }
  // Own stored data failing validation is corruption, not a boundary
  // rejection (Guide C2).
  const event = WeltariEventSchema.safeParse({ ...row.data, payload: parsed });
  if (!event.success) {
    throw new CorruptStateError(
      'object_source_event',
      `event ${String(row.data.id)} does not validate against the protocol schema`,
    );
  }
  const data = event.data;
  if (
    data.type === 'object.created' ||
    data.type === 'object.payload_written' ||
    data.type === 'object.moved' ||
    data.type === 'object.swept'
  ) {
    return data;
  }
  throw new CorruptStateError(
    'object_source_event',
    `event ${String(row.data.id)} is not an object event`,
  );
}

export function createObjectsRepository(
  db: Database.Database,
): ObjectsRepository {
  const insert = db.prepare(
    `INSERT INTO objects (object_id, world_id, name, name_key,
       holder_sublocation_id, payload, created_scene_id, created_event_id,
       last_touched_scene_id, last_touched_event_id, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  const writePayload = db.prepare(
    `UPDATE objects SET payload = ?, last_touched_scene_id = ?,
       last_touched_event_id = ?, version = version + 1
     WHERE object_id = ?`,
  );
  const move = db.prepare(
    `UPDATE objects SET holder_sublocation_id = ?, last_touched_scene_id = ?,
       last_touched_event_id = ?, version = version + 1
     WHERE object_id = ?`,
  );
  const sweep = db.prepare('DELETE FROM objects WHERE object_id = ?');
  const selectById = db.prepare('SELECT * FROM objects WHERE object_id = ?');
  const selectHeldAt = db.prepare(
    `SELECT * FROM objects WHERE world_id = ? AND holder_sublocation_id = ?
     ORDER BY created_event_id ASC`,
  );
  const selectByNameKey = db.prepare(
    `SELECT * FROM objects WHERE world_id = ? AND name_key = ?
     ORDER BY created_event_id ASC`,
  );
  const selectStrays = db.prepare(
    `SELECT * FROM objects WHERE world_id = ? AND payload IS NULL
       AND created_scene_id IS NOT NULL
       AND last_touched_scene_id = created_scene_id
     ORDER BY created_event_id ASC`,
  );
  const wipe = db.prepare('DELETE FROM objects');
  const selectSource = db.prepare(
    `SELECT * FROM events
     WHERE type IN ('object.created', 'object.payload_written',
                    'object.moved', 'object.swept')
     ORDER BY id ASC`,
  );

  function corrupt(eventType: string, objectId: string): never {
    // The engine gates resolve every ref to a live row before the append, so
    // an event pointing at nothing is corruption, not input (Guide C2).
    throw new CorruptStateError(
      'object_event_orphaned',
      `${eventType} names object ${objectId} but no such row exists`,
    );
  }

  const repository: ObjectsRepository = {
    apply(event: ObjectEvent): void {
      switch (event.type) {
        case 'object.created': {
          insert.run(
            event.payload.object_id,
            event.world_id,
            event.payload.name,
            objectNameKey(event.payload.name),
            event.payload.holder_sublocation_id,
            event.payload.object_payload ?? null,
            event.payload.scene_id ?? null,
            event.id,
            event.payload.scene_id ?? null,
            event.id,
          );
          return;
        }
        case 'object.payload_written': {
          const info = writePayload.run(
            event.payload.object_payload,
            event.payload.scene_id,
            event.id,
            event.payload.object_id,
          );
          if (info.changes === 0) corrupt(event.type, event.payload.object_id);
          return;
        }
        case 'object.moved': {
          const info = move.run(
            event.payload.to_sublocation_id,
            event.payload.scene_id,
            event.id,
            event.payload.object_id,
          );
          if (info.changes === 0) corrupt(event.type, event.payload.object_id);
          return;
        }
        case 'object.swept': {
          const info = sweep.run(event.payload.object_id);
          if (info.changes === 0) corrupt(event.type, event.payload.object_id);
          return;
        }
      }
    },
    byId(objectId: string): ObjectRow | undefined {
      const raw: unknown = selectById.get(objectId);
      return raw === undefined ? undefined : toObjectRow(raw);
    },
    heldAt(worldId: string, sublocationId: string): ObjectRow[] {
      const rows: unknown[] = selectHeldAt.all(worldId, sublocationId);
      return rows.map(toObjectRow);
    },
    resolveName(
      worldId: string,
      name: string,
      reachableSublocationIds: string[],
    ): ObjectRow[] {
      // Rows per (world, name_key) are few — filter holders in code rather
      // than building a dynamic IN list.
      const reachable = new Set(reachableSublocationIds);
      const rows: unknown[] = selectByNameKey.all(worldId, objectNameKey(name));
      return rows
        .map(toObjectRow)
        .filter((row) => reachable.has(row.holder_sublocation_id));
    },
    strayCandidates(worldId: string): ObjectRow[] {
      const rows: unknown[] = selectStrays.all(worldId);
      return rows.map(toObjectRow);
    },
    rebuild(): void {
      const run = db.transaction(() => {
        wipe.run();
        const rows: unknown[] = selectSource.all();
        for (const raw of rows) {
          repository.apply(toObjectEvent(raw));
        }
      });
      run();
    },
  };
  return repository;
}
