-- objects: durable items, materialized only on touch (M7 part 3, Rev 4 §7).
-- A PROJECTION of the object.* event family: rebuilt from the log at boot,
-- kept fresh by the event-log repository applying each object event inside
-- the SAME transaction as its append — a kill can never commit an object
-- event without its row (and boot re-projects the whole table anyway).
-- V1 holders are sublocations only (owner ruling 2026-07-16: backpacks —
-- character/user holders, transfer_object, the secrecy rule — are V2), so
-- every row is public: listed by explore, observable-now. object.swept
-- deletes the row here while the tombstone event keeps the log append-only
-- (I1). Sole SQL site: repositories/objects.ts.
CREATE TABLE objects (
  object_id              TEXT PRIMARY KEY,
  world_id               TEXT NOT NULL,
  name                   TEXT NOT NULL,   -- display form, as first touched
  name_key               TEXT NOT NULL,   -- normalized dedup/resolution key
  holder_sublocation_id  TEXT NOT NULL,   -- V1's only holder kind
  payload                TEXT,            -- prose; NULL = empty carrier
  created_scene_id       TEXT,            -- NULL on proposal-applied rows
  created_event_id       INTEGER NOT NULL,
  last_touched_scene_id  TEXT,
  last_touched_event_id  INTEGER NOT NULL,
  version                INTEGER NOT NULL -- optimistic concurrency (Principle 4)
);
-- Every inventory view is a query on holder (Rev 4 §7 hygiene — never
-- per-holder table splits).
CREATE INDEX objects_holder ON objects (world_id, holder_sublocation_id);
-- (name, holder) dedup is structural: the engine gates resolve a matching
-- name to the existing row before any event is appended, so a collision
-- surfacing here is corruption, not input.
CREATE UNIQUE INDEX objects_name_holder
  ON objects (world_id, holder_sublocation_id, name_key);
