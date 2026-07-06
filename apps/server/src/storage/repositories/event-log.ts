// Sole write path into the events table. The interface HAS no mutating members
// beyond append — the append-only rule is also enforced in SQLite triggers (I1).
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { WeltariEventSchema, type WeltariEvent } from '@weltari/protocol';
import { CorruptStateError } from '../../errors.js';

/** A WeltariEvent before the log assigns `id` and `ts` (distributes over the union). */
export type NewEvent = WeltariEvent extends infer E
  ? E extends { id: number; ts: string }
    ? Omit<E, 'id' | 'ts'>
    : never
  : never;

export interface EventLogRepository {
  /** Sole write path (Brief §2.1). Returns the persisted event with its log seq. */
  append(event: NewEvent): WeltariEvent;
  /** Events with id > sinceId, ascending — the SSE Last-Event-ID replay read. */
  readSince(sinceId: number, limit?: number): WeltariEvent[];
  /** Highest assigned event id, 0 on an empty log (the hello frame's last_event_id). */
  lastId(): number;
}

const rowSchema = z.object({
  id: z.int().positive(),
  world_id: z.string(),
  actor_id: z.string(),
  type: z.string(),
  payload: z.string(),
  ts: z.string(),
});

function rowToEvent(raw: unknown): WeltariEvent {
  const row = rowSchema.safeParse(raw);
  if (!row.success) {
    throw new CorruptStateError(
      'event_row_shape',
      'events row does not match the table shape',
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(row.data.payload);
  } catch (cause) {
    throw new CorruptStateError(
      'event_payload_json',
      `event ${String(row.data.id)} payload is not JSON`,
      {
        cause,
      },
    );
  }
  // Own stored data failing validation is corruption, not a boundary rejection (Guide C2).
  const event = WeltariEventSchema.safeParse({ ...row.data, payload });
  if (!event.success) {
    throw new CorruptStateError(
      'event_row_invalid',
      `event ${String(row.data.id)} does not validate against the protocol schema`,
    );
  }
  return event.data;
}

export function createEventLogRepository(
  db: Database.Database,
  nowIso: () => string,
): EventLogRepository {
  const insert = db.prepare(
    'INSERT INTO events (world_id, actor_id, type, payload, ts) VALUES (?, ?, ?, ?, ?)',
  );
  const selectById = db.prepare('SELECT * FROM events WHERE id = ?');
  const selectSince = db.prepare(
    'SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?',
  );
  const selectLastId = db.prepare(
    'SELECT COALESCE(MAX(id), 0) AS last_id FROM events',
  );

  return {
    append(event: NewEvent): WeltariEvent {
      const info = insert.run(
        event.world_id,
        event.actor_id,
        event.type,
        JSON.stringify(event.payload),
        nowIso(),
      );
      return rowToEvent(selectById.get(info.lastInsertRowid));
    },
    readSince(sinceId: number, limit = 1000): WeltariEvent[] {
      const rows: unknown[] = selectSince.all(sinceId, limit);
      return rows.map(rowToEvent);
    },
    lastId(): number {
      const row = z
        .object({ last_id: z.int().nonnegative() })
        .safeParse(selectLastId.get());
      if (!row.success) {
        throw new CorruptStateError(
          'event_last_id',
          'MAX(id) query returned a non-integer',
        );
      }
      return row.data.last_id;
    },
  };
}
