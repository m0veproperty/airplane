import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const PARTS = path.join(ROOT, 'capture-text');
const MIRROR = path.join(ROOT, 'mirror');
const EXPECTED_SHA256 = '0ef4d2e5939f4a853d7b40a5d42eba52f9238417bf3116817a055786cd51769f';
const EXPECTED_ENTRIES = 4206;
const EXPECTED_PAGES = 100;

const partNames = (await readdir(PARTS))
  .filter(name => /^chunk-\d+\.b64$/.test(name))
  .sort();
if (!partNames.length) throw new Error('Exact Aero capture runtime parts are missing');

let encoded = '';
for (const name of partNames) encoded += (await readFile(path.join(PARTS, name), 'utf8')).trim();
const archive = Buffer.from(encoded, 'base64');
const actualSha = createHash('sha256').update(archive).digest('hex');
if (actualSha !== EXPECTED_SHA256) {
  throw new Error(`Exact Aero runtime archive checksum mismatch: ${actualSha}`);
}

const temp = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(os.tmpdir(), 'aero-exact-')));
const archivePath = path.join(temp, 'aero-text.tar.xz');
await writeFile(archivePath, archive);
execFileSync('tar', ['-xJf', archivePath, '-C', temp], { stdio: 'inherit' });

const supplied = path.join(temp, 'aero-text-pack');
const suppliedManifestPath = path.join(supplied, 'manifest.json');
const suppliedManifest = JSON.parse(await readFile(suppliedManifestPath, 'utf8'));
const entries = suppliedManifest.entries || {};
const pages = suppliedManifest.pages || [];

if (Object.keys(entries).length !== EXPECTED_ENTRIES || pages.length !== EXPECTED_PAGES) {
  throw new Error(`Unexpected supplied capture shape: ${Object.keys(entries).length} entries, ${pages.length} pages`);
}

await mkdir(path.join(MIRROR, 'blobs'), { recursive: true });
await cp(suppliedManifestPath, path.join(MIRROR, 'manifest.json'), { force: true });
await cp(path.join(supplied, 'blobs'), path.join(MIRROR, 'blobs'), { recursive: true, force: true });

const missing = [];
for (const [url, entry] of Object.entries(entries)) {
  try {
    await access(path.join(MIRROR, entry.file));
  } catch {
    missing.push(`${entry.file} <- ${url}`);
    if (missing.length >= 40) break;
  }
}

await rm(temp, { recursive: true, force: true });

if (missing.length) {
  throw new Error(`Supplied Aero capture still needs local blob(s):\n${missing.join('\n')}`);
}

console.log(`Restored exact supplied Aero capture: ${EXPECTED_PAGES} pages, ${EXPECTED_ENTRIES} responses, captured ${suppliedManifest.capturedAt}.`);
