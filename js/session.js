/**
 * session.js — NIU Companion Web Dashboard
 *
 * Talks the NIU protocol over ANY transport that can write a 20-byte frame
 * and hand incoming notification bytes back via onNotification(). Keeping
 * Bluetooth out of here means the whole conversation — handshake, reads,
 * refusals, timeouts, polling — is tested in Node against a simulated
 * scooter (test/session.test.js).
 *
 * READ-ONLY: the session only authenticates and reads fields.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./constants.js'), require('./protocol.js'));
  } else {
    root.NIU = root.NIU || {};
    root.NIU.Session = factory(root.NIU.BLE_CONSTANTS, root.NIU.Protocol);
  }
})(typeof self !== 'undefined' ? self : this, function (C, P) {

  // What the dashboard polls. Both groups only contain fields that were read
  // successfully on a real KQi 200F; each fits in a single 16-byte request block.
  // A request holds at most 5 field codes. Current is fast-changing; health changes over weeks,
  // so it is read once per connection with the other slow values.
  const FAST_GROUP = ['foc_k_rt_speed', 'bms_soc_rt', 'db_k_realtime_status', 'db_k_f_code', 'bms_c_cur_rt'];
  const STATIC_GROUP = ['foc_k_max_speed', 'bms_rated_vlt', 'db_k_sw_ver', 'bms_c_cont', 'bms_soh_rt'];
  const ENERGY_GROUP = ['bms_accumulated_dc_energy', 'bms_accumulated_c_energy'];

  const MAX_PARKED = 50;

  class TimeoutError extends Error {
    constructor(message) { super(message); this.name = 'TimeoutError'; }
  }

  function defaultRandom(n) {
    const out = new Uint8Array(n);
    const c = globalThis.crypto || (typeof require === 'function' ? require('crypto').webcrypto : null);
    if (!c || !c.getRandomValues) throw new Error('No secure random number generator available.');
    c.getRandomValues(out);
    return out;
  }

  class Session {
    /**
     * @param {{write(frame: Uint8Array): Promise<void>}} transport
     * @param {{password: string, aes: string, timeoutMs?: number, random?: (n:number)=>Uint8Array,
     *          fieldTable?: object, catalogue?: {FIELDS: object, BY_CODE: object}}} opts
     *   fieldTable: which fields reads may name (default: the dashboard's small verified set).
     *   catalogue: the full field catalogue, used only to decode pushed frames.
     */
    constructor(transport, opts) {
      this.transport = transport;
      this.password = opts.password;
      this.aes = opts.aes;
      P.keyBytes(this.password);          // fail fast on malformed keys
      P.keyBytes(this.aes);
      this.timeoutMs = opts.timeoutMs || C.RESPONSE_TIMEOUT_MS;
      this.fieldTable = opts.fieldTable || P.FIELDS;
      this.catalogue = opts.catalogue || null;
      this.random = opts.random || defaultRandom;
      this.verified = false;
      this.unsupported = new Set();       // fields the scooter refused; skipped from now on
      this.parked = [];                   // unsolicited frames, newest last (bounded)
      this._queue = [];
      this._waiter = null;
      this._chain = Promise.resolve();
      this._polling = false;
      this._pollGen = 0;                  // bumped per polling run so a stale loop can never outlive stopPolling()
    }

    /** Transport calls this with every notification's raw bytes. */
    onNotification(bytes) {
      for (const frame of P.splitNotification(bytes)) {
        this._queue.push(frame);
      }
      this._wake();
    }

    _wake() {
      if (this._waiter) { const w = this._waiter; this._waiter = null; w(); }
    }

    /** Next frame accepted by `want`; others are parked, not lost. */
    async _next(want, timeoutMs) {
      const deadline = Date.now() + (timeoutMs || this.timeoutMs);
      for (;;) {
        while (this._queue.length) {
          const f = this._queue.shift();
          if (want(f)) return f;
          this._park(f);
        }
        const left = deadline - Date.now();
        if (left <= 0) throw new TimeoutError('no reply from scooter');
        await new Promise((resolve) => {
          const timer = setTimeout(() => { this._waiter = null; resolve(); }, left);
          this._waiter = () => { clearTimeout(timer); resolve(); };
        });
      }
    }

    async _send(frames) {
      // Anything already waiting is not an answer to this request: a late reply to an earlier
      // timed-out one, or a frame the scooter pushed on its own. Set it aside (takePushes()
      // filters the pushes out) rather than letting it be mistaken for this request's reply.
      for (const f of this._queue) this._park(f);
      this._queue.length = 0;
      for (const f of frames) await this.transport.write(f);
    }

    _park(frame) {
      this.parked.push({ t: Date.now(), frame });
      if (this.parked.length > MAX_PARKED) this.parked.shift();
    }

    /** Serializes exchanges so two callers can never interleave frames. */
    _exclusive(fn) {
      const run = this._chain.then(fn, fn);
      this._chain = run.then(() => undefined, () => undefined);
      return run;
    }

    // ------------------------------------------------------------ handshake

    handshake() {
      return this._exclusive(async () => {
        this.verified = false;
        const rnd = this.random(16);
        await this._send([P.handshake1(this.password, rnd)]);
        const r1 = await this._next((f) => f[0] === 0x01 && (f[1] === 0xa3 || f[1] === 0xc3));
        const reply = P.parseHandshake1Reply(r1, this.password);
        await this._send([P.handshake2(this.password, rnd, reply)]);
        const r2 = await this._next((f) => f[0] === 0x01 && (f[1] === 0x83 || f[1] === 0xc3));
        P.parseHandshake2Reply(r2, this.password);
        this.verified = true;
      });
    }

    // ------------------------------------------------------------ reads

    /** One request/reply exchange for `names`. @returns {Promise<{values:Object,raws:Object}>} */
    _readDetailedOnce(names, table) {
      return this._exclusive(async () => {
        if (!this.verified) throw new P.NiuError('not authenticated with the scooter yet');
        await this._send(P.buildRead(names, this.aes, table));
        const frames = [];
        for (;;) {
          const f = await this._next((fr) => fr[0] === 0x01 &&
            (fr[1] === 0xa1 || fr[1] === 0x81 || fr[1] === 0xe1 || fr[1] === 0xc1));
          frames.push(f);
          if (P.isLastReadFrame(f)) break;
        }
        return P.parseReadFramesDetailed(frames, names, this.aes, table);
      });
    }

    async _readOnce(names) {
      return (await this._readDetailedOnce(names, this.fieldTable)).values;
    }

    /**
     * Reads fields from any table (default: this session's), returning raw bytes too, and
     * sorting the outcome per field instead of throwing: if a group fails it asks for each
     * field alone. A TimeoutError still propagates, because that means the link is in trouble.
     * Does not touch the `unsupported` memory the dashboard polling uses.
     * @returns {Promise<{values:Object, raws:Object, refused:Object<string,string>, errors:Object<string,string>}>}
     *   refused: field -> the scooter's hex error code; errors: field -> message for a malformed reply
     */
    async readDetailed(names, table) {
      const t = table || this.fieldTable;
      const out = { values: {}, raws: {}, refused: {}, errors: {} };
      const merge = (r) => { Object.assign(out.values, r.values); Object.assign(out.raws, r.raws); };
      const classify = (name, err) => {
        if (!(err instanceof P.NiuError)) throw err;
        if (err.code) out.refused[name] = err.code;
        else out.errors[name] = err.message;
      };
      try {
        merge(await this._readDetailedOnce(names, t));
        return out;
      } catch (err) {
        if (!(err instanceof P.NiuError)) throw err;
        if (names.length === 1) { classify(names[0], err); return out; }
      }
      for (const name of names) {
        try { merge(await this._readDetailedOnce([name], t)); }
        catch (err) { classify(name, err); }
      }
      return out;
    }

    /**
     * Unsolicited frames the scooter pushed, decoded if a catalogue was supplied. Clears them.
     * @returns {{t:number, header:string, fields:Object|null, error?:string}[]}
     */
    takePushes() {
      const PUSH_SECOND_BYTES = new Set([0x27, 0x07, 0x25, 0x22, 0x02, 0x30, 0x10]);
      const out = [];
      for (const { t, frame } of this.parked) {
        if (frame.length !== C.FRAME_LENGTH || frame[0] !== 0x01 || !PUSH_SECOND_BYTES.has(frame[1])) continue;
        const entry = { t, header: P.toHex(frame.subarray(0, 2)), fields: null };
        if (this.catalogue) {
          try { entry.fields = P.parsePush(frame, this.aes, this.catalogue.BY_CODE, this.catalogue.FIELDS); }
          catch (err) { entry.error = err.message; }
        }
        out.push(entry);
      }
      this.parked = [];
      return out;
    }

    /**
     * Reads a group of fields. If the scooter refuses the group (it does this
     * when any one field is unsupported), falls back to one field at a time
     * and remembers which fields were refused. Timeouts are NOT retried.
     * @returns {Promise<Object>} raw values by field name (refused fields omitted)
     */
    async read(names) {
      const isRefusal = (e) => e instanceof P.NiuError && e.code !== '';
      const wanted = names.filter((n) => !this.unsupported.has(n));
      if (!wanted.length) return {};
      try {
        return await this._readOnce(wanted);
      } catch (err) {
        if (!isRefusal(err)) throw err;
        if (wanted.length === 1) {            // the one field we asked for is unsupported
          this.unsupported.add(wanted[0]);
          return {};
        }
      }
      const out = {};                          // group refused: ask for each field alone
      for (const name of wanted) {
        try {
          Object.assign(out, await this._readOnce([name]));
        } catch (err) {
          if (!isRefusal(err)) throw err;
          this.unsupported.add(name);
        }
      }
      return out;
    }

    async readStatus() { return P.interpretStatus(await this.read(FAST_GROUP)); }
    async readStatic() {
      const first = await this.read(STATIC_GROUP);
      let energy = {};
      try { energy = await this.read(ENERGY_GROUP); } catch (err) { if (err instanceof TimeoutError) throw err; }
      return P.interpretStatus(Object.assign(first, energy));
    }

    // ------------------------------------------------------------ polling

    /**
     * Reads the static group once, then the fast group every intervalMs.
     * Stops after `maxFailures` consecutive failures and reports via onError.
     */
    startPolling({ intervalMs = 1000, maxFailures = 3, onTelemetry, onError }) {
      if (this._polling) return;
      this._polling = true;
      const gen = ++this._pollGen;
      const alive = () => this._polling && this._pollGen === gen;
      let failures = 0;
      const step = async (fn) => {
        try {
          const t = await fn();
          failures = 0;
          if (alive() && onTelemetry) onTelemetry(t);
        } catch (err) {
          failures++;
          if (failures >= maxFailures && alive()) {
            this._polling = false;
            if (onError) onError(err);
          }
        }
      };
      (async () => {
        await step(() => this.readStatic());
        while (alive()) {
          await step(() => this.readStatus());
          if (!alive()) break;
          await new Promise((r) => setTimeout(r, intervalMs));
        }
      })();
    }

    stopPolling() { this._polling = false; }

    get isPolling() { return this._polling; }
  }

  return { Session, TimeoutError, FAST_GROUP, STATIC_GROUP, ENERGY_GROUP };
});
