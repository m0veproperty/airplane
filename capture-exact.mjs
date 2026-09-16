import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const START_URL = 'https://www.aerodynamics.nl/';
const OUT = path.resolve('mirror');
const CONCURRENCY = 4;
const SAME_SITE_HOSTS = new Set(['www.aerodynamics.nl', 'aerodynamics.nl']);
const SKIP_HOST_PARTS = [
  'google-analytics', 'googletagmanager', 'doubleclick', 'facebook.net',
  'hotjar', 'clarity.ms', 'linkedin.com', 'instagram.com'
];

await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(OUT, 'blobs'), { recursive: true });

const routes = JSON.parse(await readFile('routes.json', 'utf8'));
const targetPaths = [...new Set(['/', ...(routes.pages || [])])];
const queue = targetPaths.map(route => new URL(route, START_URL).href);
const manifest = {
  startUrl: START_URL,
  capturedAt: new Date().toISOString(),
  mode: 'hydrated-browser-local-mirror',
  entries: {},
  pages: []
};
const pendingSaves = new Set();
const savingUrls = new Map();
let completedPages = 0;

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function extFrom(contentType = '', url = '') {
  const ct = contentType.toLowerCase();
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
    const ext = path.extname(new URL(url).pathname);
    return ext && ext.length <= 10 ? ext : '.bin';
  } catch {
    return '.bin';
  }
}

function shouldCapture(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (SKIP_HOST_PARTS.some(part => url.hostname.includes(part))) return false;
  return SAME_SITE_HOSTS.has(url.hostname) || url.hostname.endsWith('.digitaloceanspaces.com');
}

function cleanHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) =>
    ![
      'content-security-policy', 'content-security-policy-report-only',
      'content-encoding', 'content-length', 'transfer-encoding', 'set-cookie'
    ].includes(key.toLowerCase())
  ));
}

function track(promise) {
  pendingSaves.add(promise);
  promise.finally(() => pendingSaves.delete(promise));
  return promise;
}

function saveResponse(response) {
  if (!response) return Promise.resolve();
  const url = response.url();
  if (!shouldCapture(url) || manifest.entries[url]) return Promise.resolve();
  if (savingUrls.has(url)) return savingUrls.get(url);

  const promise = (async () => {
    let body;
    try { body = await response.body(); } catch { return; }
    const headers = await response.allHeaders();
    const contentType = headers['content-type'] || '';
    const file = `blobs/${sha(url)}${extFrom(contentType, url)}`;
    await writeFile(path.join(OUT, file), body);
    manifest.entries[url] = {
      file,
      status: response.status(),
      contentType,
      headers: cleanHeaders(headers)
    };
  })().finally(() => savingUrls.delete(url));

  savingUrls.set(url, promise);
  return track(promise);
}

async function fetchReferencedUrl(rawUrl) {
  if (!shouldCapture(rawUrl) || manifest.entries[rawUrl]) return;
  if (savingUrls.has(rawUrl)) return savingUrls.get(rawUrl);

  const promise = (async () => {
    let response;
    try {
      response = await context.request.get(rawUrl, { timeout: 30000, failOnStatusCode: false });
    } catch {
      return;
    }
    if (!response.ok()) return;
    const body = await response.body();
    const headers = response.headers();
    const contentType = headers['content-type'] || '';
    const file = `blobs/${sha(rawUrl)}${extFrom(contentType, rawUrl)}`;
    await writeFile(path.join(OUT, file), body);
    manifest.entries[rawUrl] = {
      file,
      status: response.status(),
      contentType,
      headers: cleanHeaders(headers)
    };
  })().finally(() => savingUrls.delete(rawUrl));

  savingUrls.set(rawUrl, promise);
  return track(promise);
}

function normalizeHtmlAttributeValue(value = '') {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&#38;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function extractReferencedUrlsFromHtml(html, baseUrl) {
  const urls = new Set();
  const add = value => {
    value = normalizeHtmlAttributeValue(String(value || '').trim());
    if (!value || /^(data:|blob:|mailto:|tel:|javascript:|#)/i.test(value)) return;
    try { urls.add(new URL(value, baseUrl).href); } catch {}
  };

  const attrPattern = /\b(src|href|poster|data|srcset)\s*=\s*(["'])(.*?)\2/gis;
  for (const match of html.matchAll(attrPattern)) {
    const name = match[1].toLowerCase();
    const value = match[3];
    if (name !== 'srcset') {
      add(value);
      continue;
    }
    for (const candidate of normalizeHtmlAttributeValue(value).split(',')) {
      add(candidate.trim().split(/\s+/)[0]);
    }
  }
  return [...urls];
}

async function collectReferencedUrls(page) {
  return page.evaluate(() => {
    const urls = new Set();
    const add = value => {
      if (!value || /^(data:|blob:|mailto:|tel:|javascript:|#)/i.test(value)) return;
      try { urls.add(new URL(value, location.href).href); } catch {}
    };

    for (const el of document.querySelectorAll('[src],[href],[poster],[data],[srcset]')) {
      for (const attr of ['src', 'href', 'poster', 'data']) add(el.getAttribute(attr));
      const srcset = el.getAttribute('srcset');
      if (srcset) {
        for (const candidate of srcset.split(',')) {
          const value = candidate.trim().split(/\s+/)[0];
          add(value);
        }
      }
    }
    return [...urls];
  });
}

async function captureStoredHtmlReferences() {
  const processed = new Set();
  let pass = 0;

  while (pass < 4) {
    pass++;
    const htmlEntries = Object.entries(manifest.entries).filter(([rawUrl, entry]) =>
      !processed.has(rawUrl) && String(entry.contentType || '').toLowerCase().includes('text/html')
    );
    if (!htmlEntries.length) break;

    const discovered = new Set();
    for (const [rawUrl, entry] of htmlEntries) {
      processed.add(rawUrl);
      let html;
      try { html = await readFile(path.join(OUT, entry.file), 'utf8'); } catch { continue; }
      for (const url of extractReferencedUrlsFromHtml(html, rawUrl)) {
        if (shouldCapture(url) && !manifest.entries[url]) discovered.add(url);
      }
    }

    if (!discovered.size) break;
    console.log(`Stored HTML reference pass ${pass}: capturing ${discovered.size} additional local resources.`);
    await Promise.all([...discovered].map(fetchReferencedUrl));
    while (pendingSaves.size) await Promise.all([...pendingSaves]);
  }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let total = 0;
      const step = Math.max(500, Math.floor(innerHeight * 0.75));
      const timer = setInterval(() => {
        scrollBy(0, step);
        total += step;
        if (total >= document.documentElement.scrollHeight + innerHeight) {
          clearInterval(timer);
          scrollTo(0, 0);
          setTimeout(resolve, 700);
        }
      }, 180);
    });
  });
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1728, height: 972 },
  deviceScaleFactor: 1,
  locale: 'nl-NL',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/139.0.0.0 Safari/537.36'
});

async function capturePage(current) {
  const page = await context.newPage();
  page.on('response', response => saveResponse(response).catch(() => {}));

  try {
    await page.goto(current, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1800);
    await autoScroll(page);
    await page.waitForTimeout(1200);

    const referencedUrls = await collectReferencedUrls(page);
    await Promise.all(referencedUrls.filter(shouldCapture).map(fetchReferencedUrl));

    const html = await page.content();
    const documentUrl = page.url();
    const documentFile = `blobs/${sha(documentUrl + '#document')}.html`;
    await writeFile(path.join(OUT, documentFile), html, 'utf8');
    manifest.entries[documentUrl] = {
      ...(manifest.entries[documentUrl] || {}),
      file: documentFile,
      status: 200,
      contentType: 'text/html; charset=utf-8',
      isDocument: true,
      headers: {}
    };
    if (!manifest.pages.includes(documentUrl)) manifest.pages.push(documentUrl);
  } catch (error) {
    console.warn(`Skipped ${current}: ${error.message}`);
  } finally {
    completedPages++;
    console.log(`[${completedPages}/${targetPaths.length}] ${current}`);
    await page.close();
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const current = queue.shift();
    if (current) await capturePage(current);
  }
}));

while (pendingSaves.size) await Promise.all([...pendingSaves]);
await captureStoredHtmlReferences();
while (pendingSaves.size) await Promise.all([...pendingSaves]);
await context.close();
await browser.close();

manifest.pages.sort();
await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Captured ${Object.keys(manifest.entries).length} local resources across ${manifest.pages.length} pages.`);
