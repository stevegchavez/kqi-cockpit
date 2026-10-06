/**
 * sw.test.js — run with: node test/sw.test.js
 * Runs the service worker against a fake Cache Storage and a fake network.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n    ${err.stack}`); process.exitCode = 1; }
}

// ---- fakes ----
const ORIGIN = 'https://example.github.io';
class FakeCache {
  constructor() { this.m = new Map(); }
  key(r) { return typeof r === 'string' ? new URL(r, ORIGIN + '/kqi/').href : r.url; }
  async match(r, opts) {
    let k = this.key(r);
    if (opts && opts.ignoreSearch) k = k.split('?')[0];
    for (const [kk, v] of this.m) if ((opts && opts.ignoreSearch ? kk.split('?')[0] : kk) === k) return v.clone();
    return undefined;
  }
  async put(r, res) { this.m.set(this.key(r), res); }
  async add(r) { const res = await global.fetch(r); if (!res.ok) throw new Error('bad'); this.m.set(this.key(r), res); }
  async keys() { return [...this.m.keys()].map((u) => new Request(u)); }
  async delete(r) { return this.m.delete(this.key(r)); }
}
// Browsers resolve relative URLs against the worker's location; Node's Request needs that done for it.
const NodeRequest = global.Request;
global.Request = class extends NodeRequest { constructor(u, o) { super(typeof u === 'string' ? new URL(u, ORIGIN + '/kqi/').href : u, o); } };
const stores = new Map();
global.caches = {
  async open(n) { if (!stores.has(n)) stores.set(n, new FakeCache()); return stores.get(n); },
  async keys() { return [...stores.keys()]; },
  async delete(n) { return stores.delete(n); },
};
const handlers = {};
global.self = {
  location: { origin: ORIGIN },
  addEventListener: (t, fn) => { handlers[t] = fn; },
  skipWaiting: async () => {},
  clients: { claim: async () => {} },
};
let online = true;
const hits = [];
global.fetch = async (req) => {
  const url = typeof req === 'string' ? new URL(req, ORIGIN + '/kqi/').href : req.url;
  hits.push(url);
  if (!online) throw new TypeError('Failed to fetch');
  if (url.endsWith('missing.js')) return new Response('nope', { status: 404 });
  return new Response(`body of ${url}`, { status: 200 });
};
const SW = require('../sw.js');

function fetchEvent(url, extra) {
  // A navigation request can't be built with Node's Request, so it is a plain look-alike.
  const request = extra && extra.mode === 'navigate' ? { url, method: 'GET', mode: 'navigate' } : new Request(url, extra);
  const ev = { request, responded: null, respondWith(p) { this.responded = p; } };
  handlers.fetch(ev);
  return ev;
}

(async () => {
  console.log('sw (offline support)\n');

  await test('the precache list matches the scripts and styles index.html loads', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const local = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^https?:|^#/.test(u));
    for (const f of local) assert.ok(SW.APP_FILES.includes(f), `${f} is loaded by the page but not precached`);
    for (const f of SW.APP_FILES) if (f !== './') assert.ok(fs.existsSync(path.join(__dirname, '..', f)), `${f} does not exist`);
  });

  await test('install precaches the app; a missing file does not break it', async () => {
    const waits = [];
    const saved = SW.APP_FILES.slice();
    SW.APP_FILES.push('js/missing.js');
    handlers.install({ waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    SW.APP_FILES.length = 0; SW.APP_FILES.push(...saved);
    const cache = await caches.open(SW.APP_CACHE);
    assert.ok(await cache.match('js/app.js'));
    assert.ok(await cache.match('index.html'));
    assert.strictEqual(await cache.match('js/missing.js'), undefined);
  });

  await test('app files: network first when online (so updates show), cache when offline', async () => {
    online = true;
    const r1 = await fetchEvent(`${ORIGIN}/kqi/js/app.js?v=2`).responded;
    assert.match(await r1.text(), /body of .*app\.js\?v=2/);
    online = false;
    const r2 = await fetchEvent(`${ORIGIN}/kqi/js/app.js?v=3`).responded;
    assert.ok(r2, 'served from cache offline');
    online = true;
  });

  await test('offline navigation to an unknown page falls back to the app shell', async () => {
    online = false;
    const res = await fetchEvent(`${ORIGIN}/kqi/somewhere`, { mode: 'navigate' }).responded;
    assert.match(await res.text(), /index\.html/);
    online = true;
  });

  await test('map tiles: cache first, so viewed tiles work offline', async () => {
    const url = 'https://a.tile.openstreetmap.org/15/5000/12000.png';
    hits.length = 0;
    await fetchEvent(url).responded;
    online = false;
    const res = await fetchEvent(url).responded;
    assert.match(await res.text(), /12000\.png/);
    assert.strictEqual(hits.filter((h) => h === url).length, 1, 'fetched once, then from cache');
    online = true;
  });

  await test('place search and routing are never intercepted or cached', () => {
    for (const u of ['https://nominatim.openstreetmap.org/search?q=home', 'https://routing.openstreetmap.de/routed-bike/route/v1/driving/1,2;3,4']) {
      const ev = fetchEvent(u);
      assert.strictEqual(ev.responded, null, `${u} should pass straight through`);
    }
  });

  await test('the tile cache is capped, dropping the oldest tiles', async () => {
    const cache = new FakeCache();
    for (let i = 0; i < 12; i++) await cache.put(`https://a.tile.openstreetmap.org/1/1/${i}.png`, new Response('x'));
    await SW.trim(cache, 10);
    const keys = (await cache.keys()).map((r) => r.url);
    assert.strictEqual(keys.length, 10);
    assert.ok(keys[0].endsWith('/2.png'), 'the two oldest are gone');
  });

  await test('activate deletes old versions of this app\'s caches only', async () => {
    await caches.open('kqi-app-v0');
    await caches.open('someone-else');
    const waits = [];
    handlers.activate({ waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    const names = await caches.keys();
    assert.ok(!names.includes('kqi-app-v0'));
    assert.ok(names.includes('someone-else'));
    assert.ok(names.includes(SW.APP_CACHE));
  });

  await test('non-GET requests are left alone', () => {
    const ev = { request: new Request(`${ORIGIN}/kqi/x`, { method: 'POST' }), responded: null, respondWith(p) { this.responded = p; } };
    handlers.fetch(ev);
    assert.strictEqual(ev.responded, null);
  });

  console.log(`\n${passed} passed`);
})();
