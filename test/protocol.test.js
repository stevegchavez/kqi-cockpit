/**
 * protocol.test.js — run with: node test/protocol.test.js
 *
 * The important checks compare js/protocol.js byte-for-byte with output of a
 * separate reference implementation (Python, niu-kqi) stored in
 * test/fixtures/niu_vectors.json. Those vectors use made-up TEST keys.
 */
const assert = require('assert');
const P = require('../js/protocol.js');
const V = require('./fixtures/niu_vectors.json');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (err) { console.error(`  FAIL - ${name}\n    ${err.stack}`); process.exitCode = 1; }
}
const h = P.fromHex;
const hex = P.toHex;
const hexList = (frames) => frames.map(hex);

console.log('protocol (NIU BLE-10 frames, handshake, reads)\n');

// ---- basics
test('checksum is the byte sum mod 256 and checksumOk validates it', () => {
  assert.strictEqual(P.checksum(h('ff01')), 0x00);
  assert.strictEqual(P.checksum(h('0102030405')), 15);
  assert.ok(P.checksumOk(h('01020306')));
  assert.ok(!P.checksumOk(h('01020307')));
});

test('keyBytes accepts 16 ASCII chars or 32 hex digits and rejects anything else', () => {
  assert.strictEqual(P.keyBytes('0123456789abcdef').length, 16);
  assert.strictEqual(hex(P.keyBytes('00112233445566778899aabbccddeeff')), '00112233445566778899aabbccddeeff');
  assert.throws(() => P.keyBytes('short'), /16 characters or 32 hex/);
  assert.throws(() => P.keyBytes('0123456789abcdeé'), /ASCII/);
  assert.throws(() => P.keyBytes(''), /16 characters or 32 hex/);
});

// ---- handshake vs reference
test('handshake step 1 request matches the reference byte-for-byte', () => {
  assert.strictEqual(hex(P.handshake1(V.pwd, h(V.rnd))), V.hs1Frame);
});

test('handshake step 1 request has the 01 23 01 prefix seen on the real 200F', () => {
  const f = P.handshake1(V.pwd, h(V.rnd));
  assert.strictEqual(f.length, 20);
  assert.strictEqual(hex(f.subarray(0, 3)), '012301');
});

test('handshake step 1 reply decrypts to the scooter\'s plaintext', () => {
  assert.strictEqual(hex(P.parseHandshake1Reply(h(V.hs1ReplyFrame), V.pwd)), V.hs1Reply);
});

test('handshake step 2 request matches the reference byte-for-byte', () => {
  assert.strictEqual(hex(P.handshake2(V.pwd, h(V.rnd), h(V.hs1Reply))), V.hs2Frame);
});

test('handshake step 2 request has the 01 03 00 prefix seen on the real 200F', () => {
  assert.strictEqual(hex(P.handshake2(V.pwd, h(V.rnd), h(V.hs1Reply)).subarray(0, 3)), '010300');
});

test('handshake step 2 accepts a good reply and rejects a bad flag / rejected password', () => {
  assert.doesNotThrow(() => P.parseHandshake2Reply(h(V.hs2OkFrame), V.pwd));
  assert.throws(() => P.parseHandshake2Reply(h(V.hs2BadFrame), V.pwd), /password verify failed \(flag 07\)/);
  assert.throws(() => P.parseHandshake1Reply(h(V.hs1RejectFrame), V.pwd), (e) => e.code === '2A' && /rejected at step 1/.test(e.message));
});

test('handshake rejects a corrupted reply and an unexpected header', () => {
  const corrupt = h(V.hs1ReplyFrame); corrupt[19] ^= 0xff;
  assert.throws(() => P.parseHandshake1Reply(corrupt, V.pwd), /bad checksum/);
  assert.throws(() => P.parseHandshake1Reply(h(V.hs2OkFrame), V.pwd), /unexpected verify reply/);
});

// ---- reads vs reference
for (const group of ['fast', 'static', 'long']) {
  test(`read request "${group}" matches the reference (16-char key)`, () => {
    const g = V.reads[group];
    assert.deepStrictEqual(hexList(P.buildRead(g.names, V.aes)), g.request);
  });
  test(`read request "${group}" matches the reference (32-hex key)`, () => {
    const g = V.reads[group];
    assert.deepStrictEqual(hexList(P.buildRead(g.names, V.aesHex32)), g.requestHex32Key);
  });
  test(`read reply "${group}" decodes to the reference values`, () => {
    const g = V.reads[group];
    const got = P.parseReadFrames(g.replyFrames.map(h), g.names, V.aes);
    assert.deepStrictEqual(got, g.expected);
  });
}

test('a 24-byte reply spans exactly two frames and index counts down', () => {
  const frames = V.reads.long.replyFrames.map(h);
  assert.strictEqual(frames.length, 2);
  assert.strictEqual(frames[0][2], 0x01);
  assert.strictEqual(frames[1][2], 0x00);
  assert.ok(!P.isLastReadFrame(frames[0]));
  assert.ok(P.isLastReadFrame(frames[1]));
});

test('a refusal frame raises NiuError with the scooter\'s hex code (live case: 40)', () => {
  assert.throws(
    () => P.parseReadFrames([h(V.readErrorFrame)], V.reads.fast.names, V.aes),
    (e) => e instanceof P.NiuError && e.code === '40' && /refused the read \(error 40\)/.test(e.message),
  );
  assert.ok(P.isReadError(h(V.readErrorFrame)));
  assert.ok(P.isLastReadFrame(h(V.readErrorFrame)));
});

test('a bad checksum, a lost frame and a wrong key are all detected', () => {
  assert.throws(() => P.parseReadFrames([h(V.badChecksumFrame)], V.reads.fast.names, V.aes), /bad checksum/);
  assert.throws(() => P.parseReadFrames(V.lossFrames.map(h), V.reads.long.names, V.aes), /frame loss/);
  // Wrong key yields garbage plaintext, never a silent success with the right numbers.
  const wrong = P.parseReadFrames(V.reads.fast.replyFrames.map(h), V.reads.fast.names, '0000000000000000');
  assert.notDeepStrictEqual(wrong, V.reads.fast.expected);
});

test('reading an unknown field is refused up front', () => {
  assert.throws(() => P.buildRead(['no_such_field'], V.aes), /unknown or unsupported field/);
});

test('value decoding: big-endian ints and NUL-padded text', () => {
  assert.strictEqual(P.decodeValue({ type: 'U16', len: 2 }, h('012c')), 300);
  assert.strictEqual(P.decodeValue({ type: 'U32', len: 4 }, h('00420001')), 4325377);
  assert.strictEqual(P.decodeValue({ type: 'UTF-8', len: 8 }, h('4b32433246563332')), V.decode.UTF8);
  assert.strictEqual(P.decodeValue({ type: 'UTF-8', len: 8 }, h('4b32430000000000')), V.decode.UTF8_nulpad);
  assert.strictEqual(V.decode.U16, 300);
});

test('splitNotification splits concatenated 20-byte frames and passes others through', () => {
  const two = new Uint8Array(40).fill(1);
  assert.strictEqual(P.splitNotification(two).length, 2);
  assert.strictEqual(P.splitNotification(new Uint8Array(20)).length, 1);
  assert.strictEqual(P.splitNotification(new Uint8Array(7)).length, 1);
});

// ---- Diagnostics: every field type against the full catalogue (reference vectors)
const Fields = require('../js/fields.js');
for (const [group, d] of Object.entries(V.diag)) {
  test(`diagnostics "${group}": request matches the reference (${Object.values(d.types).join(', ')})`, () => {
    assert.deepStrictEqual(hexList(P.buildRead(d.names, V.aes, Fields.FIELDS)), d.request);
  });
  test(`diagnostics "${group}": reply decodes to the reference values and the raw bytes`, () => {
    const got = P.parseReadFramesDetailed(d.replyFrames.map(h), d.names, V.aes, Fields.FIELDS);
    assert.deepStrictEqual(got.values, d.expected);
    assert.deepStrictEqual(got.raws, d.raws);
  });
}

test('the diagnostics vectors cover every kind of value: unsigned, signed, float, hex and text', () => {
  const types = new Set(Object.values(V.diag).flatMap((d) => Object.values(d.types)));
  for (const t of ['U8', 'U16', 'U32', 'S8', 'S16', 'S32', 'F32', 'HEX', 'UTF-8']) assert.ok(types.has(t), `no vector for ${t}`);
});

test('a 128-byte field arrives as eight frames and reassembles intact', () => {
  const d = V.diag.bigHex;
  assert.strictEqual(d.replyFrames.length, 8);
  const got = P.parseReadFramesDetailed(d.replyFrames.map(h), d.names, V.aes, Fields.FIELDS);
  assert.strictEqual(got.raws.db_island_notification.length, 256);
  assert.strictEqual(got.raws.db_island_notification, d.raws.db_island_notification);
});

test('signed fields decode negative values (two\'s complement)', () => {
  assert.strictEqual(P.decodeValue({ type: 'S8', len: 1 }, h('fe')), -2);
  assert.strictEqual(P.decodeValue({ type: 'S16', len: 2 }, h('fffd')), -3);
  assert.strictEqual(P.decodeValue({ type: 'S32', len: 4 }, h('fffffffc')), -4);
  assert.strictEqual(P.decodeValue({ type: 'S16', len: 2 }, h('7fff')), 32767);
  assert.strictEqual(P.decodeValue({ type: 'S16', len: 2 }, h('8000')), -32768);
});

test('floats decode big-endian, and a float field of the wrong size is rejected', () => {
  assert.strictEqual(P.decodeValue({ type: 'F32', len: 4 }, h('3fc00000')), 1.5);
  assert.strictEqual(P.decodeValue({ type: 'F64', len: 8 }, h('3ff8000000000000')), 1.5);
  assert.throws(() => P.decodeValue({ type: 'F32', len: 3 }, h('3fc000')), /must be 4 bytes/);
});

test('decoding refuses types it does not know instead of guessing', () => {
  assert.throws(() => P.decodeValue({ type: 'MYSTERY', len: 1 }, h('00')), /unsupported field type/);
});

test('push frames decode to named values, stopping at the zero padding', () => {
  assert.deepStrictEqual(P.parsePush(h(V.push.frame), V.aes, Fields.BY_CODE, Fields.FIELDS), V.push.expected);
});

test('a push with a code outside the catalogue keeps the rest as raw hex and names what came before', () => {
  const got = P.parsePush(h(V.pushUnknown.frame), V.aes, Fields.BY_CODE, Fields.FIELDS);
  assert.deepStrictEqual(got, V.pushUnknown.expected);
  assert.ok('code_ABCDEF' in got);
});

test('a corrupted push frame is rejected', () => {
  const bad = h(V.push.frame); bad[19] ^= 1;
  assert.throws(() => P.parsePush(bad, V.aes, Fields.BY_CODE, Fields.FIELDS), /bad checksum/);
});

// ---- interpretation
test('interpretStatus maps battery current and lifetime energy as raw numbers', () => {
  const t = P.interpretStatus({ bms_c_cur_rt: 37, bms_accumulated_dc_energy: 437, bms_accumulated_c_energy: 435 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(t)), { batteryCurrentRaw: 37, energyOutRaw: 437, energyInRaw: 435 });
});

test('interpretStatus turns the live-style reply into dashboard telemetry', () => {
  const t = P.interpretStatus(V.reads.fast.expected);
  assert.strictEqual(t.speedKPH, 12.3);
  assert.strictEqual(t.batterySOC, 59);
  assert.strictEqual(t.batteryHealth, 93);
  assert.strictEqual(t.poweredOn, true);
  assert.strictEqual(t.faultFlags, 0);
  const s = P.interpretStatus(V.reads.static.expected);
  assert.strictEqual(s.maxSpeedKPH, 30);
  assert.strictEqual(s.ratedVoltage, 48);
  assert.strictEqual(s.dashboardVersion, 'K2C2FV32');
  assert.strictEqual(s.chargeCycles, 151);
});

test('interpretStatus only returns keys it was given, and caps percentages at 100', () => {
  assert.deepStrictEqual(P.interpretStatus({}), {});
  assert.deepStrictEqual(P.interpretStatus({ bms_soc_rt: 250 }), { batterySOC: 100 });
  assert.strictEqual(P.interpretStatus({ db_k_realtime_status: 4325376 }).poweredOn, false);
});

// ---- safety
test('this module is read-only: it exposes no write/command builders', () => {
  const names = Object.keys(P).join(' ').toLowerCase();
  assert.ok(!/write|command|lock|headlight/.test(names), `unexpected exports: ${names}`);
});

console.log(`\n${passed} passed`);
