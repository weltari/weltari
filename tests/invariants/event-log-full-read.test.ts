// Whole-log reads read the whole log: server code that folds the event log
// (projections, idempotency and "committed meanwhile" re-checks, transcripts)
// reads it through `readAllSince`, which pages through EVERY row. A bounded
// `readSince(0, N)` used as "the whole log" silently stops seeing new events
// once the shared events table outgrows N — the 100k / 10k caps this rule
// replaced froze the world clock and dropped the current scene's lines.
// `readSince` stays for code that pages on purpose with a moving cursor; the
// SSE Last-Event-ID replay is the one such site. Grep backstop, like I6.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, it } from 'vitest';

const SERVER_SRC = join(
  import.meta.dirname,
  '..',
  '..',
  'apps',
  'server',
  'src',
);

/** Deliberate cursor pagers (and the repository that defines the read). */
const PAGERS = new Set(['http/sse.ts', 'storage/repositories/event-log.ts']);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [full]
      : [];
  });
}

it('outside the deliberate pagers, server code reads the event log only through readAllSince', () => {
  const offenders = walk(SERVER_SRC)
    .map((file) => relative(SERVER_SRC, file).split(sep).join('/'))
    .filter(
      (file) =>
        !PAGERS.has(file) &&
        readFileSync(join(SERVER_SRC, file), 'utf8').includes('.readSince('),
    );
  expect(offenders).toEqual([]);
});
