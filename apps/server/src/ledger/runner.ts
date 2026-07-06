// The job runner — the ONLY catch site for job execution (Guide C7). Maps the
// error kind to a ledger state in one exhaustive switch: operational -> backoff
// retry then parked; bug -> parked immediately (never retry deterministic bugs);
// corrupt_state -> fatal. Every state change emits a job.failed / job.parked
// event for the UI in the same transaction as the row change (WriteGate).
import { AppError, BugError, type ErrorKind } from '../errors.js';
import type { Storage } from '../storage/db.js';
import type { JobError, LedgerJob } from '../storage/repositories/ledger.js';

export type JobHandler = (job: LedgerJob) => Promise<void>;

export interface RunnerOptions {
  storage: Storage;
  handlers: Record<string, JobHandler>;
  nowIso: () => string;
  workerId: string;
  /** Wired to observability/fatal in main; recorded (not exiting) in tests. */
  onFatal: (error: AppError) => void;
  leaseSeconds?: number;
  maxBackoffSeconds?: number;
}

export interface Runner {
  /**
   * One poll cycle: sweep expired leases, claim at most one due job, run it,
   * commit or classify the failure. Returns true if a job was claimed.
   * The loop wrapper lives in main.ts; tests call tick() directly (no sleeps).
   */
  tick(): Promise<boolean>;
}

function toAppError(thrown: unknown): AppError {
  if (thrown instanceof AppError) return thrown;
  // A handler threw something untyped: that is our code breaking its contract.
  return new BugError(
    'untyped_throw',
    thrown instanceof Error ? thrown.message : String(thrown),
    {
      cause: thrown,
    },
  );
}

function toJobError(error: AppError): JobError {
  return { kind: error.kind, code: error.code, message: error.message };
}

export function createRunner(options: RunnerOptions): Runner {
  const {
    storage,
    handlers,
    nowIso,
    workerId,
    onFatal,
    leaseSeconds = 60,
    maxBackoffSeconds = 300,
  } = options;

  function backoffIso(attempts: number): string {
    const delaySeconds = Math.min(2 ** attempts, maxBackoffSeconds);
    return new Date(
      new Date(nowIso()).getTime() + delaySeconds * 1000,
    ).toISOString();
  }

  function settleFailure(job: LedgerJob, error: AppError): void {
    const kind: ErrorKind = error.kind;
    switch (kind) {
      case 'operational': {
        if (job.attempts >= job.max_attempts) {
          park(job, error);
        } else {
          storage.transact(() => {
            storage.ledger.markRetry(
              job.id,
              backoffIso(job.attempts),
              toJobError(error),
            );
            storage.eventLog.append({
              world_id: job.world_id,
              actor_id: 'system:ledger',
              type: 'job.failed',
              payload: {
                job_id: job.id,
                job_type: job.type,
                attempts: job.attempts,
                error: toJobError(error),
              },
            });
          });
        }
        return;
      }
      case 'bug': {
        park(job, error);
        return;
      }
      case 'corrupt_state': {
        // No row change: in-memory state is unreliable; restart-from-durable is
        // the one tested recovery path (Guide C5).
        onFatal(error);
        return;
      }
    }
  }

  function park(job: LedgerJob, error: AppError): void {
    storage.transact(() => {
      storage.ledger.markParked(job.id, toJobError(error));
      storage.eventLog.append({
        world_id: job.world_id,
        actor_id: 'system:ledger',
        type: 'job.parked',
        payload: {
          job_id: job.id,
          job_type: job.type,
          attempts: job.attempts,
          error: toJobError(error),
        },
      });
    });
  }

  return {
    async tick(): Promise<boolean> {
      storage.ledger.sweepExpiredLeases();
      const job = storage.ledger.claimNext(workerId, leaseSeconds);
      if (job === null) return false;

      const handler = handlers[job.type];
      if (handler === undefined) {
        park(
          job,
          new BugError(
            'no_handler',
            `no handler registered for job type ${job.type}`,
          ),
        );
        return true;
      }
      try {
        await handler(job);
        storage.ledger.markCommitted(job.id);
      } catch (thrown) {
        // CATCH-OK: the C7 catch site — settleFailure maps kind -> retry/park/fatal.
        settleFailure(job, toAppError(thrown));
      }
      return true;
    },
  };
}
