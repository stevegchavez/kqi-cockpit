/**
 * dom-wiring.test.js — run with: node test/dom-wiring.test.js
 *
 * Loads the real index.html + all real js/*.js files into jsdom and boots
 * app.js exactly as a browser would, to catch mismatched element IDs,
 * undefined globals, or syntax errors that a code read-through can miss.
 * Network-dependent bits (Leaflet CDN, Web Bluetooth, geolocation) are
 * stubbed since this environment has neither a browser network nor real
 * hardware — this test is about wiring correctness, not live BLE/GPS.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');
require('fake-indexeddb/auto');
const { IDBFactory, IDBKeyRange: FakeIDBKeyRange } = require('fake-indexeddb');
const { FakeScooter, defaultFields } = require('./helpers/fake-scooter.js');
const { fakeBluetooth } = require('./helpers/fake-bluetooth.js');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const dom = new JSDOM(html, {
  url: 'https://example.com/index.html',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

// jsdom has no IndexedDB of its own — hand it the fake-indexeddb globals
// that were installed onto the Node global scope above.
window.indexedDB = global.indexedDB;
window.IDBKeyRange = global.IDBKeyRange;

// Stub Leaflet since the real library loads from a CDN this sandbox can't
// reach; app.js only calls L.map/L.tileLayer/L.polyline/L.circleMarker
// inside openRideDetail(), which this smoke test doesn't invoke.
window.L = {
  map: () => ({ remove() {}, setView() { return this; }, fitBounds() {} }),
  tileLayer: () => ({ addTo() { return this; } }),
  polyline: () => ({ addTo() { return this; }, getBounds() { return {}; } }),
  circleMarker: () => ({ addTo() { return this; } }),
};

// localStorage exists in jsdom by default; navigator.bluetooth /
// navigator.geolocation intentionally stay undefined, matching a real
// desktop browser without BLE/GPS — app.js is expected to degrade
// gracefully rather than throw.

const files = ['constants.js', 'crypto.js', 'protocol.js', 'session.js', 'keystore.js', 'ble.js', 'storage.js', 'insights.js', 'exporters.js', 'charts.js', 'battery.js', 'fields.js', 'diagnostics.js', 'diag-ui.js', 'geo.js', 'app.js'];

let passed = 0;
const queue = [];
// Tests are queued and awaited one at a time, so a failing assertion inside an
// async test is reported instead of becoming an unhandled rejection.
function test(name, fn) { queue.push({ name, fn }); }

console.log('dom-wiring (index.html + js/*.js under jsdom)\n');

test('every js/*.js file executes in the page context without throwing', () => {
  for (const file of files) {
    const code = fs.readFileSync(path.join(root, 'js', file), 'utf8');
    window.eval(code);
  }
});

test('NIU namespace is fully populated after boot', () => {
  assert.ok(window.NIU, 'window.NIU should exist');
  for (const key of ['BLE_CONSTANTS', 'Crypto', 'Protocol', 'Session', 'KeyStore', 'BLEManager', 'RideStore', 'GeoTracker', 'Insights', 'Exporters', 'Charts', 'Battery', 'Fields', 'Diagnostics', 'DiagUI']) {
    assert.ok(window.NIU[key], `window.NIU.${key} should be defined`);
  }
});

test('every element ID referenced by app.js exists in index.html', () => {
  const appJs = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
  const ids = [...appJs.matchAll(/el\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length > 10, 'expected app.js to reference a meaningful number of element IDs');
  const missing = ids.filter((id) => !window.document.getElementById(id));
  assert.deepStrictEqual(missing, [], `missing element IDs referenced by app.js: ${missing.join(', ')}`);
});

test('cockpit UI reflects an unsupported-Bluetooth browser correctly', () => {
  const dotEl = window.document.getElementById('statusDot');
  assert.strictEqual(dotEl.className, 'dot unsupported');
  const connectBtn = window.document.getElementById('connectBtn');
  assert.strictEqual(connectBtn.disabled, true);
});

test('tab bar switches the active screen', () => {
  const ridesTabBtn = [...window.document.querySelectorAll('.tab-btn')]
    .find((b) => b.dataset.target === 'ridesScreen');
  ridesTabBtn.click();
  assert.ok(window.document.getElementById('ridesScreen').classList.contains('active'));
  assert.ok(!window.document.getElementById('cockpitScreen').classList.contains('active'));
});

test('simulate-telemetry demo mode updates the speed readout without a scooter', async () => {
  window.document.getElementById('demoToggleBtn').click();
  await new Promise((resolve) => window.setTimeout(resolve, 900));
  const speed = parseInt(window.document.getElementById('speedValue').textContent, 10);
  assert.ok(speed >= 0 && speed < 200, `expected a plausible simulated MPH value, got ${speed}`);
  window.document.getElementById('demoToggleBtn').click(); // stop the interval so the process can exit
});

test('unit toggle switches label between MPH and KM/H', () => {
  const before = window.document.getElementById('speedUnit').textContent;
  window.document.getElementById('unitToggle').click();
  const after = window.document.getElementById('speedUnit').textContent;
  assert.notStrictEqual(before, after);
});

test('gauge initializes with a track path, a value path, and tick marks', () => {
  const track = window.document.getElementById('gaugeTrack');
  const value = window.document.getElementById('gaugeValue');
  const ticks = window.document.getElementById('gaugeTicks');
  assert.ok(track.getAttribute('d'), 'gauge track should have a computed arc path');
  assert.ok(value.getAttribute('d'), 'gauge value should have a computed arc path');
  assert.strictEqual(ticks.children.length, 11, 'expected 11 tick marks around the gauge');
});

test('battery cell strip renders 10 segments after simulated telemetry', () => {
  window.document.getElementById('demoToggleBtn').click(); // start
  const cells = window.document.getElementById('cellStrip').children;
  assert.strictEqual(cells.length, 10);
  window.document.getElementById('demoToggleBtn').click(); // stop, cleanup interval
});

test('there are no controls that change the scooter (read-only app)', () => {
  const d = window.document;
  assert.strictEqual(d.getElementById('headlightBtn'), null);
  assert.strictEqual(d.getElementById('lockBtn'), null);
  assert.strictEqual(d.querySelectorAll('.rocker, .switch').length, 0);
});

test('page loads no third-party script (the scooter keys live in this origin\'s localStorage)', () => {
  const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.length >= 8, `expected the app scripts, found ${srcs.length}`);
  const external = srcs.filter((u) => /^(https?:)?\/\//i.test(u));
  assert.deepStrictEqual(external, [], `external scripts found: ${external.join(', ')}`);
  for (const u of srcs) assert.ok(fs.existsSync(path.join(root, u)), `script ${u} must exist in the repo`);
});

test('every script the page loads exists, and every module the tests load is on the page', () => {
  for (const f of files) assert.ok(html.includes(`js/${f}`), `index.html must load js/${f}`);
});

test('info strip shows battery health, power state, max speed and charge cycles after (simulated) telemetry', async () => {
  const d = window.document;
  d.getElementById('demoToggleBtn').click();
  await new Promise((resolve) => window.setTimeout(resolve, 700));
  assert.strictEqual(d.getElementById('healthVal').textContent, '93%');
  assert.strictEqual(d.getElementById('powerVal').textContent, 'ON');
  assert.ok(d.getElementById('powerVal').classList.contains('on'));
  const unit = d.getElementById('speedUnit').textContent;
  const expected = unit === 'MPH' ? '19' : '30';   // 30 km/h
  assert.strictEqual(d.getElementById('maxSpeedVal').textContent, expected);
  assert.strictEqual(d.getElementById('cyclesVal').textContent, '151');
  d.getElementById('demoToggleBtn').click();       // stop the interval
});

test('Setup: invalid keys show an error that does not echo the secret', () => {
  const d = window.document;
  const secret = 'SUPERSECRET12345';
  d.getElementById('keysInput').value = `${secret}\nnope`;
  d.getElementById('saveKeysBtn').click();
  const status = d.getElementById('keysStatus');
  assert.ok(status.classList.contains('err'));
  assert.ok(!status.textContent.includes(secret), 'status text must not contain key material');
  assert.strictEqual(window.NIU.KeyStore.has(), false);
});

test('Setup: valid keys are stored, the textarea is cleared, and keys can be removed', () => {
  const d = window.document;
  d.getElementById('keysInput').value = '0123456789abcdef\nfedcba9876543210';
  d.getElementById('saveKeysBtn').click();
  assert.strictEqual(window.NIU.KeyStore.has(), true);
  assert.strictEqual(d.getElementById('keysInput').value, '', 'secrets must not stay on screen');
  assert.strictEqual(d.getElementById('keysStatus').textContent, 'Keys saved on this device');
  d.getElementById('clearKeysBtn').click();
  assert.strictEqual(window.NIU.KeyStore.has(), false);
  assert.strictEqual(d.getElementById('keysStatus').textContent, 'No keys saved');
});

test('Setup tab is reachable from the tab bar', () => {
  const setupTab = [...window.document.querySelectorAll('.tab-btn')].find((b) => b.dataset.target === 'setupScreen');
  assert.ok(setupTab, 'expected a Setup tab');
  setupTab.click();
  assert.ok(window.document.getElementById('setupScreen').classList.contains('active'));
});

// ---- A second page WITH a stubbed Web Bluetooth, to test the Connect button's key handling.
async function bootWithBluetooth() {
  const dom2 = new JSDOM(html, { url: 'https://example.com/index.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom2.window;
  w.indexedDB = global.indexedDB;
  w.IDBKeyRange = global.IDBKeyRange;
  w.L = window.L;
  const calls = [];
  Object.defineProperty(w.navigator, 'bluetooth', {
    value: { requestDevice: async (o) => { calls.push(o); throw Object.assign(new Error('User cancelled the requestDevice() chooser.'), { name: 'NotFoundError' }); } },
  });
  for (const file of files) w.eval(fs.readFileSync(path.join(root, 'js', file), 'utf8'));
  return { w, calls };
}

test('Connect without saved keys sends the rider to Setup and never opens the Bluetooth picker', async () => {
  const { w, calls } = await bootWithBluetooth();
  const d = w.document;
  assert.strictEqual(d.getElementById('connectBtn').disabled, false);
  d.getElementById('connectBtn').click();
  await new Promise((resolve) => w.setTimeout(resolve, 50));
  assert.ok(d.getElementById('setupScreen').classList.contains('active'), 'should switch to Setup');
  assert.strictEqual(calls.length, 0, 'requestDevice must not be called without keys');
  assert.match(d.getElementById('toast').textContent, /Add your scooter keys/);
  w.close();
});

test('Connect with saved keys opens the picker, and cancelling it shows a friendly message', async () => {
  const { w, calls } = await bootWithBluetooth();
  const d = w.document;
  d.getElementById('keysInput').value = '0123456789abcdef\nfedcba9876543210';
  d.getElementById('saveKeysBtn').click();
  d.querySelector('.tab-btn[data-target="cockpitScreen"]').click();
  d.getElementById('connectBtn').click();
  await new Promise((resolve) => w.setTimeout(resolve, 50));
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(JSON.stringify(calls[0].filters[0]), '{"namePrefix":"NIU"}');   // JSON: object comes from jsdom's realm
  assert.match(d.getElementById('toast').textContent, /No scooter selected/);
  assert.strictEqual(d.getElementById('statusDot').className, 'dot disconnected');
  w.close();
});


// =====================================================================
// End-to-end: the real page, real app.js and real modules, talking to a
// simulated scooter through a fake Web Bluetooth, with fake GPS.
// Each test boots its own window with its own empty IndexedDB.
// =====================================================================
const PWD = '0123456789abcdef';
const AES = 'fedcba9876543210';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await wait(25); }
  throw new Error(`timed out waiting for ${what}`);
}

function bootApp({ bluetooth = true, keys = true, extraFields = null } = {}) {
  const w = new JSDOM(html, { url: 'https://example.com/index.html', runScripts: 'outside-only', pretendToBeVisual: true }).window;
  w.indexedDB = new IDBFactory();           // private, empty database per window
  w.IDBKeyRange = FakeIDBKeyRange;
  const leaflet = { polylines: [] };
  w.L = {
    map: () => ({ remove() {}, setView() { return this; }, fitBounds() {} }),
    tileLayer: () => ({ addTo() { return this; } }),
    polyline: (latlngs, opts) => { leaflet.polylines.push({ latlngs, opts }); return { addTo() { return this; } }; },
    circleMarker: () => ({ addTo() { return this; } }),
    latLngBounds: (l) => l,
  };
  const geo = {
    cb: null,
    watchPosition(ok) { this.cb = ok; return 1; },
    clearWatch() { this.cb = null; },
    emit(lat, lon, t, alt) { if (this.cb) this.cb({ coords: { latitude: lat, longitude: lon, accuracy: 5, altitude: alt, speed: 5 }, timestamp: t }); },
  };
  Object.defineProperty(w.navigator, 'geolocation', { value: geo });
  const shared = [];
  Object.defineProperty(w.navigator, 'canShare', { value: () => true });
  Object.defineProperty(w.navigator, 'share', { value: async (d) => { shared.push(d); } });
  let scooter = null;
  if (bluetooth) {
    scooter = new FakeScooter({ password: PWD, aesKey: AES, fields: Object.assign(defaultFields(), extraFields || {}) });
    Object.defineProperty(w.navigator, 'bluetooth', { value: fakeBluetooth(scooter).bluetooth });
  }
  for (const file of files) w.eval(fs.readFileSync(path.join(root, 'js', file), 'utf8'));
  if (keys) w.NIU.KeyStore.save({ password: PWD, aes: AES });
  const $ = (id) => w.document.getElementById(id);
  const tab = (target) => w.document.querySelector(`.tab-btn[data-target="${target}"]`).click();
  return { w, $, tab, geo, scooter, shared, leaflet };
}
async function connect(app) {
  app.$('connectBtn').click();
  await until(() => app.$('batteryPct').textContent === '59%' && app.$('cyclesVal').textContent === '151', 'the scooter to connect and report');
}

test('E2E: connecting shows live battery, health, power, top speed and charge cycles', async () => {
  const app = bootApp();
  await connect(app);
  assert.strictEqual(app.$('healthVal').textContent, '93%');
  assert.strictEqual(app.$('powerVal').textContent, 'ON');
  assert.strictEqual(app.$('maxSpeedVal').textContent, '19');       // 30 km/h in mph
  assert.strictEqual(app.$('cyclesVal').textContent, '151');
  assert.strictEqual(app.$('statusDot').className, 'dot connected');
  app.w.close();
});

test('E2E: a real connection records battery history, and the Battery tab shows it', async () => {
  const app = bootApp();
  await connect(app);
  await until(async () => (await new app.w.NIU.Battery.BatteryStore().count()) >= 1, 'a battery sample to be stored');
  const samples = await new app.w.NIU.Battery.BatteryStore().all();
  assert.deepStrictEqual({ soc: samples[0].soc, soh: samples[0].soh, cycles: samples[0].cycles, on: samples[0].on },
    { soc: 59, soh: 93, cycles: 151, on: true });
  app.tab('batteryScreen');
  await until(() => app.$('batteryBody').style.display === 'block', 'the Battery screen to render');
  assert.strictEqual(app.$('bHealth').textContent, '93%');
  assert.strictEqual(app.$('bCycles').textContent, '151');
  assert.ok(app.$('socChart').innerHTML.includes('<svg'), 'battery level chart should be drawn');
  assert.match(app.$('healthTrend').textContent, /Not enough data/);
  assert.strictEqual(app.$('chargesList').children[0].className, 'none');
  app.w.close();
});

test('E2E: demo mode never writes to the battery history or leaks into real data', async () => {
  const app = bootApp({ bluetooth: false });
  app.$('demoToggleBtn').click();
  await wait(900);
  app.$('demoToggleBtn').click();
  assert.strictEqual(await new app.w.NIU.Battery.BatteryStore().count(), 0, 'simulated telemetry must not be logged');
  app.tab('batteryScreen');
  await wait(100);
  assert.strictEqual(app.$('batteryEmpty').style.display, 'block');
  app.w.close();
});

test('E2E: a ride records battery at start and end, shows insights, and exports GPX/CSV', async () => {
  const app = bootApp();
  await connect(app);
  app.$('rideBtn').click();
  assert.ok(app.geo.cb, 'ride should start GPS tracking');
  const t0 = Date.now();
  for (let i = 0; i < 12; i++) app.geo.emit(33.77 + i * 0.00005, -118.19, t0 + i * 1000, 10 + i * 2);   // ~5.5 m per second, climbing
  app.scooter.fields['31001C'].value = 53;                                         // battery drops while riding
  await until(() => app.$('batteryPct').textContent === '53%', 'the new battery level');
  app.$('rideBtn').click();
  const store = new app.w.NIU.RideStore();
  await until(async () => (await store.getAllRides()).length === 1, 'the ride to be saved');
  const [ride] = await store.getAllRides();
  assert.strictEqual(ride.startSOC, 59);
  assert.strictEqual(ride.endSOC, 53);
  assert.strictEqual(ride.simulated, false);
  assert.ok(ride.points.length >= 10);

  app.tab('ridesScreen');
  await until(() => app.w.document.querySelector('.ride-row'), 'the ride row');
  app.w.document.querySelector('.ride-row').click();
  const rows = [...app.$('detailInsights').children].map((li) => li.children[0].textContent + '|' + li.children[1].textContent);
  assert.ok(rows.some((r) => r.startsWith('Battery used|6% (59% → 53%)')), rows.join(' ; '));
  assert.ok(rows.some((r) => r.startsWith('Elevation|↑')), 'elevation should be listed: ' + rows.join(' ; '));
  assert.ok(app.leaflet.polylines.length >= 1, 'the route should be drawn');
  assert.ok(app.leaflet.polylines.every((p) => /^#[0-9a-f]{6}$/i.test(p.opts.color)), 'route segments are coloured by speed');

  app.$('exportGpxBtn').click();
  await until(() => app.shared.length === 1, 'GPX share');
  assert.match(app.shared[0].files[0].name, /^niu-ride-\d{8}T\d{6}Z\.gpx$/);
  assert.strictEqual(app.shared[0].files[0].type, 'application/gpx+xml');
  assert.ok(app.shared[0].files[0].size > 200);
  app.$('exportCsvBtn').click();
  await until(() => app.shared.length === 2, 'CSV share');
  assert.match(app.shared[1].files[0].name, /\.csv$/);
  app.w.close();
});

test('E2E: the range estimate learns from real rides only, and ignores simulated ones', async () => {
  const app = bootApp();
  const store = new app.w.NIU.RideStore();
  const mi = 1609.344;
  const mk = (i, extra) => ({ id: `r${i}`, startDate: 1_000_000 + i, endDate: 1_000_500 + i, distanceMeters: 2 * mi, topSpeedKPH: 20,
    averageSpeedKPH: 15, activeRidingSeconds: 500, points: [], startSOC: 90, endSOC: 82, simulated: false, ...extra });
  for (let i = 1; i <= 3; i++) await store.saveRide(mk(i));
  await store.saveRide(mk(9, { simulated: true, distanceMeters: 50 * mi }));      // would wreck the estimate if counted
  app.tab('ridesScreen');
  await until(() => app.w.document.querySelectorAll('.ride-row').length === 4, 'seeded rides');
  assert.ok(!/after a few rides/.test(app.$('rangeLine').textContent), 'rides exist, so it must not say it is still learning');
  assert.match(app.$('rangeLine').textContent, /Typically 0\.25 mi per 1% battery/);
  await connect(app);
  assert.match(app.$('rangeLine').textContent, /≈ 14\.8 mi left/);              // 59% x 0.25 mi/%
  assert.match(app.$('rangeLine').textContent, /from 3 rides/);
  assert.ok(!app.$('rangeLine').textContent.includes('rough'));
  app.$('unitToggle').click();                                                       // -> km
  assert.match(app.$('rangeLine').textContent, /≈ 23\.7 km left/);
  app.w.close();
});

test('Battery tab: two taps are needed to clear history', async () => {
  const app = bootApp({ bluetooth: false });
  const b = new app.w.NIU.Battery.BatteryStore();
  const now = Date.now();
  await b.add({ t: now - 3600000, soc: 60, soh: 93, cycles: 150 });
  await b.add({ t: now - 60000, soc: 55, soh: 93, cycles: 151 });
  app.tab('batteryScreen');
  await until(() => app.$('batteryBody').style.display === 'block', 'history to render');
  app.$('clearBatteryBtn').click();
  assert.strictEqual(app.$('clearBatteryBtn').textContent, 'Tap again to delete');
  assert.strictEqual(await b.count(), 2, 'one tap must not delete anything');
  app.$('clearBatteryBtn').click();
  await until(async () => (await b.count()) === 0, 'history to be cleared');
  await until(() => app.$('batteryEmpty').style.display === 'block', 'empty state');
  assert.strictEqual(app.$('clearBatteryBtn').textContent, 'Clear history');
  app.w.close();
});

test('Battery tab: infers a charge from a jump in battery level and lists it', async () => {
  const app = bootApp({ bluetooth: false });
  const b = new app.w.NIU.Battery.BatteryStore();
  const now = Date.now();
  await b.add({ t: now - 7200000, soc: 30, soh: 93, cycles: 150 });
  await b.add({ t: now - 60000, soc: 100, soh: 93, cycles: 151 });
  app.tab('batteryScreen');
  await until(() => app.$('batteryBody').style.display === 'block', 'history to render');
  assert.strictEqual(app.$('bCharges').textContent, '1');
  assert.match(app.$('chargesList').children[0].textContent, /30% → 100%/);
  app.w.close();
});

test('exports are offered only when there is something to export', async () => {
  const app = bootApp({ bluetooth: false });
  app.tab('ridesScreen');
  await wait(100);
  assert.strictEqual(app.$('exportAllBtn').style.display, 'none');
  await new app.w.NIU.RideStore().saveRide({ id: 'x', startDate: 1, endDate: 2, distanceMeters: 100, points: [], topSpeedKPH: 0, averageSpeedKPH: 0, activeRidingSeconds: 1 });
  app.tab('cockpitScreen'); app.tab('ridesScreen');
  await until(() => app.$('exportAllBtn').style.display === 'inline-block', 'the export button');
  app.$('exportAllBtn').click();
  await until(() => app.shared.length === 1, 'summary share');
  assert.match(app.shared[0].files[0].name, /^niu-rides-.*\.csv$/);
  app.w.close();
});


// =====================================================================
// Diagnostics (read-only field explorer), end to end
// =====================================================================
const Catalogue = require('../js/fields.js');
const codeOf = (n) => Catalogue.FIELDS[n].code;
const SERIAL = 'SN-SECRET-12345';
const diagExtras = () => ({
  [codeOf('db_mileage')]: { len: 4, value: 12345 },
  [codeOf('db_sn')]: { len: 16, text: SERIAL },
  [codeOf('ble_mac')]: { len: 8, hex: 'a1b2c3d4e5f60708' },
  [codeOf('db_k_function_status')]: { len: 4, value: 0b1000010 },
  [codeOf('db_k_hw_ver')]: { len: 8, text: '<b>x</b>' },        // hostile-looking text: must render as text
});
const readText = (w, file) => new Promise((res, rej) => { const r = new w.FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); });
async function openDiagnostics(app) {
  await connect(app);
  app.tab('setupScreen');
  app.$('openDiagBtn').click();
}
const scanDone = (app) => until(() => /^Scan complete/.test(app.$('diagStatus').textContent), 'the scan to finish', 25000);

test('every element ID used by diag-ui.js exists in index.html', () => {
  const src = fs.readFileSync(path.join(root, 'js', 'diag-ui.js'), 'utf8');
  const ids = [...new Set([...src.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
  assert.ok(ids.length >= 15, `expected many ids, found ${ids.length}`);
  const missing = ids.filter((id) => !window.document.getElementById(id));
  assert.deepStrictEqual(missing, []);
});

test('Diagnostics: without a connection it explains itself and offers no actions', async () => {
  const app = bootApp({ bluetooth: false });
  app.tab('setupScreen');
  app.$('openDiagBtn').click();
  assert.ok(app.$('diagScreen').classList.contains('active'));
  assert.match(app.$('diagStatus').textContent, /Not connected/);
  for (const id of ['scanBtn', 'snapABtn', 'snapBBtn', 'compareBtn', 'watchBtn', 'exportDiagBtn', 'previewDiagBtn']) {
    assert.strictEqual(app.$(id).disabled, true, `${id} should be disabled`);
  }
  app.$('scanBtn').click();
  await wait(50);
  assert.strictEqual(app.$('diagResults').children.length, 0);
  app.$('closeDiagBtn').click();
  assert.ok(!app.$('diagScreen').classList.contains('active'));
  app.w.close();
});

test('Diagnostics E2E: scan, hidden identifiers, safe rendering, and nothing sensitive requested', async () => {
  const app = bootApp({ extraFields: diagExtras() });
  await openDiagnostics(app);
  assert.strictEqual(app.$('scanBtn').disabled, false);
  app.$('scanBtn').click();
  assert.strictEqual(app.$('scanBtn').disabled, true, 'cannot start a second scan during a scan');
  assert.strictEqual(app.$('cancelScanBtn').style.display, 'inline-block');
  await scanDone(app);

  assert.match(app.$('diagSummary').textContent, /\d+ answered · \d+ refused · 40 skipped \(never read\)/);
  const table = app.$('diagResults');
  const rowFor = (name) => [...table.children].find((r) => r.children[0].textContent === name);
  assert.strictEqual(rowFor('bms_soc_rt').children[1].textContent, '59');
  assert.strictEqual(rowFor('db_mileage').children[1].textContent, '12345');

  // identifiers are hidden on screen until revealed
  assert.strictEqual(rowFor('db_sn').children[1].textContent, '••• hidden');
  assert.ok(!table.textContent.includes(SERIAL), 'serial must not be on screen by default');
  assert.ok(!table.textContent.includes('a1b2c3d4'), 'MAC must not be on screen by default');
  app.$('revealCheck').checked = true;
  app.$('revealCheck').dispatchEvent(new app.w.Event('change'));
  assert.ok(app.$('diagResults').textContent.includes(SERIAL), 'revealing shows it');

  // scooter-supplied text is rendered as text, never as markup
  assert.strictEqual(rowFor('db_k_hw_ver') ? 1 : 1, 1);
  const hw = [...app.$('diagResults').children].find((r) => r.children[0].textContent === 'db_k_hw_ver');
  assert.strictEqual(hw.children[1].textContent, JSON.stringify('<b>x</b>'));
  assert.strictEqual(app.$('diagResults').querySelector('b'), null, 'no element may be created from scooter text');

  // skipped fields are only listed when answered-only is off
  assert.ok(![...app.$('diagResults').children].some((r) => r.children[0].textContent === 'nfc_card_id_1'));
  app.$('answeredOnlyCheck').checked = false;
  app.$('answeredOnlyCheck').dispatchEvent(new app.w.Event('change'));
  const nfc = [...app.$('diagResults').children].find((r) => r.children[0].textContent === 'nfc_card_id_1');
  assert.strictEqual(nfc.children[1].textContent, 'skipped: credential');

  // the filter narrows the list
  app.$('diagFilter').value = 'soc_rt';
  app.$('diagFilter').dispatchEvent(new app.w.Event('input'));
  assert.ok([...app.$('diagResults').children].every((r) => r.children[0].textContent.includes('soc_rt')));

  // SAFETY: no credential or command field was ever requested from the scooter
  const asked = new Set(app.scooter.requested);
  for (const [name, spec] of Object.entries(Catalogue.FIELDS)) {
    if (require('../js/diagnostics.js').skipReason(name)) assert.ok(!asked.has(spec.code), `${name} was requested`);
  }
  app.w.close();
});

test('Diagnostics E2E: the dashboard polling pauses during a scan and resumes afterwards', async () => {
  const app = bootApp({ extraFields: diagExtras() });
  await openDiagnostics(app);
  const before = app.scooter.log.length;
  app.$('scanBtn').click();
  await scanDone(app);
  const lines = app.scooter.log.slice(before);
  const isDashboard = (l) => l === 'read 21000B,31001C,110004,110006,31004C' || l === 'read 21003B,310016,110002,310018';
  const scanIdx = lines.map((l, i) => [l, i]).filter(([l]) => l.startsWith('read') && !isDashboard(l)).map(([, i]) => i);
  assert.ok(scanIdx.length > 50, 'the scan should have sent many requests');
  const first = scanIdx[0], last = scanIdx[scanIdx.length - 1];
  const interleaved = lines.slice(first, last + 1).filter(isDashboard);
  assert.deepStrictEqual(interleaved, [], 'no dashboard poll may fall between the first and last scan request');
  const mark = app.scooter.log.length;
  await until(() => app.scooter.log.slice(mark).some((l) => l.startsWith('read 21000B,31001C')), 'dashboard polling to resume', 5000);
  app.w.close();
});

test('Diagnostics E2E: snapshot A, change something, snapshot B, compare shows the bits that flipped', async () => {
  const app = bootApp({ extraFields: diagExtras() });
  await openDiagnostics(app);
  assert.strictEqual(app.$('snapABtn').disabled, true, 'snapshots need a scan first');
  app.$('scanBtn').click();
  await scanDone(app);
  app.$('snapABtn').click();
  await until(() => /Snapshot A taken/.test(app.$('diagStatus').textContent), 'snapshot A');
  assert.strictEqual(app.$('compareBtn').disabled, true, 'compare needs both snapshots');
  app.scooter.fields[codeOf('db_k_function_status')].value = 0b1010010;     // bit 16 on, bit 2 and 64 unchanged
  app.$('snapBBtn').click();
  await until(() => /Snapshot B taken/.test(app.$('diagStatus').textContent), 'snapshot B');
  assert.strictEqual(app.$('compareBtn').disabled, false);
  app.$('compareBtn').click();
  assert.match(app.$('diagStatus').textContent, /1 field differ/);
  const rows = [...app.$('diagChanges').children].map((r) => r.textContent);
  const line = rows.find((r) => r.includes('db_k_function_status'));
  assert.ok(line, rows.join(' | '));
  assert.match(line, /66 → 82/);
  assert.match(line, /bits \+16/);
  app.w.close();
});

test('Diagnostics E2E: watching reports a change as it happens, and stopping resumes the dashboard', async () => {
  const app = bootApp({ extraFields: diagExtras() });
  await openDiagnostics(app);
  app.$('scanBtn').click();
  await scanDone(app);
  app.$('watchBtn').click();
  await until(() => app.$('watchBtn').textContent === 'Stop watching', 'watching to start');
  assert.strictEqual(app.$('scanBtn').disabled, true, 'cannot scan while watching');
  await wait(1800);                                                          // baseline pass first
  app.scooter.fields[codeOf('db_mileage')].value = 12399;
  await until(() => [...app.$('diagChanges').children].some((r) => r.textContent.includes('db_mileage') && r.textContent.includes('12345 → 12399')), 'the change to show', 8000);
  app.$('watchBtn').click();
  await until(() => app.$('watchBtn').textContent === 'Start watching', 'watching to stop');
  assert.match(app.$('diagStatus').textContent, /Stopped watching/);
  const mark = app.scooter.log.length;
  await until(() => app.scooter.log.slice(mark).some((l) => l.startsWith('read 21000B,31001C')), 'dashboard polling to resume', 5000);
  app.w.close();
});

test('Diagnostics E2E: closing the screen stops a running watch', async () => {
  const app = bootApp({ extraFields: diagExtras() });
  await openDiagnostics(app);
  app.$('scanBtn').click();
  await scanDone(app);
  app.$('watchBtn').click();
  await until(() => app.$('watchBtn').textContent === 'Stop watching', 'watching to start');
  app.$('closeDiagBtn').click();
  await until(() => app.$('watchBtn').textContent === 'Start watching', 'the watch to stop');
  app.w.close();
});

test('Diagnostics E2E: the exported report is valid, redacted, keyless, and carries the note', async () => {
  const app = bootApp({ extraFields: diagExtras() });
  await openDiagnostics(app);
  app.$('scanBtn').click();
  await scanDone(app);
  app.$('diagNote').value = 'A: lights off, B: lights on';
  app.$('revealCheck').checked = true;                     // even with identifiers revealed on screen, exports stay redacted
  app.$('revealCheck').dispatchEvent(new app.w.Event('change'));
  app.$('exportDiagBtn').click();
  await until(() => app.shared.length === 1, 'the report to be shared');
  const file = app.shared[0].files[0];
  assert.match(file.name, /^niu-diagnostics-\d{8}T\d{6}Z\.json$/);
  assert.strictEqual(file.type, 'application/json');
  const text = await readText(app.w, file);
  const report = JSON.parse(text);
  assert.strictEqual(report.note, 'A: lights off, B: lights on');
  assert.strictEqual(report.summary.total, 299);
  assert.strictEqual(report.summary.skipped, 40);
  assert.strictEqual(report.scooter.bleVersion, 10);
  assert.strictEqual(report.scooter.name, 'NIU KQi');
  assert.ok(!text.includes(SERIAL), 'serial leaked into the exported report');
  assert.ok(!text.includes('a1b2c3d4e5f60708'), 'MAC leaked into the exported report');
  assert.ok(!text.includes(PWD) && !text.includes(AES), 'scooter keys leaked into the exported report');
  assert.strictEqual(report.fields.find((f) => f.name === 'db_sn').value, '<hidden>');
  assert.strictEqual(report.fields.find((f) => f.name === 'bms_soc_rt').value, 59);
  app.w.close();
});

test('Diagnostics E2E: preview shows the same redacted report in a read-only box', async () => {
  const app = bootApp({ extraFields: diagExtras() });
  await openDiagnostics(app);
  app.$('scanBtn').click();
  await scanDone(app);
  app.$('previewDiagBtn').click();
  const box = app.$('diagPreview');
  assert.strictEqual(box.style.display, 'block');
  assert.ok(box.readOnly);
  assert.doesNotThrow(() => JSON.parse(box.value));
  assert.ok(!box.value.includes(SERIAL));
  app.$('previewDiagBtn').click();
  assert.strictEqual(box.style.display, 'none');
  app.w.close();
});

test('Diagnostics E2E: a scan can be cancelled and still shows partial results', async () => {
  const app = bootApp({ extraFields: diagExtras() });
  await openDiagnostics(app);
  app.$('scanBtn').click();
  await wait(150);
  app.$('cancelScanBtn').click();
  await until(() => /cancelled/i.test(app.$('diagStatus').textContent) && app.$('scanBtn').disabled === false, 'the scan to cancel', 10000);
  assert.match(app.$('diagSummary').textContent, /not run/);
  app.w.close();
});

(async () => {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed++;
      console.log(`  ok - ${name}`);
    } catch (err) {
      console.error(`  FAIL - ${name}`);
      console.error(`    ${err.stack}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed} passed`);
  process.exit(process.exitCode || 0);   // jsdom timers/intervals must not keep the process alive
})();
