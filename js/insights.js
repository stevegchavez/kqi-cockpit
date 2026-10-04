/**
 * insights.js — NIU Companion Web Dashboard
 *
 * Pure functions that turn recorded rides into useful numbers: moving time,
 * elevation, battery used, efficiency, a range estimate, and route colouring.
 * No DOM, no storage — fully unit tested in test/insights.test.js.
 *
 * Speeds come from the phone's own speed reading (CoreLocation/Doppler) when the ride has
 * one, because differencing positions turns ordinary GPS jumps into 60+ km/h "speeds" (seen on
 * a real ride). Position-derived speed is only the fallback.
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
  const MOVING_MPS = 0.5;          // position-derived speed below this counts as stopped
  const MOVING_MPS_READING = 0.8;  // the phone's own speed reading is noisier at a standstill (~1 km/h), so it needs a higher bar
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

  /** True when the ride carries the phone's own speed readings (geo.js stores 0 when it had none). */
  function hasSpeedReadings(points) {
    return points.some((p) => isNum(p.speedMPS) && p.speedMPS > 0.3);
  }

  /**
   * Per-segment facts between consecutive GPS fixes.
   *   mps    speed implied by the position change (noisy: GPS jumps look like huge speeds)
   *   speed  the best estimate: the phone's own reading averaged over the segment if the ride
   *          has readings, else mps
   *   gap    lost signal, or a recorded position step: not real movement, excluded from stats
   */
  function segments(points) {
    const readings = hasSpeedReadings(points);
    const out = [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const seconds = (b.timestamp - a.timestamp) / 1000;
      if (seconds <= 0) continue;
      const meters = distanceMeters(a.lat, a.lon, b.lat, b.lon);
      const mps = meters / seconds;
      const speed = readings ? ((a.speedMPS || 0) + (b.speedMPS || 0)) / 2 : mps;
      out.push({ a, b, seconds, meters, mps, speed, readings, gap: seconds > MAX_GAP_SECONDS || b.jump === true });
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

  /** Highest speed after smoothing over 3 segments (reduces ordinary noise in either kind of speed). */
  function gpsMaxKph(segs) {
    const live = segs.filter((s) => !s.gap);
    if (live.length < 3) return live.length ? Math.max(...live.map((s) => s.speed)) * 3.6 : null;
    let best = 0;
    for (let i = 2; i < live.length; i++) {
      best = Math.max(best, (live[i - 2].speed + live[i - 1].speed + live[i].speed) / 3);
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
    let movingSpeedSeconds = 0;       // sum of speed x time over moving segments, for a time-weighted mean
    for (const s of segs) {
      if (s.gap) continue;
      if (s.speed >= (s.readings ? MOVING_MPS_READING : MOVING_MPS)) { movingSeconds += s.seconds; movingSpeedSeconds += s.speed * s.seconds; }
      else stoppedSeconds += s.seconds;
    }
    const hasBattery = isNum(ride.startSOC) && isNum(ride.endSOC) && ride.startSOC >= ride.endSOC;
    const used = hasBattery ? ride.startSOC - ride.endSOC : null;
    const miles = (ride.distanceMeters || 0) / METERS_PER_MILE;
    return {
      movingSeconds: Math.round(movingSeconds),
      stoppedSeconds: Math.round(stoppedSeconds),
      avgMovingKph: movingSeconds > 0 ? (movingSpeedSeconds / movingSeconds) * 3.6 : null,
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
      const color = speedColor(s.speed * 3.6, maxKph);
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
