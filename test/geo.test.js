/**
 * geo.test.js — run with: node test/geo.test.js
 */
const assert = require('assert');
require('../js/geo.js'); // attaches to globalThis.NIU since no module.exports branch needed here
const { haversineMeters } = globalThis.NIU;

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

console.log(`\n${passed} passed`);
