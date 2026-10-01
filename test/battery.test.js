/**
 * battery.test.js — run with: node test/battery.test.js
 */
const assert = require('assert');
require('fake-indexeddb/auto');
const B = require('../js/battery.js');
const Charts = require('../js/charts.js');

let passed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
const MIN = 60000, DAY = 86400000, T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const s = (t, soc, extra = {}) => ({ t, soc, soh: 93, cycles: 151, on: true, ...extra });

console.log('battery (history rules, charge inference, trend, store) + charts\n');

test('always records the first sample, but never one without a battery reading', () => {
  assert.strictEqual(B.shouldRecord(null, s(T0, 59)), true);
  assert.strictEqual(B.shouldRecord(null, { t: T0 }), false);
  assert.strictEqual(B.shouldRecord(null, null), false);
});

test('a battery % wobble within 30 s is ignored, but a real change after that is kept', () => {
  assert.strictEqual(B.shouldRecord(s(T0, 59), s(T0 + 5000, 58)), false);
  assert.strictEqual(B.shouldRecord(s(T0, 59), s(T0 + 31000, 58)), true);
});

test('health, cycle or power-state changes are recorded immediately', () => {
  assert.strictEqual(B.shouldRecord(s(T0, 59), s(T0 + 1000, 59, { soh: 92 })), true);
  assert.strictEqual(B.shouldRecord(s(T0, 59), s(T0 + 1000, 59, { cycles: 152 })), true);
  assert.strictEqual(B.shouldRecord(s(T0, 59), s(T0 + 1000, 59, { on: false })), true);
});

test('an unchanged reading is recorded only as a 10-minute heartbeat', () => {
  assert.strictEqual(B.shouldRecord(s(T0, 59), s(T0 + 9 * MIN, 59)), false);
  assert.strictEqual(B.shouldRecord(s(T0, 59), s(T0 + 10 * MIN, 59)), true);
});

test('out-of-order timestamps are never recorded', () => {
  assert.strictEqual(B.shouldRecord(s(T0, 59), s(T0 - 1000, 40)), false);
  assert.strictEqual(B.shouldRecord(s(T0, 59), s(T0, 58)), false);
});

test('charges are inferred from a big rise between samples, not from small wobble', () => {
  const samples = [s(T0, 80), s(T0 + 5 * MIN, 45), s(T0 + 600 * MIN, 100), s(T0 + 605 * MIN, 99), s(T0 + 700 * MIN, 50), s(T0 + 705 * MIN, 54)];
  const c = B.inferCharges(samples);
  assert.strictEqual(c.length, 1);
  assert.deepStrictEqual({ a: c[0].fromSOC, b: c[0].toSOC }, { a: 45, b: 100 });
  assert.deepStrictEqual(B.inferCharges([]), []);
  assert.strictEqual(B.inferCharges([s(T0, 50), s(T0 + MIN, 59)]).length, 0, '9% is below the default threshold');
  assert.strictEqual(B.inferCharges([s(T0, 50), s(T0 + MIN, 59)], 5).length, 1);
});

test('daily series keeps the last value of each day, in order', () => {
  const samples = [s(T0, 80), s(T0 + 2 * 60 * MIN, 70), s(T0 + DAY, 100), s(T0 + 2 * DAY, 60), s(T0 + 2 * DAY + MIN, 55)];
  const d = B.dailySeries(samples, 'soc', 0);
  assert.deepStrictEqual(d.map((p) => p.y), [70, 100, 55]);
  assert.ok(d[0].x < d[1].x && d[1].x < d[2].x);
  assert.deepStrictEqual(B.dailySeries([s(T0, 80, { soh: undefined })], 'soh', 0), []);
});

test('daily series respects the timezone when deciding where a day ends', () => {
  const lateEvening = Date.UTC(2026, 9, 1, 23, 30);     // 23:30 UTC = 16:30 in UTC-7
  const earlyMorning = Date.UTC(2026, 9, 2, 3, 0);      // 03:00 UTC = 20:00 same local day in UTC-7
  assert.strictEqual(B.dailySeries([s(lateEvening, 10), s(earlyMorning, 20)], 'soc', 0).length, 2);
  assert.strictEqual(B.dailySeries([s(lateEvening, 10), s(earlyMorning, 20)], 'soc', 420).length, 1);
});

test('health trend needs 3 days and 10 cycles of spread, reports what was observed, and only projects with 50+ cycles', () => {
  assert.strictEqual(B.healthTrend([s(T0, 50)], 0), null);
  assert.strictEqual(B.healthTrend([s(T0, 50), s(T0 + DAY, 50, { cycles: 152 }), s(T0 + 2 * DAY, 50, { cycles: 153 })], 0), null);
  const decline = [0, 1, 2, 3].map((d) => s(T0 + d * DAY, 50, { cycles: 150 + d * 10, soh: 95 - d }));   // -1% per 10 cycles
  const t = B.healthTrend(decline, 0);
  assert.ok(Math.abs(t.perHundredCycles - -10) < 1e-9, `got ${t.perHundredCycles}`);
  assert.strictEqual(t.spanCycles, 30);
  assert.strictEqual(t.days, 4);
  assert.deepStrictEqual({ from: t.fromHealth, to: t.toHealth }, { from: 95, to: 92 });
  assert.strictEqual(t.extrapolate, false, '30 cycles is too little to project per 100 cycles');
  const long = [0, 1, 2, 3, 4, 5, 6].map((d) => s(T0 + d * DAY, 50, { cycles: 100 + d * 10, soh: 95 - Math.floor(d / 2) }));
  assert.strictEqual(B.healthTrend(long, 0).extrapolate, true, '60 cycles is enough to project');
  const flat = [0, 1, 2].map((d) => s(T0 + d * DAY, 50, { cycles: 150 + d * 10, soh: 93 }));
  assert.strictEqual(B.healthTrend(flat, 0).perHundredCycles, 0);
});

test('health trend uses the earliest and latest day for from/to regardless of input order', () => {
  const rows = [2, 0, 1, 3].map((d) => s(T0 + d * DAY, 50, { cycles: 150 + d * 10, soh: 95 - d }));
  const t = B.healthTrend(rows, 0);
  assert.deepStrictEqual({ from: t.fromHealth, to: t.toHealth }, { from: 95, to: 92 });
});

test('store: add, read back oldest-first, last, count, clear', async () => {
  const store = new B.BatteryStore();
  await store.add(s(T0 + 2000, 58));
  await store.add(s(T0, 59));
  await store.add(s(T0 + 1000, 59, { on: false }));
  assert.strictEqual(await store.count(), 3);
  assert.deepStrictEqual((await store.all()).map((x) => x.t), [T0, T0 + 1000, T0 + 2000]);
  assert.strictEqual((await store.last()).t, T0 + 2000);
  await store.clear();
  assert.strictEqual(await store.count(), 0);
  assert.strictEqual(await store.last(), null);
});

test('store: prune removes the oldest samples first', async () => {
  const store = new B.BatteryStore();
  await store.clear();
  for (let i = 0; i < 10; i++) await store.add(s(T0 + i * 1000, 50));
  assert.strictEqual(await store.prune(4), 6);
  assert.deepStrictEqual((await store.all()).map((x) => x.t), [6, 7, 8, 9].map((i) => T0 + i * 1000));
  assert.strictEqual(await store.prune(100), 0);
});

// ---- charts
test('chart: empty data gives no markup; one point gives a dot; many give a path', () => {
  assert.strictEqual(Charts.lineChart([]), '');
  assert.strictEqual(Charts.lineChart(null), '');
  const one = Charts.lineChart([{ x: 1, y: 5 }]);
  assert.ok(one.includes('<circle') && !one.includes('<path'));
  const many = Charts.lineChart([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 2 }]);
  assert.ok(many.includes('<path class="chart-line"'));
  assert.ok(!/NaN|undefined|Infinity/.test(many));
});

test('chart: flat data still draws, and non-finite points are skipped', () => {
  const flat = Charts.lineChart([{ x: 0, y: 93 }, { x: 1, y: 93 }]);
  assert.ok(flat.includes('<path') && !/NaN|Infinity/.test(flat));
  const dirty = Charts.lineChart([{ x: 0, y: NaN }, { x: 1, y: 2 }, { x: Infinity, y: 1 }]);
  assert.ok(!/NaN|Infinity/.test(dirty));
});

test('chart: labels are escaped and the y range can be pinned', () => {
  const svg = Charts.lineChart([{ x: 0, y: 10 }, { x: 1, y: 20 }], { label: '<b>"x"</b>', yMin: 0, yMax: 100, unit: '%' });
  assert.ok(!svg.includes('<b>'));
  assert.ok(svg.includes('aria-label="&lt;b&gt;&quot;x&quot;&lt;/b&gt;"'));
  assert.ok(svg.includes('>100%<') && svg.includes('>0%<'));
});

test('chart: x labels appear only when a formatter is given', () => {
  const pts = [{ x: 1, y: 1 }, { x: 9, y: 2 }];
  assert.ok(!Charts.lineChart(pts).includes('text-anchor="start"'));
  const svg = Charts.lineChart(pts, { xFormat: (x) => `d${x}` });
  assert.ok(svg.includes('>d1<') && svg.includes('>d9<'));
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; console.log(`  ok - ${name}`); }
    catch (err) { console.error(`  FAIL - ${name}\n    ${err.stack}`); process.exitCode = 1; }
  }
  console.log(`\n${passed} passed`);
})();
