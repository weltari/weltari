// The Search Index repository (Rev 4 §4.2, M7 part 1): FTS5 over memory
// deltas, behind an interface so embedding retrieval is a drop-in upgrade if
// keyword recall provably hurts in playtesting. The FTS table is a PROJECTION
// of memory.delta_committed events: rebuilt from the log at boot, kept fresh
// by the event-log repository indexing each delta inside the SAME transaction
// as its append — a kill can never leave a committed delta unindexed past the
// next boot. Participation-gating is structural: every search filters on the
// character column; there is no unscoped read.
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { CorruptStateError } from '../../errors.js';

export interface MemoryIndexHit {
  /** The memory.delta_committed event's log id. */
  event_id: number;
  content: string;
}

export interface MemoryIndexRepository {
  /** Index one committed delta — called by the event-log append, in-transaction. */
  add(eventId: number, characterId: string, content: string): void;
  /** BM25-ranked search over ONE character's own deltas (best match first). */
  search(characterId: string, query: string, limit: number): MemoryIndexHit[];
  /** Drop and re-project the whole index from the events table (boot). */
  rebuild(): void;
}

/**
 * LLM-written queries arrive as free text and FTS5 MATCH has its own syntax
 * (quotes, colons, NEAR, parentheses) — raw input would throw on half of
 * real queries. Reduce to word tokens, quote each, OR them: maximal recall,
 * BM25 does the ranking, and hostile syntax is inert inside the quotes.
 */
function toMatchExpression(query: string): string | undefined {
  const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  const meaningful = tokens.filter((t) => t.length > 1);
  if (meaningful.length === 0) return undefined;
  return meaningful.map((t) => `"${t}"`).join(' OR ');
}

const hitSchema = z.object({
  event_id: z.int().positive(),
  content: z.string(),
});

const deltaRowSchema = z.object({
  id: z.int().positive(),
  payload: z.string(),
});

const deltaPayloadSchema = z.looseObject({
  character_id: z.string().min(1),
  content: z.string().min(1),
});

export function createMemoryIndexRepository(
  db: Database.Database,
): MemoryIndexRepository {
  const insert = db.prepare(
    'INSERT INTO memory_delta_fts (content, character_id, event_id) VALUES (?, ?, ?)',
  );
  const select = db.prepare(
    `SELECT event_id, content FROM memory_delta_fts
     WHERE memory_delta_fts MATCH ? AND character_id = ?
     ORDER BY rank LIMIT ?`,
  );
  const wipe = db.prepare('DELETE FROM memory_delta_fts');
  const selectDeltas = db.prepare(
    "SELECT id, payload FROM events WHERE type = 'memory.delta_committed' ORDER BY id ASC",
  );

  const repository: MemoryIndexRepository = {
    add(eventId: number, characterId: string, content: string): void {
      insert.run(content, characterId, eventId);
    },
    search(
      characterId: string,
      query: string,
      limit: number,
    ): MemoryIndexHit[] {
      const match = toMatchExpression(query);
      if (match === undefined) return [];
      const rows: unknown[] = select.all(match, characterId, limit);
      return rows.map((raw) => {
        const hit = hitSchema.safeParse(raw);
        if (!hit.success) {
          throw new CorruptStateError(
            'memory_index_row_shape',
            'memory_delta_fts row does not match {event_id, content}',
          );
        }
        return hit.data;
      });
    },
    rebuild(): void {
      const run = db.transaction(() => {
        wipe.run();
        const rows: unknown[] = selectDeltas.all();
        for (const raw of rows) {
          const row = deltaRowSchema.safeParse(raw);
          if (!row.success) {
            throw new CorruptStateError(
              'memory_index_source_row',
              'events row does not match the table shape',
            );
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(row.data.payload);
          } catch (cause) {
            throw new CorruptStateError(
              'memory_index_source_json',
              `event ${String(row.data.id)} payload is not JSON`,
              { cause },
            );
          }
          const payload = deltaPayloadSchema.safeParse(parsed);
          if (!payload.success) {
            throw new CorruptStateError(
              'memory_index_source_payload',
              `event ${String(row.data.id)} is memory.delta_committed but lacks {character_id, content}`,
            );
          }
          repository.add(
            row.data.id,
            payload.data.character_id,
            payload.data.content,
          );
        }
      });
      run();
    },
  };
  return repository;
}
