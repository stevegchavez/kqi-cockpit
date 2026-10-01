/**
 * battery.js — NIU Companion Web Dashboard
 *
 * Battery history: a small on-device log of battery %, health %, charge-cycle
 * count and power state, plus the pure functions that decide when to record a
 * sample and what the history means. Stored in its own IndexedDB database;
 * nothing is ever sent anywhere.
 *
 * Honest limits: the app only sees the battery while it is connected, so a
 * charge is *inferred* from a jump in battery % between two connections. And
 * health is a whole number, so a trend needs many days and cycles to mean much.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NIU = root.NIU || {};
    root.NIU.Battery = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const DB_NAME = 'niu-battery';
  const DB_VERSION = 1;
  const STORE = 'samples';
  const MAX_SAMPLES = 20000;
  const PRUNE_EVERY = 200;
  const HEARTBEAT_MS = 10 * 60 * 1000;   // record at least this often while connected
  const MIN_GAP_MS = 30 * 1000;          // battery % flickers at rest; don't log every wobble
  const DAY_MS = 86400000;

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  /**
   * Should `next` be added to the history, given the last recorded sample?
   * @param {{t:number,soc:number,soh?:number,cycles?:number,on?:boolean}|null} prev
   */
  function shouldRecord(prev, next) {
    if (!next || !isNum(next.soc) || !isNum(next.t)) return false;
    if (!prev) return true;
    const dt = next.t - prev.t;
    if (dt <= 0) return false;
    if (next.cycles !== prev.cycles || next.soh !== prev.soh || next.on !== prev.on) return true;
    if (next.soc !== prev.soc) return dt >= MIN_GAP_MS;
    return dt >= HEARTBEAT_MS;
  }

  /**
   * Charges inferred from a rise in battery % between consecutive samples
   * (the scooter charges while the app isn't connected).
   */
  function inferCharges(samples, minRisePct) {
    const rise = minRisePct || 10;
    const out = [];
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1];
      const b = samples[i];
      if (isNum(a.soc) && isNum(b.soc) && b.soc - a.soc >= rise) {
        out.push({ from: a.t, to: b.t, fromSOC: a.soc, toSOC: b.soc });
      }
    }
    return out;
  }

  const dayKey = (t, tzOffsetMin) => Math.floor((t - tzOffsetMin * 60000) / DAY_MS);

  /**
   * Last value of `field` on each calendar day, as chart points.
   * @param {number} [tzOffsetMin] minutes behind UTC (Date#getTimezoneOffset); defaults to the device's
   */
  function dailySeries(samples, field, tzOffsetMin) {
    const tz = tzOffsetMin === undefined ? new Date().getTimezoneOffset() : tzOffsetMin;
    const byDay = new Map();
    for (const s of samples) {
      if (isNum(s[field]) && isNum(s.t)) byDay.set(dayKey(s.t, tz), { x: s.t, y: s[field] });
    }
    return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  }

  const EXTRAPOLATE_MIN_CYCLES = 50;

  /**
   * What health did across the recorded cycles, using one point per day.
   * Returns null until there is enough spread to say anything. The slope per
   * 100 cycles is a straight-line fit, and `extrapolate` is true only when the
   * data spans enough cycles for that projection to be worth showing.
   * @returns {{fromHealth:number,toHealth:number,spanCycles:number,days:number,perHundredCycles:number,extrapolate:boolean}|null}
   */
  function healthTrend(samples, tzOffsetMin) {
    const tz = tzOffsetMin === undefined ? new Date().getTimezoneOffset() : tzOffsetMin;
    const byDay = new Map();
    for (const s of samples) {
      if (isNum(s.soh) && isNum(s.cycles) && isNum(s.t)) byDay.set(dayKey(s.t, tz), { c: s.cycles, h: s.soh });
    }
    const pts = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    if (pts.length < 3) return null;
    const cs = pts.map((p) => p.c);
    const span = Math.max(...cs) - Math.min(...cs);
    if (span < 10) return null;
    const n = pts.length;
    const mc = cs.reduce((a, b) => a + b, 0) / n;
    const mh = pts.reduce((a, p) => a + p.h, 0) / n;
    let num = 0;
    let den = 0;
    for (const p of pts) { num += (p.c - mc) * (p.h - mh); den += (p.c - mc) ** 2; }
    if (den === 0) return null;
    return {
      fromHealth: pts[0].h,
      toHealth: pts[n - 1].h,
      spanCycles: span,
      days: n,
      perHundredCycles: (num / den) * 100,
      extrapolate: span >= EXTRAPOLATE_MIN_CYCLES,
    };
  }

  class BatteryStore {
    constructor() {
      this._adds = 0;
      this._dbPromise = this._open();
      this._dbPromise.catch(() => {});   // callers handle failures per operation
    }

    _open() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 't' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    async _tx(mode, fn) {
      const db = await this._dbPromise;
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const result = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }

    /** @param {{t:number,soc:number,soh?:number,cycles?:number,on?:boolean}} sample */
    async add(sample) {
      await this._tx('readwrite', (store) => store.put(sample));
      if (++this._adds % PRUNE_EVERY === 0) await this.prune(MAX_SAMPLES);
    }

    /** All samples, oldest first. */
    async all() {
      return this._tx('readonly', (store) => store.getAll()).then((rows) => (rows || []).sort((a, b) => a.t - b.t));
    }

    async last() {
      const db = await this._dbPromise;
      return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor(null, 'prev');
        req.onsuccess = () => resolve(req.result ? req.result.value : null);
        req.onerror = () => reject(req.error);
      });
    }

    async count() { return this._tx('readonly', (store) => store.count()); }
    async clear() { await this._tx('readwrite', (store) => store.clear()); }

    /** Deletes the oldest samples beyond `max`. */
    async prune(max) {
      const total = await this.count();
      if (total <= max) return 0;
      const toDelete = total - max;
      const db = await this._dbPromise;
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        let removed = 0;
        const req = tx.objectStore(STORE).openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (cur && removed < toDelete) { cur.delete(); removed++; cur.continue(); }
        };
        tx.oncomplete = () => resolve(removed);
        tx.onerror = () => reject(tx.error);
      });
    }
  }

  return { BatteryStore, shouldRecord, inferCharges, dailySeries, healthTrend, HEARTBEAT_MS, MIN_GAP_MS, MAX_SAMPLES };
});
