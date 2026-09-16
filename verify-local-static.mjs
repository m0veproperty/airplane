import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('dist');
const TEXT_EXTENSIONS = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.xml', '.webmanifest']);
const FORBIDDEN_HOST = /(?:https?:)?\/\/(?:www\.)?aerodynamics\.nl|(?:https?:)?\/\/[^\s"'<>)]*(?:digitaloceanspaces\.com|ondigitalocean\.app)/ig;
const ACTIVE_HTML = /<(?:script|img|source|video|audio|iframe|embed|object|link)\b[^>]*(?:src|href|poster|data)\s*=\s*["'][^"']*(?:aerodynamics\.nl|digitaloceanspaces\.com|ondigitalocean\.app)[^"']*["'][^>]*>/ig;
const CSS_REMOTE = /(?:url|@import)\s*\([^)]*(?:aerodynamics\.nl|digitaloceanspaces\.com|ondigitalocean\.app)[^)]*\)|@import\s+["'][^"']*(?:aerodynamics\.nl|digitaloceanspaces\.com|ondigitalocean\.app)[^"']*["']/ig;

const problems = [];
let files = 0;
let bytes = 0;

async function walk(dir) {
  for (const name of await readdir(dir)) {
    const file = path.join(dir, name);
    const s = await stat(file);
    if (s.isDirectory()) {
      await walk(file);
      continue;
    }
    files++;
    bytes += s.size;
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;

    const text = await readFile(file, 'utf8');
    const rel = path.relative(ROOT, file);

    if (path.extname(file).toLowerCase() === '.html') {
      for (const match of text.matchAll(ACTIVE_HTML)) {
        const tag = match[0];
        // Canonical/alternate/OG metadata are not runtime resources. Active link rel values are checked.
        if (/^<link\b/i.test(tag) && /rel=["'](?:canonical|alternate)["']/i.test(tag)) continue;
        problems.push(`${rel}: ${tag.slice(0, 240)}`);
      }
    }

    if (path.extname(file).toLowerCase() === '.css') {
      for (const match of text.matchAll(CSS_REMOTE)) problems.push(`${rel}: ${match[0].slice(0, 240)}`);
    }
  }
}

await walk(ROOT);

if (files < 100) throw new Error(`Local static site is unexpectedly small: ${files} files`);
if (problems.length) {
  console.error('Remote runtime dependencies remain in the production output:');
  for (const problem of problems.slice(0, 50)) console.error(` - ${problem}`);
  throw new Error(`${problems.length} remote runtime asset reference(s) remain`);
}

console.log(`Local-only verification passed: ${files} files, ${bytes} bytes. No Aerodynamics/DigitalOcean runtime assets.`);
