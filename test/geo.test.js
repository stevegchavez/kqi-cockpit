/**
 * geo.test.js — run with: node test/geo.test.js
 */
const assert = require('assert');
require('../js/geo.js'); // attaches to globalThis.NIU since no module.exports branch needed here
const { haversineMeters, JumpFilter } = globalThis.NIU;
const fs = require('fs');
const path = require('path');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('geo.js\n');

test('distance between identical coordinates is zero', () => {
  assert.strictEqual(haversineMeters(33.77, -118.19, 33.77, -118.19), 0);
});

test('distance between two known points is within expected tolerance', () => {
  // Long Beach, CA to Downtown LA — roughly 30.6 km great-circle.
  const d = haversineMeters(33.7701, -118.1937, 34.0522, -118.2437);
  assert.ok(d > 30000 && d < 32000, `expected ~30-32km, got ${(d / 1000).toFixed(2)}km`);
});

test('is symmetric regardless of point order', () => {
  const a = haversineMeters(33.77, -118.19, 34.05, -118.24);
  const b = haversineMeters(34.05, -118.24, 33.77, -118.19);
  assert.ok(Math.abs(a - b) < 1e-6);
});

// ---- JumpFilter: GPS spikes and steps (found on a real ride) ----
const M_LAT = (2 * Math.PI * 6371000) / 360;
/** A fix `north` metres north of a fixed origin, `sec` seconds after the start, with a phone speed reading. */
const fix = (sec, north, speedMPS = 5) => ({ lat: 40 + north / M_LAT, lon: -100, altitude: 0, speedMPS, timestamp: 1e12 + sec * 1000 });
/** Runs fixes through a fresh filter; returns the recorded points and the distance total. */
function run(fixes) {
  const f = new JumpFilter();
  const points = [];
  let meters = 0;
  for (const p of fixes) for (const a of f.push(p)) { points.push(a.point); meters += a.addMeters; }
  return { points, meters, filter: f };
}

test('JumpFilter: a normal track passes through unchanged', () => {
  const r = run(Array.from({ length: 30 }, (_, i) => fix(i, i * 5)));
  assert.strictEqual(r.points.length, 30);
  assert.ok(Math.abs(r.meters - 145) < 0.5, `got ${r.meters}`);
  assert.ok(r.points.every((p) => !p.jump));
});

test('JumpFilter: a one-fix spike is dropped and adds no distance', () => {
  const fixes = Array.from({ length: 12 }, (_, i) => fix(i, i * 5));
  fixes[6] = fix(6, 30 + 17);                      // 17 m sideways-equivalent blip
  const r = run(fixes);
  assert.strictEqual(r.points.length, 11);
  assert.ok(Math.abs(r.meters - 55) < 0.5, `got ${r.meters}`);
});

test('JumpFilter: a permanent step is re-anchored, flagged, and not counted as distance', () => {
  const fixes = Array.from({ length: 12 }, (_, i) => fix(i, i * 5 + (i >= 6 ? 17 : 0)));
  const r = run(fixes);
  assert.strictEqual(r.points.length, 12);
  assert.strictEqual(r.points.filter((p) => p.jump).length, 1);
  assert.ok(Math.abs(r.meters - 50) < 0.5, `step must not count, got ${r.meters}`);
});

test('JumpFilter: standstill jitter is not rejected', () => {
  const fixes = Array.from({ length: 30 }, (_, i) => fix(i, (i % 2) * 2, 0));
  const r = run(fixes);
  assert.strictEqual(r.points.length, 30);
  assert.strictEqual(r.filter.rejectedTotal, 0);
});

test('JumpFilter: without any speed readings it still catches an impossible jump (ceiling)', () => {
  const fixes = Array.from({ length: 10 }, (_, i) => fix(i, i * 5, 0));
  fixes[5] = fix(5, 25 + 60, 0);                   // 60 m in one second
  const r = run(fixes);
  assert.strictEqual(r.points.length, 9);
});

test('JumpFilter: gives up after 3 disagreeing fixes and starts over from the latest', () => {
  const fixes = [fix(0, 0), fix(1, 5), fix(2, 200), fix(3, 400), fix(4, 600), fix(5, 605)];
  const r = run(fixes);
  const last = r.points[r.points.length - 1];
  assert.ok(Math.abs(last.lat - (40 + 605 / M_LAT)) < 1e-9);
  assert.ok(r.meters < 20, `a teleport must not add distance, got ${r.meters}`);
  assert.ok(r.points.some((p) => p.jump));
});

test('JumpFilter: switches itself off when it would reject a large share of fixes', () => {
  // Fast zig-zag the filter cannot make sense of; after 20 fixes the guard must stand down.
  const fixes = Array.from({ length: 60 }, (_, i) => fix(i, (i % 2) * 400, 1));
  const r = run(fixes);
  assert.strictEqual(r.filter.disabled, true);
  assert.ok(r.points.length > 40, `guard should let most fixes through, got ${r.points.length}`);
});

test('real ride (relocated): filtering removes the GPS-glitch distance and keeps the points', () => {
  const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'real-ride-relocated.json'), 'utf8')).rows;
  const pts = rows.map(([ms, lat, lon, alt, kph]) => ({ lat, lon, altitude: alt, speedMPS: kph / 3.6, timestamp: 1e12 + ms }));
  let raw = 0;
  for (let i = 1; i < pts.length; i++) raw += haversineMeters(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
  let dopplerIntegral = 0;
  for (let i = 1; i < pts.length; i++) dopplerIntegral += ((pts[i - 1].speedMPS + pts[i].speedMPS) / 2) * ((pts[i].timestamp - pts[i - 1].timestamp) / 1000);
  const r = run(pts);
  assert.ok(raw > dopplerIntegral * 1.04, `raw ${raw} should overshoot the phone-speed distance ${dopplerIntegral}`);
  assert.ok(Math.abs(r.meters - dopplerIntegral) / dopplerIntegral < 0.02, `filtered ${r.meters} vs ${dopplerIntegral}`);
  assert.ok(r.points.length >= pts.length - 4, 'only a few spike fixes may be dropped');
});

console.log(`\n${passed} passed`);
