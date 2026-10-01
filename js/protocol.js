/**
 * protocol.js — NIU Companion Web Dashboard
 *
 * Pure, DOM-free implementation of the NIU KQi Bluetooth frame protocol for
 * "BLE version 10" scooters (service UUID ending ...daea50), which is what
 * the KQi 200F reports. Nothing here touches Bluetooth, so everything is
 * unit tested in plain Node, including byte-for-byte against a reference
 * implementation (test/fixtures/niu_vectors.json).
 *
 * Frame layout (every frame is exactly 20 bytes):
 *   [0..1] header   [2] index (frames still to come)   [3..18] AES-128-ECB block   [19] checksum
 * The checksum is the sum of the previous 19 bytes, mod 256.
 *
 * Authentication (BLE 10) uses the per-vehicle "blePassword" (16 chars):
 *   1. send  01 23 01 + AES_pwd(random16)           -> scooter replies 01 A3 .. AES_pwd(reply16)
 *   2. send  01 03 00 + AES_pwd(md5(random16 || reply16 || pwd))  -> scooter replies 01 83 ..
 * After that, data frames are encrypted with the per-vehicle "bleAes" key.
 *
 * The frame layout and handshake follow https://github.com/BaesTheorem/niu-kqi
 * (MIT, see NOTICE.md); the handshake frames' first bytes were also confirmed
 * against a real KQi 200F capture.
 *
 * READ-ONLY by design: this module can request fields but has no write
 * builders, so the app cannot change any scooter setting.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./constants.js'), require('./crypto.js'));
  } else {
    root.NIU = root.NIU || {};
    root.NIU.Protocol = factory(root.NIU.BLE_CONSTANTS, root.NIU.Crypto);
  }
})(typeof self !== 'undefined' ? self : this, function (C, Crypto) {

  class NiuError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'NiuError';
      this.code = code || '';   // 2-digit hex error code reported by the scooter, if any
    }
  }

  // ------------------------------------------------------------------ bytes

  function toHex(bytes) {
    let s = '';
    for (const b of bytes) s += (b < 16 ? '0' : '') + b.toString(16);
    return s;
  }

  function fromHex(hex) {
    if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
      throw new NiuError('invalid hex string');
    }
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  function checksum(bytes) {
    let sum = 0;
    for (const b of bytes) sum = (sum + b) & 0xff;
    return sum;
  }

  /** True when the last byte equals the sum of all the bytes before it. */
  function checksumOk(frame) {
    return frame.length >= 2 && frame[frame.length - 1] === checksum(frame.subarray(0, frame.length - 1));
  }

  function headerIs(frame, header) {
    return frame.length >= 2 && frame[0] === header[0] && frame[1] === header[1];
  }

  function hex2(n) {
    return (n < 16 ? '0' : '') + n.toString(16).toUpperCase();
  }

  // ------------------------------------------------------------------ keys

  /**
   * Accepts a 16-character ASCII key (used as-is) or 32 hex digits.
   * @returns {Uint8Array} 16 bytes
   */
  function keyBytes(key) {
    if (key instanceof Uint8Array && key.length === 16) return key;
    if (typeof key === 'string') {
      if (key.length === 16) {
        const out = new Uint8Array(16);
        for (let i = 0; i < 16; i++) {
          const c = key.charCodeAt(i);
          if (c > 0x7f) throw new NiuError('AES key must be plain ASCII');
          out[i] = c;
        }
        return out;
      }
      if (key.length === 32 && /^[0-9a-fA-F]{32}$/.test(key)) return fromHex(key);
    }
    throw new NiuError('AES key must be 16 characters or 32 hex digits');
  }

  const encBlock = (key, block) => Crypto.aesEncryptBlock(key, block);
  const decBlock = (key, block) => Crypto.aesDecryptBlock(key, block);

  // ------------------------------------------------------------------ fields

  // The subset of the scooter's field table this dashboard reads. Codes and
  // types come from the field table extracted from NIU's app by niu-kqi
  // (data/fields.json, MIT). Only fields confirmed readable on a real KQi 200F
  // are listed. Multi-byte integers are big-endian.
  const FIELDS = {
    foc_k_rt_speed:       { code: '21000B', len: 2, type: 'U16' },
    foc_k_max_speed:      { code: '21003B', len: 2, type: 'U16' },
    foc_k_s_ver:          { code: '210002', len: 8, type: 'UTF-8' },
    bms_soc_rt:           { code: '31001C', len: 1, type: 'U8' },
    bms_soh_rt:           { code: '31004C', len: 1, type: 'U8' },
    bms_rated_vlt:        { code: '310016', len: 1, type: 'U8' },
    bms_c_cont:           { code: '310018', len: 2, type: 'U16' },   // charge cycle count (confirmed on a 200F)
    bms_s_ver_n:          { code: '31003C', len: 8, type: 'UTF-8' },
    db_k_realtime_status: { code: '110004', len: 4, type: 'U32' },
    db_k_f_code:          { code: '110006', len: 1, type: 'U8' },
    db_k_sw_ver:          { code: '110002', len: 8, type: 'UTF-8' },
  };

  function field(name) {
    const spec = FIELDS[name];
    if (!spec) throw new NiuError(`unknown or unsupported field ${name}`);
    return spec;
  }

  function decodeValue(spec, bytes) {
    if (spec.type === 'U8' || spec.type === 'U16' || spec.type === 'U32') {
      let v = 0;
      for (const b of bytes) v = v * 256 + b;
      return v;
    }
    if (spec.type === 'UTF-8') {
      let end = bytes.length;
      while (end > 0 && bytes[end - 1] === 0) end--;
      const trimmed = bytes.subarray(0, end);
      if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(trimmed);
      return String.fromCharCode.apply(null, Array.from(trimmed));
    }
    throw new NiuError(`unsupported field type ${spec.type}`);
  }

  /** Values laid out back-to-back in request order. */
  function parseFieldsSequential(data, names) {
    const out = {};
    let pos = 0;
    for (const name of names) {
      const spec = field(name);
      const end = pos + spec.len;
      if (end > data.length) {
        throw new NiuError(`reply too short for ${name} (got ${data.length} bytes)`);
      }
      out[name] = decodeValue(spec, data.subarray(pos, end));
      pos = end;
    }
    return out;
  }

  // ------------------------------------------------------------------ frames

  /** Splits `data` into 16-byte AES blocks, one 20-byte frame each. */
  function buildChunked(firstHeader, nextHeader, data, key) {
    const k = keyBytes(key);
    const n = Math.max(1, Math.ceil(data.length / 16));
    const frames = [];
    for (let i = 0; i < n; i++) {
      const chunk = new Uint8Array(16);           // zero-padded on the right
      chunk.set(data.subarray(i * 16, (i + 1) * 16));
      const hdr = i === 0 ? firstHeader : nextHeader;
      const body = concat(Uint8Array.from(hdr), Uint8Array.of(n - i - 1), encBlock(k, chunk));
      frames.push(concat(body, Uint8Array.of(checksum(body))));
    }
    return frames;
  }

  /** Request frames asking the scooter for the named fields. */
  function buildRead(names, key) {
    const data = concat(...names.map((n) => fromHex(field(n).code)));
    return buildChunked(C.HEADERS.READ[0], C.HEADERS.READ[1], data, key);
  }

  /** True when a read reply frame is the final one (index 0) or an error. */
  function isLastReadFrame(frame) {
    return frame[2] === 0x00 || isReadError(frame);
  }

  function isReadError(frame) {
    return headerIs(frame, C.HEADERS.READ_ERR[0]) || headerIs(frame, C.HEADERS.READ_ERR[1]);
  }

  function errorCode(frame, key) {
    return hex2(decBlock(keyBytes(key), frame.slice(3, 19))[0]);
  }

  /** Reassembles a read reply and splits it into named values. */
  function parseReadFrames(frames, names, key) {
    const k = keyBytes(key);
    let receivable = 0;
    let actual = 0;
    const chunks = [];
    for (const f of frames) {
      if (f.length !== C.FRAME_LENGTH || !checksumOk(f)) throw new NiuError('bad checksum in reply frame');
      if (f[2] === 0xff) continue;
      if (headerIs(f, C.HEADERS.READ_ACK[0])) {
        receivable = f[2] + 1;
        chunks.push(decBlock(k, f.slice(3, 19)));
        actual++;
      } else if (headerIs(f, C.HEADERS.READ_ACK[1])) {
        chunks.push(decBlock(k, f.slice(3, 19)));
        actual++;
      } else if (isReadError(f)) {
        const code = errorCode(f, k);
        throw new NiuError(`scooter refused the read (error ${code})`, code);
      } else {
        throw new NiuError(`unexpected reply header ${toHex(f.subarray(0, 2))}`);
      }
    }
    if (receivable !== actual) {
      throw new NiuError(`frame loss: expected ${receivable} data frames, got ${actual}`);
    }
    return parseFieldsSequential(concat(...chunks), names);
  }

  /** The scooter may deliver several 20-byte frames in one notification. */
  function splitNotification(bytes) {
    if (bytes.length > 0 && bytes.length % C.FRAME_LENGTH === 0) {
      const out = [];
      for (let i = 0; i < bytes.length; i += C.FRAME_LENGTH) out.push(bytes.slice(i, i + C.FRAME_LENGTH));
      return out;
    }
    return [bytes];
  }

  // ------------------------------------------------------------------ handshake (BLE 10)

  /** Step 1 request: 01 23 01 + AES_pwd(random16). */
  function handshake1(password, random16) {
    const k = keyBytes(password);
    if (!(random16 instanceof Uint8Array) || random16.length !== 16) throw new NiuError('random must be 16 bytes');
    const body = concat(Uint8Array.from([...C.HEADERS.HS1, 0x01]), encBlock(k, random16));
    return concat(body, Uint8Array.of(checksum(body)));
  }

  /** Step 1 reply -> the scooter's 16 plaintext bytes. */
  function parseHandshake1Reply(frame, password) {
    const k = keyBytes(password);
    if (headerIs(frame, C.HEADERS.HS_ERR)) {
      throw new NiuError(`password rejected at step 1 (error ${errorCode(frame, k)})`, errorCode(frame, k));
    }
    if (!headerIs(frame, C.HEADERS.HS1_ACK)) throw new NiuError(`unexpected verify reply ${toHex(frame.subarray(0, 2))}`);
    if (frame.length !== C.FRAME_LENGTH || !checksumOk(frame)) throw new NiuError('bad checksum in verify reply 1');
    return decBlock(k, frame.slice(3, 19));
  }

  /** Step 2 request: 01 03 00 + AES_pwd(md5(random16 || reply16 || pwd)). */
  function handshake2(password, random16, reply16) {
    const k = keyBytes(password);
    const digest = Crypto.md5(concat(random16, reply16, k));
    const body = concat(Uint8Array.from([...C.HEADERS.HS2, 0x00]), encBlock(k, digest));
    return concat(body, Uint8Array.of(checksum(body)));
  }

  /** Step 2 reply; throws unless the scooter accepted the password. */
  function parseHandshake2Reply(frame, password) {
    const k = keyBytes(password);
    if (headerIs(frame, C.HEADERS.HS_ERR)) {
      throw new NiuError(`password rejected at step 2 (error ${errorCode(frame, k)})`, errorCode(frame, k));
    }
    if (!headerIs(frame, C.HEADERS.HS2_ACK)) throw new NiuError(`unexpected verify reply ${toHex(frame.subarray(0, 2))}`);
    if (frame.length !== C.FRAME_LENGTH || !checksumOk(frame)) throw new NiuError('bad checksum in verify reply 2');
    const plain = decBlock(k, frame.slice(3, 19));
    if (plain[0] !== 0x00) throw new NiuError(`password verify failed (flag ${hex2(plain[0])})`);
    return plain;
  }

  // ------------------------------------------------------------------ interpretation

  /**
   * Maps raw field values to the dashboard's telemetry shape. Only keys whose
   * source field was present are returned, so partial reads merge cleanly.
   *
   * Scale notes: speeds are km/h x 10. The x10 scale is confirmed for
   * foc_k_max_speed (300 = 30.0 km/h); for the live speed it is assumed to
   * match and still needs checking on a real ride.
   */
  function interpretStatus(v) {
    const t = {};
    if (v.foc_k_rt_speed !== undefined) t.speedKPH = v.foc_k_rt_speed / 10;
    if (v.bms_soc_rt !== undefined) t.batterySOC = Math.min(v.bms_soc_rt, 100);
    if (v.bms_soh_rt !== undefined) t.batteryHealth = Math.min(v.bms_soh_rt, 100);
    if (v.db_k_realtime_status !== undefined) t.poweredOn = (v.db_k_realtime_status & 1) === 1;
    if (v.db_k_f_code !== undefined) t.faultFlags = v.db_k_f_code;
    if (v.foc_k_max_speed !== undefined) t.maxSpeedKPH = v.foc_k_max_speed / 10;
    if (v.bms_rated_vlt !== undefined) t.ratedVoltage = v.bms_rated_vlt;
    if (v.bms_c_cont !== undefined) t.chargeCycles = v.bms_c_cont;
    if (v.db_k_sw_ver !== undefined) t.dashboardVersion = v.db_k_sw_ver;
    return t;
  }

  return {
    NiuError, FIELDS,
    toHex, fromHex, concat, checksum, checksumOk, keyBytes,
    buildRead, parseReadFrames, isLastReadFrame, isReadError, splitNotification,
    handshake1, parseHandshake1Reply, handshake2, parseHandshake2Reply,
    interpretStatus, decodeValue,
  };
});
