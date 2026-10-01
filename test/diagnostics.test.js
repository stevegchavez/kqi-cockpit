/**
 * diagnostics.test.js — run with: node test/diagnostics.test.js
 *
 * The safety policy (what is never read, what is always redacted) is checked
 * hardest, because a mistake there is the one that could hurt. Uses made-up
 * TEST keys and a simulated scooter only.
 */
const assert = require('assert');
const D = require('../js/diagnostics.js');
const F = require('../js/fields.js');
const { Session, TimeoutError } = require('../js/session.js');
const { FakeScooter, defaultFields } = require('./helpers/fake-scooter.js');

const PWD = '0123456789abcdef';
const AES = 'fedcba9876543210';
const SERIAL = 'SN-SECRET-12345';          // 15 chars; must never appear in any report

let passed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
const instant = () => Promise.resolve();

/** A session wired to a simulated scooter that answers `fields` (by code) and refuses everything else. */
function rig({ fields, timeoutMs = 300 } = {}) {
  const scooter = new FakeScooter({ password: PWD, aesKey: AES, fields: fields || diagFields() });
  const transport = {
    session: null,
    async write(frame) {
      const replies = scooter.receive(Buffer.from(frame));
      setImmediate(() => { for (const r of replies) this.session.onNotification(new Uint8Array(r)); });
    },
  };
  const session = new Session(transport, { password: PWD, aes: AES, timeoutMs, fieldTable: F.FIELDS, catalogue: F });
  transport.session = session;
  return { scooter, session, transport };
}
const code = (name) => F.FIELDS[name].code;
function diagFields() {
  const f = defaultFields();
  f[code('db_mileage')] = { len: 4, value: 12345 };
  f[code('db_sn')] = { len: 16, text: SERIAL };
  f[code('ble_mac')] = { len: 8, hex: 'a1b2c3d4e5f60708' };
  f[code('emcu_front_wheel_temperature')] = { len: 1, value: -5 };
  f[code('db_k_function_status')] = { len: 4, value: 0b1000010 };
  return f;
}

console.log('diagnostics (policy, scan, diff, watch, report)\n');

// ===================================================================== policy
test('credentials are never read: PINs, passwords, NFC cards and the app challenge', () => {
  for (const n of ['db_k_power_on_pwd_1', 'db_power_on_pwd_5', 'db_k_pwd2_expire_timestamp', 'db_password_display',
    'bms_p_pwrd', 'nfc_card_id_1', 'nfc_card_id_5', 'ecu_app_random_num']) {
    assert.strictEqual(D.skipReason(n), 'credential', n);
    assert.strictEqual(D.isReadable(n), false);
  }
});

test('command registers and mode switches are never read', () => {
  for (const n of ['foc_k_cmd', 'db_k_cmd', 'db_dbcmd', 'db_dbcmd2', 'alarm_cmd', 'ecu_bt_cmd', 'nfc_cmd', 'db_rcu_command',
    'foc_k_decorative_light_cmd', 'db_enter_safe_mode']) {
    assert.strictEqual(D.skipReason(n), 'command', n);
  }
});

test('ordinary status fields stay readable, including names that merely contain "key"', () => {
  for (const n of ['bms_soc_rt', 'foc_k_rt_speed', 'db_mileage', 'ecu_bt_blekey_signal_threshold', 'db_media_key_func_set', 'db_wifi_rssi']) {
    assert.strictEqual(D.skipReason(n), null, n);
    assert.strictEqual(D.isPrivate(n), false, n);
  }
});

test('identifiers and private text are marked private', () => {
  for (const n of ['db_sn', 'foc_k_sn', 'foc_sn', 'bms_sn_id', 'ble_mac', 'ecu_bt_t_mac', 'ecu_bt_slave_mac_1', 'ecu_gps_catche_id',
    'db_k_security_log', 'db_island_notification', 'db_k_navigation_name', 'db_navigation_text_turn_information',
    'ecu_bt_current_device_hash', 'db_badge_id', 'foc_id', 'db_face_name3', 'db_traffic_light_left_array']) {
    assert.strictEqual(D.isPrivate(n), true, n);
  }
  for (const n of ['bms_soc_rt', 'db_k_sw_ver', 'bms_soh_rt', 'foc_k_max_speed', 'db_pet_id']) assert.strictEqual(D.isPrivate(n), false, n);
});

test('TRIPWIRE: the catalogue has exactly the reviewed number of skipped and private fields', () => {
  const plan = D.planScan();
  const by = (r) => plan.skipped.filter((s) => s.reason === r).length;
  assert.deepStrictEqual({ readable: plan.readable.length, credential: by('credential'), command: by('command'), private: plan.readable.filter(D.isPrivate).length },
    { readable: 259, credential: 22, command: 18, private: 30 },
    'The field catalogue changed. Review every new field name for credentials, commands and identifiers, then update this test.');
});

test('TRIPWIRE: nothing credential- or identifier-looking slips through unclassified', () => {
  const suspicious = /(^|_)(pwd|pwrd|passw\w*|secret|token|auth\w*|card|random|cmd\d*|command|mac|sn|serial|imei|imsi|iccid|gps|uid|phone|user|account|hash|slave|badge)(_|\d|$)|pwd|cmd/;
  const reviewedHarmless = new Set([]);          // add a name here ONLY after deciding it is harmless
  for (const name of Object.keys(F.FIELDS)) {
    if (!suspicious.test(name) || reviewedHarmless.has(name)) continue;
    assert.ok(D.skipReason(name) || D.isPrivate(name), `${name} looks sensitive but is neither skipped nor private`);
  }
});

test('the policy never marks a skipped field as readable or vice versa', () => {
  for (const name of Object.keys(F.FIELDS)) assert.strictEqual(D.isReadable(name), D.skipReason(name) === null);
});

// ===================================================================== planning
test('every readable field is planned exactly once, and no skipped field is planned at all', () => {
  const plan = D.planScan();
  const planned = plan.batches.flat();
  assert.strictEqual(planned.length, plan.readable.length);
  assert.strictEqual(new Set(planned).size, planned.length);
  for (const s of plan.skipped) assert.ok(!planned.includes(s.name), s.name);
  assert.strictEqual(plan.readable.length + plan.skipped.length, 299);
});

test('batches respect the request and reply size limits, and big fields travel alone', () => {
  const plan = D.planScan();
  for (const b of plan.batches) {
    assert.ok(b.length <= D.BATCH_MAX_FIELDS, `batch too large: ${b.join(',')}`);
    const bytes = b.reduce((n, x) => n + F.FIELDS[x].len, 0);
    assert.ok(b.length === 1 || bytes <= D.BATCH_MAX_REPLY_BYTES, `reply too big (${bytes}B): ${b.join(',')}`);
  }
  assert.deepStrictEqual(plan.batches.find((b) => b.includes('db_island_notification')), ['db_island_notification']);
});

test('batches follow code order so related fields stay together', () => {
  const flat = D.planScan().batches.flat();
  const codes = flat.map(code);
  assert.deepStrictEqual(codes, codes.slice().sort());
});

// ===================================================================== scanning
test('a full scan sorts every field into ok / refused / skipped, and totals add up to 299', async () => {
  const { session } = rig();
  await session.handshake();
  const r = await D.scan(session, { spacingMs: 0, sleep: instant });
  assert.strictEqual(r.aborted, null);
  assert.strictEqual(r.stats.total, 299);
  assert.strictEqual(r.stats.skipped, 40);
  assert.strictEqual(r.stats.ok, Object.keys(diagFields()).length);
  assert.strictEqual(r.stats.ok + r.stats.refused + r.stats.skipped + r.stats.error + r.stats.timeout + r.stats['not-run'], 299);
  assert.deepStrictEqual(r.results.bms_soc_rt, { status: 'ok', value: 59, raw: '3b' });
  assert.deepStrictEqual(r.results.db_mileage, { status: 'ok', value: 12345, raw: '00003039' });
  assert.deepStrictEqual(r.results.emcu_front_wheel_temperature, { status: 'ok', value: -5, raw: 'fb' });
  assert.deepStrictEqual(r.results.ble_mac, { status: 'ok', value: 'a1b2c3d4e5f60708', raw: 'a1b2c3d4e5f60708' });
  assert.deepStrictEqual(r.results.db_bat_soc, { status: 'refused', code: '40' });
  assert.deepStrictEqual(r.results.nfc_card_id_1, { status: 'skipped', reason: 'credential' });
  assert.deepStrictEqual(r.results.foc_k_cmd, { status: 'skipped', reason: 'command' });
});

test('SAFETY: a scan never asks the scooter for a credential or command field', async () => {
  const { session, scooter } = rig();
  await session.handshake();
  await D.scan(session, { spacingMs: 0, sleep: instant });
  const asked = new Set(scooter.requested);
  assert.ok(asked.size > 100, 'the scan should have asked for many fields');
  for (const [name, spec] of Object.entries(F.FIELDS)) {
    if (D.skipReason(name)) assert.ok(!asked.has(spec.code), `${name} (${D.skipReason(name)}) was requested!`);
  }
});

test('SAFETY: only read requests are ever sent (handshake and read headers only)', async () => {
  const writes = [];
  const { session, transport } = rig();
  const orig = transport.write.bind(transport);
  transport.write = async (f) => { writes.push(Buffer.from(f).toString('hex').slice(0, 4)); return orig(f); };
  await session.handshake();
  await D.scan(session, { spacingMs: 0, sleep: instant });
  assert.deepStrictEqual([...new Set(writes)].sort(), ['0103', '0121', '0123'], 'handshake step 1, handshake step 2, and read requests only');
});

test('scan reports progress after every batch', async () => {
  const { session } = rig();
  await session.handshake();
  const seen = [];
  await D.scan(session, { spacingMs: 0, sleep: instant, names: ['bms_soc_rt', 'bms_soh_rt', 'foc_k_rt_speed', 'db_mileage', 'db_sn', 'ble_mac', 'db_k_sw_ver'],
    onProgress: (p) => seen.push([p.done, p.total]) });
  assert.deepStrictEqual(seen, [[1, 2], [2, 2]]);
});

test('scan can be cancelled between batches; unread fields are marked not-run', async () => {
  const { session } = rig();
  await session.handshake();
  let batches = 0;
  const r = await D.scan(session, { spacingMs: 0, sleep: instant, onProgress: () => { batches++; }, isCancelled: () => batches >= 2 });
  assert.strictEqual(r.aborted, 'cancelled');
  assert.ok(r.stats['not-run'] > 200);
  assert.ok(r.stats.ok + r.stats.refused > 0);
});

test('scan gives up after repeated timeouts and says the link was lost', async () => {
  const { session, scooter } = rig({ timeoutMs: 25 });
  await session.handshake();
  scooter.silent = true;
  const r = await D.scan(session, { spacingMs: 0, sleep: instant, maxTimeouts: 3 });
  assert.strictEqual(r.aborted, 'link-lost');
  assert.strictEqual(r.stats.timeout, 15, 'three batches of five');
  assert.ok(r.stats['not-run'] > 200);
});

test('one timeout does not abort the scan if the link recovers', async () => {
  const { session, scooter } = rig({ timeoutMs: 25 });
  await session.handshake();
  let first = true;
  const orig = scooter.receive.bind(scooter);
  scooter.receive = (b) => { if (first) { first = false; return []; } return orig(b); };   // swallow exactly one request
  const r = await D.scan(session, { spacingMs: 0, sleep: instant, names: ['bms_soc_rt', 'foc_k_rt_speed', 'db_mileage', 'bms_soh_rt', 'db_sn', 'ble_mac'] });
  assert.strictEqual(r.aborted, null);
  assert.strictEqual(r.stats.timeout, 5);
  assert.strictEqual(r.results.ble_mac.status, 'ok');
});

test('asking to scan specific names still never reads skipped ones', async () => {
  const { session, scooter } = rig();
  await session.handshake();
  const r = await D.scan(session, { spacingMs: 0, sleep: instant, names: ['bms_soc_rt', 'nfc_card_id_1', 'foc_k_cmd'] });
  assert.ok(!scooter.requested.includes(code('nfc_card_id_1')));
  assert.ok(!scooter.requested.includes(code('foc_k_cmd')));
  assert.strictEqual(r.results.bms_soc_rt.status, 'ok');
  assert.strictEqual(r.results.nfc_card_id_1.status, 'skipped');
});

test('non-timeout errors are not swallowed', async () => {
  const boom = { async readDetailed() { throw new Error('unexpected'); } };
  await assert.rejects(() => D.scan(boom, { spacingMs: 0, sleep: instant, names: ['bms_soc_rt'] }), /unexpected/);
});

test('the scan paces itself between batches', async () => {
  const { session } = rig();
  await session.handshake();
  const naps = [];
  await D.scan(session, { spacingMs: 77, sleep: async (ms) => { naps.push(ms); }, names: ['bms_soc_rt', 'bms_soh_rt', 'foc_k_rt_speed', 'db_mileage', 'db_sn', 'ble_mac'] });
  assert.deepStrictEqual(naps, [77], 'one pause between the two batches, none after the last');
});

// ===================================================================== snapshots and diffs
const snap = (fields) => ({ t: 0, fields });
const E = (value, raw) => ({ value, raw });

test('diff: reports which bits turned on and off in a status word', () => {
  const a = snap({ db_k_function_status: E(0b1000010, '00000042') });
  const b = snap({ db_k_function_status: E(0b0010011, '00000013') });
  const [c] = D.diffSnapshots(a, b);
  assert.strictEqual(c.kind, 'changed');
  assert.deepStrictEqual(c.bitsSet, [1, 16]);
  assert.deepStrictEqual(c.bitsCleared, [64]);
});

test('diff: handles the top bit of a 32-bit word without sign errors', () => {
  const [c] = D.diffSnapshots(snap({ db_k_realtime_status: E(1, '00000001') }), snap({ db_k_realtime_status: E(0x80000001, '80000001') }));
  assert.deepStrictEqual(c.bitsSet, [2147483648]);
  assert.deepStrictEqual(c.bitsCleared, []);
});

test('diff: unchanged fields are omitted; changes are sorted by name', () => {
  const a = snap({ z_field: E(1, '01'), a_field: E(1, '01'), same: E(5, '05') });
  const b = snap({ z_field: E(2, '02'), a_field: E(2, '02'), same: E(5, '05') });
  assert.deepStrictEqual(D.diffSnapshots(a, b).map((c) => c.name), ['a_field', 'z_field']);
});

test('diff: hex fields report which byte positions changed', () => {
  const [c] = D.diffSnapshots(snap({ ble_mac: E('aabbccdd', 'aabbccdd') }), snap({ ble_mac: E('aabb00dd', 'aabb00dd') }));
  assert.deepStrictEqual(c.bytes, [2]);
});

test('diff: text changes and added/removed fields are described', () => {
  const d = D.diffSnapshots(snap({ db_k_sw_ver: E('A', '41'), gone: E(1, '01') }), snap({ db_k_sw_ver: E('B', '42'), fresh: E(2, '02') }));
  const by = Object.fromEntries(d.map((c) => [c.name, c]));
  assert.strictEqual(by.db_k_sw_ver.kind, 'changed');
  assert.strictEqual(by.gone.kind, 'removed');
  assert.strictEqual(by.fresh.kind, 'added');
});

test('snapshot keeps only fields that answered', () => {
  const s = D.snapshot({ a: { status: 'ok', value: 1, raw: '01' }, b: { status: 'refused', code: '40' }, c: { status: 'skipped', reason: 'command' } }, 123);
  assert.deepStrictEqual(s, { t: 123, fields: { a: { value: 1, raw: '01' } } });
});

test('bitChanges and changedBytes basics', () => {
  assert.deepStrictEqual(D.bitChanges(0, 0), { set: [], cleared: [] });
  assert.deepStrictEqual(D.bitChanges(0b101, 0b011), { set: [2], cleared: [4] });
  assert.strictEqual(D.changedBytes('aabb', 'aabbcc'), null, 'different lengths cannot be compared byte by byte');
  assert.deepStrictEqual(D.changedBytes('aabbcc', 'aabbcc'), []);
});

// ===================================================================== watching
test('watch: the first pass is the baseline and reports nothing', async () => {
  const { session } = rig();
  await session.handshake();
  const w = new D.Watcher({ session, names: ['bms_soc_rt', 'db_k_function_status', 'db_mileage'], now: () => 1000 });
  assert.deepStrictEqual(await w.step(), []);
});

test('watch: a changed value is reported once, with bit detail, and not again if it stays', async () => {
  const { session, scooter } = rig();
  await session.handshake();
  const seen = [];
  const w = new D.Watcher({ session, names: ['bms_soc_rt', 'db_k_function_status'], now: () => 5000, onChange: (c) => seen.push(c) });
  await w.step();
  scooter.fields[code('db_k_function_status')].value = 0b1000010 | 0b10000;      // bit 16 turns on
  const first = await w.step();
  assert.strictEqual(first.length, 1);
  assert.strictEqual(first[0].name, 'db_k_function_status');
  assert.deepStrictEqual(first[0].bitsSet, [16]);
  assert.strictEqual(first[0].t, 5000);
  assert.deepStrictEqual(await w.step(), [], 'no further change, no further report');
  assert.strictEqual(seen.length, 1);
});

test('watch: a field that changes constantly is muted after a few changes and reported as noisy once', async () => {
  const { session, scooter } = rig();
  await session.handshake();
  const noisy = [];
  const changes = [];
  const w = new D.Watcher({ session, names: ['foc_k_rt_speed', 'bms_soc_rt'], noisyAfter: 3, onNoisy: (n) => noisy.push(n), onChange: (c) => changes.push(c.name) });
  await w.step();
  for (let i = 1; i <= 6; i++) { scooter.fields[code('foc_k_rt_speed')].value = 100 + i; await w.step(); }
  assert.deepStrictEqual(noisy, ['foc_k_rt_speed']);
  assert.strictEqual(changes.filter((n) => n === 'foc_k_rt_speed').length, 3, 'reported until muted, then silent');
  scooter.fields[code('bms_soc_rt')].value = 58;
  await w.step();
  assert.ok(changes.includes('bms_soc_rt'), 'other fields keep being reported');
});

test('watch: pushed frames are forwarded', async () => {
  const { session, scooter, transport } = rig();
  await session.handshake();
  const pushed = [];
  const w = new D.Watcher({ session, names: ['bms_soc_rt'], onPush: (p) => pushed.push(...p) });
  transport.session.onNotification(new Uint8Array(scooter.push([['21000B', Buffer.from([0, 9])]])));
  await w.step();
  assert.strictEqual(pushed.length, 1);
  assert.deepStrictEqual(pushed[0].fields, { foc_k_rt_speed: 9 });
});

test('watch: never reads skipped fields even if asked to', async () => {
  const { session, scooter } = rig();
  await session.handshake();
  const w = new D.Watcher({ session, names: ['bms_soc_rt', 'nfc_card_id_1', 'foc_k_cmd', 'db_k_pwd1_expire_timestamp'] });
  await w.step();
  assert.deepStrictEqual(w.names, ['bms_soc_rt']);
  assert.ok(![code('nfc_card_id_1'), code('foc_k_cmd')].some((c) => scooter.requested.includes(c)));
});

test('watch: run() loops until stopped, and stops itself on repeated timeouts', async () => {
  const { session, scooter } = rig({ timeoutMs: 25 });
  await session.handshake();
  let passes = 0;
  const w = new D.Watcher({ session, names: ['bms_soc_rt'], maxTimeouts: 2, onError: () => {} });
  const origStep = w.step.bind(w);
  w.step = async () => { passes++; if (passes === 3) w.stop(); return origStep(); };
  await w.run(0, instant);
  assert.strictEqual(passes, 3);

  const errors = [];
  const w2 = new D.Watcher({ session, names: ['bms_soc_rt'], maxTimeouts: 2, onError: (e) => errors.push(e) });
  scooter.silent = true;
  await w2.run(0, instant);
  assert.strictEqual(w2.running, false);
  assert.ok(errors[0] instanceof TimeoutError);
});

// ===================================================================== report
async function scannedResults() {
  const { session } = rig();
  await session.handshake();
  return (await D.scan(session, { spacingMs: 0, sleep: instant })).results;
}

test('REPORT: private values are removed, and their serial text appears nowhere in the output', async () => {
  const results = await scannedResults();
  assert.strictEqual(results.db_sn.value, SERIAL, 'sanity: the scan did read the serial');
  const report = D.buildReport({ results, meta: { generatedAt: 0 } });
  const text = D.reportText(report);
  assert.ok(!text.includes(SERIAL), 'serial number leaked into the report');
  assert.ok(!text.includes('a1b2c3d4e5f60708'), 'MAC address leaked into the report');
  const sn = report.fields.find((f) => f.name === 'db_sn');
  assert.deepStrictEqual({ v: sn.value, r: sn.raw, p: sn.private, s: sn.status }, { v: D.HIDDEN, r: D.HIDDEN, p: true, s: 'ok' });
  assert.strictEqual(sn.len, 16, 'the shape stays visible so the field can still be interpreted');
});

test('REPORT: ordinary values keep their decoded value, raw bytes and set bits', async () => {
  const report = D.buildReport({ results: await scannedResults() });
  const f = (n) => report.fields.find((x) => x.name === n);
  assert.deepStrictEqual({ v: f('bms_soc_rt').value, r: f('bms_soc_rt').raw }, { v: 59, r: '3b' });
  assert.deepStrictEqual(f('db_k_function_status').bitsSet, [2, 64]);
  assert.strictEqual(f('db_mileage').value, 12345);
  assert.strictEqual(f('emcu_front_wheel_temperature').value, -5);
});

test('REPORT: skipped, refused and failed fields say why', async () => {
  const report = D.buildReport({ results: await scannedResults() });
  const f = (n) => report.fields.find((x) => x.name === n);
  assert.deepStrictEqual({ s: f('nfc_card_id_1').status, r: f('nfc_card_id_1').reason }, { s: 'skipped', r: 'credential' });
  assert.strictEqual(f('foc_k_cmd').reason, 'command');
  assert.deepStrictEqual({ s: f('db_bat_soc').status, c: f('db_bat_soc').errorCode }, { s: 'refused', c: '40' });
  assert.strictEqual(report.summary.total, 299);
  assert.strictEqual(report.summary.skipped, 40);
});

test('REPORT: contains no scooter keys, whatever else is in it', async () => {
  const results = await scannedResults();
  const text = D.reportText(D.buildReport({
    results, note: 'A = lights off, B = lights on',
    meta: { scooter: { name: 'NIU KQi', bleVersion: 10 } },
    comparisons: [{ label: 'A to B', changes: D.diffSnapshots(snap({ bms_soc_rt: E(1, '01') }), snap({ bms_soc_rt: E(2, '02') })) }],
  }));
  assert.ok(!text.includes(PWD), 'Bluetooth password leaked');
  assert.ok(!text.includes(AES), 'AES key leaked');
});

test('REPORT: it is valid JSON, ordered by field code, and deterministic', async () => {
  const results = await scannedResults();
  const a = D.reportText(D.buildReport({ results, meta: { generatedAt: 1 } }));
  const b = D.reportText(D.buildReport({ results, meta: { generatedAt: 1 } }));
  assert.strictEqual(a, b);
  const parsed = JSON.parse(a);
  const codes = parsed.fields.map((f) => f.code);
  assert.deepStrictEqual(codes, codes.slice().sort());
});

test('REPORT: comparisons and watch changes hide private values too, but keep the bit detail of the rest', () => {
  const cmp = D.diffSnapshots(
    snap({ db_sn: E('OLD-SECRET-SERIAL', 'aa'), db_k_function_status: E(0, '00000000') }),
    snap({ db_sn: E('NEW-SECRET-SERIAL', 'bb'), db_k_function_status: E(16, '00000010') }));
  const watch = [{ t: 1, name: 'ble_mac', kind: 'changed', from: E('1122', '1122'), to: E('3344', '3344') }];
  const text = D.reportText(D.buildReport({ results: {}, comparisons: [{ label: 'A to B', changes: cmp }], watchChanges: watch }));
  for (const secret of ['OLD-SECRET-SERIAL', 'NEW-SECRET-SERIAL', '1122', '3344']) assert.ok(!text.includes(secret), `${secret} leaked`);
  const parsed = JSON.parse(text);
  const status = parsed.comparisons[0].changes.find((c) => c.name === 'db_k_function_status');
  assert.deepStrictEqual(status.bitsSet, [16]);
  assert.strictEqual(parsed.comparisons[0].changes.find((c) => c.name === 'db_sn').private, true);
  assert.strictEqual(parsed.watchChanges[0].private, true);
});

test('REPORT: pushed frames hide private fields; notes and labels are length-limited', () => {
  const report = D.buildReport({
    results: {}, note: 'x'.repeat(2000),
    comparisons: [{ label: 'y'.repeat(500), changes: [] }],
    pushes: [{ t: 1, header: '0127', fields: { foc_k_rt_speed: 5, db_sn: 'SECRET' } }],
  });
  assert.strictEqual(report.note.length, 500);
  assert.strictEqual(report.comparisons[0].label.length, 120);
  assert.deepStrictEqual(report.pushes[0].fields, { foc_k_rt_speed: 5, db_sn: D.HIDDEN });
  assert.ok(!D.reportText(report).includes('SECRET'));
});

test('REPORT: an empty report is still valid and says what it is', () => {
  const report = D.buildReport({});
  assert.strictEqual(report.summary.total, 0);
  assert.match(report.privacy, /No scooter keys are included/);
  assert.doesNotThrow(() => JSON.parse(D.reportText(report)));
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; console.log(`  ok - ${name}`); }
    catch (err) { console.error(`  FAIL - ${name}\n    ${err.stack}`); process.exitCode = 1; }
  }
  console.log(`\n${passed} passed`);
})();
