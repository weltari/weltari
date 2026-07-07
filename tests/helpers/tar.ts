// Test-only ustar WRITER — builds the .tar.gz update artifacts the B12 apply
// path consumes (the server only extracts; the real writer is the packaging
// script). Compiled into tests/dist so the kill harness reuses it.
import { gzipSync } from 'node:zlib';
import { Buffer } from 'node:buffer';

const BLOCK = 512;

export interface TarEntry {
  /** Forward-slash relative path, ≤100 chars (ustar name field). */
  path: string;
  /** File content; undefined = directory entry. */
  data?: string | Buffer;
}

function octal(value: number, length: number): Buffer {
  const text = value.toString(8).padStart(length - 1, '0');
  return Buffer.from(`${text}\0`, 'latin1');
}

function header(entry: TarEntry, size: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  if (entry.path.length > 100) {
    throw new Error(`tar helper: path too long (${entry.path})`);
  }
  block.write(entry.path, 0, 100, 'utf8');
  octal(0o755, 8).copy(block, 100); // mode
  octal(0, 8).copy(block, 108); // uid
  octal(0, 8).copy(block, 116); // gid
  octal(size, 12).copy(block, 124);
  octal(0, 12).copy(block, 136); // mtime
  block.write(entry.data === undefined ? '5' : '0', 156, 1, 'latin1');
  block.write('ustar', 257, 5, 'latin1');
  block.write('00', 263, 2, 'latin1');
  // Checksum: field treated as spaces while summing.
  block.fill(' ', 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  const checksum = `${sum.toString(8).padStart(6, '0')}\0 `;
  block.write(checksum, 148, 8, 'latin1');
  return block;
}

export function buildTarGz(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data =
      entry.data === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(entry.data)
          ? entry.data
          : Buffer.from(entry.data, 'utf8');
    parts.push(header(entry, data.length));
    if (data.length > 0) {
      const padded = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK);
      data.copy(padded);
      parts.push(padded);
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // end-of-archive
  return gzipSync(Buffer.concat(parts));
}
