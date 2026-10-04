/**
 * session.test.js — run with: node test/session.test.js
 *
 * Runs the real Session (handshake, reads, fallback, polling) against a
 * simulated scooter that was written independently of js/protocol.js.
 * Uses made-up TEST keys only.
 */
const assert = require('assert');
const P = require('../js/protocol.js');
const { Session, TimeoutError, FAST_GROUP, STATIC_GROUP, ENERGY_GROUP } = require('../js/session.js');
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
  assert.deepStrictEqual(t, { speedKPH: 12.3, batterySOC: 59, poweredOn: true, faultFlags: 0, batteryCurrentRaw: 0 });
});

test('readStatic returns max speed, rated voltage, firmware, charge cycles, health and lifetime energy', async () => {
  const { session } = link();
  await session.handshake();
  assert.deepStrictEqual(await session.readStatic(), { maxSpeedKPH: 30, ratedVoltage: 48, dashboardVersion: 'K2C2FV32', chargeCycles: 151, batteryHealth: 93, energyOutRaw: 437, energyInRaw: 435 });
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
  assert.strictEqual(scooter.log.length, 3, 'one fast read, then the slow group and the energy group');
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
  for (const name of [...FAST_GROUP, ...STATIC_GROUP, ...ENERGY_GROUP]) assert.ok(P.FIELDS[name], `${name} missing from FIELDS`);
  assert.ok(FAST_GROUP.length <= 5 && STATIC_GROUP.length <= 5 && ENERGY_GROUP.length <= 5, 'one 16-byte request block holds 5 codes');
});

// ---- Diagnostics-oriented behaviour: raw reads, per-field outcomes, pushes, polling races
const Fields = require('../js/fields.js');

/** Like link(), but the session may name any catalogue field, and the scooter answers only `fields`. */
function diagLink({ fields, join = false, timeoutMs = 300 } = {}) {
  const scooter = new FakeScooter({ password: PWD, aesKey: AES, fields: fields || defaultFields() });
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
  const session = new Session(transport, { password: PWD, aes: AES, timeoutMs, fieldTable: Fields.FIELDS, catalogue: Fields });
  transport.session = session;
  return { scooter, transport, session };
}

test('readDetailed returns decoded values AND raw hex for each field', async () => {
  const { session } = diagLink();
  await session.handshake();
  const r = await session.readDetailed(['bms_soc_rt', 'foc_k_rt_speed', 'db_k_sw_ver']);
  assert.deepStrictEqual(r.values, { bms_soc_rt: 59, foc_k_rt_speed: 123, db_k_sw_ver: 'K2C2FV32' });
  assert.deepStrictEqual(r.raws, { bms_soc_rt: '3b', foc_k_rt_speed: '007b', db_k_sw_ver: '4b32433246563332' });
  assert.deepStrictEqual(r.refused, {});
  assert.deepStrictEqual(r.errors, {});
});

test('readDetailed sorts a mixed group into answered and refused, without throwing', async () => {
  const { session, scooter } = diagLink();
  await session.handshake();
  const r = await session.readDetailed(['bms_soc_rt', 'db_mileage', 'foc_k_rt_speed']);   // db_mileage: the scooter has no such field
  assert.deepStrictEqual(Object.keys(r.values).sort(), ['bms_soc_rt', 'foc_k_rt_speed']);
  assert.deepStrictEqual(r.refused, { db_mileage: '40' });
  assert.strictEqual(scooter.log.filter((l) => l.startsWith('read')).length, 4, 'one group read, then each field alone');
});

test('readDetailed does not pollute the dashboard\'s "unsupported" memory', async () => {
  const { session } = diagLink();
  await session.handshake();
  await session.readDetailed(['db_mileage']);
  assert.strictEqual(session.unsupported.size, 0);
});

test('a group whose reply is too short is recovered by reading each field alone', async () => {
  const fields = defaultFields();
  for (const code of ['110002', '210002', '31003C']) fields[code] = { len: 1, text: 'K' };   // catalogue says 8 bytes each
  const { session } = diagLink({ fields });
  await session.handshake();
  const r = await session.readDetailed(['db_k_sw_ver', 'foc_k_s_ver', 'bms_s_ver_n', 'bms_soc_rt']);
  assert.strictEqual(r.values.bms_soc_rt, 59);
  assert.strictEqual(r.values.db_k_sw_ver, 'K', 'read alone, the short reply fits and decodes');
  assert.deepStrictEqual(r.errors, {});
  assert.deepStrictEqual(r.refused, {});
});

test('a field whose reply is still too short alone is recorded as an error, and does not stop the others', async () => {
  const fields = defaultFields();
  fields[Fields.FIELDS.db_k_navigation_name.code] = { len: 1, text: 'K' };   // catalogue says 32 bytes; one block is only 16
  const { session } = diagLink({ fields });
  await session.handshake();
  const r = await session.readDetailed(['db_k_navigation_name', 'bms_soc_rt']);
  assert.strictEqual(r.values.bms_soc_rt, 59, 'the healthy field in the same request must still come through');
  assert.match(r.errors.db_k_navigation_name, /reply too short/);
  assert.deepStrictEqual(r.refused, {});
  assert.ok(!('db_k_navigation_name' in r.values));
});

test('readDetailed lets a timeout through, because the link itself is in trouble', async () => {
  const { session, scooter } = diagLink({ timeoutMs: 60 });
  await session.handshake();
  scooter.silent = true;
  await assert.rejects(() => session.readDetailed(['bms_soc_rt']), (e) => e instanceof TimeoutError);
});

test('a large multi-frame field comes back whole', async () => {
  const hex = Array.from({ length: 128 }, (_, i) => (i & 0xff).toString(16).padStart(2, '0')).join('');
  const fields = defaultFields();
  fields[Fields.FIELDS.db_island_notification.code] = { len: 128, hex };
  const { session } = diagLink({ fields, join: true });
  await session.handshake();
  const r = await session.readDetailed(['db_island_notification']);
  assert.strictEqual(r.raws.db_island_notification, hex);
});

test('pushed frames are decoded and cleared, and unrelated parked frames are ignored', async () => {
  const { session, scooter, transport } = diagLink();
  await session.handshake();
  transport.session.onNotification(new Uint8Array(scooter.push([['21000B', Buffer.from([0x00, 0xc8])], ['210009', Buffer.from([3])]])));
  const junk = new Uint8Array(20); junk[0] = 0x01; junk[1] = 0x55;
  transport.session.onNotification(junk);
  await session.readStatus();                       // reading parks whatever else is waiting in the queue
  const pushes = session.takePushes();
  assert.strictEqual(pushes.length, 1);
  assert.strictEqual(pushes[0].header, '0127');
  assert.deepStrictEqual(pushes[0].fields, { foc_k_rt_speed: 200, foc_k_gears: 3 });
  assert.ok(pushes[0].t > 0);
  assert.deepStrictEqual(session.takePushes(), [], 'taking pushes clears them');
});

test('a corrupted push is reported as an error entry instead of throwing', async () => {
  const { session, scooter, transport } = diagLink();
  await session.handshake();
  const frame = new Uint8Array(scooter.push([['21000B', Buffer.from([0, 1])]]));
  frame[19] ^= 0xff;
  transport.session.onNotification(frame);
  await session.readStatus();
  const [p] = session.takePushes();
  assert.match(p.error, /bad checksum/);
});

test('stopping and quickly restarting polling never leaves two loops running', async () => {
  const { session, scooter } = diagLink();
  await session.handshake();
  session.startPolling({ intervalMs: 40, onTelemetry() {} });
  await new Promise((r) => setTimeout(r, 120));
  session.stopPolling();
  session.startPolling({ intervalMs: 40, onTelemetry() {} });      // restart while the old loop is still sleeping
  await new Promise((r) => setTimeout(r, 60));
  scooter.log.length = 0;
  await new Promise((r) => setTimeout(r, 400));
  session.stopPolling();
  const reads = scooter.log.filter((l) => l.startsWith('read')).length;
  // One loop: about 400ms / (40ms sleep + a few ms of reading) = ~8-9 reads. Two loops would be ~16+.
  assert.ok(reads <= 11, `expected one polling loop (~9 reads), saw ${reads}`);
  assert.ok(reads >= 4, `polling should still be running, saw ${reads}`);
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; console.log(`  ok - ${name}`); }
    catch (err) { console.error(`  FAIL - ${name}\n    ${err.stack}`); process.exitCode = 1; }
  }
  console.log(`\n${passed} passed`);
})();
