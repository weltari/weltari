// E2: tests ship in the same task as the code. A PR that adds a new source
// file under apps/server/src or packages/*/src with no test file added or
// modified anywhere in the range fails. Bulk after-the-fact backfill is banned
// — backfilled tests merely encode whatever the possibly-buggy code does.
// Usage: node tools/check-tests-accompany.mjs [<base-ref>]   (default origin/main)
import { execFileSync } from 'node:child_process';

const base = process.argv[2] ?? process.env.BASE_REF ?? 'origin/main';

let diff;
try {
  diff = execFileSync('git', ['diff', '--name-status', `${base}...HEAD`], {
    encoding: 'utf8',
  });
} catch (error) {
  console.error(
    `check-tests-accompany: git diff against "${base}" failed — ${error.message}`,
  );
  process.exit(1);
}

const added = [];
const touched = [];
for (const line of diff.split('\n')) {
  const [status, ...rest] = line.split('\t');
  const path = rest.at(-1); // renames report old\tnew — take the new path
  if (path === undefined) continue;
  const normalized = path.replaceAll('\\', '/');
  touched.push(normalized);
  if (status === 'A') added.push(normalized);
}

const isSource = (p) =>
  (/^apps\/server\/src\/.+\.ts$/.test(p) ||
    /^packages\/[^/]+\/src\/.+\.ts$/.test(p)) &&
  !p.endsWith('.test.ts');
const isTest = (p) => p.endsWith('.test.ts') || p.startsWith('tests/');

const newSource = added.filter(isSource);
const testsTouched = touched.filter(isTest);

if (newSource.length > 0 && testsTouched.length === 0) {
  console.error(
    'check-tests-accompany FAIL (Guide E2): new source files with no test added or modified in this range:',
  );
  for (const p of newSource) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `check-tests-accompany: ${newSource.length} new source file(s), ${testsTouched.length} test file(s) touched — ok`,
);
