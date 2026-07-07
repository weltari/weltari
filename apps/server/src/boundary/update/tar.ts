// Minimal ustar reader for update artifacts (.tar.gz) — zero dependencies.
// Runs only AFTER SHA-256 + minisign verification (Guide B12), so this is a
// correctness parser, not the security boundary; containment is still
// enforced per entry (zip-slip idiom, Guide B13): regular files and
// directories only, no links, no absolute paths, no '..' segments. Our own
// packaging script writes these archives — anything it wouldn't write is
// refused loudly.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Buffer } from 'node:buffer';
import { err, ok, OperationalError, type Result } from '../../errors.js';

const BLOCK = 512;

function readOctal(block: Buffer, offset: number, length: number): number {
  const text = block
    .toString('latin1', offset, offset + length)
    .replace(/\0.*$/, '')
    .trim();
  if (text === '') return 0;
  const value = Number.parseInt(text, 8);
  return Number.isNaN(value) ? -1 : value;
}

function readString(block: Buffer, offset: number, length: number): string {
  const end = block.indexOf(0, offset);
  const stop = end === -1 || end > offset + length ? offset + length : end;
  return block.toString('utf8', offset, stop);
}

function checksumValid(block: Buffer): boolean {
  const stored = readOctal(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    // The checksum field itself counts as spaces.
    sum += i >= 148 && i < 156 ? 32 : (block[i] ?? 0);
  }
  return sum === stored;
}

function refused(detail: string): Result<never> {
  return err(new OperationalError('artifact_invalid', detail));
}

/**
 * Extract a gzipped ustar archive into `destDir` (created if missing). Every
 * entry path must resolve inside `destDir` or the whole extraction is refused.
 */
export function extractTarGz(
  archive: Buffer,
  destDir: string,
): Result<{ files: number }> {
  let tarBytes: Buffer;
  try {
    tarBytes = gunzipSync(archive);
  } catch (thrown) {
    // CATCH-OK: corrupt gzip from an update artifact is an operational
    // rejection value, never a crash (Guide B12).
    void thrown;
    return refused('gzip_invalid');
  }
  const root = resolve(destDir);
  mkdirSync(root, { recursive: true });
  let files = 0;
  let offset = 0;
  while (offset + BLOCK <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break; // end-of-archive marker
    if (!checksumValid(header)) return refused('tar_checksum_invalid');
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const fullName = prefix === '' ? name : `${prefix}/${name}`;
    const size = readOctal(header, 124, 12);
    if (size < 0) return refused('tar_size_invalid');
    const typeflag = header.toString('latin1', 156, 157);
    if (fullName === '' || fullName.startsWith('/') || fullName.includes('\\'))
      return refused(`tar_entry_path_invalid: ${fullName}`);
    const target = resolve(root, fullName);
    if (target !== root && !target.startsWith(root + sep))
      return refused(`tar_entry_escapes: ${fullName}`);
    if (fullName.split('/').includes('..'))
      return refused(`tar_entry_escapes: ${fullName}`);
    if (typeflag === '5') {
      mkdirSync(target, { recursive: true });
    } else if (typeflag === '0' || typeflag === '\0') {
      if (offset + BLOCK + size > tarBytes.length)
        return refused('tar_truncated');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(
        target,
        tarBytes.subarray(offset + BLOCK, offset + BLOCK + size),
      );
      files += 1;
    } else {
      // Links, devices, FIFOs: never produced by our packaging, refused.
      return refused(`tar_entry_type_refused: ${typeflag}`);
    }
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return ok({ files });
}
