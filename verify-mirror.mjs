import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('mirror');
const manifestPath = path.join(root, 'manifest.json');
await access(manifestPath);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const entries = manifest.entries || {};
const pages = manifest.pages || [];

if (!entries['https://www.aerodynamics.nl/']) throw new Error('Mirror is missing the homepage capture.');
if (pages.length < 20) throw new Error(`Mirror has too few captured pages: ${pages.length}`);

let checked = 0;
for (const entry of Object.values(entries)) {
  if (!entry?.file) continue;
  await access(path.join(root, entry.file));
  checked++;
}

const blobCount = (await readdir(path.join(root, 'blobs'))).length;
if (blobCount < 100) throw new Error(`Mirror has too few blobs: ${blobCount}`);

console.log(`Verified exact replay mirror: ${pages.length} pages, ${checked} mapped responses, ${blobCount} blobs.`);
