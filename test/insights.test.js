/**
 * insights.test.js — run with: node test/insights.test.js
 * Rides are synthetic: straight lines north at a known speed, so the expected
 * numbers can be worked out by hand.
 */
const assert = require('assert');
const I = require('../js/insights.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n    ${err.stack}`); process.exitCode = 1; }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} ±${tol}, got ${a}`);

const M_PER_DEG_LAT = (2 * Math.PI * 6371000) / 360;   // ≈ 111,195 m
/** Builds a northbound track from [[seconds, metresPerSecond], ...] legs, one fix per second. */
function track(legs, { t0 = 1_700_000_000_000, alt = null } = {}) {
  const pts = [];
  let lat = 33.77, t = t0, i = 0;
  const push = () => pts.push({ lat, lon: -118.19, altitude: alt ? alt(i) : 0, speedMPS: 0, timestamp: t });
  push();
  for (const [seconds, mps] of legs) {
    for (let s = 0; s < seconds; s++) { lat += mps / M_PER_DEG_LAT; t += 1000; i++; push(); }
  }
  return pts;
}
const distance = (pts) => pts.slice(1).reduce((n, p, k) => n + I.distanceMeters(pts[k].lat, pts[k].lon, p.lat, p.lon), 0);

console.log('insights (ride stats, range estimate, route colours)\n');

test('moving vs stopped time and average moving speed', () => {
  const pts = track([[60, 5], [20, 0], [20, 5]]);
  const s = I.rideStats({ points: pts, distanceMeters: distance(pts) });
  near(s.movingSeconds, 80, 1, 'moving');
  near(s.stoppedSeconds, 20, 1, 'stopped');
  near(s.avgMovingKph, 18, 0.2, 'avg moving km/h');   // 5 m/s = 18 km/h
});

test('GPS max speed is close to the true steady speed', () => {
  const pts = track([[30, 4], [30, 6]]);
  near(I.rideStats({ points: pts, distanceMeters: distance(pts) }).gpsMaxKph, 21.6, 0.3, 'max');   // 6 m/s
});

test('a long gap in GPS is lost signal: neither moving nor stopped, and not a speed spike', () => {
  const a = track([[30, 5]]);
  const b = track([[30, 5]], { t0: a[a.length - 1].timestamp + 120_000 });
  b.forEach((p) => { p.lat += 0.01; });                     // jumped ~1.1 km while the signal was lost
  const pts = [...a, ...b];
  const s = I.rideStats({ points: pts, distanceMeters: distance(pts) });
  near(s.movingSeconds, 58, 2, 'moving excludes the gap');
  assert.strictEqual(s.stoppedSeconds, 0);
  near(s.gpsMaxKph, 18, 0.5, 'the jump must not become a 9 m/s+ record');
});

test('elevation: steady climb is counted, GPS jitter is not', () => {
  const climb = track([[10, 0]]).map((p, i) => ({ ...p, altitude: 100 + i * 2 }));    // +2 m per fix
  near(I.elevationChange(climb).gainMeters, 20, 3, 'gain');
  assert.strictEqual(I.elevationChange(climb).lossMeters, 0);
  const jitter = climb.map((p, i) => ({ ...p, altitude: 100 + (i % 2 ? 1 : -1) }));
  assert.deepStrictEqual(I.elevationChange(jitter), { gainMeters: 0, lossMeters: 0 });
  const down = climb.slice().reverse();
  assert.ok(I.elevationChange(down).lossMeters >= 17);
});

test('elevation is null when the phone gave no altitude (all zeros) or too few points', () => {
  assert.strictEqual(I.elevationChange(track([[10, 5]])), null);
  assert.strictEqual(I.elevationChange([{ altitude: 5 }]), null);
  assert.strictEqual(I.elevationChange([]), null);
});

test('battery used and miles per percent', () => {
  const ride = { points: [], distanceMeters: 3 * I.METERS_PER_MILE, startSOC: 80, endSOC: 74 };
  const s = I.rideStats(ride);
  assert.strictEqual(s.batteryUsedPct, 6);
  near(s.milesPerPct, 0.5, 1e-9);
});

test('battery numbers are null when unknown, nonsensical, or too small to trust', () => {
  assert.strictEqual(I.rideStats({ points: [], distanceMeters: 1000 }).batteryUsedPct, null);
  assert.strictEqual(I.rideStats({ points: [], distanceMeters: 1000, startSOC: 50, endSOC: 60 }).batteryUsedPct, null);
  const zero = I.rideStats({ points: [], distanceMeters: 1000, startSOC: 50, endSOC: 50 });
  assert.strictEqual(zero.batteryUsedPct, 0);
  assert.strictEqual(zero.milesPerPct, null, 'no efficiency from a 0% drop');
});

test('scooter top speed is passed through only when positive', () => {
  assert.strictEqual(I.rideStats({ points: [], topSpeedKPH: 17.8 }).scooterTopKph, 17.8);
  assert.strictEqual(I.rideStats({ points: [], topSpeedKPH: 0 }).scooterTopKph, null);
  assert.strictEqual(I.rideStats({ points: [] }).scooterTopKph, null);
});

test('stats cope with an empty or malformed ride without throwing', () => {
  assert.doesNotThrow(() => I.rideStats({}));
  const s = I.rideStats({ points: [null, { lat: 'x' }, {}] });
  assert.strictEqual(s.movingSeconds, 0);
  assert.strictEqual(s.gpsMaxKph, null);
});

// ---- range estimate
const ride = (miles, used, startDate, extra = {}) => ({
  startDate, distanceMeters: miles * I.METERS_PER_MILE, startSOC: 90, endSOC: 90 - used, ...extra,
});

test('range pools rides: total miles over total percent, times current battery', () => {
  const r = I.rangeEstimate([ride(2, 8, 3), ride(2, 8, 2), ride(2, 8, 1)], 50);
  near(r.milesPerPct, 0.25, 1e-9);
  near(r.miles, 12.5, 1e-9);
  assert.strictEqual(r.rides, 3);
  assert.strictEqual(r.usedPct, 24);
  assert.strictEqual(r.confidence, 'good');
});

test('pooling weighs long rides more than short ones (ratio of sums, not mean of ratios)', () => {
  const r = I.rangeEstimate([ride(10, 20, 2), ride(0.5, 2, 1)], 100);   // 0.5 and 0.25 mi/% -> pooled 10.5/22
  near(r.milesPerPct, 10.5 / 22, 1e-9);
});

test('one short sample is labelled rough', () => {
  const r = I.rangeEstimate([ride(1, 4, 1)], 60);
  assert.strictEqual(r.confidence, 'rough');
  assert.strictEqual(r.rides, 1);
});

test('simulated, too-short, too-small-drop and incomplete rides are ignored', () => {
  const rides = [
    ride(5, 10, 1, { simulated: true }),
    ride(0.1, 5, 2),
    ride(3, 1, 3),
    { startDate: 4, distanceMeters: 5000 },
    ride(2, 8, 5),
  ];
  const r = I.rangeEstimate(rides, 40);
  assert.strictEqual(r.rides, 1);
  near(r.milesPerPct, 0.25, 1e-9);
});

test('only the most recent rides are used', () => {
  const old = Array.from({ length: 10 }, (_, i) => ride(1, 10, i + 1));              // 0.1 mi/%
  const recent = Array.from({ length: 10 }, (_, i) => ride(4, 10, 100 + i));         // 0.4 mi/%
  near(I.rangeEstimate([...old, ...recent], 10).milesPerPct, 0.4, 1e-9);
});

test('no usable rides gives null; unknown battery gives a rate but no miles', () => {
  assert.strictEqual(I.rangeEstimate([], 50), null);
  assert.strictEqual(I.rangeEstimate([ride(5, 10, 1, { simulated: true })], 50), null);
  const r = I.rangeEstimate([ride(2, 8, 1)], null);
  assert.strictEqual(r.miles, null);
  assert.ok(r.milesPerPct > 0);
});

// ---- route colours
test('speed colour steps up with speed and clamps at both ends', () => {
  const c = (k) => I.speedColor(k, 30);
  assert.strictEqual(c(0), I.SPEED_RAMP[0]);
  assert.strictEqual(c(29), I.SPEED_RAMP[4]);
  assert.strictEqual(c(500), I.SPEED_RAMP[4]);
  assert.strictEqual(c(-5), I.SPEED_RAMP[0]);
  assert.notStrictEqual(c(3), c(20));
  assert.strictEqual(I.speedColor(10, 0), I.SPEED_RAMP[0]);
  assert.strictEqual(I.speedColor(NaN, 30), I.SPEED_RAMP[0]);
});

test('coloured route merges same-speed neighbours and starts a new line when speed band changes', () => {
  const pts = track([[20, 1], [20, 8]]);                      // 3.6 km/h then 28.8 km/h
  const route = I.colouredRoute(pts, 30);
  assert.strictEqual(route.length, 2, JSON.stringify(route.map((r) => r.color)));
  assert.notStrictEqual(route[0].color, route[1].color);
  assert.ok(route[0].latlngs.length >= 19 && route[1].latlngs.length >= 19);
  const joint = route[0].latlngs[route[0].latlngs.length - 1];
  assert.deepStrictEqual(route[1].latlngs[0], joint, 'lines must join end to start');
});

test('coloured route is empty for fewer than two fixes and breaks at signal gaps', () => {
  assert.deepStrictEqual(I.colouredRoute([], 30), []);
  assert.deepStrictEqual(I.colouredRoute(track([]), 30), []);
  const a = track([[5, 3]]);
  const b = track([[5, 3]], { t0: a[a.length - 1].timestamp + 90_000 });
  const route = I.colouredRoute([...a, ...b], 30);
  assert.ok(route.length >= 2, 'a gap must not be joined into one continuous line');
});

// ---- phone speed readings and position steps (found on a real ride) ----
test('speeds come from the phone reading when present, not from jumpy positions', () => {
  // Steady 5 m/s (18 km/h) reading, but one fix lands 17 m ahead (a GPS blip).
  const pts = track([[40, 5]]).map((p) => ({ ...p, speedMPS: 5 }));
  for (let i = 20; i < pts.length; i++) pts[i] = { ...pts[i], lat: pts[i].lat + 17 / M_PER_DEG_LAT };
  const s = I.rideStats({ points: pts, distanceMeters: distance(pts) });
  near(s.gpsMaxKph, 18, 0.5, 'top speed follows the reading');
  near(s.avgMovingKph, 18, 0.5, 'average follows the reading');
});

test('a ride whose readings are all zero falls back to position-derived speed', () => {
  const pts = track([[30, 6]]);
  const s = I.rideStats({ points: pts, distanceMeters: distance(pts) });
  near(s.gpsMaxKph, 21.6, 0.5, 'fallback top speed');
});

test('the reading is trusted less at a standstill: ~1 km/h of noise counts as stopped', () => {
  const pts = track([[30, 5], [30, 0]]);
  pts.forEach((p, i) => { p.speedMPS = i < 30 ? 5 : 0.3; });     // 0.3 m/s ~ 1 km/h of reading noise
  const s = I.rideStats({ points: pts, distanceMeters: distance(pts) });
  assert.ok(s.stoppedSeconds >= 28, `stopped ${s.stoppedSeconds}`);
  near(s.avgMovingKph, 18, 0.7, 'standstill noise must not drag the moving average');
});

test('a flagged position step is treated as a gap, not as movement', () => {
  const pts = track([[30, 5]]).map((p) => ({ ...p, speedMPS: 5 }));
  for (let i = 15; i < pts.length; i++) pts[i] = { ...pts[i], lat: pts[i].lat + 17 / M_PER_DEG_LAT };
  pts[15] = { ...pts[15], jump: true };
  const segs = I.segments(pts);
  assert.strictEqual(segs.filter((s) => s.gap).length, 1);
  near(I.rideStats({ points: pts, distanceMeters: distance(pts) }).gpsMaxKph, 18, 0.5, 'the step must not set the top speed');
});

test('real ride (relocated): top speed matches the phone reading, not the GPS jumps', () => {
  const fs = require('fs');
  const rows = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'fixtures', 'real-ride-relocated.json'), 'utf8')).rows;
  const pts = rows.map(([ms, lat, lon, alt, kph]) => ({ lat, lon, altitude: alt, speedMPS: kph / 3.6, timestamp: 1e12 + ms }));
  const s = I.rideStats({ points: pts, distanceMeters: distance(pts) });
  assert.ok(s.gpsMaxKph > 27 && s.gpsMaxKph < 31, `top speed ${s.gpsMaxKph}`);
  assert.ok(s.avgMovingKph > 21 && s.avgMovingKph < 24.5, `average ${s.avgMovingKph}`);
});

console.log(`\n${passed} passed`);
