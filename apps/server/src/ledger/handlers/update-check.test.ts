// The update_check 404 rule (week 19, audit item 5): GitHub answers 404 on
// /releases/latest while a repo has zero releases — the standing dev-world
// state. That is "nothing to announce", never a failure: the job completes
// with zero events instead of parking a retrying error on every boot. Every
// OTHER non-ok status stays a typed OperationalError so the runner retries.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { OperationalError } from '../../errors.js';
import { createEventSink } from '../../engine/event-sink.js';
import { Bus } from '../../http/bus.js';
import { createRootLogger } from '../../observability/logger.js';
import { openStorage } from '../../storage/db.js';
import type { LedgerJob } from '../../storage/repositories/ledger.js';
import { createUpdateCheckHandler } from './update-check.js';

function quietLogger(): ReturnType<typeof createRootLogger> {
  const sink = new Writable({
    write(_c, _e, cb): void {
      cb();
    },
  });
  return createRootLogger({ level: 'debug', stream: sink });
}

function makeJob(): LedgerJob {
  return {
    id: 1,
    idempotency_key: 'update_check:test',
    world_id: 'w1',
    type: 'update_check',
    payload: {},
    state: 'running',
    attempts: 1,
    max_attempts: 5,
    run_at: '2026-07-21T00:00:00.000Z',
    lease_until: null,
    worker_id: 'test-worker',
    serial_group: null,
    last_error: null,
  };
}

function makeHandler(status: number): {
  run: () => Promise<void>;
  eventCount: () => number;
} {
  const storage = openStorage({
    dbPath: join(mkdtempSync(join(tmpdir(), 'wl-upd-')), 'w.db'),
  });
  const logger = quietLogger();
  const sink = createEventSink(storage, new Bus(logger));
  const handler = createUpdateCheckHandler({
    storage,
    sink,
    logger,
    currentVersion: '0.1.0',
    releasesUrl: 'https://releases.test/latest',
    fetchFn: async () => Promise.resolve(new Response('not found', { status })),
  });
  return {
    run: async () => handler(makeJob()),
    eventCount: () => storage.eventLog.readSince(0, 1000).length,
  };
}

describe('update_check on a repo with no releases (audit item 5)', () => {
  it('404 = nothing published yet: completes cleanly, zero events', async () => {
    const fixture = makeHandler(404);
    await expect(fixture.run()).resolves.toBeUndefined();
    expect(fixture.eventCount()).toBe(0);
  });

  it('any other non-ok status stays a retryable OperationalError', async () => {
    const fixture = makeHandler(500);
    await expect(fixture.run()).rejects.toBeInstanceOf(OperationalError);
    expect(fixture.eventCount()).toBe(0);
  });
});
