/**
 * fake-scooter.js — a simulated NIU KQi (BLE 10) for tests.
 *
 * Deliberately implemented from the protocol description using Node's own
 * crypto and plain byte handling, NOT js/protocol.js, so a bug shared by both
 * sides can't hide. It speaks only what the dashboard needs: the two-step
 * password handshake and field reads.
 */
const nodeCrypto = require('crypto');

function keyBuf(key) {
  return key.length === 32 ? Buffer.from(key, 'hex') : Buffer.from(key, 'latin1');
}
function aes(key, block, encrypt) {
  const c = (encrypt ? nodeCrypto.createCipheriv : nodeCrypto.createDecipheriv)('aes-128-ecb', keyBuf(key), null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(block), c.final()]);
}
const sum = (buf) => buf.reduce((a, b) => (a + b) & 0xff, 0);
function frame(header, index, block16) {
  const body = Buffer.concat([Buffer.from(header), Buffer.from([index]), block16]);
  return Buffer.concat([body, Buffer.from([sum(body)])]);
}

class FakeScooter {
  /**
   * @param {object} o
   * @param {string} o.password 16-char blePassword
   * @param {string} o.aesKey   16-char bleAes
   * @param {Object<string,{len:number,value?:number,text?:string}>} o.fields by 6-hex-digit code
   * @param {string[]} [o.refuse] codes the scooter refuses (error 0x40)
   */
  constructor({ password, aesKey, fields, refuse = [] }) {
    this.password = password;
    this.aesKey = aesKey;
    this.fields = fields;
    this.refuse = new Set(refuse.map((c) => c.toUpperCase()));
    this.silent = false;           // when true, never answers (simulates a dead link)
    this.verified = false;
    this.log = [];                 // every received request, for assertions
    this._rnd = null;
    this._reply = null;
    this._pending = [];            // decrypted blocks of a multi-frame read request
  }

  /** Feed one 20-byte frame from the app; returns the reply frames (possibly none). */
  receive(buf) {
    if (this.silent || buf.length !== 20 || sum(buf.subarray(0, 19)) !== buf[19]) return [];
    const h0 = buf[0], h1 = buf[1], idx = buf[2];
    const payload = buf.subarray(3, 19);

    if (h0 === 0x01 && h1 === 0x23 && idx === 0x01) {            // handshake step 1
      this.log.push('hs1');
      this._rnd = aes(this.password, payload, false);
      this._reply = nodeCrypto.randomBytes(16);
      return [frame([0x01, 0xa3], 0x01, aes(this.password, this._reply, true))];
    }
    if (h0 === 0x01 && h1 === 0x03 && idx === 0x00) {            // handshake step 2
      this.log.push('hs2');
      const got = aes(this.password, payload, false);
      const want = nodeCrypto.createHash('md5')
        .update(Buffer.concat([this._rnd || Buffer.alloc(16), this._reply || Buffer.alloc(16), keyBuf(this.password)]))
        .digest();
      if (this._rnd && got.equals(want)) {
        this.verified = true;
        return [frame([0x01, 0x83], 0x00, aes(this.password, Buffer.concat([Buffer.from([0x00]), nodeCrypto.randomBytes(15)]), true))];
      }
      return [frame([0x01, 0xc3], 0x00, aes(this.password, Buffer.concat([Buffer.from([0x2a]), Buffer.alloc(15)]), true))];
    }
    if (h0 === 0x01 && (h1 === 0x21 || h1 === 0x01)) {           // read request (first / continuation)
      if (!this.verified) return [];
      if (h1 === 0x21) this._pending = [];
      this._pending.push(aes(this.aesKey, payload, false));
      if (idx !== 0x00) return [];
      const data = Buffer.concat(this._pending);
      this._pending = [];
      const codes = [];
      for (let i = 0; i + 3 <= data.length; i += 3) {
        const code = data.subarray(i, i + 3).toString('hex').toUpperCase();
        if (code === '000000') break;
        codes.push(code);
      }
      this.log.push('read ' + codes.join(','));
      if (codes.some((c) => this.refuse.has(c) || !this.fields[c])) {
        return [frame([0x01, 0xe1], 0x00, aes(this.aesKey, Buffer.concat([Buffer.from([0x40]), Buffer.alloc(15)]), true))];
      }
      const out = Buffer.concat(codes.map((c) => {
        const f = this.fields[c];
        const b = Buffer.alloc(f.len);
        if (f.text !== undefined) b.write(f.text, 'latin1');
        else for (let i = 0; i < f.len; i++) b[f.len - 1 - i] = Math.floor(f.value / 2 ** (8 * i)) & 0xff;
        return b;
      }));
      const n = Math.max(1, Math.ceil(out.length / 16));
      const frames = [];
      for (let i = 0; i < n; i++) {
        const block = Buffer.alloc(16);
        out.copy(block, 0, i * 16, (i + 1) * 16);
        frames.push(frame(i === 0 ? [0x01, 0xa1] : [0x01, 0x81], n - i - 1, aes(this.aesKey, block, true)));
      }
      return frames;
    }
    return [];
  }
}

/** Realistic field set, using the values read from the real 200F in testing. */
function defaultFields() {
  return {
    '21000B': { len: 2, value: 123 },           // foc_k_rt_speed: 12.3 km/h
    '21003B': { len: 2, value: 300 },           // foc_k_max_speed: 30.0 km/h
    '210002': { len: 8, text: 'KDE13G07' },     // foc_k_s_ver
    '31001C': { len: 1, value: 59 },            // bms_soc_rt
    '31004C': { len: 1, value: 93 },            // bms_soh_rt
    '310016': { len: 1, value: 48 },            // bms_rated_vlt
    '310018': { len: 2, value: 151 },           // bms_c_cont: charge cycles
    '31003C': { len: 8, text: 'K3D66V02' },     // bms_s_ver_n
    '110004': { len: 4, value: 4325377 },       // db_k_realtime_status (powered on)
    '110006': { len: 1, value: 0 },             // db_k_f_code
    '110002': { len: 8, text: 'K2C2FV32' },     // db_k_sw_ver
  };
}

module.exports = { FakeScooter, defaultFields };
