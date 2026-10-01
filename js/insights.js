/**
 * insights.js — NIU Companion Web Dashboard
 *
 * Pure functions that turn recorded rides into useful numbers: moving time,
 * elevation, battery used, efficiency, a range estimate, and route colouring.
 * No DOM, no storage — fully unit tested in test/insights.test.js.
 *
 * Honesty notes baked into the maths:
 *  - Battery % is a whole number, so a ride's "battery used" is only ±1%. The
 *    range estimate therefore pools several rides (ratio of sums) instead of
 *    averaging per-ride ratios, and labels itself "rough" until it has enough.
 *  - Simulated (demo-mode) rides are never used for estimates.
 *  - Elevation is reported only if the phone actually supplied altitude.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NIU = root.NIU || {};
    root.NIU.Insights = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const METERS_PER_MILE = 1609.344;
  const MOVING_MPS = 0.5;          // slower than this between GPS fixes counts as stopped
  const MAX_GAP_SECONDS = 30;      // longer gaps are lost signal, not riding or stopping
  const ELEVATION_NOISE_METERS = 3;
  // cool -> hot, by share of the scooter's top speed
  const SPEED_RAMP = ['#5ec8d8', '#8fd18a', '#ffd24a', '#ffb020', '#ff4438'];

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  function distanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(lat2 - lat1);
    const dLon = rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function validPoints(points) {
    return (points || []).filter((p) => p && isNum(p.lat) && isNum(p.lon) && isNum(p.timestamp));
  }

  /** Per-segment facts between consecutive GPS fixes. */
  function segments(points) {
    const out = [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const seconds = (b.timestamp - a.timestamp) / 1000;
      if (seconds <= 0) continue;
      const meters = distanceMeters(a.lat, a.lon, b.lat, b.lon);
      out.push({ a, b, seconds, meters, mps: meters / seconds, gap: seconds > MAX_GAP_SECONDS });
    }
    return out;
  }

  /** Gain/loss in metres with a small dead-band so GPS jitter doesn't inflate it; null without altitude. */
  function elevationChange(points) {
    const alts = (points || []).map((p) => p && p.altitude).filter(isNum);
    if (alts.length < 2 || alts.every((a) => a === 0)) return null;   // geo.js stores 0 when altitude is missing
    let ref = alts[0];
    let gain = 0;
    let loss = 0;
    for (const alt of alts) {
      if (alt - ref > ELEVATION_NOISE_METERS) { gain += alt - ref; ref = alt; }
      else if (ref - alt > ELEVATION_NOISE_METERS) { loss += ref - alt; ref = alt; }
    }
    return { gainMeters: Math.round(gain), lossMeters: Math.round(loss) };
  }

  /** Highest speed after smoothing over 3 segments (reduces ordinary GPS noise; geo.js already drops poor-accuracy fixes). */
  function gpsMaxKph(segs) {
    const live = segs.filter((s) => !s.gap);
    if (live.length < 3) return live.length ? Math.max(...live.map((s) => s.mps)) * 3.6 : null;
    let best = 0;
    for (let i = 2; i < live.length; i++) {
      best = Math.max(best, (live[i - 2].mps + live[i - 1].mps + live[i].mps) / 3);
    }
    return best * 3.6;
  }

  /**
   * @param {object} ride a saved ride (see app.js finishRide)
   * @returns {object} numbers for the ride-detail screen; unknowns are null
   */
  function rideStats(ride) {
    const pts = validPoints(ride.points);
    const segs = segments(pts);
    let movingSeconds = 0;
    let stoppedSeconds = 0;
    let movingMeters = 0;
    for (const s of segs) {
      if (s.gap) continue;
      if (s.mps >= MOVING_MPS) { movingSeconds += s.seconds; movingMeters += s.meters; }
      else stoppedSeconds += s.seconds;
    }
    const hasBattery = isNum(ride.startSOC) && isNum(ride.endSOC) && ride.startSOC >= ride.endSOC;
    const used = hasBattery ? ride.startSOC - ride.endSOC : null;
    const miles = (ride.distanceMeters || 0) / METERS_PER_MILE;
    return {
      movingSeconds: Math.round(movingSeconds),
      stoppedSeconds: Math.round(stoppedSeconds),
      avgMovingKph: movingSeconds > 0 ? (movingMeters / movingSeconds) * 3.6 : null,
      gpsMaxKph: gpsMaxKph(segs),
      scooterTopKph: isNum(ride.topSpeedKPH) && ride.topSpeedKPH > 0 ? ride.topSpeedKPH : null,
      elevation: elevationChange(pts),
      batteryUsedPct: used,
      milesPerPct: used !== null && used >= 1 && miles > 0 ? miles / used : null,
    };
  }

  /**
   * Estimates remaining range by pooling recent real rides.
   * @param {object[]} rides saved rides (any order)
   * @param {number|null} soc current battery %
   * @returns {{miles:number|null, milesPerPct:number, rides:number, usedPct:number, confidence:'rough'|'good'}|null}
   */
  function rangeEstimate(rides, soc, opts) {
    const o = Object.assign({ maxRides: 10, minUsedPct: 2, minMiles: 0.3 }, opts);
    const eligible = (rides || [])
      .filter((r) => !r.simulated
        && isNum(r.startSOC) && isNum(r.endSOC)
        && r.startSOC - r.endSOC >= o.minUsedPct
        && (r.distanceMeters || 0) / METERS_PER_MILE >= o.minMiles)
      .sort((a, b) => b.startDate - a.startDate)
      .slice(0, o.maxRides);
    if (!eligible.length) return null;
    const totalMeters = eligible.reduce((n, r) => n + r.distanceMeters, 0);
    const usedPct = eligible.reduce((n, r) => n + (r.startSOC - r.endSOC), 0);
    const milesPerPct = totalMeters / METERS_PER_MILE / usedPct;
    return {
      miles: isNum(soc) ? soc * milesPerPct : null,
      milesPerPct,
      rides: eligible.length,
      usedPct,
      confidence: eligible.length >= 3 && usedPct >= 15 ? 'good' : 'rough',
    };
  }

  function speedColor(kph, maxKph) {
    if (!isNum(kph) || !isNum(maxKph) || maxKph <= 0) return SPEED_RAMP[0];
    const idx = Math.min(SPEED_RAMP.length - 1, Math.max(0, Math.floor((kph / maxKph) * SPEED_RAMP.length)));
    return SPEED_RAMP[idx];
  }

  /**
   * Splits a route into polylines coloured by speed, merging neighbours of the
   * same colour so the map doesn't need one layer per GPS fix.
   * @returns {{color:string, latlngs:number[][]}[]}
   */
  function colouredRoute(points, maxKph) {
    const out = [];
    for (const s of segments(validPoints(points))) {
      const color = speedColor(s.mps * 3.6, maxKph);
      const last = out[out.length - 1];
      const from = [s.a.lat, s.a.lon];
      const to = [s.b.lat, s.b.lon];
      if (last && last.color === color && !s.gap) last.latlngs.push(to);
      else out.push({ color, latlngs: [from, to] });
    }
    return out;
  }

  return {
    METERS_PER_MILE, SPEED_RAMP,
    distanceMeters, segments, elevationChange, rideStats, rangeEstimate, speedColor, colouredRoute,
  };
});
