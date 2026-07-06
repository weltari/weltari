-- ledger_jobs: the Job Ledger (Brief §2.2). Durable cold-path work: idempotency
-- keys, leases, retries, dead-letter lane. Jobs are idempotent projections of
-- the immutable event log — no rollback, saga-style.
CREATE TABLE ledger_jobs (
  id              INTEGER PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,  -- duplicate enqueue is a silent no-op (I3)
  world_id        TEXT NOT NULL,
  type            TEXT NOT NULL,          -- handler name, e.g. 'reflect', 'cron.heartbeat'
  payload         TEXT NOT NULL,          -- JSON job args; handler validates on read
  -- pending: claimable when run_at is due
  -- running: leased by a worker; lease_until expiry makes it claimable again (sweep)
  -- failed:  operational failure awaiting its backoff retry (still claimable at run_at)
  -- committed / parked: terminal; parked = dead-letter, never auto-retried (I3)
  state           TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','running','committed','failed','parked')),
  attempts        INTEGER NOT NULL DEFAULT 0,   -- incremented at claim time: a crash mid-job counts
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  run_at          TEXT NOT NULL,          -- ISO UTC; croner writes future occurrences here
  lease_until     TEXT,                   -- worker lease expiry; expired+running => retryable (Rev 4 §4.2)
  worker_id       TEXT,
  -- serialization group, e.g. 'world_agent:<world_id>' — at most one running job
  -- per group (Brief §2.2: World Agent = 1 per world). NULL = no serialization.
  serial_group    TEXT,
  last_error      TEXT,                   -- truncated JSON {kind, code, message}; never prompt content (C7)
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_ledger_jobs_claim ON ledger_jobs (state, run_at);
CREATE INDEX idx_ledger_jobs_world ON ledger_jobs (world_id, state);
