// Invariant I6 (Brief §2.7): only repositories touch SQL. The ESLint fence
// (Guide A11) enforces imports; this is the grep backstop builder.md §6 names,
// so a bypass fails CI even if the lint config regresses.
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

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

function isUnderStorage(file: string): boolean {
  return relative(SERVER_SRC, file).split(sep)[0] === 'storage';
}

it('better-sqlite3 is imported only under apps/server/src/storage/', () => {
  const offenders = walk(SERVER_SRC).filter(
    (file) =>
      !isUnderStorage(file) &&
      readFileSync(file, 'utf8').includes('better-sqlite3'),
  );
  expect(offenders).toEqual([]);
});

it('raw statement calls (.prepare/.exec) exist only under apps/server/src/storage/', () => {
  const pattern = /\bdb\.(?:prepare|exec)\(/;
  const offenders = walk(SERVER_SRC).filter(
    (file) => !isUnderStorage(file) && pattern.test(readFileSync(file, 'utf8')),
  );
  expect(offenders).toEqual([]);
});
