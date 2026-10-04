/**
 * planner.test.js — run with: node test/planner.test.js
 * The network is faked with canned replies shaped like Nominatim and OSRM answers.
 * These prove the app's handling of such replies; they do NOT prove the live services answer
 * in exactly this shape (that has to be tried on a phone with a connection).
 */
const assert = require('assert');
const Pl = require('../js/planner.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n    ${err.stack}`); process.exitCode = 1; }
}
const M_LAT = (2 * Math.PI * 6371000) / 360;
const ORIGIN = { lat: 40, lon: -100 };          // an unremarkable made-up place
const north = (m) => ORIGIN.lat + m / M_LAT;
const east = (m) => ORIGIN.lon + m / (M_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180));

/** 1000 m north, then a right turn and 500 m east, in 25 m vertices (GeoJSON order: lon, lat). */
function osrmBody() {
  const coordinates = [];
  for (let m = 0; m <= 1000; m += 25) coordinates.push([ORIGIN.lon, north(m)]);
  for (let m = 25; m <= 500; m += 25) coordinates.push([east(m), north(1000)]);
  return {
    code: 'Ok',
    routes: [{
      distance: 1500, duration: 400,
      geometry: { type: 'LineString', coordinates },
      legs: [{ steps: [
        { distance: 1000, name: 'Elm Street', maneuver: { type: 'depart', location: [ORIGIN.lon, north(0)] } },
        { distance: 500, name: 'Oak Avenue', maneuver: { type: 'turn', modifier: 'right', location: [ORIGIN.lon, north(1000)] } },
        { distance: 0, name: '', maneuver: { type: 'arrive', location: [east(500), north(1000)] } },
      ] }],
    }],
  };
}
const okJSON = (body) => async () => ({ ok: true, status: 200, json: async () => body });

(async () => {
  console.log('planner (place search, routing, directions, estimates, following)\n');

  await test('geocode returns cleaned results and builds a safe URL', async () => {
    let seen;
    const f = async (url) => { seen = url; return { ok: true, json: async () => [
      { display_name: 'Cafe One, Main St', lat: '40.001', lon: '-100.002' },
      { display_name: 'Bad one', lat: 'x', lon: '1' },
      { display_name: '', lat: '1', lon: '1' },
    ] }; };
    const r = await Pl.geocode('cafe & bar?', f);
    assert.deepStrictEqual(r, [{ name: 'Cafe One, Main St', lat: 40.001, lon: -100.002 }]);
    assert.ok(seen.includes('q=cafe%20%26%20bar%3F'), seen);
    assert.ok(seen.startsWith('https://nominatim.openstreetmap.org/'));
  });

  await test('geocode rejects tiny queries without calling the network', async () => {
    let called = false;
    await assert.rejects(() => Pl.geocode(' a ', async () => { called = true; }), /at least two/);
    assert.strictEqual(called, false);
  });

  await test('network and server failures become readable errors', async () => {
    await assert.rejects(() => Pl.geocode('abc', async () => { throw new TypeError('Failed to fetch'); }), /could not reach the internet/);
    await assert.rejects(() => Pl.geocode('abc', async () => ({ ok: false, status: 429 })), /failed \(429\)/);
    await assert.rejects(() => Pl.geocode('abc', async () => ({ ok: true, json: async () => { throw new Error('x'); } })), /could not be read/);
  });

  await test('route parses geometry, steps and positions of each turn along the route', async () => {
    let seen;
    const rt = await Pl.route({ lat: north(0), lon: ORIGIN.lon }, { lat: north(1000), lon: east(500) }, async (u) => { seen = u; return { ok: true, json: async () => osrmBody() }; });
    assert.ok(seen.startsWith('https://routing.openstreetmap.de/routed-bike/route/v1/driving/-100,40;'));
    assert.ok(seen.includes('steps=true') && seen.includes('geometries=geojson'));
    assert.strictEqual(rt.coords[0][0], north(0));         // [lat, lon] order after parsing
    assert.strictEqual(rt.steps.length, 3);
    assert.ok(Math.abs(rt.steps[1].at - 1000) < 2, `turn at ${rt.steps[1].at}`);
    assert.ok(Math.abs(rt.cum[rt.cum.length - 1] - 1500) < 5);
    assert.strictEqual(rt.steps[1].text, 'Turn right onto Oak Avenue');
    assert.strictEqual(rt.steps[0].text, 'Head out on Elm Street');
    assert.strictEqual(rt.steps[2].text, 'Arrive at your destination');
  });

  await test('route refuses bad input and reports "no route" clearly', async () => {
    const A = { lat: north(0), lon: ORIGIN.lon }, B = { lat: north(1000), lon: ORIGIN.lon };
    await assert.rejects(() => Pl.route(null, B, okJSON({})), /start and a destination/);
    await assert.rejects(() => Pl.route(A, { lat: north(5), lon: ORIGIN.lon }, okJSON({})), /same place/);
    await assert.rejects(() => Pl.route(A, B, okJSON({ code: 'NoRoute' })), /No route was found/);
    await assert.rejects(() => Pl.route(A, B, okJSON({ code: 'Ok', routes: [{ geometry: { coordinates: [[1, 2]] } }] })), /came back empty/);
  });

  await test('instructions read naturally for common maneuvers', () => {
    const i = Pl.instruction;
    assert.strictEqual(i({ type: 'turn', modifier: 'sharp left' }, 'A St'), 'Turn sharp left onto A St');
    assert.strictEqual(i({ type: 'roundabout', exit: 2 }, 'B Rd'), 'At the roundabout, take the 2nd exit onto B Rd');
    assert.strictEqual(i({ type: 'continue', modifier: 'straight' }, 'C Ave'), 'Continue on C Ave');
    assert.strictEqual(i({ type: 'fork', modifier: 'slight left' }, ''), 'Keep left at the fork');
    assert.strictEqual(i({ type: 'something new' }, ''), 'Continue');
  });

  await test('estimate: uses the rider\'s own speed, plans below the limit otherwise, and says when it can\'t judge battery', () => {
    const rt = { distance: 8046.72 };                     // 5.0 miles
    const a = Pl.estimate(rt, { maxKph: 30 });
    assert.strictEqual(a.speedSource, 'assumed');
    assert.ok(Math.abs(a.cruiseKph - 21) < 1e-9);
    assert.ok(Math.abs(a.minutes - (8.04672 / 21) * 60) < 0.01);
    assert.strictEqual(a.verdict, 'unknown');
    assert.strictEqual(a.batteryNeededPct, null);
    const b = Pl.estimate(rt, { maxKph: 30, avgMovingKph: 22.8 });
    assert.strictEqual(b.speedSource, 'your rides');
    assert.ok(Math.abs(b.cruiseKph - 22.8) < 1e-9);
    const cap = Pl.estimate(rt, { maxKph: 30, avgMovingKph: 45 });
    assert.strictEqual(cap.cruiseKph, 30, 'never plan faster than the scooter\'s limit');
  });

  await test('estimate: battery verdicts at the boundaries', () => {
    const rt = { distance: 8046.72 };                     // 5 miles at 0.25 mi/% needs 20%
    const v = (soc) => Pl.estimate(rt, { milesPerPct: 0.25, soc }).verdict;
    assert.strictEqual(v(80), 'ok');                      // arrive with 60
    assert.strictEqual(v(40), 'tight');                   // arrive with 20
    assert.strictEqual(v(28), 'no');                      // arrive with 8
    const e = Pl.estimate(rt, { milesPerPct: 0.25, soc: 80 });
    assert.ok(Math.abs(e.batteryNeededPct - 20) < 1e-9 && Math.abs(e.arriveSOC - 60) < 1e-9 && Math.abs(e.returnSOC - 40) < 1e-9);
  });

  await test('locate: progress, next turn and distance to it along the route', async () => {
    const rt = Pl.parseRoute(osrmBody().routes[0]);
    const l = Pl.locate(rt, { lat: north(600), lon: ORIGIN.lon }, 0);
    assert.ok(Math.abs(l.progress - 600) < 13, `progress ${l.progress}`);
    assert.strictEqual(l.next.type, 'turn');
    assert.ok(Math.abs(l.toNext - 400) < 15);
    assert.ok(Math.abs(l.remaining - 900) < 15);
    assert.strictEqual(l.isOff, false);
    assert.strictEqual(l.arrived, false);
  });

  await test('locate: after the turn the next step is the arrival; at the end it reports arrived', async () => {
    const rt = Pl.parseRoute(osrmBody().routes[0]);
    const mid = Pl.locate(rt, { lat: north(1000), lon: east(200) }, 0);
    assert.strictEqual(mid.next.type, 'arrive');
    const end = Pl.locate(rt, { lat: north(1000), lon: east(495) }, mid.index);
    assert.strictEqual(end.arrived, true);
  });

  await test('locate: flags a rider who has left the route, and recovers when found again', async () => {
    const rt = Pl.parseRoute(osrmBody().routes[0]);
    const off = Pl.locate(rt, { lat: north(500), lon: east(-150) }, 0);   // 150 m west of the road
    assert.strictEqual(off.isOff, true);
    assert.ok(off.offRoute > 100);
    const back = Pl.locate(rt, { lat: north(900), lon: ORIGIN.lon }, off.index);
    assert.strictEqual(back.isOff, false);
  });

  await test('locate: a route that doubles back does not jump the rider to the return leg', () => {
    // Out 500 m north, then straight back south 500 m along (nearly) the same road.
    const coords = [];
    for (let m = 0; m <= 500; m += 25) coords.push([north(m), ORIGIN.lon]);
    for (let m = 475; m >= 0; m -= 25) coords.push([north(m), east(4)]);
    const rt = { coords, cum: null, distance: 0, steps: [] };
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + Pl.haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
    rt.cum = cum; rt.distance = cum[cum.length - 1];
    const l = Pl.locate(rt, { lat: north(200), lon: ORIGIN.lon }, 8);
    assert.ok(l.progress < 300, `should still be on the outward leg, progress ${l.progress}`);
  });

  await test('formatting: metric and imperial, short and long', () => {
    assert.strictEqual(Pl.formatDistance(240, false), '240 m');
    assert.strictEqual(Pl.formatDistance(2345, false), '2.35 km');
    assert.strictEqual(Pl.formatDistance(120, true), '390 ft');
    assert.strictEqual(Pl.formatDistance(8046.72, true), '5.00 mi');
    assert.strictEqual(Pl.formatMinutes(0.2), '1 min');
    assert.strictEqual(Pl.formatMinutes(75), '1 h 15 min');
  });

  console.log(`\n${passed} passed`);
})();
