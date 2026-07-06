import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openStorage } from './db.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'weltari-db-'));
}

function writeMigration(
  dir: string,
  name: string,
  sql: string,
  manifestSql?: string,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), sql, 'utf8');
  const hash = createHash('sha256')
    .update(manifestSql ?? sql)
    .digest('hex');
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ [name]: hash }),
    'utf8',
  );
}

const EVENTS_SQL =
  'CREATE TABLE events (id INTEGER PRIMARY KEY, world_id TEXT NOT NULL, actor_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, ts TEXT NOT NULL);';

describe('openStorage migrations', () => {
  it('applies migrations to a fresh database and is idempotent on reopen', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'weltari.sqlite');
    const first = openStorage({ dbPath });
    expect(first.eventLog.lastId()).toBe(0);
    first.close();
    const second = openStorage({ dbPath });
    expect(second.eventLog.lastId()).toBe(0);
    second.close();
  });

  it('refuses to boot when a migration file was edited (hash-locked history)', () => {
    const dir = tempDir();
    const migrationsDir = join(dir, 'migrations');
    writeMigration(
      migrationsDir,
      '0001_events.sql',
      EVENTS_SQL,
      `${EVENTS_SQL}-- tampered`,
    );
    expect(() =>
      openStorage({ dbPath: join(dir, 'w.sqlite'), migrationsDir }),
    ).toThrow(/manifest hash/);
  });

  it('refuses to boot when a migration file is missing from the manifest', () => {
    const dir = tempDir();
    const migrationsDir = join(dir, 'migrations');
    writeMigration(migrationsDir, '0001_events.sql', EVENTS_SQL);
    writeFileSync(
      join(migrationsDir, '0002_more.sql'),
      'CREATE TABLE more (id INTEGER);',
      'utf8',
    );
    expect(() =>
      openStorage({ dbPath: join(dir, 'w.sqlite'), migrationsDir }),
    ).toThrow(/missing from manifest/);
  });

  it('refuses a numbering gap in migrations', () => {
    const dir = tempDir();
    const migrationsDir = join(dir, 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    const sqlA = EVENTS_SQL;
    const sqlB = 'CREATE TABLE later (id INTEGER);';
    const hash = (s: string): string =>
      createHash('sha256').update(s).digest('hex');
    writeFileSync(join(migrationsDir, '0001_events.sql'), sqlA, 'utf8');
    writeFileSync(join(migrationsDir, '0003_later.sql'), sqlB, 'utf8');
    writeFileSync(
      join(migrationsDir, 'manifest.json'),
      JSON.stringify({
        '0001_events.sql': hash(sqlA),
        '0003_later.sql': hash(sqlB),
      }),
      'utf8',
    );
    expect(() =>
      openStorage({ dbPath: join(dir, 'w.sqlite'), migrationsDir }),
    ).toThrow(/skips version/);
  });

  it('WriteGate transact rolls the whole write back on throw', () => {
    const dir = tempDir();
    const storage = openStorage({ dbPath: join(dir, 'w.sqlite') });
    expect(() =>
      storage.transact(() => {
        storage.eventLog.append({
          world_id: 'w1',
          actor_id: 'user:owner',
          type: 'turn.started',
          payload: { scene_id: 's1', turn_id: 't1' },
        });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(storage.eventLog.lastId()).toBe(0);
    storage.close();
  });
});
