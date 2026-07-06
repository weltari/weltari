// Sole SQL site for the ledger_jobs table (Brief §2.2, §2.7). State semantics
// live here; the retry/park *policy* (which error kind does what) lives in
// ledger/runner.ts — the one catch site (Guide C7).
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { CorruptStateError, type ErrorKind } from '../../errors.js';

export const JOB_STATES = [
  'pending',
  'running',
  'committed',
  'failed',
  'parked',
] as const;
export type JobState = (typeof JOB_STATES)[number];

export interface NewLedgerJob {
  idempotency_key: string;
  world_id: string;
  type: string;
  payload: unknown;
  /** ISO UTC; omit to make the job due immediately. */
  run_at?: string;
  max_attempts?: number;
  /** e.g. `world_agent:<world_id>` — at most one running job per group. */
  serial_group?: string;
}

export interface JobError {
  kind: ErrorKind;
  code: string;
  message: string;
}

export interface LedgerJob {
  id: number;
  idempotency_key: string;
  world_id: string;
  type: string;
  payload: unknown;
  state: JobState;
  attempts: number;
  max_attempts: number;
  run_at: string;
  lease_until: string | null;
  worker_id: string | null;
  serial_group: string | null;
  last_error: JobError | null;
}

export interface LedgerRepository {
  /** Idempotent enqueue: an existing idempotency_key makes this a silent no-op (returns null). */
  enqueue(job: NewLedgerJob): LedgerJob | null;
  /**
   * Claim the next due job (pending, or failed whose backoff elapsed), skipping
   * jobs whose serial_group already has a running job. Increments attempts and
   * leases the row — so a kill -9 mid-job still burns an attempt (crash-loop cap).
   */
  claimNext(workerId: string, leaseSeconds?: number): LedgerJob | null;
  markCommitted(id: number): void;
  /** Retryable failure: back to claimable at run_at (backoff computed by the runner). */
  markRetry(id: number, runAt: string, error: JobError): void;
  /** Dead-letter: never auto-retried (I3). */
  markParked(id: number, error: JobError): void;
  /** Expired running leases -> pending. The startup/poll sweep (FINAL item 8). Returns count. */
  sweepExpiredLeases(): number;
  get(id: number): LedgerJob | null;
  countByKey(idempotencyKey: string): number;
  /**
   * Jobs still owed to a world (pending/running/failed — not terminal). The
   * scene-open blocking rule reads this (Brief §4: block only on that world +
   * involved characters' pending jobs).
   */
  listActive(worldId: string): LedgerJob[];
}

const rowSchema = z.object({
  id: z.int().positive(),
  idempotency_key: z.string(),
  world_id: z.string(),
  type: z.string(),
  payload: z.string(),
  state: z.enum(JOB_STATES),
  attempts: z.int().nonnegative(),
  max_attempts: z.int().positive(),
  run_at: z.string(),
  lease_until: z.string().nullable(),
  worker_id: z.string().nullable(),
  serial_group: z.string().nullable(),
  last_error: z.string().nullable(),
});

const jobErrorSchema = z.strictObject({
  kind: z.enum(['operational', 'bug', 'corrupt_state']),
  code: z.string(),
  message: z.string(),
});

function rowToJob(raw: unknown): LedgerJob {
  const row = rowSchema.safeParse(raw);
  if (!row.success) {
    throw new CorruptStateError(
      'ledger_row_shape',
      'ledger_jobs row does not match the table shape',
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(row.data.payload);
  } catch (cause) {
    throw new CorruptStateError(
      'ledger_payload_json',
      `job ${String(row.data.id)} payload is not JSON`,
      { cause },
    );
  }
  let lastError: JobError | null = null;
  if (row.data.last_error !== null) {
    let parsedError: unknown;
    try {
      parsedError = JSON.parse(row.data.last_error);
    } catch (cause) {
      throw new CorruptStateError(
        'ledger_error_json',
        `job ${String(row.data.id)} last_error is not JSON`,
        { cause },
      );
    }
    const checked = jobErrorSchema.safeParse(parsedError);
    if (!checked.success) {
      throw new CorruptStateError(
        'ledger_error_shape',
        `job ${String(row.data.id)} last_error does not match {kind, code, message}`,
      );
    }
    lastError = checked.data;
  }
  return { ...row.data, payload, last_error: lastError };
}

function truncateError(error: JobError): string {
  return JSON.stringify({
    kind: error.kind,
    code: error.code.slice(0, 100),
    message: error.message.slice(0, 500),
  });
}

export function createLedgerRepository(
  db: Database.Database,
  nowIso: () => string,
): LedgerRepository {
  const insert = db.prepare(
    `INSERT INTO ledger_jobs
       (idempotency_key, world_id, type, payload, state, max_attempts, run_at, serial_group, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
     ON CONFLICT(idempotency_key) DO NOTHING`,
  );
  const selectById = db.prepare('SELECT * FROM ledger_jobs WHERE id = ?');
  const selectClaimable = db.prepare(
    `SELECT * FROM ledger_jobs j
     WHERE j.state IN ('pending','failed') AND j.run_at <= ?
       AND (j.serial_group IS NULL OR NOT EXISTS (
         SELECT 1 FROM ledger_jobs r
         WHERE r.state = 'running' AND r.serial_group = j.serial_group))
     ORDER BY j.run_at ASC, j.id ASC LIMIT 1`,
  );
  const updateClaim = db.prepare(
    `UPDATE ledger_jobs
     SET state='running', attempts=attempts+1, worker_id=?, lease_until=?, updated_at=?
     WHERE id = ?`,
  );
  const updateCommitted = db.prepare(
    `UPDATE ledger_jobs SET state='committed', lease_until=NULL, worker_id=NULL, updated_at=? WHERE id = ?`,
  );
  const updateRetry = db.prepare(
    `UPDATE ledger_jobs
     SET state='failed', run_at=?, lease_until=NULL, worker_id=NULL, last_error=?, updated_at=?
     WHERE id = ?`,
  );
  const updateParked = db.prepare(
    `UPDATE ledger_jobs
     SET state='parked', lease_until=NULL, worker_id=NULL, last_error=?, updated_at=?
     WHERE id = ?`,
  );
  const updateSweep = db.prepare(
    `UPDATE ledger_jobs
     SET state='pending', lease_until=NULL, worker_id=NULL, updated_at=?
     WHERE state='running' AND lease_until IS NOT NULL AND lease_until < ?`,
  );
  const selectCountByKey = db.prepare(
    'SELECT COUNT(*) AS n FROM ledger_jobs WHERE idempotency_key = ?',
  );
  const selectActiveByWorld = db.prepare(
    `SELECT * FROM ledger_jobs
     WHERE world_id = ? AND state IN ('pending','running','failed')
     ORDER BY id ASC`,
  );

  const claimTransaction = db.transaction(
    (workerId: string, leaseSeconds: number) => {
      const now = nowIso();
      const candidate = selectClaimable.get(now);
      if (candidate === undefined) return null;
      const job = rowToJob(candidate);
      const leaseUntil = new Date(
        new Date(now).getTime() + leaseSeconds * 1000,
      ).toISOString();
      updateClaim.run(workerId, leaseUntil, now, job.id);
      return rowToJob(selectById.get(job.id));
    },
  );

  return {
    enqueue(job: NewLedgerJob): LedgerJob | null {
      const now = nowIso();
      const info = insert.run(
        job.idempotency_key,
        job.world_id,
        job.type,
        JSON.stringify(job.payload ?? null),
        job.max_attempts ?? 5,
        job.run_at ?? now,
        job.serial_group ?? null,
        now,
        now,
      );
      if (info.changes === 0) return null; // idempotency no-op
      return rowToJob(selectById.get(info.lastInsertRowid));
    },
    claimNext(workerId: string, leaseSeconds = 60): LedgerJob | null {
      return claimTransaction(workerId, leaseSeconds);
    },
    markCommitted(id: number): void {
      updateCommitted.run(nowIso(), id);
    },
    markRetry(id: number, runAt: string, error: JobError): void {
      updateRetry.run(runAt, truncateError(error), nowIso(), id);
    },
    markParked(id: number, error: JobError): void {
      updateParked.run(truncateError(error), nowIso(), id);
    },
    sweepExpiredLeases(): number {
      const now = nowIso();
      return updateSweep.run(now, now).changes;
    },
    get(id: number): LedgerJob | null {
      const raw = selectById.get(id);
      return raw === undefined ? null : rowToJob(raw);
    },
    listActive(worldId: string): LedgerJob[] {
      return selectActiveByWorld.all(worldId).map(rowToJob);
    },
    countByKey(idempotencyKey: string): number {
      const row = z
        .object({ n: z.int().nonnegative() })
        .safeParse(selectCountByKey.get(idempotencyKey));
      if (!row.success) {
        throw new CorruptStateError(
          'ledger_count',
          'COUNT(*) returned a non-integer',
        );
      }
      return row.data.n;
    },
  };
}
