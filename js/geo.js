/**
 * geo.js — NIU Companion Web Dashboard
 *
 * Foreground-only GPS trip recording via navigator.geolocation.watchPosition.
 *
 * ⚠️ Unlike the native iOS app's CoreLocation background mode, this CANNOT
 * keep recording once the browser tab is backgrounded or the phone screen
 * locks — WebKit suspends JS timers and geolocation callbacks in that state.
 * Keep the dashboard in the foreground and the screen awake while riding
 * (see README for a Screen Wake Lock note).
 */
(function (root) {
  const MIN_ACCURACY_METERS = 20;

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ---------------------------------------------------------------------------
  // GPS glitch filter.
  //
  // Found on a real ride: the phone's position occasionally jumps ~17 m in one second,
  // either for a single fix (a spike) or permanently (a step, e.g. after re-locking onto
  // satellites), while its own speed reading stays correct. Summing raw position changes
  // overstated that ride's distance by 6% and implied speeds of 60+ km/h on a scooter
  // limited to 30. A fix is plausible if it is no further from the last accepted fix than
  // the speed could cover; otherwise it is held back for one fix to decide which it was:
  //   - the next fix is back on the old track  -> the held fix was a spike: drop it;
  //   - the next fix agrees with the held one  -> the track really moved: re-anchor there
  //     without counting the jump as distance, and flag the point as a discontinuity;
  //   - neither                                -> after MAX_REJECTS, start over from here.
  // If the filter is rejecting a large share of fixes it is probably wrong about this
  // phone, so it switches itself off and accepts everything.
  // ---------------------------------------------------------------------------
  const MAX_PLAUSIBLE_MPS = 12;      // ~43 km/h: used until the phone reports a real speed
  const SLACK_MPS = 1.5;
  const SLACK_METERS = 4;
  const MAX_REJECTS = 3;
  const DOPPLER_MIN_MPS = 0.3;
  const GUARD_MIN_FIXES = 20;
  const GUARD_MAX_REJECT_FRACTION = 0.3;

  class JumpFilter {
    constructor() {
      this.last = null;
      this.cand = null;
      this.rejects = 0;
      this.seen = 0;
      this.rejectedTotal = 0;
      this.sawSpeed = false;
      this.disabled = false;
    }

    _allowed(a, b) {
      const dt = Math.max(0.5, (b.timestamp - a.timestamp) / 1000);
      const v = this.sawSpeed ? Math.max(a.speedMPS, b.speedMPS) : MAX_PLAUSIBLE_MPS;
      return (v + SLACK_MPS) * dt + SLACK_METERS;
    }

    _near(a, b) {
      return haversineMeters(a.lat, a.lon, b.lat, b.lon) <= this._allowed(a, b);
    }

    /**
     * Feed one fix. Returns the fixes to record now, each with the distance to add; this may be
     * none (held back), one, or two (a held fix confirmed by this one).
     * @returns {{point: object, addMeters: number}[]}
     */
    push(p) {
      this.seen++;
      if (p.speedMPS > DOPPLER_MIN_MPS) this.sawSpeed = true;
      const dist = (a, b) => haversineMeters(a.lat, a.lon, b.lat, b.lon);

      if (!this.disabled && this.seen >= GUARD_MIN_FIXES && this.rejectedTotal / this.seen > GUARD_MAX_REJECT_FRACTION) {
        this.disabled = true;
        const out = [];
        if (this.cand) { out.push({ point: this.cand, addMeters: dist(this.last, this.cand) }); this.last = this.cand; this.cand = null; }
        out.push({ point: p, addMeters: dist(this.last, p) });
        this.last = p;
        return out;
      }
      if (this.disabled || !this.last) {
        const add = this.last ? dist(this.last, p) : 0;
        this.last = p;
        return [{ point: p, addMeters: add }];
      }

      if (!this.cand) {
        if (this._near(this.last, p)) {
          const add = dist(this.last, p);
          this.last = p;
          return [{ point: p, addMeters: add }];
        }
        this.cand = p;
        this.rejects = 1;
        this.rejectedTotal++;
        return [];
      }

      if (this._near(this.last, p)) {                         // back on the old track: the held fix was a spike
        const add = dist(this.last, p);
        this.cand = null;
        this.rejects = 0;
        this.last = p;
        return [{ point: p, addMeters: add }];
      }
      if (this._near(this.cand, p)) {                         // agrees with the held fix: the track really moved
        const held = Object.assign({}, this.cand, { jump: true });
        const add = dist(this.cand, p);
        this.cand = null;
        this.rejects = 0;
        this.last = p;
        return [{ point: held, addMeters: 0 }, { point: p, addMeters: add }];
      }
      if (++this.rejects >= MAX_REJECTS) {                    // nothing agrees: start over from here
        this.cand = null;
        this.rejects = 0;
        this.last = p;
        return [{ point: Object.assign({}, p, { jump: true }), addMeters: 0 }];
      }
      return [];
    }
  }

  class GeoTracker extends EventTarget {
    constructor() {
      super();
      this.watchId = null;
      this.isRecording = false;
      this.points = [];
      this.distanceMeters = 0;
    }

    get isSupported() {
      return typeof navigator !== 'undefined' && !!navigator.geolocation;
    }

    start() {
      if (!this.isSupported) throw new Error('Geolocation is not available in this browser.');
      this.points = [];
      this.distanceMeters = 0;
      this._filter = new JumpFilter();
      this.isRecording = true;

      this.watchId = navigator.geolocation.watchPosition(
        (pos) => this._handlePosition(pos),
        (err) => this.dispatchEvent(new CustomEvent('error', { detail: err })),
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
      );
    }

    stop() {
      this.isRecording = false;
      if (this.watchId !== null) {
        navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null;
      }
      return { points: this.points, distanceMeters: this.distanceMeters };
    }

    _handlePosition(pos) {
      const { latitude, longitude, accuracy, altitude, speed } = pos.coords;
      this.dispatchEvent(new CustomEvent('position', { detail: pos }));

      if (!this.isRecording || accuracy > MIN_ACCURACY_METERS) return;

      const point = {
        lat: latitude,
        lon: longitude,
        altitude: altitude || 0,
        speedMPS: Number.isFinite(speed) && speed > 0 ? speed : 0,   // null/negative means "unknown"
        timestamp: pos.timestamp,
      };

      for (const accepted of this._filter.push(point)) {
        this.distanceMeters += accepted.addMeters;
        this.points.push(accepted.point);
        this.dispatchEvent(new CustomEvent('point', { detail: accepted.point }));
      }
    }
  }

  root.NIU = root.NIU || {};
  root.NIU.GeoTracker = GeoTracker;
  root.NIU.haversineMeters = haversineMeters;
  root.NIU.JumpFilter = JumpFilter;
})(typeof globalThis !== 'undefined' ? globalThis : this);
