-- events: append-only event log (Brief §2.1). Rows are never updated or deleted;
-- everything else in the system is a rebuildable projection of this table.
CREATE TABLE events (
  id       INTEGER PRIMARY KEY,   -- monotonic (SQLite rowid); doubles as SSE Last-Event-ID
  world_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,         -- Brief §2.8: every event carries actor_id
  type     TEXT NOT NULL,         -- closed union in @weltari/protocol events.ts
  payload  TEXT NOT NULL,         -- JSON, shape per event type (validated on read)
  ts       TEXT NOT NULL          -- wall-clock append time, ISO 8601 UTC
);

-- The append-only rule is enforced by the database itself, not convention (Invariant I1).
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only (Brief §2.1)'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only (Brief §2.1)'); END;

-- Replay path: SSE reconnect reads events with id > Last-Event-ID for one world.
CREATE INDEX idx_events_world_id ON events (world_id, id);
