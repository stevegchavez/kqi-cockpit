/**
 * crypto.test.js — run with: node test/crypto.test.js
 *
 * js/crypto.js is hand-written (browsers have no AES-ECB or MD5), so it is
 * checked against Node's built-in crypto on many random inputs plus the
 * FIPS-197 Appendix C.1 known-answer vector.
 */
const assert = require('assert');
const nodeCrypto = require('crypto');
const { aesEncryptBlock, aesDecryptBlock, md5 } = require('../js/crypto.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n    ${err.stack}`); process.exitCode = 1; }
}
const hex = (u8) => Buffer.from(u8).toString('hex');
const bytes = (h) => new Uint8Array(Buffer.from(h, 'hex'));

console.log('crypto (AES-128 block + MD5)\n');

test('AES-128 FIPS-197 Appendix C.1 vector encrypts correctly', () => {
  const key = bytes('000102030405060708090a0b0c0d0e0f');
  const pt = bytes('00112233445566778899aabbccddeeff');
  assert.strictEqual(hex(aesEncryptBlock(key, pt)), '69c4e0d86a7b0430d8cdb78070b4c55a');
});

test('AES-128 FIPS-197 Appendix C.1 vector decrypts correctly', () => {
  const key = bytes('000102030405060708090a0b0c0d0e0f');
  const ct = bytes('69c4e0d86a7b0430d8cdb78070b4c55a');
  assert.strictEqual(hex(aesDecryptBlock(key, ct)), '00112233445566778899aabbccddeeff');
});

test('AES-128 matches Node crypto on 500 random key/block pairs (both directions)', () => {
  for (let i = 0; i < 500; i++) {
    const key = nodeCrypto.randomBytes(16);
    const block = nodeCrypto.randomBytes(16);
    const c = nodeCrypto.createCipheriv('aes-128-ecb', key, null);
    c.setAutoPadding(false);
    const expectEnc = Buffer.concat([c.update(block), c.final()]);
    const got = aesEncryptBlock(new Uint8Array(key), new Uint8Array(block));
    assert.strictEqual(hex(got), expectEnc.toString('hex'));
    assert.strictEqual(hex(aesDecryptBlock(new Uint8Array(key), got)), block.toString('hex'));
  }
});

test('AES rejects wrong key and block sizes', () => {
  assert.throws(() => aesEncryptBlock(new Uint8Array(15), new Uint8Array(16)));
  assert.throws(() => aesEncryptBlock(new Uint8Array(16), new Uint8Array(15)));
  assert.throws(() => aesDecryptBlock(new Uint8Array(16), new Uint8Array(17)));
});

test('MD5 matches the RFC 1321 test suite', () => {
  const cases = {
    '': 'd41d8cd98f00b204e9800998ecf8427e',
    'a': '0cc175b9c0f1b6a831c399e269772661',
    'abc': '900150983cd24fb0d6963f7d28e17f72',
    'message digest': 'f96b697d7cb7938d525a2f31aaf161d0',
    'abcdefghijklmnopqrstuvwxyz': 'c3fcd3d76192e4007dfb496cca67e13b',
    '12345678901234567890123456789012345678901234567890123456789012345678901234567890':
      '57edf4a22be3c955ac49da2e2107b67a',
  };
  for (const [input, want] of Object.entries(cases)) {
    assert.strictEqual(hex(md5(new Uint8Array(Buffer.from(input)))), want, `md5(${JSON.stringify(input)})`);
  }
});

test('MD5 matches Node crypto for every length 0..200 (covers padding boundaries)', () => {
  for (let len = 0; len <= 200; len++) {
    const data = nodeCrypto.randomBytes(len);
    const want = nodeCrypto.createHash('md5').update(data).digest('hex');
    assert.strictEqual(hex(md5(new Uint8Array(data))), want, `length ${len}`);
  }
});

console.log(`\n${passed} passed`);
