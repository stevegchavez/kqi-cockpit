/**
 * protocol.js — NIU Companion Web Dashboard
 *
 * Pure, DOM-free frame encode/decode logic. Deliberately isolated from
 * ble.js so it can be unit tested with plain Node (see /test) rather than
 * only ever being exercised against a real scooter.
 *
 * Frame layout (placeholder pending real-capture verification — see README
 * "Calibrating the protocol"):
 *   [0] 0x5A  [1] 0xA5  [2] length  [3] frameType  [4...] payload  [last] checksum (XOR of [2..n-2])
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./constants.js'));
  } else {
    root.NIU = root.NIU || {};
    root.NIU.Protocol = factory(root.NIU.BLE_CONSTANTS);
  }
})(typeof self !== 'undefined' ? self : this, function (C) {

  function xorChecksum(bytes, start, end) {
    // XOR of bytes[start .. end) — end exclusive.
    let checksum = 0;
    for (let i = start; i < end; i++) checksum ^= bytes[i];
    return checksum;
  }

  /**
   * Builds a properly framed + checksummed command packet ready to write
   * to the control characteristic.
   * @returns {Uint8Array}
   */
  function encodeCommand(cmd, payload) {
    payload = payload || [];
    const body = [cmd, ...payload];
    const withLen = [body.length + 1, ...body]; // +1 for the command byte itself
    const checksum = xorChecksum(withLen, 0, withLen.length);
    return new Uint8Array([C.SYNC0, C.SYNC1, ...withLen, checksum]);
  }

  /**
   * Parses a raw notify packet from the telemetry characteristic.
   * @param {Uint8Array|number[]} bytes
   * @returns {object|null} decoded fields, or null if the frame doesn't
   *   match the expected sync word, declared length, checksum, or frame type.
   */
  function parseTelemetry(bytes) {
    bytes = Array.from(bytes);
    if (bytes.length < 5) return null;
    if (bytes[0] !== C.SYNC0 || bytes[1] !== C.SYNC1) return null;

    const declaredLength = bytes[2];
    if (bytes.length < declaredLength + 3) return null; // +sync(2)+length(1)

    const checksumIndex = bytes.length - 1;
    const computed = xorChecksum(bytes, 2, checksumIndex);
    if (computed !== bytes[checksumIndex]) return null;

    if (bytes[3] !== C.TELEMETRY_FRAME_TYPE) return null;

    const payload = bytes.slice(4, checksumIndex);
    const out = {};

    if (payload.length >= 2) {
      out.speedKPH = (payload[0] | (payload[1] << 8)) / 10;
    }
    if (payload.length >= 3) {
      out.batterySOC = Math.min(payload[2], 100);
    }
    if (payload.length >= 7) {
      out.odometerMeters =
        (payload[3] | (payload[4] << 8) | (payload[5] << 16) | (payload[6] << 24)) >>> 0;
    }
    if (payload.length >= 9) {
      out.faultFlags = payload[7] | (payload[8] << 8);
    }
    if (payload.length >= 10) {
      out.headlightOn = (payload[9] & 0x01) !== 0;
      out.motorLocked = (payload[9] & 0x02) !== 0;
    }

    return out;
  }

  function headlightCommand(on) {
    return encodeCommand(C.CMD_HEADLIGHT, [on ? 0x01 : 0x00]);
  }

  function motorLockCommand(locked) {
    return encodeCommand(C.CMD_LOCK, [locked ? 0x01 : 0x00]);
  }

  function requestStateCommand() {
    return encodeCommand(C.CMD_REQUEST_STATE, []);
  }

  return {
    encodeCommand,
    parseTelemetry,
    headlightCommand,
    motorLockCommand,
    requestStateCommand,
    xorChecksum,
  };
});
