// C3 catch audit — crude by design (Guide C3): every `catch` in server source
// must, within its following lines, rethrow, return err(...), escalate to
// fatal(...), log at warn+ with the error attached, or carry a `// CATCH-OK:`
// marker. Drive-by swallowing should be loud, not subtle.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'apps', 'server', 'src');
const WINDOW_LINES = 12;
const EVIDENCE =
  /\bthrow\b|return err\(|\bfatal\(|\.warn\(|\.error\(|CATCH-OK|reject\(/;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
      yield path;
  }
}

const problems = [];
for (const file of walk(SRC)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!/\bcatch\b/.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
    const windowText = lines.slice(i, i + WINDOW_LINES).join('\n');
    if (!EVIDENCE.test(windowText)) {
      problems.push(
        `${relative(ROOT, file)}:${i + 1} — catch with no rethrow / return err / fatal / warn+ log / CATCH-OK marker within ${WINDOW_LINES} lines (Guide C3)`,
      );
    }
  });
}

if (problems.length > 0) {
  console.error('check-catch-audit FAIL:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('check-catch-audit: every catch site shows its handling evidence');
