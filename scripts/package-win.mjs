// Windows packaging (FINAL item 12): one self-contained zip bundling the
// pinned Node runtime (this machine's own node.exe — .node-version enforces
// the major), the built app as versions/<version>/, prebuilt natives
// (better-sqlite3, sharp arrive via a real `npm ci --omit=dev`), and a
// launcher honoring the `current` pointer + the exit-code contract (exit 3 =
// corrupt_state: do not blindly restart). Also emits the update artifact
// (weltari-app-<v>-win32-x64.tar.gz + .sha256) — the .minisig is added by the
// owner with the secret key: `minisign -Sm <artifact>`.
// Usage: node scripts/package-win.mjs [--out <dir>]
// Run `npm run build` first — this script packages existing dist output.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`PACKAGE-WIN FAIL: ${message}`);
  process.exit(1);
}

if (process.platform !== 'win32') {
  fail('this script produces the Windows bundle — run it on Windows');
}
const outIndex = process.argv.indexOf('--out');
const OUT =
  outIndex !== -1 && process.argv[outIndex + 1]
    ? process.argv[outIndex + 1]
    : join(tmpdir(), 'weltari-pack');

const serverPkg = JSON.parse(
  readFileSync(join(ROOT, 'apps', 'server', 'package.json'), 'utf8'),
);
const VERSION = serverPkg.version;
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) fail(`bad server version ${VERSION}`);

for (const required of [
  join(ROOT, 'apps', 'server', 'dist', 'main.js'),
  join(ROOT, 'apps', 'web', 'dist', 'index.html'),
  join(ROOT, 'packages', 'protocol', 'dist', 'index.js'),
  join(ROOT, 'minisign.pub'),
]) {
  if (!existsSync(required))
    fail(`missing ${required} — run \`npm run build\` first`);
}

const stagingRoot = join(OUT, 'weltari-win-x64');
const appDir = join(stagingRoot, 'versions', VERSION);
rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });

// --- 1. The app directory mirrors the repo shape (dist paths keep working:
// main.js resolves web dist + migrations relative to itself).
const copies = [
  ['package.json'],
  ['package-lock.json'],
  ['.npmrc'],
  // The baked update-verification PUBLIC key (owner decision, 2026-07-09):
  // shipping it is what makes auto-apply work out of the box — main.js reads
  // it from the app root when WELTARI_UPDATE_PUBKEY is unset (the
  // Sparkle/Tauri model; the private key never travels). Included in the
  // update artifact too, so post-update versions keep it.
  ['minisign.pub'],
  ['packages', 'protocol', 'package.json'],
  ['packages', 'protocol', 'dist'],
  ['packages', 'plugin-sdk', 'package.json'],
  ['packages', 'plugin-sdk', 'dist'],
  ['apps', 'server', 'package.json'],
  ['apps', 'server', 'dist'],
  ['apps', 'server', 'migrations'],
  ['apps', 'web', 'package.json'],
  ['apps', 'web', 'dist'],
  ['plugins'],
];
for (const parts of copies) {
  cpSync(join(ROOT, ...parts), join(appDir, ...parts), { recursive: true });
}

// --- 2. Real production install: exact pins from the lockfile, prebuilt
// natives (better-sqlite3, sharp) fetched for win32-x64 by their own scripts.
console.log('npm ci --omit=dev (production node_modules)…');
const ci = spawnSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
  cwd: appDir,
  stdio: 'inherit',
  shell: true,
});
if (ci.status !== 0) fail('npm ci failed');

// --- 3. Workspace junctions -> real copies (archives must not contain links;
// the update tar reader refuses link entries by design).
const scopeDir = join(appDir, 'node_modules', '@weltari');
if (existsSync(scopeDir)) {
  for (const name of readdirSync(scopeDir)) {
    const linkPath = join(scopeDir, name);
    if (!lstatSync(linkPath).isSymbolicLink()) continue;
    rmSync(linkPath, { recursive: true, force: true });
    const packageSource = join(appDir, 'packages', name);
    // npm links every workspace; only the MIT packages are import targets —
    // app links (@weltari/server, @weltari/web) are simply dropped.
    if (existsSync(packageSource)) {
      cpSync(packageSource, linkPath, { recursive: true });
    }
  }
}
// The packages/ tree only existed for npm's workspace resolution.
rmSync(join(appDir, 'packages'), { recursive: true, force: true });

// --- 4. Pinned runtime + pointer + launcher.
mkdirSync(join(stagingRoot, 'node'), { recursive: true });
cpSync(process.execPath, join(stagingRoot, 'node', 'node.exe'));
writeFileSync(join(stagingRoot, 'versions', 'current'), `${VERSION}\n`);
writeFileSync(
  join(stagingRoot, 'weltari.cmd'),
  [
    '@echo off',
    'setlocal EnableExtensions',
    'cd /d "%~dp0"',
    'if not exist "data" mkdir "data"',
    'if not exist "versions\\current" (',
    '  echo [weltari] versions\\current missing - broken install, re-extract the zip.',
    '  exit /b 1',
    ')',
    '',
    ':run',
    'set /p WELTARI_CURRENT=<"versions\\current"',
    'set "WELTARI_VERSIONS_DIR=%~dp0versions"',
    'set "WELTARI_DB_PATH=%~dp0data\\weltari.sqlite"',
    'set "WELTARI_IMAGES_DIR=%~dp0data\\images"',
    'set "WELTARI_PLUGINS_DIR=%~dp0versions\\%WELTARI_CURRENT%\\plugins"',
    'echo [weltari] starting version %WELTARI_CURRENT% on http://127.0.0.1:7777',
    '"%~dp0node\\node.exe" "%~dp0versions\\%WELTARI_CURRENT%\\apps\\server\\dist\\main.js"',
    'if %ERRORLEVEL%==3 goto corrupt',
    'if %ERRORLEVEL%==0 exit /b 0',
    'echo [weltari] exited with %ERRORLEVEL% - restarting in 3 seconds (Ctrl+C to stop)...',
    'timeout /t 3 /nobreak >nul',
    'rem the pointer is re-read on restart: a staged update takes effect here',
    'goto run',
    '',
    ':corrupt',
    'echo [weltari] EXIT 3: corrupt state - NOT restarting automatically.',
    'echo [weltari] Check the data directory before starting again (docs/update.md).',
    'exit /b 3',
    '',
  ].join('\r\n'),
);

// --- 5. Archives: the user-facing zip + the self-update artifact
// (ustar-format tar.gz — the in-app reader supports exactly this).
const zipPath = join(OUT, `weltari-win-x64-${VERSION}.zip`);
rmSync(zipPath, { force: true });
console.log('zipping…');
const zip = spawnSync(
  'tar.exe',
  ['-a', '-cf', zipPath, '-C', OUT, 'weltari-win-x64'],
  { stdio: 'inherit' },
);
if (zip.status !== 0) fail('zip creation failed');

const artifactName = `weltari-app-${VERSION}-win32-x64.tar.gz`;
const artifactPath = join(OUT, artifactName);
rmSync(artifactPath, { force: true });
console.log('building update artifact…');
const tar = spawnSync(
  'tar.exe',
  ['--format=ustar', '-czf', artifactPath, '-C', appDir, '.'],
  { stdio: 'inherit' },
);
if (tar.status !== 0) fail('update artifact creation failed');
const sha = createHash('sha256')
  .update(readFileSync(artifactPath))
  .digest('hex');
writeFileSync(join(OUT, `${artifactName}.sha256`), `${sha}  ${artifactName}\n`);

console.log(`
package-win done:
  ${zipPath}
  ${artifactPath}
  ${artifactPath}.sha256
Release checklist (owner): sign the artifact — minisign -Sm ${artifactName}
— then attach all four files to the GitHub Release.`);
