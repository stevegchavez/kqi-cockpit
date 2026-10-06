/**
 * sw.js — NIU Companion offline support (service worker)
 *
 * - App files (same origin): network first, so an update on GitHub Pages shows up on the next
 *   load; the cached copy is used only when there is no connection.
 * - Map tiles from tile.openstreetmap.org: cache first, keeping only tiles you have already
 *   looked at (no bulk downloading, per the OSM tile policy), capped at MAX_TILES.
 * - Fonts: cached after first use.
 * - Place search and routing (Nominatim, routing.openstreetmap.de) are never cached: they pass
 *   straight through, so nothing you searched for is kept here.
 *
 * Scooter keys, rides and battery history are not touched by this file; they live in
 * localStorage / IndexedDB as before.
 *
 * Note: some in-app browsers (including, possibly, Bluefy on iOS) do not run service workers.
 * The app works the same without it; it just needs a connection to load.
 */
const VERSION = 'v1';
const APP_CACHE = `kqi-app-${VERSION}`;
const TILE_CACHE = `kqi-tiles-${VERSION}`;
const FONT_CACHE = `kqi-fonts-${VERSION}`;
const MAX_TILES = 1500;
const NETWORK_TIMEOUT_MS = 4000;

const APP_FILES = [
  './', 'index.html', 'manifest.json', 'css/style.css',
  'vendor/leaflet/leaflet.css', 'vendor/leaflet/leaflet.js',
  'js/constants.js', 'js/crypto.js', 'js/protocol.js', 'js/session.js', 'js/keystore.js', 'js/ble.js',
  'js/storage.js', 'js/insights.js', 'js/exporters.js', 'js/charts.js', 'js/battery.js', 'js/garage.js',
  'js/fields.js', 'js/diagnostics.js', 'js/diag-ui.js', 'js/planner.js', 'js/plan-ui.js', 'js/geo.js', 'js/app.js',
];

const isTile = (url) => /(^|\.)tile\.openstreetmap\.org$/.test(url.hostname);
const isFont = (url) => url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      // Fetch each file fresh; one missing file must not stop the rest from being cached.
      .then((cache) => Promise.all(APP_FILES.map((f) => cache.add(new Request(f, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  const keep = new Set([APP_CACHE, TILE_CACHE, FONT_CACHE]);
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith('kqi-') && !keep.has(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) event.respondWith(networkFirst(req));
  else if (isTile(url)) event.respondWith(cacheFirst(req, TILE_CACHE, MAX_TILES));
  else if (isFont(url)) event.respondWith(cacheFirst(req, FONT_CACHE, 50));
  // Anything else (place search, routing) is left alone: the browser fetches it normally.
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function networkFirst(req) {
  const cache = await caches.open(APP_CACHE);
  try {
    const res = await withTimeout(fetch(req), NETWORK_TIMEOUT_MS);
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await cache.match('index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

async function cacheFirst(req, name, max) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // Opaque (no-cors) tile responses have status 0 but are still usable images.
  if (res && (res.ok || res.type === 'opaque')) {
    await cache.put(req, res.clone()).catch(() => {});
    trim(cache, max);
  }
  return res;
}

/** Drops the oldest entries once a cache grows past `max` (keys come back in insertion order). */
async function trim(cache, max) {
  try {
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
  } catch { /* best effort */ }
}

// For tests (no effect in a browser, where `module` is undefined).
if (typeof module === 'object' && module.exports) module.exports = { APP_FILES, networkFirst, cacheFirst, trim, MAX_TILES, APP_CACHE, TILE_CACHE };
