// D8: every dependency needs a `## <name>` heading in docs/dependencies.md,
// and every declared version is an exact pin (no ^ or ~ ranges — bumps happen
// only in the monthly chore(deps) PR). Exit 1 lists every violation.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFESTS = [
  'package.json',
  'packages/protocol/package.json',
  'apps/server/package.json',
  'apps/web/package.json',
];

const ledger = readFileSync(join(ROOT, 'docs', 'dependencies.md'), 'utf8');
const headings = new Set(
  [...ledger.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim()),
);

const problems = [];
for (const manifestPath of MANIFESTS) {
  let raw;
  try {
    raw = readFileSync(join(ROOT, manifestPath), 'utf8');
  } catch {
    continue; // workspace not created yet (e.g. plugin-sdk)
  }
  const manifest = JSON.parse(raw);
  const declared = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
  };
  for (const [name, version] of Object.entries(declared)) {
    if (name.startsWith('@weltari/')) continue; // internal workspace siblings
    if (/^[\^~]/.test(version)) {
      problems.push(
        `${manifestPath}: ${name}@${version} is a range — versions are exact pins (Guide D8)`,
      );
    }
    if (!headings.has(name)) {
      problems.push(
        `${manifestPath}: ${name} has no "## ${name}" heading in docs/dependencies.md (Guide D8)`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error('check-dep-ledger FAIL:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  'check-dep-ledger: every dependency has a ledger entry and an exact pin',
);
