// A12 + D8: the MIT edge packages stay MIT (license field, no AGPL workspace
// deps), and every direct dependency's installed license is AGPLv3-compatible
// (MIT/ISC/BSD/Apache-2.0/MPL-2.0/0BSD). Apache-2.0 may be depended on but
// never copied into the MIT packages — that half is a review rule (Guide A12).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'MPL-2.0',
  '0BSD',
]);
const AGPL_WORKSPACE = new Set(['@weltari/server', '@weltari/web']);

const problems = [];

function readManifest(path) {
  try {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
  } catch {
    return null;
  }
}

// 1. License fields: AGPL core, MIT edges.
for (const [path, expected] of [
  ['package.json', 'AGPL-3.0-only'],
  ['apps/server/package.json', 'AGPL-3.0-only'],
  ['apps/web/package.json', 'AGPL-3.0-only'],
  ['packages/protocol/package.json', 'MIT'],
  ['packages/plugin-sdk/package.json', 'MIT'],
]) {
  const manifest = readManifest(path);
  if (manifest === null) continue; // workspace not created yet
  if (manifest.license !== expected) {
    problems.push(
      `${path}: license is "${manifest.license}", expected "${expected}"`,
    );
  }
}

// 2. MIT packages must not depend on the AGPL core (A12).
for (const path of [
  'packages/protocol/package.json',
  'packages/plugin-sdk/package.json',
]) {
  const manifest = readManifest(path);
  if (manifest === null) continue;
  const declared = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
  };
  for (const name of Object.keys(declared)) {
    if (AGPL_WORKSPACE.has(name)) {
      problems.push(
        `${path}: depends on AGPL workspace package ${name} (license fence A12)`,
      );
    }
  }
}

// 3. Every direct dependency's installed license is on the approved list (D8).
for (const path of [
  'package.json',
  'packages/protocol/package.json',
  'apps/server/package.json',
  'apps/web/package.json',
]) {
  const manifest = readManifest(path);
  if (manifest === null) continue;
  const declared = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
  };
  for (const name of Object.keys(declared)) {
    if (name.startsWith('@weltari/')) continue;
    // npm hoists most deps to the root; version conflicts nest them per-workspace.
    const installed =
      readManifest(join('node_modules', name, 'package.json')) ??
      readManifest(join(dirname(path), 'node_modules', name, 'package.json'));
    if (installed === null) {
      problems.push(`${path}: ${name} is not installed — run npm ci first`);
      continue;
    }
    const license =
      typeof installed.license === 'string' ? installed.license : '(none)';
    if (!ALLOWED.has(license)) {
      problems.push(
        `${path}: ${name} has license "${license}" — not on the approved list (Guide D8)`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error('check-licenses FAIL:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  'check-licenses: license fields and direct-dependency licenses all pass',
);
