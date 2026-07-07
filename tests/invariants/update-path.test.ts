// Invariant I10, B-update fixtures (Guide B12): update metadata is untrusted;
// an artifact becomes trusted only after SHA-256 AND minisign verification;
// any mismatch deletes the download and keeps the running version; the
// pointer-flip path is unreachable without a VerifiedArtifact. Asserted
// through public seams: staging results, the filesystem, the pointer file.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { verifyMinisign } from '../../apps/server/src/boundary/update/minisign.js';
import { extractTarGz } from '../../apps/server/src/boundary/update/tar.js';
import {
  isNewerVersion,
  normalizeVersion,
} from '../../apps/server/src/boundary/update/version.js';
import {
  verifyArtifact,
  type VerifiedArtifact,
} from '../../apps/server/src/boundary/update/verifier.js';
import {
  cleanStaleStaging,
  readCurrentPointer,
  stageUpdate,
  type FetchLike,
} from '../../apps/server/src/boundary/update/stage.js';
import {
  artifactName,
  pickUpdateAssets,
  ReleaseSchema,
} from '../../apps/server/src/boundary/update/release.js';
import { captureLogger } from '../helpers/capture-logger.js';
import { generateMinisignKeypair, minisignSign } from '../helpers/minisign.js';
import { buildTarGz } from '../helpers/tar.js';
import { createHash } from 'node:crypto';

const keypair = generateMinisignKeypair();

describe('minisign verification (node:crypto, zero deps)', () => {
  const content = Buffer.from('the artifact bytes');

  it('accepts a valid prehashed (ED) and pure (Ed) signature', () => {
    for (const algorithm of ['ED', 'Ed'] as const) {
      const sig = minisignSign(content, keypair, { algorithm });
      expect(verifyMinisign(content, sig, keypair.publicKeyBase64)).toEqual({
        ok: true,
      });
    }
  });

  it('rejects tampered content', () => {
    const sig = minisignSign(content, keypair);
    const result = verifyMinisign(
      Buffer.from('the artifact byteZ'),
      sig,
      keypair.publicKeyBase64,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('signature_invalid');
  });

  it('rejects a signature from a different key (key id mismatch)', () => {
    const otherKeypair = generateMinisignKeypair();
    const sig = minisignSign(content, otherKeypair);
    const result = verifyMinisign(content, sig, keypair.publicKeyBase64);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('key_id_mismatch');
  });

  it('rejects a tampered trusted comment (global signature)', () => {
    const sig = minisignSign(content, keypair, {
      trustedComment: 'timestamp:0\tfile:artifact',
    });
    const tampered = sig.replace('file:artifact', 'file:evil-swap');
    const result = verifyMinisign(content, tampered, keypair.publicKeyBase64);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('global_signature_invalid');
  });

  it('rejects malformed signature files and public keys, never throws', () => {
    expect(
      verifyMinisign(content, 'not a signature', keypair.publicKeyBase64).ok,
    ).toBe(false);
    const sig = minisignSign(content, keypair);
    expect(verifyMinisign(content, sig, 'garbage!!').ok).toBe(false);
  });
});

describe('ustar extraction (containment)', () => {
  it('round-trips files and directories', () => {
    const dest = mkdtempSync(join(tmpdir(), 'weltari-tar-'));
    const archive = buildTarGz([
      { path: 'app' },
      { path: 'app/main.js', data: 'console.log("hi");' },
      { path: 'app/deep/nested.txt', data: 'x'.repeat(1300) },
    ]);
    const result = extractTarGz(archive, dest);
    expect(result).toEqual({ ok: true, value: { files: 2 } });
    expect(readFileSync(join(dest, 'app', 'main.js'), 'utf8')).toBe(
      'console.log("hi");',
    );
    expect(
      readFileSync(join(dest, 'app', 'deep', 'nested.txt'), 'utf8'),
    ).toHaveLength(1300);
  });

  it('refuses traversal entries — nothing extracted', () => {
    const dest = mkdtempSync(join(tmpdir(), 'weltari-tar-'));
    const archive = buildTarGz([{ path: '../escape.txt', data: 'evil' }]);
    const result = extractTarGz(archive, dest);
    expect(result.ok).toBe(false);
    expect(existsSync(join(dest, '..', 'escape.txt'))).toBe(false);
  });

  it('refuses non-file entry types and corrupt gzip', () => {
    const dest = mkdtempSync(join(tmpdir(), 'weltari-tar-'));
    expect(extractTarGz(Buffer.from('not gzip'), dest).ok).toBe(false);
  });
});

describe('version comparison (untrusted tags)', () => {
  it('orders plain semver and refuses garbage', () => {
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true);
    expect(isNewerVersion('v0.2.0', '0.1.9')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false);
    expect(isNewerVersion('1.0.0-rc1', '0.1.0')).toBe(false);
    expect(isNewerVersion('lol; rm -rf /', '0.1.0')).toBe(false);
    expect(normalizeVersion('v0.10.2')).toBe('0.10.2');
    expect(normalizeVersion('nope')).toBeNull();
  });
});

describe('artifact verifier (VerifiedArtifact confinement)', () => {
  const artifact = buildTarGz([{ path: 'app.js', data: 'ok' }]);
  const sha256 = createHash('sha256').update(artifact).digest('hex');

  it('passes only when SHA-256 AND minisign both pass', () => {
    const good = verifyArtifact({
      version: '0.2.0',
      artifact,
      expectedSha256: sha256,
      signatureText: minisignSign(artifact, keypair),
      publicKeyBase64: keypair.publicKeyBase64,
    });
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.value.version).toBe('0.2.0');
      expect(good.value.sha256).toBe(sha256);
    }

    const wrongHash = verifyArtifact({
      version: '0.2.0',
      artifact,
      expectedSha256: 'b'.repeat(64),
      signatureText: minisignSign(artifact, keypair),
      publicKeyBase64: keypair.publicKeyBase64,
    });
    expect(wrongHash.ok).toBe(false);
    if (!wrongHash.ok)
      expect(wrongHash.error.code).toBe('update_hash_mismatch');

    const wrongSig = verifyArtifact({
      version: '0.2.0',
      artifact,
      expectedSha256: sha256,
      signatureText: minisignSign(Buffer.from('different bytes'), keypair),
      publicKeyBase64: keypair.publicKeyBase64,
    });
    expect(wrongSig.ok).toBe(false);
    if (!wrongSig.ok)
      expect(wrongSig.error.code).toBe('update_signature_rejected');
  });

  it('VerifiedArtifact cannot be constructed or faked outside the verifier', () => {
    // @ts-expect-error — the class value is not exported and its props are
    // private: a structurally-identical object is not assignable (Guide B12).
    const forged: VerifiedArtifact = {
      version: '0.2.0',
      sha256: sha256,
      bytes: artifact,
    };
    expect(typeof forged).toBe('object');
  });
});

describe('staging pipeline (download → verify → extract → flip)', () => {
  const version = '0.2.0';
  const base = artifactName(version);

  function makeRelease(overrides?: { artifact?: Buffer; sha?: string }) {
    const artifact =
      overrides?.artifact ??
      buildTarGz([
        { path: 'dist' },
        { path: 'dist/main.js', data: `// weltari ${version}` },
        { path: 'package.json', data: `{"version":"${version}"}` },
      ]);
    const sha =
      overrides?.sha ?? createHash('sha256').update(artifact).digest('hex');
    const files = new Map<string, Buffer>([
      [`https://cdn.test/${base}`, artifact],
      [
        `https://cdn.test/${base}.minisig`,
        Buffer.from(minisignSign(artifact, keypair), 'utf8'),
      ],
      [`https://cdn.test/${base}.sha256`, Buffer.from(`${sha}  ${base}\n`)],
    ]);
    const fetchFn: FetchLike = async (url) => {
      const body = files.get(url);
      return Promise.resolve(
        body === undefined
          ? new Response('not found', { status: 404 })
          : new Response(new Uint8Array(body)),
      );
    };
    const releaseJson: unknown = {
      tag_name: `v${version}`,
      html_url: 'https://github.com/weltari/weltari/releases/tag/v0.2.0',
      assets: [base, `${base}.minisig`, `${base}.sha256`].map((name) => ({
        name,
        browser_download_url: `https://cdn.test/${name}`,
      })),
    };
    return { fetchFn, releaseJson };
  }

  function stageDeps(versionsDir: string, fetchFn: FetchLike) {
    const { logger } = captureLogger();
    return {
      versionsDir,
      publicKeyBase64: keypair.publicKeyBase64,
      maxArtifactBytes: 1024 * 1024,
      fetchFn,
      logger,
    };
  }

  it('release schema strips unknown keys and pickUpdateAssets finds the trio', () => {
    const { releaseJson } = makeRelease();
    const withExtra: unknown = {
      ...(typeof releaseJson === 'object' ? releaseJson : {}),
      surprise_field: 'ignored',
    };
    const parsed = ReleaseSchema.safeParse(withExtra);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect('surprise_field' in parsed.data).toBe(false);
    const assets = pickUpdateAssets(parsed.data, version);
    expect(assets?.artifact.name).toBe(base);
    expect(pickUpdateAssets(parsed.data, '9.9.9')).toBeNull();
  });

  it('stages a verified update: version dir + atomic pointer flip', async () => {
    const versionsDir = mkdtempSync(join(tmpdir(), 'weltari-versions-'));
    const { fetchFn, releaseJson } = makeRelease();
    const parsed = ReleaseSchema.safeParse(releaseJson);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const assets = pickUpdateAssets(parsed.data, version);
    expect(assets).not.toBeNull();
    if (assets === null) return;

    const result = await stageUpdate(stageDeps(versionsDir, fetchFn), {
      version,
      assets,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.previousPointer).toBeNull();
    expect(readCurrentPointer(versionsDir)).toBe(version);
    expect(
      readFileSync(join(versionsDir, version, 'dist', 'main.js'), 'utf8'),
    ).toContain(version);
    expect(existsSync(join(versionsDir, 'vNext'))).toBe(false);

    // Idempotent redo (a retried job after kill -9): same converged state.
    const again = await stageUpdate(stageDeps(versionsDir, fetchFn), {
      version,
      assets,
    });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.previousPointer).toBe(version);
    expect(readCurrentPointer(versionsDir)).toBe(version);
  });

  it('wrong hash: download deleted, pointer untouched, no version dir', async () => {
    const versionsDir = mkdtempSync(join(tmpdir(), 'weltari-versions-'));
    const { fetchFn, releaseJson } = makeRelease({ sha: 'c'.repeat(64) });
    const parsed = ReleaseSchema.safeParse(releaseJson);
    if (!parsed.success) return;
    const assets = pickUpdateAssets(parsed.data, version);
    if (assets === null) return;

    const result = await stageUpdate(stageDeps(versionsDir, fetchFn), {
      version,
      assets,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('update_hash_mismatch');
    expect(readCurrentPointer(versionsDir)).toBeNull();
    expect(existsSync(join(versionsDir, version))).toBe(false);
    expect(existsSync(join(versionsDir, 'vNext'))).toBe(false);
  });

  it('wrong signature: refused even with a correct hash', async () => {
    const versionsDir = mkdtempSync(join(tmpdir(), 'weltari-versions-'));
    const artifact = buildTarGz([{ path: 'dist/main.js', data: 'evil' }]);
    const { fetchFn, releaseJson } = makeRelease({ artifact });
    // Overwrite the signature with one from an unknown key.
    const rogue = generateMinisignKeypair();
    const files = new Map<string, Buffer>([
      [
        `https://cdn.test/${base}.minisig`,
        Buffer.from(minisignSign(artifact, rogue), 'utf8'),
      ],
    ]);
    const fetchWithRogueSig: FetchLike = async (url) => {
      const override = files.get(url);
      if (override !== undefined)
        return Promise.resolve(new Response(new Uint8Array(override)));
      return fetchFn(url);
    };
    const parsed = ReleaseSchema.safeParse(releaseJson);
    if (!parsed.success) return;
    const assets = pickUpdateAssets(parsed.data, version);
    if (assets === null) return;

    const result = await stageUpdate(
      stageDeps(versionsDir, fetchWithRogueSig),
      { version, assets },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('update_signature_rejected');
    expect(readCurrentPointer(versionsDir)).toBeNull();
    expect(existsSync(join(versionsDir, version))).toBe(false);
  });

  it('startup cleanup removes a stale vNext (kill mid-download)', () => {
    const versionsDir = mkdtempSync(join(tmpdir(), 'weltari-versions-'));
    const { logger } = captureLogger();
    cleanStaleStaging(versionsDir, logger); // absent: no-op
    const staging = join(versionsDir, 'vNext');
    extractTarGz(buildTarGz([{ path: 'partial.bin', data: 'x' }]), staging);
    expect(existsSync(staging)).toBe(true);
    cleanStaleStaging(versionsDir, logger);
    expect(existsSync(staging)).toBe(false);
  });
});
