/**
 * exporters.test.js — run with: node test/exporters.test.js
 */
const assert = require('assert');
const { JSDOM } = require('jsdom');
const E = require('../js/exporters.js');

let passed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const T0 = Date.UTC(2026, 9, 1, 8, 15, 0);   // 2026-10-01T08:15:00Z
const ride = (over = {}) => ({
  id: 'ride_1', startDate: T0, endDate: T0 + 600000, distanceMeters: 2500, topSpeedKPH: 27.4, averageSpeedKPH: 17.2,
  activeRidingSeconds: 540, startSOC: 80, endSOC: 74,
  points: [
    { lat: 33.77, lon: -118.19, altitude: 12.34, speedMPS: 0, timestamp: T0 },
    { lat: 33.7705, lon: -118.1905, altitude: 13.5, speedMPS: 5, timestamp: T0 + 1000 },
  ],
  ...over,
});
const parseXml = (xml) => new JSDOM(xml, { contentType: 'text/xml' }).window.document;

console.log('exporters (GPX, CSV, delivery)\n');

test('GPX is well-formed XML with one trkpt per fix, ISO times and elevation', () => {
  const doc = parseXml(E.toGPX(ride()));
  assert.strictEqual(doc.documentElement.nodeName, 'gpx');
  const pts = doc.getElementsByTagName('trkpt');
  assert.strictEqual(pts.length, 2);
  assert.strictEqual(pts[0].getAttribute('lat'), '33.770000');
  assert.strictEqual(pts[0].getAttribute('lon'), '-118.190000');
  assert.strictEqual(pts[0].getElementsByTagName('time')[0].textContent, '2026-10-01T08:15:00.000Z');
  assert.strictEqual(pts[0].getElementsByTagName('ele')[0].textContent, '12.3');
});

test('GPX omits elevation when the phone never gave altitude', () => {
  const r = ride({ points: ride().points.map((p) => ({ ...p, altitude: 0 })) });
  assert.strictEqual(parseXml(E.toGPX(r)).getElementsByTagName('ele').length, 0);
});

test('GPX escapes hostile names and stays well-formed', () => {
  const xml = E.toGPX(ride(), { name: `Ride <script>&"'` });
  const doc = parseXml(xml);
  assert.ok(!xml.includes('<script>'));
  assert.strictEqual(doc.getElementsByTagName('name')[0].textContent, `Ride <script>&"'`);
});

test('GPX skips malformed points instead of writing NaN', () => {
  const xml = E.toGPX(ride({ points: [{ lat: 'x', lon: 1 }, null, { lat: 33.7, lon: -118.1, timestamp: T0 }] }));
  assert.ok(!/NaN|undefined/.test(xml));
  assert.strictEqual(parseXml(xml).getElementsByTagName('trkpt').length, 1);
});

test('ride CSV has a header, one row per fix, and speed in km/h', () => {
  const lines = E.toRideCSV(ride()).trim().split('\r\n');
  assert.strictEqual(lines[0], 'time_utc,lat,lon,altitude_m,gps_speed_kph');
  assert.strictEqual(lines.length, 3);
  assert.strictEqual(lines[2], '2026-10-01T08:15:01.000Z,33.770500,-118.190500,13.5,18');
});

test('CSV quoting: commas, quotes and newlines are escaped; formulas are neutralised; numbers are not', () => {
  assert.strictEqual(E.csvCell('a,b'), '"a,b"');
  assert.strictEqual(E.csvCell('say "hi"'), '"say ""hi"""');
  assert.strictEqual(E.csvCell('line1\nline2'), '"line1\nline2"');
  assert.strictEqual(E.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.strictEqual(E.csvCell('+1'), "'+1");
  assert.strictEqual(E.csvCell('-118.19'), '-118.19');
  assert.strictEqual(E.csvCell(0), '0');
  assert.strictEqual(E.csvCell(null), '');
  assert.strictEqual(E.csvCell(undefined), '');
});

test('rides summary CSV: one row per ride, simulated rides flagged, missing battery left blank', () => {
  const rows = E.ridesSummaryCSV([ride(), ride({ id: 'r2', startSOC: undefined, endSOC: undefined, simulated: true })]).trim().split('\r\n');
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].split(',').length, 9);
  assert.strictEqual(rows[1], '2026-10-01T08:15:00.000Z,2026-10-01T08:25:00.000Z,2.5,9,27.4,17.2,80,74,');
  assert.ok(rows[2].endsWith(',,,yes'));
});

test('battery CSV lists samples in order with yes/no/blank power state', () => {
  const rows = E.batteryCSV([
    { t: T0, soc: 59, soh: 93, cycles: 151, on: true },
    { t: T0 + 60000, soc: 58, soh: 93, cycles: 151, on: false },
    { t: T0 + 120000, soc: 58 },
  ]).trim().split('\r\n');
  assert.strictEqual(rows[0], 'time_utc,battery_pct,health_pct,charge_cycles,powered_on');
  assert.strictEqual(rows[1], '2026-10-01T08:15:00.000Z,59,93,151,yes');
  assert.strictEqual(rows[2], '2026-10-01T08:16:00.000Z,58,93,151,no');
  assert.strictEqual(rows[3], '2026-10-01T08:17:00.000Z,58,,,');
});

test('filenames are deterministic and filesystem-safe', () => {
  assert.strictEqual(E.filenameFor('niu-ride', T0, 'gpx'), 'niu-ride-20261001T081500Z.gpx');
  assert.ok(!/[:\s/\\]/.test(E.filenameFor('x', T0 + 123, 'csv')));
});

// ---- delivery
class FakeFile { constructor(parts, name, opts) { this.parts = parts; this.name = name; this.type = opts.type; } }
class FakeBlob { constructor(parts, opts) { this.parts = parts; this.type = opts.type; } }
function fakeEnv({ share, canShare = true, clipboard = true, download = true } = {}) {
  const log = { shared: null, clicked: null, copied: null, revoked: null };
  const body = { children: [], appendChild(a) { this.children.push(a); } };
  const env = {
    File: FakeFile, Blob: FakeBlob,
    navigator: {
      canShare: () => canShare,
      share: share || (async (d) => { log.shared = d; }),
      clipboard: clipboard ? { writeText: async (t) => { log.copied = t; } } : undefined,
    },
    document: download ? { body, createElement: () => ({ click() { log.clicked = this.download; }, remove() {} }) } : undefined,
    URL: download ? { createObjectURL: () => 'blob:x', revokeObjectURL: (u) => { log.revoked = u; } } : undefined,
  };
  return { env, log };
}

test('deliver uses the share sheet first and passes a real file', async () => {
  const { env, log } = fakeEnv();
  assert.strictEqual(await E.deliver('a.gpx', 'application/gpx+xml', '<gpx/>', env), 'share');
  assert.strictEqual(log.shared.files[0].name, 'a.gpx');
  assert.strictEqual(log.shared.files[0].type, 'application/gpx+xml');
});

test('deliver treats a closed share sheet as cancelled, not as a failure to fall back from', async () => {
  const { env, log } = fakeEnv({ share: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); } });
  assert.strictEqual(await E.deliver('a.csv', 'text/csv', 'x', env), 'cancelled');
  assert.strictEqual(log.clicked, null);
});

test('deliver falls back to a download when files cannot be shared', async () => {
  const { env, log } = fakeEnv({ canShare: false });
  assert.strictEqual(await E.deliver('a.csv', 'text/csv', 'x', env), 'download');
  assert.strictEqual(log.clicked, 'a.csv');
});

test('deliver falls back to a download when sharing throws something other than a cancel', async () => {
  const { env } = fakeEnv({ share: async () => { throw Object.assign(new Error('nope'), { name: 'NotAllowedError' }); } });
  assert.strictEqual(await E.deliver('a.csv', 'text/csv', 'x', env), 'download');
});

test('deliver copies to the clipboard when neither sharing nor downloading is possible', async () => {
  const { env, log } = fakeEnv({ canShare: false, download: false });
  assert.strictEqual(await E.deliver('a.csv', 'text/csv', 'hello', env), 'clipboard');
  assert.strictEqual(log.copied, 'hello');
});

test('deliver reports clearly when nothing works', async () => {
  const { env } = fakeEnv({ canShare: false, download: false, clipboard: false });
  await assert.rejects(() => E.deliver('a.csv', 'text/csv', 'x', env), /could not share, download or copy/);
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; console.log(`  ok - ${name}`); }
    catch (err) { console.error(`  FAIL - ${name}\n    ${err.stack}`); process.exitCode = 1; }
  }
  console.log(`\n${passed} passed`);
})();
