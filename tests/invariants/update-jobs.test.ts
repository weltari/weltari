// The updater jobs (FINAL item 12, Guide B12): update_check announces a newer
// release exactly once as a durable event; update_apply re-fetches, verifies,
// stages, flips the pointer, and appends update.staged exactly once — retries
// after kill -9 converge instead of double-applying. Asserted through public
// seams: event-log reads, the filesystem, the pointer file.
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Bus } from '../../apps/server/src/http/bus.js';
import { createEventSink } from '../../apps/server/src/engine/event-sink.js';
import { createUpdateCheckHandler } from '../../apps/server/src/ledger/handlers/update-check.js';
import { createUpdateApplyHandler } from '../../apps/server/src/ledger/handlers/update-apply.js';
import { artifactName } from '../../apps/server/src/boundary/update/release.js';
import {
  readCurrentPointer,
  type FetchLike,
} from '../../apps/server/src/boundary/update/stage.js';
import type { LedgerJob } from '../../apps/server/src/storage/repositories/ledger.js';
import type { Storage } from '../../apps/server/src/storage/db.js';
import { captureLogger } from '../helpers/capture-logger.js';
import { generateMinisignKeypair, minisignSign } from '../helpers/minisign.js';
import { buildTarGz } from '../helpers/tar.js';
import { tempStorage } from '../helpers/temp-storage.js';

const keypair = generateMinisignKeypair();
const RELEASES_URL = 'https://releases.test/latest';

function makeJob(type: string, payload: unknown): LedgerJob {
  return {
    id: 1,
    idempotency_key: `${type}:test`,
    world_id: 'w1',
    type,
    payload,
    state: 'running',
    attempts: 1,
    max_attempts: 5,
    run_at: '2026-07-07T00:00:00.000Z',
    lease_until: null,
    worker_id: 'test-worker',
    serial_group: null,
    last_error: null,
  };
}

interface Fixture {
  storage: Storage;
  sink: ReturnType<typeof createEventSink>;
  fetchFn: FetchLike;
  versionsDir: string;
}

function makeFixture(options?: {
  version?: string;
  badSha?: boolean;
  rogueKey?: boolean;
}): Fixture {
  const version = options?.version ?? '0.2.0';
  const base = artifactName(version);
  const artifact = buildTarGz([
    { path: 'dist' },
    { path: 'dist/main.js', data: `// weltari ${version}` },
  ]);
  const sha =
    options?.badSha === true
      ? 'd'.repeat(64)
      : createHash('sha256').update(artifact).digest('hex');
  const signer =
    options?.rogueKey === true ? generateMinisignKeypair() : keypair;
  const bodies = new Map<string, Buffer>([
    [
      RELEASES_URL,
      Buffer.from(
        JSON.stringify({
          tag_name: `v${version}`,
          html_url: `https://github.com/weltari/weltari/releases/tag/v${version}`,
          assets: [base, `${base}.minisig`, `${base}.sha256`].map((name) => ({
            name,
            browser_download_url: `https://cdn.test/${name}`,
          })),
        }),
      ),
    ],
    [`https://cdn.test/${base}`, artifact],
    [
      `https://cdn.test/${base}.minisig`,
      Buffer.from(minisignSign(artifact, signer), 'utf8'),
    ],
    [`https://cdn.test/${base}.sha256`, Buffer.from(`${sha}  ${base}\n`)],
  ]);
  const fetchFn: FetchLike = async (url) => {
    const body = bodies.get(url);
    return Promise.resolve(
      body === undefined
        ? new Response('not found', { status: 404 })
        : new Response(new Uint8Array(body)),
    );
  };
  const storage = tempStorage();
  const { logger } = captureLogger();
  const sink = createEventSink(storage, new Bus(logger));
  const versionsDir = mkdtempSync(join(tmpdir(), 'weltari-versions-'));
  return { storage, sink, fetchFn, versionsDir };
}

function eventsOfType(storage: Storage, type: string): number {
  return storage.eventLog.readSince(0, 100000).filter((e) => e.type === type)
    .length;
}

describe('update_check job', () => {
  it('announces a newer release exactly once (idempotent projection)', async () => {
    const fixture = makeFixture();
    const { logger } = captureLogger();
    const handler = createUpdateCheckHandler({
      storage: fixture.storage,
      sink: fixture.sink,
      logger,
      currentVersion: '0.1.0',
      releasesUrl: RELEASES_URL,
      fetchFn: fixture.fetchFn,
    });
    await handler(makeJob('update_check', null));
    await handler(makeJob('update_check', null)); // retry after kill -9
    expect(eventsOfType(fixture.storage, 'update.available')).toBe(1);
    const event = fixture.storage.eventLog
      .readSince(0, 100000)
      .find((e) => e.type === 'update.available');
    expect(event?.payload).toMatchObject({
      version: '0.2.0',
      current_version: '0.1.0',
    });
    fixture.storage.close();
  });

  it('is silent when the channel offers nothing newer', async () => {
    const fixture = makeFixture();
    const { logger } = captureLogger();
    const handler = createUpdateCheckHandler({
      storage: fixture.storage,
      sink: fixture.sink,
      logger,
      currentVersion: '0.2.0', // already there
      releasesUrl: RELEASES_URL,
      fetchFn: fixture.fetchFn,
    });
    await handler(makeJob('update_check', null));
    expect(eventsOfType(fixture.storage, 'update.available')).toBe(0);
    fixture.storage.close();
  });

  it('throws operational on an unreachable channel (runner retries, C7)', async () => {
    const fixture = makeFixture();
    const { logger } = captureLogger();
    const handler = createUpdateCheckHandler({
      storage: fixture.storage,
      sink: fixture.sink,
      logger,
      currentVersion: '0.1.0',
      releasesUrl: RELEASES_URL,
      fetchFn: async () =>
        Promise.resolve(new Response('rate limited', { status: 429 })),
    });
    await expect(handler(makeJob('update_check', null))).rejects.toMatchObject({
      kind: 'operational',
    });
    expect(eventsOfType(fixture.storage, 'update.available')).toBe(0);
    fixture.storage.close();
  });
});

describe('update_apply job', () => {
  function makeApplyHandler(fixture: Fixture) {
    const { logger } = captureLogger();
    return createUpdateApplyHandler({
      storage: fixture.storage,
      sink: fixture.sink,
      logger,
      currentVersion: '0.1.0',
      releasesUrl: RELEASES_URL,
      fetchFn: fixture.fetchFn,
      versionsDir: fixture.versionsDir,
      publicKeyBase64: keypair.publicKeyBase64,
      maxArtifactBytes: 1024 * 1024,
    });
  }

  it('stages, flips the pointer, appends update.staged exactly once', async () => {
    const fixture = makeFixture();
    const handler = makeApplyHandler(fixture);
    await handler(makeJob('update_apply', { version: '0.2.0' }));
    expect(readCurrentPointer(fixture.versionsDir)).toBe('0.2.0');
    expect(
      existsSync(join(fixture.versionsDir, '0.2.0', 'dist', 'main.js')),
    ).toBe(true);
    expect(eventsOfType(fixture.storage, 'update.staged')).toBe(1);

    await handler(makeJob('update_apply', { version: '0.2.0' })); // retry
    expect(eventsOfType(fixture.storage, 'update.staged')).toBe(1);
    const event = fixture.storage.eventLog
      .readSince(0, 100000)
      .find((e) => e.type === 'update.staged');
    expect(event?.payload).toMatchObject({
      version: '0.2.0',
      previous_version: '0.1.0',
    });
    fixture.storage.close();
  });

  it('wrong hash: throws, nothing staged, pointer untouched (B12)', async () => {
    const fixture = makeFixture({ badSha: true });
    const handler = makeApplyHandler(fixture);
    await expect(
      handler(makeJob('update_apply', { version: '0.2.0' })),
    ).rejects.toMatchObject({ code: 'update_hash_mismatch' });
    expect(readCurrentPointer(fixture.versionsDir)).toBeNull();
    expect(existsSync(join(fixture.versionsDir, '0.2.0'))).toBe(false);
    expect(eventsOfType(fixture.storage, 'update.staged')).toBe(0);
    fixture.storage.close();
  });

  it('rogue signature: refused even with a correct hash (B12)', async () => {
    const fixture = makeFixture({ rogueKey: true });
    const handler = makeApplyHandler(fixture);
    await expect(
      handler(makeJob('update_apply', { version: '0.2.0' })),
    ).rejects.toMatchObject({ code: 'update_signature_rejected' });
    expect(readCurrentPointer(fixture.versionsDir)).toBeNull();
    expect(eventsOfType(fixture.storage, 'update.staged')).toBe(0);
    fixture.storage.close();
  });

  it('refuses a version the channel no longer offers', async () => {
    const fixture = makeFixture({ version: '0.3.0' });
    const handler = makeApplyHandler(fixture);
    await expect(
      handler(makeJob('update_apply', { version: '0.2.0' })),
    ).rejects.toMatchObject({ code: 'update_version_not_available' });
    fixture.storage.close();
  });

  it('garbage payload is corruption, not input (C2)', async () => {
    const fixture = makeFixture();
    const handler = makeApplyHandler(fixture);
    await expect(
      handler(makeJob('update_apply', { nonsense: true })),
    ).rejects.toMatchObject({ kind: 'corrupt_state' });
    fixture.storage.close();
  });
});
