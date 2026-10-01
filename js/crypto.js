/**
 * crypto.js — NIU Companion Web Dashboard
 *
 * Minimal AES-128 (ECB, single block) and MD5, because the scooter's frame
 * format needs both and neither is available in browsers: WebCrypto has no
 * ECB mode and no MD5.
 *
 * ECB and MD5 are used here ONLY because the scooter's protocol dictates
 * them. Don't reuse this module for anything else.
 *
 * Verified against Node's built-in crypto (random inputs) and the FIPS-197
 * Appendix C.1 vector — see test/crypto.test.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NIU = root.NIU || {};
    root.NIU.Crypto = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // ------------------------------------------------------------------ AES

  const SBOX = new Uint8Array(256);
  const INV_SBOX = new Uint8Array(256);
  (function initSbox() {
    const rotl8 = (x, n) => ((x << n) | (x >> (8 - n))) & 0xff;
    let p = 1, q = 1;
    do {
      p = (p ^ (p << 1) ^ (p & 0x80 ? 0x11b : 0)) & 0xff;      // p *= 3
      q = (q ^ (q << 1)) & 0xff;                               // q /= 3
      q = (q ^ (q << 2)) & 0xff;
      q = (q ^ (q << 4)) & 0xff;
      if (q & 0x80) q ^= 0x09;
      const x = q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4);
      SBOX[p] = (x ^ 0x63) & 0xff;
    } while (p !== 1);
    SBOX[0] = 0x63;
    for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
  })();

  function xtime(a) { return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff; }
  function gmul(a, b) {
    let r = 0;
    while (b) {
      if (b & 1) r ^= a;
      a = xtime(a);
      b >>= 1;
    }
    return r;
  }

  function expandKey(key) {
    if (!(key instanceof Uint8Array) || key.length !== 16) {
      throw new Error('AES-128 key must be 16 bytes');
    }
    const w = new Uint8Array(176);
    w.set(key);
    let rcon = 1;
    for (let i = 16; i < 176; i += 4) {
      let t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
      if (i % 16 === 0) {
        const s0 = SBOX[t1] ^ rcon, s1 = SBOX[t2], s2 = SBOX[t3], s3 = SBOX[t0];
        t0 = s0; t1 = s1; t2 = s2; t3 = s3;
        rcon = xtime(rcon);
      }
      w[i] = w[i - 16] ^ t0;
      w[i + 1] = w[i - 15] ^ t1;
      w[i + 2] = w[i - 14] ^ t2;
      w[i + 3] = w[i - 13] ^ t3;
    }
    return w;
  }

  function addRoundKey(s, w, round) {
    for (let i = 0; i < 16; i++) s[i] ^= w[round * 16 + i];
  }

  function subBytes(s, box) {
    for (let i = 0; i < 16; i++) s[i] = box[s[i]];
  }

  // State is column-major: s[r + 4c].
  function shiftRows(s) {
    const t = s.slice();
    for (let r = 1; r < 4; r++) {
      for (let c = 0; c < 4; c++) s[r + 4 * c] = t[r + 4 * ((c + r) % 4)];
    }
  }
  function invShiftRows(s) {
    const t = s.slice();
    for (let r = 1; r < 4; r++) {
      for (let c = 0; c < 4; c++) s[r + 4 * ((c + r) % 4)] = t[r + 4 * c];
    }
  }

  function mixColumns(s) {
    for (let c = 0; c < 4; c++) {
      const a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3];
      s[4 * c] = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
      s[4 * c + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
      s[4 * c + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
      s[4 * c + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3);
    }
  }
  function invMixColumns(s) {
    for (let c = 0; c < 4; c++) {
      const a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3];
      s[4 * c] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
      s[4 * c + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
      s[4 * c + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
      s[4 * c + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
    }
  }

  function checkBlock(block) {
    if (!(block instanceof Uint8Array) || block.length !== 16) {
      throw new Error('AES block must be 16 bytes');
    }
  }

  /** Encrypts one 16-byte block. @returns {Uint8Array} */
  function aesEncryptBlock(key, block) {
    checkBlock(block);
    const w = expandKey(key);
    const s = block.slice();
    addRoundKey(s, w, 0);
    for (let round = 1; round < 10; round++) {
      subBytes(s, SBOX); shiftRows(s); mixColumns(s); addRoundKey(s, w, round);
    }
    subBytes(s, SBOX); shiftRows(s); addRoundKey(s, w, 10);
    return s;
  }

  /** Decrypts one 16-byte block. @returns {Uint8Array} */
  function aesDecryptBlock(key, block) {
    checkBlock(block);
    const w = expandKey(key);
    const s = block.slice();
    addRoundKey(s, w, 10);
    for (let round = 9; round > 0; round--) {
      invShiftRows(s); subBytes(s, INV_SBOX); addRoundKey(s, w, round); invMixColumns(s);
    }
    invShiftRows(s); subBytes(s, INV_SBOX); addRoundKey(s, w, 0);
    return s;
  }

  // ------------------------------------------------------------------ MD5

  const MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const MD5_K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  /** MD5 of a byte array. @returns {Uint8Array} 16 bytes */
  function md5(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new Error('md5 expects a Uint8Array');
    const len = bytes.length;
    const padded = new Uint8Array(((len + 8) >> 6 << 6) + 64);
    padded.set(bytes);
    padded[len] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, (len << 3) >>> 0, true);
    view.setUint32(padded.length - 4, Math.floor(len / 0x20000000), true);

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let off = 0; off < padded.length; off += 64) {
      const M = new Uint32Array(16);
      for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + MD5_K[i] + M[g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + ((F << MD5_S[i]) | (F >>> (32 - MD5_S[i])))) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    const out = new Uint8Array(16);
    const ov = new DataView(out.buffer);
    ov.setUint32(0, a0, true); ov.setUint32(4, b0, true);
    ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
    return out;
  }

  return { aesEncryptBlock, aesDecryptBlock, md5 };
});
