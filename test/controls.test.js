/**
 * controls.test.js — run with: node test/controls.test.js
 *
 * The only module that can send commands. Checks:
 *   - frames are byte-for-byte what the reference implementation builds (made-up test keys);
 *   - nothing outside the four allow-listed commands can ever be built or sent;
 *   - the safety rules (off by default, standstill only for lock/unlock, never mid-ride,
 *     spacing between commands) hold against the simulated scooter, and that a refused
 *     command sends nothing to the scooter.
 */
const assert = require('assert');
const P = require('../js/protocol.js');
const Ctl = require('../js/controls.js');
const Fields = require('../js/fields.js');
const { Session } = require('../js/session.js');
const { FakeScooter, defaultFields } = require('./helpers/fake-scooter.js');
const V = require('./fixtures/niu_vectors.json');

const PWD = '0123456789abcdef';
const AES = 'fedcba9876543210';

let passed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

function memStorage() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; }

async function linked({ speed = 0, extra = {}, refuse = [] } = {}) {
  const fields = Object.assign(defaultFields(), {
    '21000B': { len: 2, value: speed },
    '210010': { len: 4, value: 6145 },          // foc_k_realtime_status1 (as read on a real 200F)
    '110005': { len: 4, value: 66 },            // db_k_function_status
  }, extra);
  const scooter = new FakeScooter({ password: PWD, aesKey: AES, fields, refuse });
  const transport = { session: null, async write(f) { const r = scooter.receive(Buffer.from(f)); setImmediate(() => r.forEach((x) => this.session.onNotification(new Uint8Array(x)))); } };
  const session = new Session(transport, { password: PWD, aes: AES, timeoutMs: 300, fieldTable: P.FIELDS });
  transport.session = session;
  await session.handshake();
  return { scooter, session };
}
const ctx = (o) => Object.assign({ aes: AES, enabled: true, isRiding: false, fieldTable: Fields.FIELDS, storage: memStorage() }, o);
const writesSent = (scooter) => scooter.log.filter((l) => l.startsWith('write'));

console.log('controls (the only commands the app can send)\n');

test('command frames match the reference implementation byte for byte', () => {
  for (const [name, v] of Object.entries(V.writes)) {
    assert.deepStrictEqual([P.toHex(Ctl.buildCommand(name, AES))], v.frames, name);
    const cmd = Ctl.COMMANDS[name];
    assert.strictEqual(cmd.value, v.value, name);
    assert.strictEqual(cmd.code, v.field === 'foc_k_cmd' ? '210016' : '11000F', name);
  }
});

test('the allow-list is exactly lock, unlock, alarm on, alarm off, and cannot be extended', () => {
  assert.deepStrictEqual(Object.keys(Ctl.COMMANDS).sort(), ['alarmOff', 'alarmOn', 'lock', 'unlock']);
  assert.ok(Object.isFrozen(Ctl.COMMANDS) && Object.values(Ctl.COMMANDS).every(Object.isFrozen));
  const pairs = Object.values(Ctl.COMMANDS).map((c) => `${c.code}=${c.value}`).sort();
  assert.deepStrictEqual(pairs, ['11000F=5', '11000F=6', '210016=1', '210016=2']);
  assert.throws(() => { 'use strict'; Ctl.COMMANDS.factoryReset = { code: '11000F', len: 1, value: 100 }; });
  for (const bad of ['factoryReset', 'powerOff', 'constructor', '__proto__', 'toString', '', undefined]) {
    assert.throws(() => Ctl.buildCommand(bad, AES), Ctl.SafetyError, String(bad));
  }
});

test('the reference write replies parse: accepted, non-zero result, refusal, corruption', () => {
  assert.strictEqual(Ctl.parseWriteReply(P.fromHex(V.writeAck.frame), AES), true);
  assert.throws(() => Ctl.parseWriteReply(P.fromHex(V.writeAckNonZero.frame), AES), (e) => e.code === '03');
  assert.throws(() => Ctl.parseWriteReply(P.fromHex(V.writeErr.frame), AES), (e) => e instanceof P.NiuError && e.code === '40');
  const bad = P.fromHex(V.writeAck.frame); bad[19] ^= 1;
  assert.throws(() => Ctl.parseWriteReply(bad, AES), /checksum/);
});

test('lock at a standstill: one write of foc_k_cmd = 1, logged with status before and after', async () => {
  const { scooter, session } = await linked({ speed: 0 });
  const c = ctx();
  const r = await Ctl.send(session, 'lock', c);
  assert.deepStrictEqual(scooter.writes, [{ code: '210016', value: 1 }]);
  assert.strictEqual(r.speedKPH, 0);
  assert.strictEqual(r.before.foc_k_realtime_status1, 6145);
  assert.strictEqual(r.after.db_k_function_status, 66);
  const log = Ctl.readLog(c.storage);
  assert.strictEqual(log.length, 1);
  assert.strictEqual(log[0].name, 'lock');
});

test('lock is refused while the scooter is moving, and nothing is sent', async () => {
  const { scooter, session } = await linked({ speed: 52 });
  await assert.rejects(() => Ctl.send(session, 'lock', ctx()), (e) => e instanceof Ctl.SafetyError && /5\.2 km\/h/.test(e.message));
  assert.deepStrictEqual(writesSent(scooter), []);
});

test('lock is refused if the speed cannot be read, and nothing is sent', async () => {
  const { scooter, session } = await linked({ speed: 0, refuse: ['21000B'] });
  await assert.rejects(() => Ctl.send(session, 'unlock', ctx()), /Could not confirm the scooter is stopped/);
  assert.deepStrictEqual(writesSent(scooter), []);
});

test('nothing is sent when controls are off, mid-ride, too soon after the last command, or not connected', async () => {
  const { scooter, session } = await linked({ speed: 0 });
  await assert.rejects(() => Ctl.send(session, 'lock', ctx({ enabled: false })), /turned off/);
  await assert.rejects(() => Ctl.send(session, 'lock', ctx({ isRiding: true })), /Finish the ride/);
  await assert.rejects(() => Ctl.send(session, 'alarmOn', ctx({ lastSentAt: Date.now() - 500 })), /wait a moment/);
  await assert.rejects(() => Ctl.send({ verified: false }, 'lock', ctx()), /Connect to the scooter/);
  await assert.rejects(() => Ctl.send(session, 'factoryReset', ctx()), Ctl.SafetyError);
  assert.deepStrictEqual(writesSent(scooter), []);
  assert.deepStrictEqual(scooter.writes, []);
});

test('the alarm can be switched even when the scooter reports speed (it is a setting, not the motor)', async () => {
  const { scooter, session } = await linked({ speed: 52 });
  await Ctl.send(session, 'alarmOn', ctx());
  assert.deepStrictEqual(scooter.writes, [{ code: '11000F', value: 6 }]);
});

test('a refused command is reported with the scooter\'s error code', async () => {
  const { scooter, session } = await linked({ speed: 0 });
  scooter.refuseWrites = true;
  await assert.rejects(() => Ctl.send(session, 'lock', ctx()), (e) => e instanceof P.NiuError && e.code === '40');
  scooter.refuseWrites = false;
  scooter.writeResult = 0x07;
  await assert.rejects(() => Ctl.send(session, 'lock', ctx()), (e) => e.code === '07');
});

test('controls stay off until switched on, and the setting survives junk', () => {
  const st = memStorage();
  assert.strictEqual(Ctl.isEnabled(st), false);
  Ctl.setEnabled(st, true);
  assert.strictEqual(Ctl.isEnabled(st), true);
  Ctl.setEnabled(st, false);
  assert.strictEqual(Ctl.isEnabled(st), false);
  st.setItem(Ctl.ENABLE_KEY, '{oops');
  assert.strictEqual(Ctl.isEnabled(st), false);
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; console.log(`  ok - ${name}`); }
    catch (err) { console.error(`  FAIL - ${name}\n    ${err.stack}`); process.exitCode = 1; }
  }
  console.log(`\n${passed} passed`);
})();
