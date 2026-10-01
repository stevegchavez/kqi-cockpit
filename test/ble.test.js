/**
 * ble.test.js — run with: node test/ble.test.js
 *
 * Exercises BLEManager (js/ble.js) against a fake navigator.bluetooth that
 * mimics the Web Bluetooth call sequence and is backed by the simulated
 * scooter. This checks our use of the API; it cannot prove a real phone's
 * Bluetooth stack behaves identically — that needs a live check.
 */
const assert = require('assert');
const BLEManager = require('../js/ble.js');
const C = require('../js/constants.js');
const { FakeScooter, defaultFields } = require('./helpers/fake-scooter.js');

const PWD = '0123456789abcdef';
const AES = 'fedcba9876543210';
const KEYS = { password: PWD, aes: AES };

let passed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { fakeBluetooth } = require('./helpers/fake-bluetooth.js');

function setup(o = {}) {
  const scooter = new FakeScooter({ password: PWD, aesKey: AES, fields: defaultFields(), refuse: o.refuse || [] });
  const fb = fakeBluetooth(scooter, o);
  const mgr = new BLEManager({ bluetooth: fb.bluetooth, pollIntervalMs: 15, timeoutMs: o.timeoutMs || 80 });
  const events = { states: [], telemetry: [], errors: [], connected: [], disconnected: 0 };
  mgr.addEventListener('statechange', (e) => events.states.push(e.detail));
  mgr.addEventListener('telemetry', (e) => events.telemetry.push(e.detail));
  mgr.addEventListener('error', (e) => events.errors.push(e.detail));
  mgr.addEventListener('connected', (e) => events.connected.push(e.detail));
  mgr.addEventListener('disconnected', () => { events.disconnected++; });
  return { scooter, fb, mgr, events };
}

console.log('ble (BLEManager against a fake Web Bluetooth)\n');

test('connects, authenticates, and streams telemetry', async () => {
  const { mgr, events, fb } = setup();
  await mgr.connect(KEYS);
  await sleep(120);
  mgr.disconnect();
  assert.deepStrictEqual(events.states.slice(0, 2), ['connecting', 'connected']);
  assert.deepStrictEqual(events.connected, [{ name: 'NIU KQi' }]);
  assert.ok(events.telemetry.length >= 2);
  assert.strictEqual(events.telemetry[0].maxSpeedKPH, 30);
  assert.ok(events.telemetry.slice(1).every((t) => t.batterySOC === 59 && t.speedKPH === 12.3));
  assert.ok(fb.notifyChar.notifying, 'notifications must be started');
});

test('the device picker matches by name or by service and declares every NIU service', async () => {
  const { mgr, fb } = setup();
  await mgr.connect(KEYS);
  mgr.disconnect();
  const opts = fb.calls[0];
  assert.deepStrictEqual(opts.filters, [{ namePrefix: 'NIU' }, { services: [C.PRIMARY_SERVICE_UUID] }]);
  for (const uuid of C.ALL_SERVICE_UUIDS) assert.ok(opts.optionalServices.includes(uuid));
});

test('READ-ONLY: the only frames ever written are handshake and read requests', async () => {
  const { mgr, fb } = setup();
  await mgr.connect(KEYS);
  await sleep(150);
  mgr.disconnect();
  const allowed = new Set(['0123', '0103', '0121', '0101']);
  assert.ok(fb.written.length > 3);
  for (const f of fb.written) {
    assert.strictEqual(f.length, 40, 'every frame is 20 bytes');
    assert.ok(allowed.has(f.slice(0, 4)), `unexpected frame header ${f.slice(0, 4)}`);
  }
});

test('falls back to writeValue when writeValueWithResponse is unavailable', async () => {
  const { mgr, events } = setup({ noWithResponse: true });
  await mgr.connect(KEYS);
  await sleep(80);
  mgr.disconnect();
  assert.ok(events.telemetry.length >= 1);
});

test('wrong keys are rejected with a clear message and the state resets', async () => {
  const { mgr, events } = setup();
  await assert.rejects(() => mgr.connect({ password: 'AAAAAAAAAAAAAAAA', aes: AES }), /rejected the saved keys/);
  assert.strictEqual(mgr.state, 'disconnected');
  assert.strictEqual(events.telemetry.length, 0);
});

test('cancelling the picker gives a friendly message', async () => {
  const { mgr } = setup({ cancel: true });
  await assert.rejects(() => mgr.connect(KEYS), /No scooter selected/);
  assert.strictEqual(mgr.state, 'disconnected');
});

test('a BLE-20 scooter is refused with an explanation instead of a broken session', async () => {
  const { mgr, fb } = setup({ serviceUuid: '8ec94e30-f315-4f60-9fb8-838830daea51' });
  await assert.rejects(() => mgr.connect(KEYS), /BLE version 20.*does not support/);
  assert.strictEqual(fb.written.length, 0, 'nothing may be sent to an unsupported scooter');
  assert.strictEqual(mgr.state, 'disconnected');
});

test('missing keys are caught before the Bluetooth picker opens', async () => {
  const { mgr, fb } = setup();
  await assert.rejects(() => mgr.connect(null), /No scooter keys saved/);
  await assert.rejects(() => mgr.connect({ password: PWD }), /No scooter keys saved/);
  assert.strictEqual(fb.calls.length, 0);
});

test('a browser without Web Bluetooth reports unsupported', async () => {
  const mgr = new BLEManager({ bluetooth: undefined });   // Node's navigator has no .bluetooth either
  assert.strictEqual(mgr.isSupported, false);
  await assert.rejects(() => mgr.connect(KEYS), /Web Bluetooth is not available/);
  assert.strictEqual(mgr.state, 'unsupported');
});

test('disconnect() stops polling and reports disconnected', async () => {
  const { mgr, events, fb } = setup();
  await mgr.connect(KEYS);
  await sleep(60);
  mgr.disconnect();
  await sleep(30);
  const n = events.telemetry.length;
  const w = fb.written.length;
  await sleep(100);
  assert.strictEqual(events.disconnected, 1);
  assert.strictEqual(mgr.state, 'disconnected');
  assert.ok(events.telemetry.length <= n + 1);
  assert.ok(fb.written.length <= w + 1, 'no more requests after disconnect');
});

test('if the scooter goes silent mid-ride, an error is reported and the link is closed', async () => {
  const { mgr, events, scooter } = setup({ timeoutMs: 40 });
  await mgr.connect(KEYS);
  await sleep(50);
  scooter.silent = true;
  await sleep(500);
  assert.ok(events.errors.length >= 1, 'expected an error event');
  assert.match(events.errors[0].message, /did not answer/);
  assert.strictEqual(mgr.state, 'disconnected');
});

test('reconnect() reuses the same device without showing the picker again', async () => {
  const { mgr, fb } = setup();
  await mgr.connect(KEYS);
  mgr.disconnect();
  await sleep(20);
  await mgr.reconnect(KEYS);
  await sleep(60);
  mgr.disconnect();
  assert.strictEqual(fb.calls.length, 1, 'requestDevice must be called only once');
  assert.strictEqual(mgr.state, 'disconnected');
});

test('withPollingPaused stops the dashboard polling during the work and resumes it afterwards', async () => {
  const { mgr, events, fb } = setup();
  await mgr.connect(KEYS);
  await sleep(80);
  let during = null;
  const result = await mgr.withPollingPaused(async (session) => {
    await sleep(40);                                   // let any in-flight poll finish
    const before = fb.written.length;
    const teleBefore = events.telemetry.length;
    await sleep(120);
    during = { writes: fb.written.length - before, telemetry: events.telemetry.length - teleBefore };
    assert.ok(session, 'the work receives the live session');
    return 'done';
  });
  assert.strictEqual(result, 'done');
  assert.deepStrictEqual(during, { writes: 0, telemetry: 0 }, 'nothing may be polled while paused');
  const n = events.telemetry.length;
  await sleep(120);
  assert.ok(events.telemetry.length > n, 'polling must resume afterwards');
  mgr.disconnect();
});

test('withPollingPaused resumes polling even if the work throws, and passes the error on', async () => {
  const { mgr, events } = setup();
  await mgr.connect(KEYS);
  await sleep(50);
  await assert.rejects(() => mgr.withPollingPaused(async () => { throw new Error('scan blew up'); }), /scan blew up/);
  const n = events.telemetry.length;
  await sleep(120);
  assert.ok(events.telemetry.length > n);
  mgr.disconnect();
});

test('withPollingPaused refuses to run when there is no connection, and does not resume after a disconnect', async () => {
  const { mgr, events } = setup();
  await assert.rejects(() => mgr.withPollingPaused(async () => 1), /Not connected/);
  await mgr.connect(KEYS);
  await sleep(50);
  await mgr.withPollingPaused(async () => { mgr.disconnect(); await sleep(20); });
  const n = events.telemetry.length;
  await sleep(120);
  assert.strictEqual(events.telemetry.length, n, 'a disconnected link must not be polled');
});

test('the manager hands the field catalogue to the session so pushes can be decoded', async () => {
  const Fields = require('../js/fields.js');
  const scooter = new (require('./helpers/fake-scooter.js').FakeScooter)({ password: PWD, aesKey: AES, fields: require('./helpers/fake-scooter.js').defaultFields() });
  const fb = fakeBluetooth(scooter);
  const mgr = new BLEManager({ bluetooth: fb.bluetooth, pollIntervalMs: 15, timeoutMs: 80, catalogue: Fields });
  await mgr.connect(KEYS);
  assert.strictEqual(mgr.session.catalogue, Fields);
  mgr.disconnect();
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; console.log(`  ok - ${name}`); }
    catch (err) { console.error(`  FAIL - ${name}\n    ${err.stack}`); process.exitCode = 1; }
  }
  console.log(`\n${passed} passed`);
})();
