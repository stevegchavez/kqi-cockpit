/**
 * garage.test.js — run with: node test/garage.test.js
 */
const assert = require('assert');
const G = require('../js/garage.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n    ${err.stack}`); process.exitCode = 1; }
}
const MI = G.METERS_PER_MILE;
const ride = (miles, extra) => Object.assign({ distanceMeters: miles * MI, startDate: 1 }, extra);
function memStorage() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; }

console.log('garage (odometer, maintenance)\n');

test('odometer: real rides plus the offset; demo rides do not count', () => {
  const rides = [ride(10), ride(5.5), ride(100, { simulated: true })];
  assert.ok(Math.abs(G.odometer(rides, { offsetMiles: 0, log: [] }) - 15.5) < 1e-9);
  const d = G.setOdometer(rides, { offsetMiles: 0, log: [] }, 412);
  assert.ok(Math.abs(G.odometer(rides, d) - 412) < 1e-9, 'matches the scooter display after setting');
  assert.ok(Math.abs(G.odometer(rides.concat([ride(3)]), d) - 415) < 1e-9, 'and keeps counting from there');
});

test('setOdometer rejects nonsense', () => {
  for (const bad of [NaN, -1, 1e9, '12']) assert.throws(() => G.setOdometer([], { offsetMiles: 0, log: [] }, bad), /number of miles/);
});

test('maintenance: never-done checks count from zero, done checks from when they were done', () => {
  let d = { offsetMiles: 0, log: [] };
  let s = G.status(d, 120);
  const tyres = () => s.find((x) => x.item.id === 'tyres');
  assert.strictEqual(tyres().due, true, '120 mi with no tyre check logged: due');
  d = G.markDone(d, 'tyres', 120, 1000);
  s = G.status(d, 130);
  assert.strictEqual(tyres().due, false);
  assert.strictEqual(tyres().milesSince, 10);
  assert.strictEqual(tyres().dueInMiles, 90);
  s = G.status(d, 210);
  assert.strictEqual(tyres().soon, true, '10 mi left of 100 is "soon"');
  assert.strictEqual(s[0].due || s[0].soon, true, 'most urgent first');
});

test('markDone refuses unknown items', () => {
  assert.throws(() => G.markDone({ offsetMiles: 0, log: [] }, 'turbo', 1), /Unknown/);
});

test('load/save round-trip, tolerate junk, and cap the log', () => {
  const st = memStorage();
  assert.deepStrictEqual(G.load(st), { offsetMiles: 0, log: [] });
  st.setItem(G.KEY, '{not json');
  assert.deepStrictEqual(G.load(st), { offsetMiles: 0, log: [] });
  st.setItem(G.KEY, JSON.stringify({ offsetMiles: 'x', log: [{ id: 'tyres', atMiles: 5, t: 1 }, { id: 3 }, null] }));
  assert.deepStrictEqual(G.load(st), { offsetMiles: 0, log: [{ id: 'tyres', atMiles: 5, t: 1 }] });
  let d = { offsetMiles: 7, log: [] };
  for (let i = 0; i < 250; i++) d = G.markDone(d, 'tyres', i, i);
  G.save(st, d);
  const back = G.load(st);
  assert.strictEqual(back.offsetMiles, 7);
  assert.strictEqual(back.log.length, 200);
  assert.strictEqual(back.log[199].atMiles, 249, 'newest entries kept');
});

console.log(`\n${passed} passed`);
