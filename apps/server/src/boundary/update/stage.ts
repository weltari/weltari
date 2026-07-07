// Download → verify → extract → flip (FINAL item 12, Guide B12). Nothing here
// touches the RUNNING version: work happens under versions/vNext, and only
// flipCurrentPointer — which demands a VerifiedArtifact the verifier alone can
// construct — makes the new version visible, via atomic tmp+rename writes. A
// kill -9 at ANY moment leaves either the old pointer or the new one, both
// naming complete version directories; the retried job wipes vNext and redoes
// the work (idempotent).
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import { err, ok, OperationalError, type Result } from '../../errors.js';
import type { FaultPointHook } from '../../engine/fault-points.js';
import type { Logger } from '../../observability/logger.js';
import { extractTarGz } from './tar.js';
import { verifyArtifact, type VerifiedArtifact } from './verifier.js';
import type { UpdateAssets } from './release.js';

const POINTER_FILE = 'current';
const STAGING_DIR = 'vNext';

export type FetchLike = (url: string) => Promise<Response>;

export interface StageDeps {
  versionsDir: string;
  publicKeyBase64: string;
  maxArtifactBytes: number;
  fetchFn: FetchLike;
  logger: Logger;
  faultPoint?: FaultPointHook | undefined;
}

/** The version the `current` pointer names, or null before any update. */
export function readCurrentPointer(versionsDir: string): string | null {
  const file = join(versionsDir, POINTER_FILE);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8').trim();
  return text === '' ? null : text;
}

/**
 * Startup IS recovery (Brief §2.4): a leftover vNext is an update that never
 * finished verifying + flipping — delete it; the retried job redoes the work.
 */
export function cleanStaleStaging(versionsDir: string, logger: Logger): void {
  const staging = join(versionsDir, STAGING_DIR);
  if (existsSync(staging)) {
    rmSync(staging, { recursive: true, force: true });
    logger.warn({ staging }, 'removed stale update staging dir (vNext)');
  }
}

async function downloadCapped(
  fetchFn: FetchLike,
  url: string,
  maxBytes: number,
): Promise<Result<Buffer>> {
  try {
    const response = await fetchFn(url);
    if (!response.ok) {
      return err(
        new OperationalError(
          'update_download_failed',
          `GET ${url} returned ${String(response.status)}`,
        ),
      );
    }
    if (response.body === null) {
      return err(
        new OperationalError('update_download_failed', `GET ${url}: no body`),
      );
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      const piece = Buffer.from(chunk);
      total += piece.byteLength;
      if (total > maxBytes) {
        return err(
          new OperationalError(
            'update_download_too_large',
            `GET ${url} exceeded the ${String(maxBytes)}-byte cap`,
          ),
        );
      }
      chunks.push(piece);
    }
    return ok(Buffer.concat(chunks));
  } catch (thrown) {
    // CATCH-OK: network failure during an update download is operational —
    // the job runner retries with backoff (C2/C7).
    return err(
      new OperationalError('update_download_failed', `GET ${url} failed`, {
        cause: thrown,
      }),
    );
  }
}

/**
 * The ONLY code path that makes a new version current — and the compiler
 * makes it unreachable without a VerifiedArtifact (Guide B12). Atomic:
 * tmp-write + rename, same volume.
 */
export function flipCurrentPointer(
  artifact: VerifiedArtifact,
  versionsDir: string,
): void {
  const tmp = join(versionsDir, `${POINTER_FILE}.tmp`);
  writeFileSync(tmp, `${artifact.version}\n`, 'utf8');
  renameSync(tmp, join(versionsDir, POINTER_FILE));
}

export interface StagedUpdate {
  version: string;
  sha256: string;
  previousPointer: string | null;
}

/**
 * Run the full apply pipeline for one release version. Any failure deletes
 * everything downloaded and leaves the pointer untouched (B12: mismatch
 * deletes the download and keeps the running version).
 */
export async function stageUpdate(
  deps: StageDeps,
  input: { version: string; assets: UpdateAssets },
): Promise<Result<StagedUpdate>> {
  const versionsDir = resolve(deps.versionsDir);
  const staging = join(versionsDir, STAGING_DIR);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  function failCleaning<T>(error: Result<T>): Result<T> {
    rmSync(staging, { recursive: true, force: true });
    return error;
  }

  const artifactBytes = await downloadCapped(
    deps.fetchFn,
    input.assets.artifact.browser_download_url,
    deps.maxArtifactBytes,
  );
  if (!artifactBytes.ok) return failCleaning(artifactBytes);
  const signatureText = await downloadCapped(
    deps.fetchFn,
    input.assets.signature.browser_download_url,
    65536,
  );
  if (!signatureText.ok) return failCleaning(signatureText);
  const shaText = await downloadCapped(
    deps.fetchFn,
    input.assets.sha256.browser_download_url,
    4096,
  );
  if (!shaText.ok) return failCleaning(shaText);

  const verified = verifyArtifact({
    version: input.version,
    artifact: artifactBytes.value,
    // The .sha256 asset is "<hex>  <filename>" or bare hex — first token.
    expectedSha256: shaText.value.toString('utf8').trim().split(/\s+/)[0] ?? '',
    signatureText: signatureText.value.toString('utf8'),
    publicKeyBase64: deps.publicKeyBase64,
  });
  if (!verified.ok) {
    deps.logger.warn(
      { version: input.version, code: verified.error.code },
      'update artifact REFUSED — download deleted, running version kept (B12)',
    );
    return failCleaning(verified);
  }

  const appDir = join(staging, 'app');
  const extracted = extractTarGz(verified.value.bytes, appDir);
  if (!extracted.ok) return failCleaning(extracted);

  // The harness SIGKILLs here: verified but not yet flipped — the running
  // version must survive and the retried job must converge (Invariant I4).
  if (deps.faultPoint !== undefined) await deps.faultPoint('mid_update');

  const versionDir = join(versionsDir, input.version);
  rmSync(versionDir, { recursive: true, force: true });
  renameSync(appDir, versionDir);
  const previousPointer = readCurrentPointer(versionsDir);
  flipCurrentPointer(verified.value, versionsDir);
  rmSync(staging, { recursive: true, force: true });

  deps.logger.info(
    { version: input.version, sha256: verified.value.sha256 },
    'update staged — new version starts on next restart',
  );
  return ok({
    version: input.version,
    sha256: verified.value.sha256,
    previousPointer,
  });
}
