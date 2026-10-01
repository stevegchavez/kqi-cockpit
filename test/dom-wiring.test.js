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

const files = ['constants.js', 'crypto.js', 'protocol.js', 'session.js', 'keystore.js', 'ble.js', 'storage.js', 'geo.js', 'app.js'];

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
  for (const key of ['BLE_CONSTANTS', 'Crypto', 'Protocol', 'Session', 'KeyStore', 'BLEManager', 'RideStore', 'GeoTracker']) {
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

test('info strip shows battery health, power state and max speed after (simulated) telemetry', async () => {
  const d = window.document;
  d.getElementById('demoToggleBtn').click();
  await new Promise((resolve) => window.setTimeout(resolve, 700));
  assert.strictEqual(d.getElementById('healthVal').textContent, '93%');
  assert.strictEqual(d.getElementById('powerVal').textContent, 'ON');
  assert.ok(d.getElementById('powerVal').classList.contains('on'));
  const unit = d.getElementById('speedUnit').textContent;
  const expected = unit === 'MPH' ? '19' : '30';   // 30 km/h
  assert.strictEqual(d.getElementById('maxSpeedVal').textContent, expected);
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
