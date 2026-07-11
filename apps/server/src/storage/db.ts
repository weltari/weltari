// The only file in the codebase that opens a SQLite connection (Brief §2.7,
// fence A11). Connection + pragmas + hash-locked migration runner + WriteGate.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { BugError, CorruptStateError } from '../errors.js';
import {
  createEventLogRepository,
  type EventLogRepository,
} from './repositories/event-log.js';
import {
  createGatewayRepository,
  type GatewayRepository,
} from './repositories/gateway.js';
import {
  createLedgerRepository,
  type LedgerRepository,
} from './repositories/ledger.js';
import {
  createMemoryIndexRepository,
  type MemoryIndexRepository,
} from './repositories/memory-index.js';

export interface StorageOptions {
  /** Path to the SQLite file; ':memory:' allowed in tests. */
  dbPath: string;
  /** Defaults to apps/server/migrations. Overridable for migration-runner tests only. */
  migrationsDir?: string;
  /** Wall-time source for row timestamps; injectable for deterministic tests. */
  nowIso?: () => string;
}

export interface Storage {
  readonly eventLog: EventLogRepository;
  readonly ledger: LedgerRepository;
  readonly gateway: GatewayRepository;
  /** The Search Index over memory deltas (Rev 4 §4.2 — V1: SQLite FTS5). */
  readonly memoryIndex: MemoryIndexRepository;
  /**
   * The WriteGate: every multi-statement durable write goes through here so it
   * commits or vanishes atomically (crash-only design, Brief §2.4). better-sqlite3
   * is synchronous — a throw inside rolls the whole transaction back.
   */
  transact<T>(fn: () => T): T;
  close(): void;
}

const manifestSchema = z.record(z.string(), z.string());

const DEFAULT_MIGRATIONS_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  'migrations',
);

function applyMigrations(db: Database.Database, migrationsDir: string): void {
  const manifestRaw: unknown = JSON.parse(
    readFileSync(join(migrationsDir, 'manifest.json'), 'utf8'),
  );
  const manifest = manifestSchema.safeParse(manifestRaw);
  if (!manifest.success) {
    throw new CorruptStateError(
      'migration_manifest_invalid',
      'migrations/manifest.json is not a {file: sha256} map',
    );
  }

  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();

  const versionRow: unknown = db.pragma('user_version', { simple: true });
  if (typeof versionRow !== 'number') {
    throw new BugError(
      'pragma_user_version',
      'PRAGMA user_version did not return a number',
    );
  }
  let version = versionRow;

  for (const file of files) {
    const number = Number(file.slice(0, 4));
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    const expected = manifest.data[file];
    if (expected === undefined) {
      throw new CorruptStateError(
        'migration_unlisted',
        `migration ${file} missing from manifest.json`,
      );
    }
    if (expected !== hash) {
      // A shipped migration was edited — append-only history is broken (Guide §8.3).
      throw new CorruptStateError(
        'migration_hash_mismatch',
        `migration ${file} does not match its manifest hash`,
      );
    }
    if (number <= version) continue;
    if (number !== version + 1) {
      throw new CorruptStateError(
        'migration_gap',
        `migration ${file} skips version ${String(version + 1)}`,
      );
    }
    const apply = db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${String(number)}`);
    });
    apply();
    version = number;
  }
}

/**
 * The FTS5 boot probe (M7 part 1, Rev 4 §4.2): the Search Index requires an
 * FTS5-enabled SQLite build. Probe with a real CREATE (definitive — compile
 * options can lie about a stripped build) BEFORE migrations run, so a missing
 * FTS5 fails loud with an actionable message instead of a cryptic migration
 * error. Never a silent degrade.
 */
function assertFts5(db: Database.Database): void {
  try {
    db.exec(
      'CREATE VIRTUAL TABLE temp.weltari_fts5_probe USING fts5(probe); DROP TABLE temp.weltari_fts5_probe;',
    );
  } catch (cause) {
    throw new BugError(
      'fts5_missing',
      'this better-sqlite3 build has no FTS5 — the memory Search Index requires it (Rev 4 §4.2). Reinstall dependencies (npm ci) or rebuild better-sqlite3 with FTS5 enabled.',
      { cause },
    );
  }
}

export function openStorage(options: StorageOptions): Storage {
  const db = new Database(options.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  assertFts5(db);
  applyMigrations(db, options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);

  const nowIso = options.nowIso ?? ((): string => new Date().toISOString());
  const memoryIndex = createMemoryIndexRepository(db);
  const eventLog = createEventLogRepository(db, nowIso, memoryIndex);
  const ledger = createLedgerRepository(db, nowIso);
  const gateway = createGatewayRepository(db, nowIso);
  // Projection discipline: the FTS index is derived state — re-project it
  // from the log every boot, so a kill between an append and nothing (the
  // index write shares the append's transaction) or a hand-deleted DB file
  // sibling can never leave stale search results.
  memoryIndex.rebuild();

  return {
    eventLog,
    ledger,
    gateway,
    memoryIndex,
    transact<T>(fn: () => T): T {
      const run = db.transaction(fn);
      return run();
    },
    close(): void {
      db.close();
    },
  };
}
