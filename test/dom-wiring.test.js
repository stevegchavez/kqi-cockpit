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

const files = ['constants.js', 'protocol.js', 'ble.js', 'storage.js', 'geo.js', 'app.js'];

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(`    ${err.stack}`);
    process.exitCode = 1;
  }
}

console.log('dom-wiring (index.html + js/*.js under jsdom)\n');

test('every js/*.js file executes in the page context without throwing', () => {
  for (const file of files) {
    const code = fs.readFileSync(path.join(root, 'js', file), 'utf8');
    window.eval(code);
  }
});

test('NIU namespace is fully populated after boot', () => {
  assert.ok(window.NIU, 'window.NIU should exist');
  for (const key of ['BLE_CONSTANTS', 'Protocol', 'BLEManager', 'RideStore', 'GeoTracker']) {
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

test('rocker switches expose aria-checked and toggle on click without throwing', () => {
  const headlightBtn = window.document.getElementById('headlightBtn');
  assert.strictEqual(headlightBtn.dataset.active, 'false');
  assert.strictEqual(headlightBtn.querySelector('.switch').getAttribute('aria-checked'), 'false');
  // navigator.bluetooth is intentionally absent in this smoke test, so the
  // click's async ble.setHeadlight() call will reject — that's expected
  // and handled by app.js's own catch/toast, not this test's job to catch.
  assert.doesNotThrow(() => headlightBtn.click());
});

console.log(`\n${passed} passed`);
