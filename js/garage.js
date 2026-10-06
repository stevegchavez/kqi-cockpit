/**
 * garage.js — NIU Companion Web Dashboard
 *
 * The rider's own odometer and maintenance reminders.
 *
 * The scooter does not answer any odometer field over Bluetooth (checked with a Diagnostics
 * scan of a real 200F), so the odometer here is the total of the rides recorded in this app,
 * plus an optional offset the rider sets once to match the scooter's own display.
 *
 * Maintenance intervals are suggestions, not NIU's service schedule: adjust to taste and follow
 * the manual where it says otherwise. Everything is stored on this device only.
 *
 * Pure apart from the injected `storage` (localStorage in the app).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NIU = root.NIU || {};
    root.NIU.Garage = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const METERS_PER_MILE = 1609.344;
  const KEY = 'niu.garage';
  const MAX_LOG = 200;
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

  /** Suggested checks. Distances in miles. */
  const ITEMS = [
    { id: 'tyres', name: 'Check tyre pressure', everyMiles: 100 },
    { id: 'lights', name: 'Clean and check lights', everyMiles: 150 },
    { id: 'bolts', name: 'Check folding latch and bolts', everyMiles: 200 },
    { id: 'brakes', name: 'Check brakes', everyMiles: 300 },
    { id: 'wear', name: 'Inspect tyres for wear and cuts', everyMiles: 500 },
  ];

  /** Miles from real (non-demo) recorded rides. */
  function ridesMiles(rides) {
    return (rides || []).filter((r) => r && !r.simulated && isNum(r.distanceMeters))
      .reduce((n, r) => n + r.distanceMeters, 0) / METERS_PER_MILE;
  }

  function emptyData() { return { offsetMiles: 0, log: [] }; }

  function load(storage) {
    try {
      const raw = storage && storage.getItem(KEY);
      if (!raw) return emptyData();
      const d = JSON.parse(raw);
      return {
        offsetMiles: isNum(d.offsetMiles) ? d.offsetMiles : 0,
        log: Array.isArray(d.log) ? d.log.filter((e) => e && typeof e.id === 'string' && isNum(e.atMiles) && isNum(e.t)) : [],
      };
    } catch { return emptyData(); }
  }

  function save(storage, data) {
    try { storage.setItem(KEY, JSON.stringify({ offsetMiles: data.offsetMiles, log: data.log.slice(-MAX_LOG) })); } catch { /* storage full or blocked */ }
  }

  function odometer(rides, data) { return ridesMiles(rides) + (data.offsetMiles || 0); }

  /** Makes the odometer read `scooterMiles` now (the reading on the scooter's own display). */
  function setOdometer(rides, data, scooterMiles) {
    if (!isNum(scooterMiles) || scooterMiles < 0 || scooterMiles > 100000) throw new Error('Enter the odometer reading as a number of miles.');
    return Object.assign({}, data, { offsetMiles: scooterMiles - ridesMiles(rides) });
  }

  /** Records that a check was done at the current odometer reading. */
  function markDone(data, id, odoMiles, now) {
    if (!ITEMS.some((i) => i.id === id)) throw new Error('Unknown maintenance item.');
    const log = data.log.concat([{ id, atMiles: odoMiles, t: isNum(now) ? now : Date.now() }]);
    return Object.assign({}, data, { log });
  }

  /**
   * Status of each check. A check never logged counts from 0 miles on the odometer, so a scooter
   * that already has miles on it shows its checks as due until they are first ticked off.
   */
  function status(data, odoMiles) {
    return ITEMS.map((item) => {
      const done = data.log.filter((e) => e.id === item.id).sort((a, b) => b.atMiles - a.atMiles || b.t - a.t)[0] || null;
      const since = odoMiles - (done ? done.atMiles : 0);
      const dueIn = item.everyMiles - since;
      return {
        item, lastDone: done, milesSince: Math.max(0, since), dueInMiles: dueIn,
        due: dueIn <= 0, soon: dueIn > 0 && dueIn <= item.everyMiles * 0.15,
      };
    }).sort((a, b) => a.dueInMiles - b.dueInMiles);
  }

  return { ITEMS, KEY, ridesMiles, load, save, odometer, setOdometer, markDone, status, METERS_PER_MILE };
});
