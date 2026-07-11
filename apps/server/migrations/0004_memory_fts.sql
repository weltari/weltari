-- The Search Index (Rev 4 §4.2, V1: SQLite FTS5 — built into better-sqlite3,
-- zero new dependencies): full-text retrieval over memory deltas. The table
-- is a PROJECTION of memory.delta_committed events, keyed by the delta's
-- event-log id and REBUILT FROM THE LOG at every boot (projection
-- discipline) — dropping or corrupting it loses nothing. character_id and
-- event_id are UNINDEXED: stored for filtering, never full-text matched, so
-- a query can only ever match delta CONTENT and the participation gate is a
-- plain WHERE equality on the character column.
CREATE VIRTUAL TABLE memory_delta_fts USING fts5(
  content,
  character_id UNINDEXED,
  event_id UNINDEXED
);
