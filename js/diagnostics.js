/**
 * diagnostics.js — NIU Companion Web Dashboard
 *
 * The logic behind the read-only Diagnostics tool: which fields may be read, how a full
 * scan is planned and run, how two snapshots are compared, how a live "watch" notices
 * changes, and how a shareable report is built with private values removed.
 *
 * No DOM, no Bluetooth: it talks to an object with `readDetailed(names, table)` (a
 * Session), so everything here is unit tested against a simulated scooter.
 *
 * SAFETY, in order of importance:
 *  1. It only ever asks the scooter to READ fields. There is no write path in this file.
 *  2. Some fields are never read: credentials (PINs, passwords, NFC card ids, the app's
 *     random challenge) and command registers. See skipReason().
 *  3. Identifiers and private text (serial numbers, MAC addresses, GPS cache, navigation
 *     and notification text, ...) are hidden on screen by default and ALWAYS removed from
 *     exported reports. See isPrivate().
 *  4. Reports never contain the scooter keys; they are not available to this module.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./protocol.js'), require('./fields.js'), require('./session.js'));
  } else {
    root.NIU = root.NIU || {};
    root.NIU.Diagnostics = factory(root.NIU.Protocol, root.NIU.Fields, root.NIU.Session);
  }
})(typeof self !== 'undefined' ? self : this, function (P, Fields, SessionNs) {
  const { TimeoutError } = SessionNs;

  // ------------------------------------------------------------------ policy

  /** Credentials and challenges: never requested, even though reading is harmless in itself. */
  const CREDENTIAL = /pwd|pwrd|passw|secret|token|nfc_card|app_random_num/i;
  /** Command registers and mode switches: a status tool has no business touching them. */
  const COMMAND = /cmd|command|enter_safe_mode/i;

  /** Identifiers and private text: hidden on screen, always redacted from exports. */
  const PRIVATE = [
    /(^|_)sn(_|$)/, /sn_id/, /serial/, /(^|_)mac(_|$)/, /slave/, /imei|imsi|iccid/, /ssid/,
    /gps/, /device_hash/, /badge_id/, /^foc_id$/, /(^|_)(uid|phone|user|account)(_|$)/,
    /navigation_name/, /navigation_text/, /traffic_light/, /island_notification/, /notice_text/,
    /face_name/, /security_log/,
  ];

  /** @returns {'credential'|'command'|null} why a field is never read, or null if it may be */
  function skipReason(name) {
    if (CREDENTIAL.test(name)) return 'credential';
    if (COMMAND.test(name)) return 'command';
    return null;
  }
  const isReadable = (name) => skipReason(name) === null;
  const isPrivate = (name) => PRIVATE.some((re) => re.test(name));

  // ------------------------------------------------------------------ planning

  const BATCH_MAX_FIELDS = 5;       // one 16-byte request block holds 5 field codes
  const BATCH_MAX_REPLY_BYTES = 48; // keep replies to a few frames; big fields travel alone

  /**
   * Splits field names into request-sized batches, in code order so related fields stay together.
   * @param {string[]} names
   * @param {Object} table field specs ({code, len, type})
   * @returns {string[][]}
   */
  function batchFields(names, table) {
    const sorted = names.slice().sort((a, b) => (table[a].code < table[b].code ? -1 : table[a].code > table[b].code ? 1 : 0));
    const batches = [];
    let cur = [];
    let bytes = 0;
    for (const n of sorted) {
      const len = table[n].len;
      if (cur.length && (cur.length >= BATCH_MAX_FIELDS || bytes + len > BATCH_MAX_REPLY_BYTES)) {
        batches.push(cur);
        cur = [];
        bytes = 0;
      }
      cur.push(n);
      bytes += len;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  /** What a full scan would do: readable names grouped into batches, and what is skipped and why. */
  function planScan(table) {
    const t = table || Fields.FIELDS;
    const readable = [];
    const skipped = [];
    for (const name of Object.keys(t)) {
      const reason = skipReason(name);
      if (reason) skipped.push({ name, reason });
      else readable.push(name);
    }
    skipped.sort((a, b) => (a.name < b.name ? -1 : 1));
    return { readable, skipped, batches: batchFields(readable, t) };
  }

  // ------------------------------------------------------------------ scanning

  const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Reads every readable field, batch by batch.
   * @param {{readDetailed:(names:string[], table:Object)=>Promise<Object>}} session
   * @param {{table?:Object, names?:string[], onProgress?:Function, isCancelled?:()=>boolean,
   *          spacingMs?:number, maxTimeouts?:number, sleep?:(ms:number)=>Promise}} [opts]
   * @returns {Promise<{results:Object, stats:Object, aborted:null|'cancelled'|'link-lost'}>}
   *   results[name] = {status:'ok',value,raw} | {status:'refused',code} | {status:'error',message}
   *                 | {status:'timeout'} | {status:'skipped',reason} | {status:'not-run'}
   */
  async function scan(session, opts) {
    const o = Object.assign({ table: Fields.FIELDS, spacingMs: 40, maxTimeouts: 3, sleep: defaultSleep }, opts);
    const results = {};
    const plan = planScan(o.table);
    for (const s of plan.skipped) results[s.name] = { status: 'skipped', reason: s.reason };
    const wanted = o.names ? o.names.filter(isReadable) : plan.readable;
    const batches = batchFields(wanted, o.table);
    for (const n of wanted) results[n] = { status: 'not-run' };

    let consecutiveTimeouts = 0;
    let aborted = null;
    for (let i = 0; i < batches.length; i++) {
      if (o.isCancelled && o.isCancelled()) { aborted = 'cancelled'; break; }
      const batch = batches[i];
      try {
        const r = await session.readDetailed(batch, o.table);
        consecutiveTimeouts = 0;
        for (const n of batch) {
          if (n in r.values) results[n] = { status: 'ok', value: r.values[n], raw: r.raws[n] };
          else if (n in r.refused) results[n] = { status: 'refused', code: r.refused[n] };
          else if (n in r.errors) results[n] = { status: 'error', message: r.errors[n] };
          else results[n] = { status: 'error', message: 'no reply' };
        }
      } catch (err) {
        if (!(err instanceof TimeoutError)) throw err;
        for (const n of batch) results[n] = { status: 'timeout' };
        if (++consecutiveTimeouts >= o.maxTimeouts) { aborted = 'link-lost'; break; }
      }
      if (o.onProgress) o.onProgress({ done: i + 1, total: batches.length, results });
      if (i < batches.length - 1 && o.spacingMs) await o.sleep(o.spacingMs);
    }

    const stats = { total: Object.keys(results).length, ok: 0, refused: 0, error: 0, timeout: 0, skipped: 0, 'not-run': 0 };
    for (const r of Object.values(results)) stats[r.status]++;
    return { results, stats, aborted };
  }

  // ------------------------------------------------------------------ snapshots and diffs

  /** The fields that answered, as a comparable snapshot. */
  function snapshot(results, t) {
    const fields = {};
    for (const [name, r] of Object.entries(results)) if (r.status === 'ok') fields[name] = { value: r.value, raw: r.raw };
    return { t: t === undefined ? Date.now() : t, fields };
  }

  const isInt = (spec) => spec && (spec.type === 'U8' || spec.type === 'U16' || spec.type === 'U32');

  /** Which bits turned on / off between two unsigned integers, as bit values (1, 2, 4, ...). */
  function bitChanges(a, b) {
    const x = (a ^ b) >>> 0;
    const set = [];
    const cleared = [];
    for (let i = 0; i < 32; i++) {
      const bit = 2 ** i;
      if (x & bit) (((b >>> i) & 1) ? set : cleared).push(bit);
    }
    return { set, cleared };
  }

  /** Which byte positions differ between two same-length hex strings. */
  function changedBytes(rawA, rawB) {
    if (rawA.length !== rawB.length) return null;
    const out = [];
    for (let i = 0; i < rawA.length; i += 2) if (rawA.substr(i, 2) !== rawB.substr(i, 2)) out.push(i / 2);
    return out;
  }

  function describeChange(name, from, to, table) {
    const spec = table[name];
    const c = { name, from: from || null, to: to || null };
    if (from && to) {
      c.kind = 'changed';
      if (isInt(spec)) {
        const { set, cleared } = bitChanges(from.value, to.value);
        c.bitsSet = set;
        c.bitsCleared = cleared;
      } else {
        const bytes = changedBytes(from.raw, to.raw);
        if (bytes) c.bytes = bytes;
      }
    } else {
      c.kind = from ? 'removed' : 'added';
    }
    return c;
  }

  /**
   * Differences between two snapshots, sorted by name. A field present in only one counts
   * as added/removed (it answered one time and not the other).
   */
  function diffSnapshots(a, b, table) {
    const t = table || Fields.FIELDS;
    const out = [];
    const names = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
    for (const name of [...names].sort()) {
      const from = a.fields[name];
      const to = b.fields[name];
      if (from && to && from.raw === to.raw) continue;
      out.push(describeChange(name, from, to, t));
    }
    return out;
  }

  // ------------------------------------------------------------------ live watch

  /**
   * Polls a set of fields and reports what changes. The first pass is the baseline and
   * reports nothing. A field that keeps changing (a clock, a counter) is muted after
   * `noisyAfter` changes so it can't drown out the rest; it is reported once as noisy.
   */
  class Watcher {
    /**
     * @param {{session:object, names:string[], table?:Object, now?:()=>number, noisyAfter?:number,
     *          maxTimeouts?:number, onChange?:Function, onNoisy?:Function, onPush?:Function, onError?:Function}} o
     */
    constructor(o) {
      this.session = o.session;
      this.table = o.table || Fields.FIELDS;
      this.names = o.names.filter(isReadable);
      this.batches = batchFields(this.names, this.table);
      this.now = o.now || Date.now;
      this.noisyAfter = o.noisyAfter || 6;
      this.maxTimeouts = o.maxTimeouts || 3;
      this.onChange = o.onChange || (() => {});
      this.onNoisy = o.onNoisy || (() => {});
      this.onPush = o.onPush || (() => {});
      this.onError = o.onError || (() => {});
      this.last = null;
      this.counts = {};
      this.muted = new Set();
      this.timeouts = 0;
      this.running = false;
      this.changes = [];
    }

    /** One pass over every watched field. @returns {Promise<Object[]>} changes seen on this pass */
    async step() {
      const current = {};
      for (const batch of this.batches) {
        const r = await this.session.readDetailed(batch, this.table);
        for (const n of Object.keys(r.values)) current[n] = { value: r.values[n], raw: r.raws[n] };
      }
      const pushes = this.session.takePushes ? this.session.takePushes() : [];
      if (pushes.length) this.onPush(pushes);
      const seen = [];
      if (this.last) {
        for (const name of Object.keys(current)) {
          const prev = this.last[name];
          if (!prev || prev.raw === current[name].raw) continue;
          this.counts[name] = (this.counts[name] || 0) + 1;
          if (this.muted.has(name)) continue;
          const change = Object.assign({ t: this.now() }, describeChange(name, prev, current[name], this.table));
          seen.push(change);
          this.changes.push(change);
          this.onChange(change);
          if (this.counts[name] >= this.noisyAfter) {
            this.muted.add(name);
            this.onNoisy(name);
          }
        }
      }
      this.last = current;
      return seen;
    }

    /** Runs until stop(). Stops itself after repeated timeouts. */
    async run(intervalMs, sleep) {
      const nap = sleep || defaultSleep;
      this.running = true;
      while (this.running) {
        try {
          await this.step();
          this.timeouts = 0;
        } catch (err) {
          if (!(err instanceof TimeoutError)) { this.running = false; this.onError(err); break; }
          if (++this.timeouts >= this.maxTimeouts) { this.running = false; this.onError(err); break; }
        }
        if (this.running) await nap(intervalMs);
      }
    }

    stop() { this.running = false; }
  }

  // ------------------------------------------------------------------ report

  const HIDDEN = '<hidden>';

  function bitsOf(value) {
    const out = [];
    for (let i = 0; i < 32; i++) if ((value >>> 0) & (2 ** i)) out.push(2 ** i);
    return out;
  }

  /** One field as it appears in a report. Private values are removed; everything else is kept. */
  function reportField(name, r, table) {
    const spec = table[name];
    const e = { name, code: spec.code, type: spec.type, len: spec.len, status: r.status };
    if (r.status === 'ok') {
      if (isPrivate(name)) { e.value = HIDDEN; e.raw = HIDDEN; e.private = true; }
      else {
        e.value = r.value;
        e.raw = r.raw;
        if (isInt(spec) && r.value > 0) e.bitsSet = bitsOf(r.value);
      }
    } else if (r.status === 'refused') e.errorCode = r.code;
    else if (r.status === 'error') e.message = r.message;
    else if (r.status === 'skipped') e.reason = r.reason;
    return e;
  }

  function reportChange(c, table) {
    const priv = isPrivate(c.name);
    const side = (s) => (s ? (priv ? { value: HIDDEN, raw: HIDDEN } : { value: s.value, raw: s.raw }) : null);
    const out = { name: c.name, kind: c.kind, from: side(c.from), to: side(c.to) };
    if (c.t !== undefined) out.t = new Date(c.t).toISOString();
    if (priv) out.private = true;
    else {
      if (c.bitsSet) out.bitsSet = c.bitsSet;
      if (c.bitsCleared) out.bitsCleared = c.bitsCleared;
      if (c.bytes) out.changedBytes = c.bytes;
    }
    return out;
  }

  /**
   * Builds the shareable report. Private values are removed here, in one place, so no
   * caller can forget to. Nothing in the input can put a scooter key into the output,
   * because keys are never passed to this module.
   * @param {{meta?:object, results?:Object, comparisons?:{label:string, changes:Object[]}[],
   *          watchChanges?:Object[], pushes?:Object[], note?:string, table?:Object}} input
   */
  function buildReport(input) {
    const table = input.table || Fields.FIELDS;
    const results = input.results || {};
    const names = Object.keys(results).sort((a, b) => (table[a].code < table[b].code ? -1 : 1));
    const fields = names.map((n) => reportField(n, results[n], table));
    const summary = { total: names.length, ok: 0, refused: 0, error: 0, timeout: 0, skipped: 0, 'not-run': 0 };
    for (const f of fields) summary[f.status]++;
    return {
      app: 'NIU Companion (KQi Cockpit) diagnostics',
      generatedAt: new Date(input.meta && input.meta.generatedAt !== undefined ? input.meta.generatedAt : Date.now()).toISOString(),
      scooter: Object.assign({}, input.meta && input.meta.scooter),
      note: String(input.note || '').slice(0, 500),
      privacy: 'Serial numbers, MAC addresses, GPS cache, navigation/notification text and similar are removed (<hidden>). Passwords, PINs, NFC card ids and command registers are never read. No scooter keys are included.',
      summary,
      fields,
      comparisons: (input.comparisons || []).map((c) => ({ label: String(c.label).slice(0, 120), changes: c.changes.map((x) => reportChange(x, table)) })),
      watchChanges: (input.watchChanges || []).map((c) => reportChange(c, table)),
      pushes: (input.pushes || []).map((p) => ({
        t: new Date(p.t).toISOString(),
        header: p.header,
        fields: p.fields ? Object.fromEntries(Object.entries(p.fields).map(([k, v]) => [k, isPrivate(k) ? HIDDEN : v])) : null,
        error: p.error,
      })),
    };
  }

  const reportText = (report) => JSON.stringify(report, null, 1) + '\n';

  return {
    skipReason, isReadable, isPrivate,
    batchFields, planScan, scan,
    snapshot, diffSnapshots, bitChanges, changedBytes,
    Watcher, buildReport, reportText, HIDDEN,
    BATCH_MAX_FIELDS, BATCH_MAX_REPLY_BYTES,
  };
});
