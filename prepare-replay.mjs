import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { patchGlobe } from './globe-fallback.mjs';

const ROOT = process.cwd();
const MIRROR = path.join(ROOT, 'mirror');
const PUBLIC = path.join(ROOT, 'public');
const STATIC = path.join(PUBLIC, '__mirror_webgl1');
const manifest = JSON.parse(await readFile(path.join(MIRROR, 'manifest.json'), 'utf8'));
const entries = manifest.entries || {};

const capturedHosts = [...new Set(Object.keys(entries).map(raw => {
  try { return new URL(raw).hostname; } catch { return null; }
}).filter(Boolean))];

function isText(entry) {
  const ct = String(entry.contentType || entry.headers?.['content-type'] || '').toLowerCase();
  return ct.startsWith('text/') || ct.includes('javascript') || ct.includes('json') || ct.includes('xml') || ct.includes('svg');
}

function localizeText(text) {
  let out = text;
  out = out.replaceAll('https://www.aerodynamics.nl', '');
  out = out.replaceAll('https://aerodynamics.nl', '');
  out = out.replaceAll('https:\/\/www.aerodynamics.nl', '');
  out = out.replaceAll('https:\/\/aerodynamics.nl', '');

  for (const host of capturedHosts) {
    if (host === 'www.aerodynamics.nl' || host === 'aerodynamics.nl') continue;
    const prefix = `/__external/${host}`;
    out = out.replaceAll(`https://${host}`, prefix);
    out = out.replaceAll(`https:\/\/${host}`, prefix.replaceAll('/', '\\/'));
    out = out.replaceAll(`//${host}`, prefix);
  }
  return out.replaceAll('/_next/', '/_aero/');
}

await rm(PUBLIC, { recursive: true, force: true });
await mkdir(STATIC, { recursive: true });

const items = Object.values(entries);
const concurrency = 48;
for (let i = 0; i < items.length; i += concurrency) {
  await Promise.all(items.slice(i, i + concurrency).map(async entry => {
    if (!entry?.file) return;
    const source = path.join(MIRROR, entry.file);
    const dest = path.join(STATIC, path.basename(entry.file));
    if (isText(entry)) {
      let text = await readFile(source, 'utf8');
      if (path.basename(entry.file) === 'bb23aea23b6414912751312af2a64198c1e254dab030e70a5368535c1763f8f1.js') text = patchGlobe(text);
      await writeFile(dest, localizeText(text));
    } else {
      await copyFile(source, dest);
    }
  }));
}

await writeFile(path.join(PUBLIC, '__aero-replay.json'), JSON.stringify({
  capturedAt: manifest.capturedAt,
  pages: (manifest.pages || []).length,
  resources: Object.keys(entries).length,
  mode: 'manifest-request-replay'
}, null, 2));

console.log(`Prepared ${Object.keys(entries).length} captured responses for local CDN replay.`);
