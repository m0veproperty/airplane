import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');

await access(path.join(dist, 'index.html'));
await access(path.join(dist, '__capture.json'));

const capture = JSON.parse(await readFile(path.join(dist, '__capture.json'), 'utf8'));
if (capture.runtimeSourceProxy !== false) {
  throw new Error('Committed snapshot is not marked as runtime-local.');
}

let fileCount = 0;
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else fileCount++;
  }
}
await walk(dist);

console.log(`Using committed static snapshot from dist with ${fileCount} files. No source-site fetch is performed during this build.`);
