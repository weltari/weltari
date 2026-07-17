-- Chance-encounter markers (M7 part 4, Rev 4 §14/§17): the markers table is a
-- PROJECTION of the marker.* event family — fed by the event-log append inside
-- the SAME transaction, re-projected from the log at boot. A marker is a lazy
-- intent; `state` walks dropped → instantiated | expired and terminal rows
-- STAY (an instantiated row answers the join race with its one scene; an
-- expired row is the audit trail) — "live" always means state = 'dropped'.
CREATE TABLE markers (
  marker_id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  sublocation_id TEXT NOT NULL,
  -- JSON array of character ids (may be empty).
  involved_characters TEXT NOT NULL,
  premise_seed TEXT NOT NULL,
  dropped_at_game_time TEXT NOT NULL,
  ttl_game_minutes INTEGER NOT NULL,
  -- Engine-computed dropped_at + ttl; the sweep and the click re-validation
  -- compare this lexicographically against the world clock.
  expires_at_game_time TEXT NOT NULL,
  -- scene_end | cron | engine_topup (drop provenance).
  source TEXT NOT NULL,
  -- scene_end only: the ending scene that proposed the follow-up.
  proposed_by_scene_id TEXT,
  -- dropped | instantiated | expired.
  state TEXT NOT NULL,
  -- instantiated only: the ONE scene the first click opened.
  instantiated_scene_id TEXT,
  created_event_id INTEGER NOT NULL,
  last_event_id INTEGER NOT NULL,
  -- The first-click-wins race counter (bumped per state transition).
  version INTEGER NOT NULL
);
CREATE INDEX markers_world_state ON markers (world_id, state);
