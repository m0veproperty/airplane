import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile, copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const routes = JSON.parse(await readFile(path.join(root, 'routes.json'), 'utf8'));
const dist = path.join(root, 'dist');
const source = (process.env.SOURCE_ORIGIN || routes.source).replace(/\/$/, '');
const sourceOrigin = new URL(source).origin;
const localRoutes = new Set([...routes.pages, ...Object.keys(routes.aliases || {})]);

const assetPaths = new Map();
const assetInflight = new Map();
const capturedAssets = new Set();

const contentTypeExtensions = new Map([
  ['text/css', '.css'],
  ['text/javascript', '.js'],
  ['application/javascript', '.js'],
  ['application/json', '.json'],
  ['application/manifest+json', '.webmanifest'],
  ['image/avif', '.avif'],
  ['image/gif', '.gif'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/svg+xml', '.svg'],
  ['image/webp', '.webp'],
  ['image/x-icon', '.ico'],
  ['font/otf', '.otf'],
  ['font/ttf', '.ttf'],
  ['font/woff', '.woff'],
  ['font/woff2', '.woff2'],
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['audio/mpeg', '.mp3'],
  ['audio/ogg', '.ogg'],
  ['application/pdf', '.pdf']
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: {
          'user-agent': 'Aero-Static-Snapshot/2.0',
          ...(options.headers || {})
        },
        signal: AbortSignal.timeout(30000)
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(attempt * 500);
    }
  }
  throw new Error(`Failed to fetch ${url}: ${lastError}`);
}

function outputPath(route) {
  if (route === '/') return path.join(dist, 'index.html');
  const clean = route.replace(/^\/+|\/+$/g, '');
  if (!clean || clean.includes('..')) throw new Error(`Unsafe route: ${route}`);
  return path.join(dist, `${clean}.html`);
}

function normaliseUrl(raw, base) {
  if (!raw) return null;
  const value = String(raw).trim().replaceAll('&amp;', '&');
  if (!value || value.startsWith('#') || /^(?:data|blob|javascript|mailto|tel):/i.test(value)) return null;
  try {
    const url = new URL(value, base);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function extensionFor(url, contentType) {
  const existing = path.posix.extname(url.pathname);
  if (existing && existing.length <= 12) return existing.toLowerCase();
  const cleanType = String(contentType || '').split(';')[0].trim().toLowerCase();
  return contentTypeExtensions.get(cleanType) || '';
}

function publicPathFor(url, contentType) {
  const existingExtension = path.posix.extname(url.pathname);
  if (url.origin === sourceOrigin && !url.search && existingExtension && !url.pathname.includes('..')) {
    return url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`;
  }
  const hash = createHash('sha256').update(url.href).digest('hex').slice(0, 24);
  return `/__assets/${hash}${extensionFor(url, contentType)}`;
}

function diskPathFor(publicPath) {
  const clean = publicPath.replace(/^\/+/, '');
  if (!clean || clean.includes('..')) throw new Error(`Unsafe asset path: ${publicPath}`);
  return path.join(dist, clean);
}

async function replaceAsync(input, regex, replacer) {
  const matches = [...input.matchAll(regex)];
  if (!matches.length) return input;
  const replacements = await Promise.all(matches.map(match => replacer(...match)));
  let output = '';
  let cursor = 0;
  matches.forEach((match, index) => {
    output += input.slice(cursor, match.index) + replacements[index];
    cursor = match.index + match[0].length;
  });
  return output + input.slice(cursor);
}

async function rewriteCss(css, baseUrl) {
  let output = await replaceAsync(css, /url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, async (full, quote, raw) => {
    const url = normaliseUrl(raw, baseUrl);
    if (!url) return full;
    const local = await captureAsset(url.href, baseUrl);
    return `url("${local}")`;
  });

  output = await replaceAsync(output, /@import\s+(['"])([^'"]+)\1/gi, async (full, quote, raw) => {
    const url = normaliseUrl(raw, baseUrl);
    if (!url) return full;
    const local = await captureAsset(url.href, baseUrl);
    return `@import "${local}"`;
  });

  return output;
}

async function captureAsset(rawUrl, referrer = source) {
  const url = normaliseUrl(rawUrl, referrer);
  if (!url) return rawUrl;

  const key = url.href;
  if (assetPaths.has(key)) return assetPaths.get(key);
  if (assetInflight.has(key)) return assetInflight.get(key);

  const promise = (async () => {
    const response = await fetchWithRetry(key, { headers: { referer: referrer } });
    const contentType = response.headers.get('content-type') || '';
    const publicPath = publicPathFor(url, contentType);
    assetPaths.set(key, publicPath);
    capturedAssets.add(publicPath);

    let body;
    if (contentType.toLowerCase().startsWith('text/css')) {
      body = await rewriteCss(await response.text(), key);
    } else {
      body = Buffer.from(await response.arrayBuffer());
    }

    const destination = diskPathFor(publicPath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, body);
    return publicPath;
  })().finally(() => assetInflight.delete(key));

  assetInflight.set(key, promise);
  return promise;
}

async function rewriteSrcset(value, baseUrl) {
  const entries = value.split(',').map(item => item.trim()).filter(Boolean);
  const rewritten = await Promise.all(entries.map(async entry => {
    const match = entry.match(/^(\S+)(\s+.*)?$/);
    if (!match) return entry;
    const url = normaliseUrl(match[1], baseUrl);
    if (!url) return entry;
    const local = await captureAsset(url.href, baseUrl);
    return `${local}${match[2] || ''}`;
  }));
  return rewritten.join(', ');
}

async function rewriteTagAttribute(tag, attribute, baseUrl, mode = 'asset') {
  const regex = new RegExp(`(\\b${attribute}\\s*=\\s*)(["'])([^"']+)(\\2)`, 'i');
  const match = tag.match(regex);
  if (!match) return tag;

  const raw = match[3];
  const url = normaliseUrl(raw, baseUrl);
  if (!url) return tag;

  let replacement = raw;
  if (mode === 'asset') {
    replacement = await captureAsset(url.href, baseUrl);
  } else if (mode === 'local-link' && url.origin === sourceOrigin) {
    const route = `${url.pathname}${url.search}${url.hash}`;
    replacement = route || '/';
  }

  return tag.replace(regex, `${match[1]}${match[2]}${replacement}${match[2]}`);
}

async function rewriteHtml(html, pageUrl) {
  let output = html;

  output = output.replace(/<link\b[^>]*\brel\s*=\s*["'][^"']*(?:preconnect|dns-prefetch)[^"']*["'][^>]*>/gi, '');

  output = await replaceAsync(output, /<link\b[^>]*>/gi, async tag => {
    if (!/\brel\s*=\s*["'][^"']*(?:stylesheet|icon|preload|prefetch|modulepreload|manifest|apple-touch-icon)[^"']*["']/i.test(tag)) return tag;
    return rewriteTagAttribute(tag, 'href', pageUrl, 'asset');
  });

  output = await replaceAsync(output, /<(?:script|img|source|video|audio|track|embed)\b[^>]*>/gi, async tag => {
    let rewritten = await rewriteTagAttribute(tag, 'src', pageUrl, 'asset');
    rewritten = await rewriteTagAttribute(rewritten, 'poster', pageUrl, 'asset');

    const srcset = rewritten.match(/(\bsrcset\s*=\s*)(["'])([^"']+)(\2)/i);
    if (srcset) {
      const localSrcset = await rewriteSrcset(srcset[3], pageUrl);
      rewritten = rewritten.replace(srcset[0], `${srcset[1]}${srcset[2]}${localSrcset}${srcset[2]}`);
    }
    return rewritten;
  });

  output = await replaceAsync(output, /<object\b[^>]*>/gi, tag => rewriteTagAttribute(tag, 'data', pageUrl, 'asset'));

  output = await replaceAsync(output, /<meta\b[^>]*>/gi, async tag => {
    if (!/(?:property|name)\s*=\s*["'](?:og:image|twitter:image|msapplication-TileImage)["']/i.test(tag)) return tag;
    return rewriteTagAttribute(tag, 'content', pageUrl, 'asset');
  });

  output = await replaceAsync(output, /<style\b[^>]*>([\s\S]*?)<\/style>/gi, async (full, css) => {
    return full.replace(css, await rewriteCss(css, pageUrl));
  });

  output = await replaceAsync(output, /\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi, async (full, quote, css) => {
    return `style=${quote}${await rewriteCss(css, pageUrl)}${quote}`;
  });

  output = await replaceAsync(output, /<a\b[^>]*>/gi, async tag => {
    const hrefMatch = tag.match(/\bhref\s*=\s*(["'])([^"']+)\1/i);
    if (!hrefMatch) return tag;
    const url = normaliseUrl(hrefMatch[2], pageUrl);
    if (!url || url.origin !== sourceOrigin) return tag;

    const extension = path.posix.extname(url.pathname).toLowerCase();
    if (extension && !['.html', '.htm'].includes(extension)) {
      return rewriteTagAttribute(tag, 'href', pageUrl, 'asset');
    }
    return rewriteTagAttribute(tag, 'href', pageUrl, 'local-link');
  });

  output = await replaceAsync(output, /<form\b[^>]*>/gi, tag => rewriteTagAttribute(tag, 'action', pageUrl, 'local-link'));

  return output;
}

const navigationPatch = `<script>(()=>{const routes=new Set(${JSON.stringify([...localRoutes])});document.addEventListener('click',event=>{if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;const anchor=event.target?.closest?.('a[href]');if(!anchor||anchor.target&&anchor.target!=='_self'||anchor.hasAttribute('download'))return;let url;try{url=new URL(anchor.href,location.href)}catch{return}if(url.origin!==location.origin)return;if(url.hash&&url.pathname===location.pathname&&url.search===location.search)return;if(!routes.has(url.pathname))return;event.preventDefault();event.stopImmediatePropagation();location.assign(url.pathname+url.search+url.hash)},true)})();</script>`;

function injectNavigation(html) {
  if (html.includes('</head>')) return html.replace('</head>', `${navigationPatch}</head>`);
  return `${navigationPatch}${html}`;
}

function assertNoRemoteAssetReferences(html, route) {
  const sourceEscaped = sourceOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const checks = [
    new RegExp(`<(?:script|img|source|video|audio|track|embed)[^>]+(?:src|srcset|poster)=["'][^"']*${sourceEscaped}`, 'i'),
    new RegExp(`<link[^>]+href=["'][^"']*${sourceEscaped}`, 'i'),
    new RegExp(`style=["'][^"']*${sourceEscaped}`, 'i')
  ];
  if (checks.some(regex => regex.test(html))) {
    throw new Error(`Remote Aerodynamics asset reference remains in route ${route}`);
  }
}

async function fetchPage(route) {
  const pageUrl = `${source}${route}`;
  const response = await fetchWithRetry(pageUrl);
  const html = await rewriteHtml(await response.text(), pageUrl);
  const finalHtml = injectNavigation(html);
  assertNoRemoteAssetReferences(finalHtml, route);
  return finalHtml;
}

async function writePage(route) {
  const file = outputPath(route);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, await fetchPage(route));
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const queue = [...routes.pages];
const workerCount = Math.min(6, queue.length || 1);
await Promise.all(Array.from({ length: workerCount }, async () => {
  while (queue.length) {
    const route = queue.shift();
    if (route) await writePage(route);
  }
}));

for (const [alias, target] of Object.entries(routes.aliases || {})) {
  const targetFile = outputPath(target);
  const aliasFile = outputPath(alias);
  await mkdir(path.dirname(aliasFile), { recursive: true });
  await copyFile(targetFile, aliasFile);
}

const directCapturedAssets = [
  ['assets/loader/pill.svg', '/loader/pill.svg'],
  ['assets/loader/pill-2.svg', '/loader/pill-2.svg'],
  ['assets/img/icon-plane.svg', '/img/icon-plane.svg']
];

for (const [sourceFile, publicPath] of directCapturedAssets) {
  const destination = diskPathFor(publicPath);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(root, sourceFile), destination);
  capturedAssets.add(publicPath);
}

try {
  await captureAsset(`${source}/favicon.ico`, source);
} catch (error) {
  console.warn(String(error));
}

await writeFile(path.join(dist, '__capture.json'), JSON.stringify({
  sourceUsedAtBuildTimeOnly: routes.source,
  builtAt: new Date().toISOString(),
  pages: routes.pages.length,
  aliases: Object.keys(routes.aliases || {}).length,
  localAssets: capturedAssets.size,
  runtimeSourceProxy: false
}, null, 2));

console.log(`Built ${routes.pages.length} routes, ${Object.keys(routes.aliases || {}).length} aliases and ${capturedAssets.size} local assets. No runtime source proxy is used.`);
