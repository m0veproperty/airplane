import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', 'mirror');
const SOURCE_ORIGIN = 'https://www.aerodynamics.nl';
const manifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.json'), 'utf8'));
const entries = manifest.entries || {};

const rscIndex = new Map();
for (const [rawUrl, entry] of Object.entries(entries)) {
  if (!String(entry.contentType || '').startsWith('text/x-component')) continue;
  try {
    const url = new URL(rawUrl);
    const params = new URLSearchParams(url.search);
    params.delete('_rsc');
    const key = `${url.pathname}?${params.toString()}`;
    if (!rscIndex.has(key)) rscIndex.set(key, entry);
  } catch {}
}

function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

function incomingRequest(req) {
  const localOrigin = requestOrigin(req);
  const incoming = new URL(req.url || '/', localOrigin);
  let pathname = incoming.pathname;

  if (incoming.searchParams.has('path')) {
    const value = incoming.searchParams.get('path') || '';
    pathname = value ? `/${value.replace(/^\/+/, '')}` : '/';
    incoming.searchParams.delete('path');
  }

  // Versioned public prefix avoids previously cached immutable chunk redirects.
  if (pathname.startsWith('/_aero/')) pathname = '/_next/' + pathname.slice('/_aero/'.length);
  const query = incoming.searchParams.toString();
  return { localOrigin, pathname, search: query ? `?${query}` : '' };
}

function findEntry(req) {
  const { localOrigin, pathname, search } = incomingRequest(req);

  if (pathname.startsWith('/__external/')) {
    const rest = pathname.slice('/__external/'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return { entry: null, localOrigin };
    const host = rest.slice(0, slash);
    const externalPath = rest.slice(slash);
    const entry = entries[`https://${host}${externalPath}${search}`] ||
      entries[`https://${host}${externalPath}`] || null;
    return { entry, localOrigin };
  }

  const exact = `${SOURCE_ORIGIN}${pathname}${search}`;
  if (entries[exact]) return { entry: entries[exact], localOrigin };

  if (search) {
    const params = new URLSearchParams(search.slice(1));
    if (params.has('_rsc')) {
      params.delete('_rsc');
      const key = `${pathname}?${params.toString()}`;
      const entry = rscIndex.get(key);
      if (entry) return { entry, localOrigin };
    }
  }

  const noQuery = `${SOURCE_ORIGIN}${pathname}`;
  if (entries[noQuery]) return { entry: entries[noQuery], localOrigin };

  if (!path.extname(pathname)) {
    const slashUrl = `${SOURCE_ORIGIN}${pathname.endsWith('/') ? pathname : `${pathname}/`}`;
    if (entries[slashUrl]) return { entry: entries[slashUrl], localOrigin };
  }

  return { entry: null, localOrigin };
}

function staticPath(entry) {
  return `/__mirror_webgl1/${path.basename(entry.file)}`;
}

const replayCsp = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'"
].join('; ');

function setReplayHeaders(res, entry) {
  res.setHeader('content-type', entry.contentType || entry.headers?.['content-type'] || 'application/octet-stream');
  res.setHeader('cache-control', entry.isDocument ? 'no-store' : 'public, max-age=31536000, immutable');
  res.setHeader('x-aero-replay', 'local-capture');
  if (entry.isDocument) {
    res.setHeader('content-security-policy', replayCsp);
    res.setHeader('referrer-policy', 'no-referrer');
  }
}

function patchDocument(html) {
  const cookieKiller = `<style id="aero-cookie-killer">#ch-backdrop,#ch-banner{display:none!important;visibility:hidden!important;opacity:0!important;pointer-events:none!important}</style><script id="aero-cookie-killer-script">(function(){function kill(){var b=document.getElementById('ch-backdrop');if(b)b.remove();var n=document.getElementById('ch-banner');if(n)n.remove();if(document.documentElement)document.documentElement.style.removeProperty('overflow');if(document.body)document.body.style.removeProperty('overflow')}kill();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',kill,{once:true});new MutationObserver(kill).observe(document.documentElement,{childList:true,subtree:true})})();</script>`;

  if (html.includes('id="aero-cookie-killer"')) return html;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${cookieKiller}`);
  return cookieKiller + html;
}

export default async function handler(req, res) {
  const { entry, localOrigin } = findEntry(req);
  if (!entry) {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('x-aero-replay', 'local-capture');
    res.end(`Not captured: ${req.url}`);
    return;
  }

  const localBlobPath = staticPath(entry);

  // Keep the visible page URL unchanged. Documents are loaded only from the
  // captured local CDN blob and are patched before delivery. No source request
  // is made here or from the browser.
  if (entry.isDocument) {
    try {
      const response = await fetch(new URL(localBlobPath, localOrigin), { redirect: 'follow' });
      if (!response.ok) throw new Error(`Static replay blob returned ${response.status}`);
      const raw = Buffer.from(await response.arrayBuffer());
      const contentType = String(entry.contentType || entry.headers?.['content-type'] || '').toLowerCase();
      const body = contentType.includes('text/html') ? Buffer.from(patchDocument(raw.toString('utf8'))) : raw;
      res.statusCode = entry.status || 200;
      setReplayHeaders(res, entry);
      res.end(body);
      return;
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.setHeader('x-aero-replay', 'local-capture');
      res.end(error.stack || String(error));
      return;
    }
  }

  // Assets and captured RSC/data responses are immutable local CDN files.
  res.statusCode = 307;
  res.setHeader('location', localBlobPath);
  res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  res.setHeader('x-aero-replay', 'local-capture');
  res.end();
}
