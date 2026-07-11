-- user_profile: the GM's profiling side store (M7 part 2, Rev 4 §9 Job 2 /
-- §4.3). DELIBERATELY OUTSIDE the event-sourced world: profiling text is
-- personal data that must be truly erasable (GDPR), while the event log is
-- append-only forever — so hypotheses live here as MUTABLE rows (the one
-- sanctioned exception, like image pixels living as files), events carry
-- only counts/references, and delete-profile physically removes rows that
-- no replay can resurrect. Sole writer: the GM's profile_analysis ledger
-- job (plus the delete command); sole SQL site: repositories/user-profile.ts.
CREATE TABLE user_profile (
  id          INTEGER PRIMARY KEY,
  actor_id    TEXT NOT NULL,          -- whose profile this row belongs to
  kind        TEXT NOT NULL,          -- 'hypothesis' | 'engagement'
  body        TEXT NOT NULL,          -- the structured text (LLM-gated)
  context_id  TEXT NOT NULL,          -- the ended scene/chat range it came from
  created_at  TEXT NOT NULL           -- wall-clock ISO
);
CREATE INDEX user_profile_actor ON user_profile (actor_id, kind);
