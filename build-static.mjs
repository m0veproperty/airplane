import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm, copyFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const MIRROR = path.join(ROOT, 'mirror');
const OUT = path.join(ROOT, 'dist');
const SOURCE_HOSTS = new Set(['www.aerodynamics.nl', 'aerodynamics.nl']);
const SOURCE_ORIGINS = ['https://www.aerodynamics.nl', 'https://aerodynamics.nl'];
const DROP_HOST_PARTS = [
  'google-analytics', 'googletagmanager', 'doubleclick', 'facebook.net',
  'hotjar', 'clarity.ms', 'linkedin.com', 'instagram.com'
];
const FORBIDDEN_RUNTIME_HOSTS = [
  'www.aerodynamics.nl',
  'aerodynamics.nl',
  'digitaloceanspaces.com'
];

const manifest = JSON.parse(await readFile(path.join(MIRROR, 'manifest.json'), 'utf8'));
const entries = manifest.entries || {};
const routes = JSON.parse(await readFile(path.join(ROOT, 'routes.json'), 'utf8'));

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function extFrom(entry, rawUrl) {
  const ct = String(entry.contentType || '').toLowerCase();
  if (ct.includes('text/html')) return '.html';
  if (ct.includes('text/css')) return '.css';
  if (ct.includes('javascript')) return '.js';
  if (ct.includes('application/json')) return '.json';
  if (ct.includes('text/x-component')) return '.rsc';
  if (ct.includes('image/avif')) return '.avif';
  if (ct.includes('image/webp')) return '.webp';
  if (ct.includes('image/png')) return '.png';
  if (ct.includes('image/jpeg')) return '.jpg';
  if (ct.includes('image/svg')) return '.svg';
  if (ct.includes('font/woff2')) return '.woff2';
  if (ct.includes('font/woff')) return '.woff';
  if (ct.includes('video/mp4')) return '.mp4';
  try {
    const ext = path.extname(new URL(rawUrl).pathname);
    return ext && ext.length <= 10 ? ext : '.bin';
  } catch {
    return '.bin';
  }
}

function isText(entry) {
  const ct = String(entry.contentType || '').toLowerCase();
  return ct.startsWith('text/') ||
    ct.includes('javascript') || ct.includes('json') || ct.includes('xml') ||
    ct.includes('svg');
}

function isHtml(entry) {
  return String(entry.contentType || '').toLowerCase().includes('text/html');
}

function safePathname(raw) {
  let pathname = decodeURIComponent(raw || '/');
  pathname = pathname.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = pathname.split('/').filter(Boolean).filter(part => part !== '.' && part !== '..');
  return parts.join('/');
}

function outputFor(rawUrl, entry) {
  const url = new URL(rawUrl);
  const sameSource = SOURCE_HOSTS.has(url.hostname);

  if (entry.isDocument && sameSource) {
    const clean = safePathname(url.pathname);
    return clean ? path.join(clean, 'index.html') : 'index.html';
  }

  if (sameSource && !url.search) {
    const clean = safePathname(url.pathname);
    const hasFileExtension = Boolean(path.extname(url.pathname));
    const isStaticPath = url.pathname.startsWith('/_next/') || hasFileExtension;
    if (!clean || !isStaticPath) return `__mirror/${sha(rawUrl)}${extFrom(entry, rawUrl)}`;
    return clean;
  }

  return `__mirror/${sha(rawUrl)}${extFrom(entry, rawUrl)}`;
}

const localPathByUrl = new Map();
for (const [rawUrl, entry] of Object.entries(entries)) {
  try {
    localPathByUrl.set(rawUrl, '/' + outputFor(rawUrl, entry).replaceAll(path.sep, '/'));
  } catch {}
}

function normalizeEmbeddedSource(value) {
  try {
    return new URL(value, 'https://www.aerodynamics.nl').href;
  } catch {
    return value;
  }
}

const nextImageVariantBySource = new Map();
for (const [rawUrl, localPath] of localPathByUrl.entries()) {
  try {
    const url = new URL(rawUrl);
    if (!SOURCE_HOSTS.has(url.hostname) || url.pathname !== '/_next/image') continue;
    const source = url.searchParams.get('url');
    if (!source) continue;
    const normalized = normalizeEmbeddedSource(source);
    if (!nextImageVariantBySource.has(normalized)) nextImageVariantBySource.set(normalized, localPath);
  } catch {}
}

const replacements = [];
function addReplacement(from, to) {
  if (!from) return;
  replacements.push([from, to]);
  if (from.includes('&')) replacements.push([from.replaceAll('&', '&amp;'), to]);
}

for (const [rawUrl, localPath] of localPathByUrl.entries()) {
  let url;
  try { url = new URL(rawUrl); } catch { continue; }

  addReplacement(rawUrl, localPath);
  addReplacement(rawUrl.replaceAll('/', '\\/'), localPath.replaceAll('/', '\\/'));

  if (SOURCE_HOSTS.has(url.hostname) && url.search) {
    const relative = `${url.pathname}${url.search}`;
    addReplacement(relative, localPath);
    addReplacement(relative.replaceAll('/', '\\/'), localPath.replaceAll('/', '\\/'));
  }

  if (!SOURCE_HOSTS.has(url.hostname)) {
    const protocolRelative = `//${url.host}${url.pathname}${url.search}`;
    addReplacement(protocolRelative, localPath);
  }
}

replacements.sort((a, b) => b[0].length - a[0].length);

function stripTrackingTags(html) {
  const hostPattern = DROP_HOST_PARTS.map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (!hostPattern) return html;
  const tag = new RegExp(`<(?:script|link|img|iframe)[^>]*(?:${hostPattern})[^>]*>(?:<\\/script>)?`, 'gi');
  return html.replace(tag, '');
}

function stripRemoteHints(html) {
  return html.replace(
    /<link\b(?=[^>]*\brel=["'](?:preconnect|dns-prefetch)["'])[^>]*\bhref=["'](?:https?:)?\/\/[^"']+["'][^>]*>/gi,
    ''
  );
}

function localizeText(text) {
  let out = text;
  for (const [from, to] of replacements) {
    if (from && out.includes(from)) out = out.split(from).join(to);
  }

  for (const origin of SOURCE_ORIGINS) {
    out = out.split(origin).join('');
    out = out.split(origin.replaceAll('/', '\\/')).join('');
  }
  out = out.split('//www.aerodynamics.nl').join('');
  out = out.split('//aerodynamics.nl').join('');
  return out;
}

function localizeUncapturedNextImages(html) {
  return html.replace(
    /\/_next\/image\?url=([^&"'\s<>]+)(?:&amp;|&)w=[^&"'\s<>]+(?:&amp;|&)q=[^&"'\s<>]+/gi,
    (full, encodedSource) => {
      let decoded;
      try { decoded = decodeURIComponent(encodedSource); } catch { return full; }
      const source = normalizeEmbeddedSource(decoded);
      return localPathByUrl.get(source) || nextImageVariantBySource.get(source) || full;
    }
  );
}

function cleanHtml(html) {
  let out = localizeText(html);
  out = localizeUncapturedNextImages(out);
  out = stripTrackingTags(out);
  out = stripRemoteHints(out);
  return out;
}

const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'">`;

const privacyPatch = `<style data-aero-privacy-patch>
[id*="cookie-banner" i],[class*="cookie-banner" i],[id*="cookie-consent" i],[class*="cookie-consent" i],[id*="consent-banner" i],[class*="consent-banner" i]{display:none!important;visibility:hidden!important;pointer-events:none!important}
</style><script data-aero-privacy-patch>(function(){
var needles=['we waarderen uw privacy','cookie instellingen'];
function removeBanner(){
  var nodes=document.querySelectorAll('div,section,aside,dialog');
  for(var i=0;i<nodes.length;i++){
    var n=nodes[i],t=(n.textContent||'').toLowerCase();
    if(!needles.some(function(x){return t.indexOf(x)!==-1}))continue;
    if(t.indexOf('accepteren')===-1&&t.indexOf('weigeren')===-1)continue;
    var candidate=n;
    while(candidate.parentElement&&candidate.parentElement!==document.body){
      var p=candidate.parentElement,pt=(p.textContent||'').toLowerCase();
      if(pt.indexOf('we waarderen uw privacy')===-1&&pt.indexOf('cookie instellingen')===-1)break;
      candidate=p;
    }
    candidate.remove();
  }
}
removeBanner();
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',removeBanner,{once:true});
new MutationObserver(removeBanner).observe(document.documentElement,{childList:true,subtree:true});
})();</script>`;

const navigationGuard = `<script data-aero-static-nav>(function(){document.addEventListener('click',function(e){if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;var h=a.getAttribute('href')||'';if(!h||h[0]==='#'||/^(mailto:|tel:|javascript:)/i.test(h)||a.target&&a.target!=='_self'||a.hasAttribute('download'))return;var u;try{u=new URL(a.href,location.href)}catch(_){return}if(u.origin!==location.origin)return;e.preventDefault();e.stopImmediatePropagation();location.assign(u.pathname+u.search+u.hash)},true)})();</script>`;

function prepareHtml(html) {
  let out = cleanHtml(html);
  const injected = `${csp}${privacyPatch}${navigationGuard}`;
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head([^>]*)>/i, `<head$1>${injected}`);
  else out = injected + out;
  return out;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

let written = 0;
let documents = 0;
for (const [rawUrl, entry] of Object.entries(entries)) {
  let destRel;
  try { destRel = outputFor(rawUrl, entry); } catch { continue; }
  const src = path.join(MIRROR, entry.file);
  const dest = path.join(OUT, destRel);
  await mkdir(path.dirname(dest), { recursive: true });

  if (isText(entry)) {
    let text = await readFile(src, 'utf8');
    if (isHtml(entry)) text = entry.isDocument ? prepareHtml(text) : cleanHtml(text);
    else text = localizeText(text);
    await writeFile(dest, text);
  } else {
    await copyFile(src, dest);
  }
  written++;
  if (entry.isDocument) documents++;
}

for (const [alias, target] of Object.entries(routes.aliases || {})) {
  const aliasPath = safePathname(alias);
  const dest = path.join(OUT, aliasPath, 'index.html');
  await mkdir(path.dirname(dest), { recursive: true });
  const targetEntry = entries[`https://www.aerodynamics.nl${target}`] || entries[`https://www.aerodynamics.nl${target}/`];
  if (targetEntry) {
    const html = prepareHtml(await readFile(path.join(MIRROR, targetEntry.file), 'utf8'));
    await writeFile(dest, html);
  } else {
    await writeFile(dest, `<!doctype html><meta charset="utf-8">${csp}<meta http-equiv="refresh" content="0;url=${target}"><script>location.replace(${JSON.stringify(target)})</script>`);
  }
}

const marker = {
  generatedAt: new Date().toISOString(),
  capturedAt: manifest.capturedAt,
  resources: written,
  documents,
  sourceRuntimeDependency: false,
  assetsLocalised: true,
  remoteSourceCallsBlocked: true,
  cookieBannerRemoved: true
};
await writeFile(path.join(OUT, '__static-replay.json'), JSON.stringify(marker, null, 2));

async function listFiles(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(full));
    else result.push(full);
  }
  return result;
}

const textExtensions = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.rsc', '.svg', '.xml', '.txt']);
const violations = [];
for (const file of await listFiles(OUT)) {
  if (!textExtensions.has(path.extname(file).toLowerCase())) continue;
  let text;
  try { text = await readFile(file, 'utf8'); } catch { continue; }
  const normalized = text.replaceAll('\\/', '/').toLowerCase();
  for (const host of FORBIDDEN_RUNTIME_HOSTS) {
    if (normalized.includes(`https://${host}`) || normalized.includes(`http://${host}`) || normalized.includes(`//${host}`)) {
      violations.push(`${path.relative(OUT, file)} -> ${host}`);
    }
  }
}
if (violations.length) {
  throw new Error(`Remote source references survived static localisation:\n${violations.slice(0, 50).join('\n')}`);
}

const indexPath = path.join(OUT, 'index.html');
const indexHtml = await readFile(indexPath, 'utf8');
if (!indexHtml.includes('data-aero-privacy-patch')) throw new Error('Cookie banner removal patch missing from homepage.');
if (!indexHtml.includes('Content-Security-Policy')) throw new Error('Runtime CSP missing from homepage.');
console.log(`Built fully-local static replay: ${documents} documents, ${written} captured resources. Zero source-site runtime URLs detected.`);
