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
        speedMPS: speed || 0,
        timestamp: pos.timestamp,
      };

      const last = this.points[this.points.length - 1];
      if (last) {
        this.distanceMeters += haversineMeters(last.lat, last.lon, point.lat, point.lon);
      }
      this.points.push(point);
      this.dispatchEvent(new CustomEvent('point', { detail: point }));
    }
  }

  root.NIU = root.NIU || {};
  root.NIU.GeoTracker = GeoTracker;
  root.NIU.haversineMeters = haversineMeters;
})(typeof globalThis !== 'undefined' ? globalThis : this);
