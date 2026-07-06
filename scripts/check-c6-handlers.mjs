// C6: process.on('uncaughtException') and process.on('unhandledRejection')
// are registered exactly once each, both in main.ts — no library or module
// may install its own survival handler. Grep-enforced (Guide C6).
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'apps', 'server', 'src');

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith('.ts')) yield path;
  }
}

const registrations = [];
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8');
  for (const handler of ['uncaughtException', 'unhandledRejection']) {
    const pattern = new RegExp(`process\\.on\\(\\s*['"]${handler}['"]`, 'g');
    const count = [...text.matchAll(pattern)].length;
    for (let i = 0; i < count; i++) {
      registrations.push({ file: relative(ROOT, file), handler });
    }
  }
}

const problems = [];
for (const handler of ['uncaughtException', 'unhandledRejection']) {
  const hits = registrations.filter((r) => r.handler === handler);
  if (hits.length !== 1) {
    problems.push(
      `${handler}: expected exactly 1 registration, found ${hits.length} (${hits.map((h) => h.file).join(', ') || 'none'})`,
    );
  } else if (
    !hits[0].file.replaceAll('\\', '/').endsWith('apps/server/src/main.ts')
  ) {
    problems.push(
      `${handler}: registered in ${hits[0].file}, must be main.ts only (Guide C6)`,
    );
  }
}

if (problems.length > 0) {
  console.error('check-c6-handlers FAIL:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  'check-c6-handlers: both process handlers registered once, in main.ts',
);
