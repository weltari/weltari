// A local signed-release fixture server for exercising the Config update
// surface by hand (M4 criterion d) — the same artifact-trio pattern the kill
// harness uses for mid_update, standalone: serve /latest + assets, print the
// env the server needs. The keypair is fresh per run, so nothing here can
// ever verify against a real release.
// Usage: node tools/update-fixture.mjs [version] [port]
//   then start weltari with the two printed WELTARI_UPDATE_* variables.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Reuses the compiled test helpers (tsc -b builds tests/); file:// for Windows.
const { generateMinisignKeypair, minisignSign } = await import(
  pathToFileURL(join(ROOT, 'tests', 'dist', 'helpers', 'minisign.js')).href
);
const { buildTarGz } = await import(
  pathToFileURL(join(ROOT, 'tests', 'dist', 'helpers', 'tar.js')).href
);

const version = process.argv[2] ?? '0.9.0';
const port = Number(process.argv[3] ?? 7799);

const keypair = generateMinisignKeypair();
const base = `weltari-app-${version}-${process.platform}-${process.arch}.tar.gz`;
const artifact = buildTarGz([
  { path: 'dist' },
  { path: 'dist/main.js', data: `// weltari ${version} (local fixture)` },
  { path: 'package.json', data: `{"version":"${version}"}` },
]);
const sha = createHash('sha256').update(artifact).digest('hex');
const files = new Map([
  [base, artifact],
  [`${base}.minisig`, Buffer.from(minisignSign(artifact, keypair))],
  [`${base}.sha256`, Buffer.from(`${sha}  ${base}\n`)],
]);
const releaseJson = JSON.stringify({
  tag_name: `v${version}`,
  html_url: `http://127.0.0.1:${String(port)}/releases/v${version}`,
  assets: [...files.keys()].map((name) => ({
    name,
    browser_download_url: `http://127.0.0.1:${String(port)}/assets/${name}`,
  })),
});

createServer((req, res) => {
  if (req.url === '/latest') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(releaseJson);
    return;
  }
  const asset = req.url?.startsWith('/assets/')
    ? files.get(decodeURIComponent(req.url.slice('/assets/'.length)))
    : undefined;
  if (asset === undefined) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/octet-stream' });
  res.end(asset);
}).listen(port, '127.0.0.1', () => {
  console.log(
    `update fixture: v${version} on http://127.0.0.1:${String(port)}/latest`,
  );
  console.log(
    `WELTARI_UPDATE_RELEASES_URL=http://127.0.0.1:${String(port)}/latest`,
  );
  console.log(`WELTARI_UPDATE_PUBKEY=${keypair.publicKeyBase64}`);
});
