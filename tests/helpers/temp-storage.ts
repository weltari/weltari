import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage, type Storage } from '../../apps/server/src/storage/db.js';

export function tempStorage(nowIso?: () => string): Storage {
  const dir = mkdtempSync(join(tmpdir(), 'weltari-test-'));
  const dbPath = join(dir, 'w.sqlite');
  return openStorage(nowIso === undefined ? { dbPath } : { dbPath, nowIso });
}
