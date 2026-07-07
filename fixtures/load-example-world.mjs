// Loads the example world into a real SQLite THROUGH the repository layer —
// the only SQL site (Brief §2.7) — so agents and the owner can inspect real
// rows instead of guessing from column names (builder.md §4.3). Every row is
// safeParse-checked against the protocol union before it is appended: the
// fixture can never drift from the wire format silently.
// Usage: npm run build (or tsc -b) first, then:
//   node fixtures/load-example-world.mjs [target.sqlite]
// Default target: data/example-world.sqlite (gitignored).
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const { openStorage } = await import(
  pathToFileURL(join(ROOT, 'apps', 'server', 'dist', 'storage', 'db.js')).href
);
const { WeltariEventSchema } = await import(
  pathToFileURL(join(ROOT, 'packages', 'protocol', 'dist', 'index.js')).href
);

const target = process.argv[2] ?? join(ROOT, 'data', 'example-world.sqlite');
mkdirSync(dirname(target), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(`${target}${suffix}`, { force: true });
}

const lines = readFileSync(join(HERE, 'example-world', 'events.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '');

const storage = openStorage({ dbPath: target });
let appended = 0;
for (const line of lines) {
  const row = JSON.parse(line);
  // The JSONL rows are append inputs (id/ts are assigned by the repository);
  // validate the full wire shape they will become.
  const candidate = {
    id: appended + 1,
    ts: '2026-07-08T00:00:00.000Z',
    ...row,
  };
  const checked = WeltariEventSchema.safeParse(candidate);
  if (!checked.success) {
    console.error(
      `events.jsonl line ${String(appended + 1)} is not a valid WeltariEvent:`,
      checked.error.issues[0],
    );
    storage.close();
    process.exit(1);
  }
  storage.eventLog.append(row);
  appended += 1;
}
storage.close();
console.log(`example world loaded: ${String(appended)} events -> ${target}`);
