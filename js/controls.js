/**
 * controls.js — NIU Companion Web Dashboard
 *
 * The ONLY place in the app that can send a command to the scooter. Everything else
 * (protocol.js, session.js, diagnostics) stays read-only.
 *
 * What it can send is a fixed allow-list of four commands, nothing else:
 *   lock / unlock      motor lock      (foc_k_cmd 1 / 2)
 *   alarmOn / alarmOff alarm sound     (db_k_cmd 6 / 5)
 * These command numbers come from the niu-kqi project (MIT, see NOTICE.md), which recovered
 * them from the NIU app and tested them on a KQi Air. On the KQi 200F they are untested until
 * the first real try. Frames are checked byte-for-byte against that project's reference
 * implementation (test/fixtures/niu_vectors.json, made-up test keys).
 *
 * Safety rules, enforced here and not just in the UI:
 *   - Controls are off until the rider turns them on in Setup.
 *   - Lock and unlock are refused unless a fresh read shows the scooter at 0 km/h, and never
 *     while a ride is being recorded. There is deliberately no "kill switch while moving".
 *   - Commands are spaced out (MIN_GAP_MS) so a double tap cannot fire twice.
 * After each command the app reads a few status words before and after and keeps both in a
 * small on-device log, so the bit that means "locked" can be found later.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./protocol.js'), require('./crypto.js'));
  } else {
    root.NIU = root.NIU || {};
    root.NIU.Controls = factory(root.NIU.Protocol, root.NIU.Crypto);
  }
})(typeof self !== 'undefined' ? self : this, function (P, Crypto) {
  const WRITE_FIRST = [0x01, 0x22];
  const WRITE_ACK = [[0x01, 0xa2], [0x01, 0x82]];
  const WRITE_ERR = [[0x01, 0xe2], [0x01, 0xc2]];
  const MIN_GAP_MS = 2500;
  const LOG_KEY = 'niu.controlLog';
  const ENABLE_KEY = 'niu.controls';
  const MAX_LOG = 50;

  /** The allow-list. Frozen: nothing at runtime can add a command. */
  const COMMANDS = Object.freeze({
    lock: Object.freeze({ label: 'Lock', code: '210016', len: 2, value: 1, stillOnly: true, done: 'Lock command accepted' }),
    unlock: Object.freeze({ label: 'Unlock', code: '210016', len: 2, value: 2, stillOnly: true, done: 'Unlock command accepted' }),
    alarmOn: Object.freeze({ label: 'Alarm on', code: '11000F', len: 1, value: 6, stillOnly: false, done: 'Alarm turned on' }),
    alarmOff: Object.freeze({ label: 'Alarm off', code: '11000F', len: 1, value: 5, stillOnly: false, done: 'Alarm turned off' }),
  });

  /** Status words read before and after a command, to learn which bit tracks the lock. */
  const READBACK = ['db_k_realtime_status', 'db_k_function_status', 'foc_k_realtime_status1', 'foc_k_function_status1'];

  class SafetyError extends Error {
    constructor(message) { super(message); this.name = 'SafetyError'; }
  }

  const same = (frame, h) => frame.length >= 2 && frame[0] === h[0] && frame[1] === h[1];

  /** The one 20-byte frame for an allow-listed command. */
  function buildCommand(name, aesKey) {
    const cmd = Object.prototype.hasOwnProperty.call(COMMANDS, name) ? COMMANDS[name] : null;
    if (!cmd) throw new SafetyError(`"${name}" is not a command this app can send`);
    const data = new Uint8Array(16);                     // code(3) + value(len), zero-padded
    data.set(P.fromHex(cmd.code), 0);
    for (let i = 0; i < cmd.len; i++) data[3 + i] = (cmd.value >> (8 * (cmd.len - 1 - i))) & 0xff;
    const body = P.concat(Uint8Array.from(WRITE_FIRST), Uint8Array.of(0x00), Crypto.aesEncryptBlock(P.keyBytes(aesKey), data));
    return P.concat(body, Uint8Array.of(P.checksum(body)));
  }

  const isWriteReply = (f) => WRITE_ACK.some((h) => same(f, h)) || WRITE_ERR.some((h) => same(f, h));

  /** Checks the scooter's answer to a command. Throws P.NiuError on refusal or a bad frame. */
  function parseWriteReply(frame, aesKey) {
    if (frame.length !== 20 || !P.checksumOk(frame)) throw new P.NiuError('bad checksum in the reply to a command');
    const result = Crypto.aesDecryptBlock(P.keyBytes(aesKey), frame.slice(3, 19))[0];
    const hex = (result < 16 ? '0' : '') + result.toString(16).toUpperCase();
    if (WRITE_ERR.some((h) => same(frame, h))) throw new P.NiuError(`the scooter refused the command (error ${hex})`, hex);
    if (!WRITE_ACK.some((h) => same(frame, h))) throw new P.NiuError('unexpected reply to a command');
    if (frame[2] !== 0x00) throw new P.NiuError('the reply to a command did not finish');
    if (result !== 0) throw new P.NiuError(`the scooter answered the command with result ${hex}`, hex);
    return true;
  }

  function isEnabled(storage) {
    try { const v = JSON.parse(storage.getItem(ENABLE_KEY)); return !!(v && v.enabled); } catch { return false; }
  }
  function setEnabled(storage, on, now) {
    try { storage.setItem(ENABLE_KEY, JSON.stringify({ enabled: !!on, t: now || Date.now() })); } catch { /* blocked */ }
  }
  function readLog(storage) {
    try { const v = JSON.parse(storage.getItem(LOG_KEY)); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  function appendLog(storage, entry) {
    try { storage.setItem(LOG_KEY, JSON.stringify(readLog(storage).concat([entry]).slice(-MAX_LOG))); } catch { /* blocked */ }
  }

  /**
   * Sends one allow-listed command over an authenticated session, with the safety checks.
   * The caller pauses the dashboard's polling first (BLEManager.withPollingPaused).
   * @param {object} session  an authenticated Session
   * @param {string} name     a key of COMMANDS
   * @param {{aes: string, enabled: boolean, isRiding: boolean, fieldTable: object,
   *          storage?: Storage, now?: () => number, lastSentAt?: number}} ctx
   * @returns {Promise<{name, speedKPH, before, after}>}
   */
  async function send(session, name, ctx) {
    const cmd = Object.prototype.hasOwnProperty.call(COMMANDS, name) ? COMMANDS[name] : null;
    if (!cmd) throw new SafetyError(`"${name}" is not a command this app can send`);
    if (!ctx || !ctx.enabled) throw new SafetyError('Controls are turned off. Turn them on in Setup first.');
    const now = ctx.now || Date.now;
    if (ctx.lastSentAt && now() - ctx.lastSentAt < MIN_GAP_MS) throw new SafetyError('Please wait a moment between commands.');
    if (cmd.stillOnly && ctx.isRiding) throw new SafetyError('Finish the ride first. Lock and unlock only work while stopped.');
    if (!session || !session.verified) throw new SafetyError('Connect to the scooter first.');

    const table = ctx.fieldTable;
    const before = await session.readDetailed(READBACK.concat(['foc_k_rt_speed']), table);
    const raw = before.values.foc_k_rt_speed;
    const speedKPH = typeof raw === 'number' ? raw / 10 : null;
    if (cmd.stillOnly && (speedKPH === null || speedKPH > 0)) {
      throw new SafetyError(speedKPH === null
        ? 'Could not confirm the scooter is stopped, so nothing was sent.'
        : `The scooter reports ${speedKPH} km/h. Lock and unlock only work at a standstill.`);
    }

    const frame = buildCommand(name, ctx.aes);
    await session._exclusive(async () => {
      if (!session.verified) throw new SafetyError('Connect to the scooter first.');
      await session._send([frame]);
      const reply = await session._next(isWriteReply);
      parseWriteReply(reply, ctx.aes);
    });

    let after = { values: {} };
    try { after = await session.readDetailed(READBACK, table); } catch { /* read-back is informational */ }
    const pick = (v) => Object.fromEntries(READBACK.filter((k) => typeof v[k] === 'number').map((k) => [k, v[k]]));
    const result = { name, speedKPH, before: pick(before.values), after: pick(after.values) };
    if (ctx.storage) appendLog(ctx.storage, Object.assign({ t: now() }, result));
    return result;
  }

  return {
    COMMANDS, READBACK, MIN_GAP_MS, SafetyError,
    buildCommand, parseWriteReply, isWriteReply, send,
    isEnabled, setEnabled, readLog, ENABLE_KEY, LOG_KEY,
  };
});
