/**
 * keystore.test.js — run with: node test/keystore.test.js
 * Uses made-up TEST keys only.
 */
const assert = require('assert');

// Minimal in-memory localStorage so the real module can be exercised.
function installStorage({ throws = false } = {}) {
  const data = new Map();
  global.localStorage = {
    getItem: (k) => { if (throws) throw new Error('blocked'); return data.has(k) ? data.get(k) : null; },
    setItem: (k, v) => { if (throws) throw new Error('blocked'); data.set(k, String(v)); },
    removeItem: (k) => data.delete(k),
    _data: data,
  };
}
installStorage();
const K = require('../js/keystore.js');

const PWD = '0123456789abcdef';
const AES = 'fedcba9876543210';
const AES32 = '00112233445566778899aabbccddeeff';

let passed = 0;
function test(name, fn) {
  try { installStorage(); fn(); passed++; console.log(`  ok - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n    ${err.stack}`); process.exitCode = 1; }
}

console.log('keystore (parse, validate, store)\n');

test('parses the niu-kqi scooter.json layout (keys under "ble")', () => {
  const json = JSON.stringify({ sn: 'x', ble: { mac: 'AA:BB:CC:DD:EE:FF', password: PWD, aes: AES, name: 'KQi' } });
  assert.deepStrictEqual(K.parseKeys(json), { password: PWD, aes: AES });
});

test('parses flat JSON in either naming convention', () => {
  assert.deepStrictEqual(K.parseKeys(`{"password":"${PWD}","aes":"${AES}"}`), { password: PWD, aes: AES });
  assert.deepStrictEqual(K.parseKeys(`{"blePassword":"${PWD}","bleAes":"${AES32}"}`), { password: PWD, aes: AES32 });
});

test('parses two plain lines, tolerating blank lines and Windows line endings', () => {
  assert.deepStrictEqual(K.parseKeys(`\n${PWD}\r\n\r\n${AES}\n`), { password: PWD, aes: AES });
});

test('rejects empty, malformed and wrong-length input with helpful messages', () => {
  assert.throws(() => K.parseKeys(''), /Paste your scooter keys/);
  assert.throws(() => K.parseKeys('   '), /Paste your scooter keys/);
  assert.throws(() => K.parseKeys('{not json'), /could not be read/);
  assert.throws(() => K.parseKeys(PWD), /two lines/);
  assert.throws(() => K.parseKeys(`short\n${AES}`), /exactly 16 characters/);
  assert.throws(() => K.parseKeys(`${PWD}\nnope`), /AES key must be 16 characters or 32 hex/);
  assert.throws(() => K.parseKeys('{"ble":{}}'), /exactly 16 characters/);
  assert.throws(() => K.parseKeys(`${PWD}\n${AES}\nextra`), /two lines/);
});

test('error messages never contain key material', () => {
  const secret = 'SUPERSECRET12345';             // 16 chars
  const attempts = [`${secret}\nnope`, `{"password":"${secret}","aes":"bad"}`, `${secret}`, `{"password":"${secret}`];
  for (const input of attempts) {
    try { K.parseKeys(input); assert.fail('should have thrown'); }
    catch (e) { assert.ok(!e.message.includes(secret), `leaked in: ${e.message}`); }
  }
});

test('save/load round-trips and clear removes the keys', () => {
  assert.strictEqual(K.has(), false);
  assert.strictEqual(K.save({ password: PWD, aes: AES }), true);
  assert.strictEqual(K.has(), true);
  assert.deepStrictEqual(K.load(), { password: PWD, aes: AES });
  K.clear();
  assert.strictEqual(K.load(), null);
});

test('refuses to store invalid keys', () => {
  assert.strictEqual(K.save({ password: 'x', aes: AES }), false);
  assert.strictEqual(K.save({ password: PWD, aes: 'y' }), false);
  assert.strictEqual(K.load(), null);
});

test('corrupt or tampered stored data is ignored, not trusted', () => {
  localStorage.setItem(K.STORAGE_KEY, '{oops');
  assert.strictEqual(K.load(), null);
  localStorage.setItem(K.STORAGE_KEY, JSON.stringify({ password: 'short', aes: AES }));
  assert.strictEqual(K.load(), null);
});

test('blocked storage (private window) degrades to "not stored" instead of throwing', () => {
  installStorage({ throws: true });
  assert.strictEqual(K.save({ password: PWD, aes: AES }), false);
  assert.strictEqual(K.load(), null);
  assert.doesNotThrow(() => K.clear());
});

console.log(`\n${passed} passed`);
