import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const routes = JSON.parse(await readFile(path.join(root, 'routes.json'), 'utf8'));
const sourceOrigin = new URL(routes.source).origin;

const assetExtensions = /\.(?:css|js|mjs|json|webmanifest|avif|gif|jpe?g|png|svg|webp|ico|woff2?|otf|ttf|mp4|webm|mp3|ogg|pdf)$/i;
const textExtensions = /\.(?:css|js|mjs|json|webmanifest)$/i;
const imageExtensions = /\.(?:avif|gif|jpe?g|png|svg|webp|ico)$/i;
const inflight = new Map();
const resolved = new Map();
const captured = new Set();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: {
          'user-agent': 'Aero-Static-Finalizer/1.2',
          referer: routes.source
        },
        signal: AbortSignal.timeout(30000)
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(attempt * 600);
    }
  }
  throw new Error(`Failed to fetch ${url}: ${lastError}`);
}

function normaliseUrl(raw, base = routes.source) {
  if (!raw) return null;
  const value = String(raw).trim().replaceAll('&amp;', '&');
  if (!value || /^(?:data|blob|javascript|mailto|tel):/i.test(value)) return null;
  try {
    const url = new URL(value, base);
    url.hash = '';
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function isCapturableHost(url) {
  return url.origin === sourceOrigin || url.hostname.endsWith('.digitaloceanspaces.com') || url.hostname === 'digitaloceanspaces.com';
}

function publicPathFor(url) {
  if (url.origin === sourceOrigin && url.pathname.startsWith('/_next/static/')) {
    return url.pathname;
  }

  if (url.origin === sourceOrigin && !url.search && assetExtensions.test(url.pathname)) {
    return url.pathname;
  }

  const ext = path.posix.extname(url.pathname).toLowerCase();
  const safeExt = assetExtensions.test(ext) ? ext : '';
  const hash = createHash('sha256').update(url.href).digest('hex').slice(0, 24);
  return `/__assets/${hash}${safeExt}`;
}

function diskPathFor(publicPath) {
  return path.join(dist, publicPath.replace(/^\/+/, ''));
}

async function ensureMissingImage() {
  const publicPath = '/__assets/missing-image.svg';
  const destination = diskPathFor(publicPath);
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await readFile(destination);
  } catch {
    await writeFile(destination, '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"></svg>');
  }
  captured.add(publicPath);
  return publicPath;
}

async function replaceAsync(input, regex, replacer) {
  const matches = [...input.matchAll(regex)];
  if (!matches.length) return input;

  const unique = new Map();
  for (const match of matches) {
    if (!unique.has(match[0])) unique.set(match[0], replacer(match[0]));
  }

  const replacementMap = new Map();
  for (const [key, promise] of unique) replacementMap.set(key, await promise);

  let output = '';
  let cursor = 0;
  for (const match of matches) {
    output += input.slice(cursor, match.index) + replacementMap.get(match[0]);
    cursor = match.index + match[0].length;
  }
  return output + input.slice(cursor);
}

async function rewriteEmbeddedAssets(text, baseUrl) {
  let output = text;

  output = await replaceAsync(
    output,
    /\/_next\/static\/[A-Za-z0-9_./%~!$&()*+,;=:@?-]+/g,
    async raw => captureAsset(raw, baseUrl)
  );

  output = await replaceAsync(
    output,
    /https?:\/\/[^"'\\\s<>]+?\.(?:css|js|mjs|json|webmanifest|avif|gif|jpe?g|png|svg|webp|ico|woff2?|otf|ttf|mp4|webm|mp3|ogg|pdf)(?:\?[^"'\\\s<>]*)?/gi,
    async raw => captureAsset(raw, baseUrl)
  );

  return output;
}

async function captureAsset(rawUrl, baseUrl = routes.source) {
  const url = normaliseUrl(rawUrl, baseUrl);
  if (!url) return rawUrl;

  if (!isCapturableHost(url)) return rawUrl;

  if (url.origin === sourceOrigin && url.pathname === '/_next/image') {
    const original = url.searchParams.get('url');
    if (original) return captureAsset(original, baseUrl);
  }

  const key = url.href;
  if (resolved.has(key)) return resolved.get(key);
  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    const publicPath = publicPathFor(url);
    resolved.set(key, publicPath);

    let response;
    try {
      response = await fetchWithRetry(key);
    } catch (error) {
      if (imageExtensions.test(url.pathname)) {
        const fallback = await ensureMissingImage();
        resolved.set(key, fallback);
        console.warn(`Using local fallback for unavailable image ${key}`);
        return fallback;
      }
      throw error;
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const extension = path.posix.extname(url.pathname).toLowerCase();
    const destination = diskPathFor(publicPath);
    await mkdir(path.dirname(destination), { recursive: true });

    if (contentType.startsWith('text/') || /(?:javascript|json|manifest)/i.test(contentType) || textExtensions.test(extension)) {
      let body = await response.text();
      body = await rewriteEmbeddedAssets(body, key);
      await writeFile(destination, body);
    } else {
      await writeFile(destination, Buffer.from(await response.arrayBuffer()));
    }

    captured.add(publicPath);
    return publicPath;
  })().finally(() => inflight.delete(key));

  inflight.set(key, promise);
  return promise;
}

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

function stripAnalytics(html) {
  let output = html;
  output = output.replace(/<noscript>\s*<iframe[^>]+googletagmanager\.com[\s\S]*?<\/iframe>\s*<\/noscript>/gi, '');
  output = output.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, block => {
    if (/self\.__next_s/i.test(block) && /googletagmanager\.com|GTM-T9MT6J3J/i.test(block)) return '';
    if (/\bsrc=["'][^"']*googletagmanager\.com/i.test(block)) return '';
    return block;
  });
  return output;
}

function injectStaticSafety(html) {
  if (html.includes('id="aero-static-safety"')) return html;

  const selector = '.fixed.inset-0.z-9999.pointer-events-none,.fixed.inset-0.z-9998.pointer-events-none,[data-remove-on-complete]';
  const safety = `<style id="aero-static-safety">${selector}{display:none!important;opacity:0!important;visibility:hidden!important}</style><script id="aero-static-reveal">(()=>{const reveal=()=>document.querySelectorAll('${selector}').forEach(el=>el.remove());if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',reveal,{once:true});else reveal();setTimeout(reveal,1200)})();</script>`;
  return html.includes('</head>') ? html.replace('</head>', `${safety}</head>`) : `${safety}${html}`;
}

const htmlFiles = (await walk(dist)).filter(file => file.endsWith('.html'));
let rewrittenFiles = 0;

for (const file of htmlFiles) {
  let html = await readFile(file, 'utf8');
  html = stripAnalytics(html);
  html = await rewriteEmbeddedAssets(html, routes.source);
  html = injectStaticSafety(html);
  await writeFile(file, html);
  rewrittenFiles++;
}

const capturePath = path.join(dist, '__capture.json');
const capture = JSON.parse(await readFile(capturePath, 'utf8'));
capture.finalizedStaticRuntime = true;
capture.embeddedAssetsLocalized = captured.size;
capture.staticLoaderFailSafe = true;
capture.analyticsRuntimeRemoved = true;
await writeFile(capturePath, JSON.stringify(capture, null, 2));

console.log(`Finalized ${rewrittenFiles} HTML files and localized ${captured.size} embedded runtime assets.`);
