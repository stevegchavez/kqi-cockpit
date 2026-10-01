/**
 * session.test.js — run with: node test/session.test.js
 *
 * Runs the real Session (handshake, reads, fallback, polling) against a
 * simulated scooter that was written independently of js/protocol.js.
 * Uses made-up TEST keys only.
 */
const assert = require('assert');
const P = require('../js/protocol.js');
const { Session, TimeoutError, FAST_GROUP, STATIC_GROUP } = require('../js/session.js');
const { FakeScooter, defaultFields } = require('./helpers/fake-scooter.js');

const PWD = '0123456789abcdef';
const AES = 'fedcba9876543210';

let passed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

/** Wires a Session to a FakeScooter. `join` delivers multi-frame replies as one notification. */
function link({ join = false, refuse = [], password = PWD, aes = AES, sessionPassword = PWD, sessionAes = AES, timeoutMs = 300 } = {}) {
  const scooter = new FakeScooter({ password, aesKey: aes, fields: defaultFields(), refuse });
  const transport = {
    session: null,
    async write(frame) {
      const replies = scooter.receive(Buffer.from(frame));
      setImmediate(() => {
        if (join && replies.length > 1) this.session.onNotification(new Uint8Array(Buffer.concat(replies)));
        else for (const r of replies) this.session.onNotification(new Uint8Array(r));
      });
    },
  };
  const session = new Session(transport, { password: sessionPassword, aes: sessionAes, timeoutMs });
  transport.session = session;
  return { scooter, transport, session };
}

console.log('session (against a simulated scooter)\n');

test('handshake with the right keys succeeds', async () => {
  const { session, scooter } = link();
  await session.handshake();
  assert.strictEqual(session.verified, true);
  assert.strictEqual(scooter.verified, true);
  assert.deepStrictEqual(scooter.log, ['hs1', 'hs2']);
});

test('handshake with the wrong password is rejected, not silently accepted', async () => {
  const { session } = link({ sessionPassword: 'AAAAAAAAAAAAAAAA' });
  await assert.rejects(() => session.handshake(), (e) => e instanceof P.NiuError && /rejected at step 2/.test(e.message));
  assert.strictEqual(session.verified, false);
});

test('reads are refused locally until the handshake has succeeded', async () => {
  const { session, scooter } = link();
  await assert.rejects(() => session.read(['bms_soc_rt']), /not authenticated/);
  assert.deepStrictEqual(scooter.log, [], 'nothing should be sent before authentication');
});

test('readStatus returns dashboard telemetry from the fast group', async () => {
  const { session } = link();
  await session.handshake();
  const t = await session.readStatus();
  assert.deepStrictEqual(t, { speedKPH: 12.3, batterySOC: 59, poweredOn: true, faultFlags: 0, batteryHealth: 93 });
});

test('readStatic returns max speed, rated voltage and firmware', async () => {
  const { session } = link();
  await session.handshake();
  assert.deepStrictEqual(await session.readStatic(), { maxSpeedKPH: 30, ratedVoltage: 48, dashboardVersion: 'K2C2FV32' });
});

test('a refused field falls back to one-by-one reads and is remembered as unsupported', async () => {
  const { session, scooter } = link({ refuse: ['110006'] });   // db_k_f_code refused
  await session.handshake();
  const t = await session.readStatus();
  assert.strictEqual(t.faultFlags, undefined);
  assert.strictEqual(t.batterySOC, 59);
  assert.ok(session.unsupported.has('db_k_f_code'));
  scooter.log.length = 0;
  await session.readStatus();
  assert.strictEqual(scooter.log.length, 1, 'second poll should be a single group read');
  assert.ok(!scooter.log[0].includes('110006'), 'refused field must not be requested again');
});

test('asking for a single unsupported field returns nothing instead of throwing', async () => {
  const { session } = link({ refuse: ['110006'] });
  await session.handshake();
  assert.deepStrictEqual(await session.read(['db_k_f_code']), {});
  assert.ok(session.unsupported.has('db_k_f_code'));
});

test('a silent scooter produces a TimeoutError, not a hang', async () => {
  const { session, scooter } = link({ timeoutMs: 60 });
  await session.handshake();
  scooter.silent = true;
  await assert.rejects(() => session.readStatus(), (e) => e instanceof TimeoutError);
});

test('a reply spanning two frames is reassembled even when delivered in one notification', async () => {
  const { session } = link({ join: true });
  await session.handshake();
  const v = await session.read(['db_k_sw_ver', 'foc_k_s_ver', 'bms_s_ver_n']);
  assert.deepStrictEqual(v, { db_k_sw_ver: 'K2C2FV32', foc_k_s_ver: 'KDE13G07', bms_s_ver_n: 'K3D66V02' });
});

test('unsolicited frames are set aside and do not corrupt a read', async () => {
  const { session, transport } = link();
  await session.handshake();
  const orig = transport.write.bind(transport);
  transport.write = async (frame) => {
    await orig(frame);
    const push = new Uint8Array(20); push[0] = 0x01; push[1] = 0x27;   // some unrelated push frame
    transport.session.onNotification(push);
  };
  const t = await session.readStatus();
  assert.strictEqual(t.batterySOC, 59);
  assert.ok(session.parked.length >= 1);
});

test('concurrent reads are serialized and both succeed', async () => {
  const { session, scooter } = link();
  await session.handshake();
  scooter.log.length = 0;
  const [a, b] = await Promise.all([session.readStatus(), session.readStatic()]);
  assert.strictEqual(a.batterySOC, 59);
  assert.strictEqual(b.maxSpeedKPH, 30);
  assert.strictEqual(scooter.log.length, 2);
});

test('polling emits static info first, then repeated status, and stops on request', async () => {
  const { session } = link();
  await session.handshake();
  const seen = [];
  session.startPolling({ intervalMs: 15, onTelemetry: (t) => seen.push(t) });
  await new Promise((r) => setTimeout(r, 200));
  session.stopPolling();
  const n = seen.length;
  assert.ok(n >= 3, `expected several telemetry events, got ${n}`);
  assert.strictEqual(seen[0].maxSpeedKPH, 30, 'first event is the static group');
  assert.ok(seen.slice(1).every((t) => t.batterySOC === 59));
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(seen.length <= n + 1, 'no more events after stopPolling');
});

test('polling reports an error and stops after repeated failures', async () => {
  const { session, scooter } = link({ timeoutMs: 40 });
  await session.handshake();
  let error = null;
  const seen = [];
  session.startPolling({ intervalMs: 10, maxFailures: 2, onTelemetry: (t) => seen.push(t), onError: (e) => { error = e; } });
  await new Promise((r) => setTimeout(r, 40));
  scooter.silent = true;
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(error instanceof TimeoutError, 'expected a TimeoutError to be reported');
  assert.strictEqual(session._polling, false);
});

test('malformed keys are rejected when the session is created', () => {
  assert.throws(() => new Session({ write() {} }, { password: 'short', aes: AES }), /16 characters or 32 hex/);
  assert.throws(() => new Session({ write() {} }, { password: PWD, aes: '' }), /16 characters or 32 hex/);
});

test('the polled field groups only use fields the protocol module supports', () => {
  for (const name of [...FAST_GROUP, ...STATIC_GROUP]) assert.ok(P.FIELDS[name], `${name} missing from FIELDS`);
  assert.ok(FAST_GROUP.length <= 5 && STATIC_GROUP.length <= 5, 'one 16-byte request block holds 5 codes');
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; console.log(`  ok - ${name}`); }
    catch (err) { console.error(`  FAIL - ${name}\n    ${err.stack}`); process.exitCode = 1; }
  }
  console.log(`\n${passed} passed`);
})();
