/**
 * exporters.js — NIU Companion Web Dashboard
 *
 * Turns rides and battery history into GPX / CSV text, and hands the file to
 * the user. Everything is generated on the device; nothing is uploaded.
 *
 * deliver() tries, in order: the iOS/Android share sheet (works in Bluefy if
 * it exposes the Web Share API), a normal file download, then copying the text
 * to the clipboard so the data is never stranded.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NIU = root.NIU || {};
    root.NIU.Exporters = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const iso = (t) => new Date(t).toISOString();

  function xmlEscape(s) {
    return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  }

  /** RFC 4180 quoting; also neutralises spreadsheet formula injection. */
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  const csvRow = (cells) => cells.map(csvCell).join(',');
  const round = (v, d) => (isNum(v) ? Number(v.toFixed(d)) : '');

  function validPoints(ride) {
    return (ride.points || []).filter((p) => p && isNum(p.lat) && isNum(p.lon));
  }

  /** GPX 1.1 track. Elevation is written only if the phone supplied altitude. */
  function toGPX(ride, opts) {
    const name = (opts && opts.name) || `NIU ride ${iso(ride.startDate)}`;
    const pts = validPoints(ride);
    const hasAlt = pts.some((p) => isNum(p.altitude) && p.altitude !== 0);
    const trkpts = pts.map((p) => {
      const ele = hasAlt && isNum(p.altitude) ? `<ele>${p.altitude.toFixed(1)}</ele>` : '';
      const time = isNum(p.timestamp) ? `<time>${iso(p.timestamp)}</time>` : '';
      return `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${ele}${time}</trkpt>`;
    });
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="NIU Companion (KQi Cockpit)" xmlns="http://www.topografix.com/GPX/1/1">',
      `  <metadata><name>${xmlEscape(name)}</name>${isNum(ride.startDate) ? `<time>${iso(ride.startDate)}</time>` : ''}</metadata>`,
      '  <trk>',
      `    <name>${xmlEscape(name)}</name>`,
      '    <trkseg>',
      ...trkpts,
      '    </trkseg>',
      '  </trk>',
      '</gpx>',
      '',
    ].join('\n');
  }

  /** One row per GPS fix, with the speed the phone's GPS reported. */
  function toRideCSV(ride) {
    const rows = [csvRow(['time_utc', 'lat', 'lon', 'altitude_m', 'gps_speed_kph'])];
    for (const p of validPoints(ride)) {
      rows.push(csvRow([
        isNum(p.timestamp) ? iso(p.timestamp) : '',
        p.lat.toFixed(6), p.lon.toFixed(6),
        isNum(p.altitude) && p.altitude !== 0 ? round(p.altitude, 1) : '',
        isNum(p.speedMPS) ? round(p.speedMPS * 3.6, 1) : '',
      ]));
    }
    return rows.join('\r\n') + '\r\n';
  }

  /** One row per ride. */
  function ridesSummaryCSV(rides) {
    const rows = [csvRow([
      'start_utc', 'end_utc', 'distance_km', 'duration_min', 'scooter_top_kph', 'scooter_avg_kph',
      'battery_start_pct', 'battery_end_pct', 'simulated',
    ])];
    for (const r of rides) {
      rows.push(csvRow([
        isNum(r.startDate) ? iso(r.startDate) : '', isNum(r.endDate) ? iso(r.endDate) : '',
        round((r.distanceMeters || 0) / 1000, 3), round((r.activeRidingSeconds || 0) / 60, 1),
        round(r.topSpeedKPH, 1), round(r.averageSpeedKPH, 1),
        isNum(r.startSOC) ? r.startSOC : '', isNum(r.endSOC) ? r.endSOC : '', r.simulated ? 'yes' : '',
      ]));
    }
    return rows.join('\r\n') + '\r\n';
  }

  /** Battery history samples, oldest first. */
  function batteryCSV(samples) {
    const rows = [csvRow(['time_utc', 'battery_pct', 'health_pct', 'charge_cycles', 'powered_on'])];
    for (const s of samples) {
      rows.push(csvRow([
        iso(s.t), isNum(s.soc) ? s.soc : '', isNum(s.soh) ? s.soh : '',
        isNum(s.cycles) ? s.cycles : '', s.on === true ? 'yes' : (s.on === false ? 'no' : ''),
      ]));
    }
    return rows.join('\r\n') + '\r\n';
  }

  /** Deterministic, filesystem-safe name, e.g. niu-ride-20261001T081500Z.gpx */
  function filenameFor(prefix, t, ext) {
    const stamp = iso(t).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    return `${prefix}-${stamp}.${ext}`;
  }

  /**
   * Hands `text` to the user as a file. `env` is injectable for tests and
   * defaults to the browser's globals.
   * @returns {Promise<'share'|'download'|'clipboard'|'cancelled'>}
   */
  async function deliver(filename, mime, text, env) {
    const e = env || {};
    const nav = e.navigator || (typeof navigator !== 'undefined' ? navigator : undefined);
    const doc = e.document || (typeof document !== 'undefined' ? document : undefined);
    const Url = e.URL || (typeof URL !== 'undefined' ? URL : undefined);
    const FileCtor = e.File || (typeof File !== 'undefined' ? File : undefined);
    const BlobCtor = e.Blob || (typeof Blob !== 'undefined' ? Blob : undefined);

    if (nav && nav.canShare && nav.share && FileCtor) {
      try {
        const file = new FileCtor([text], filename, { type: mime });
        if (nav.canShare({ files: [file] })) {
          await nav.share({ files: [file], title: filename });
          return 'share';
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return 'cancelled';   // the user closed the share sheet
      }
    }
    if (doc && Url && BlobCtor && Url.createObjectURL) {
      try {
        const url = Url.createObjectURL(new BlobCtor([text], { type: mime }));
        const a = doc.createElement('a');
        a.href = url;
        a.download = filename;
        a.rel = 'noopener';
        (doc.body || doc.documentElement).appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => Url.revokeObjectURL && Url.revokeObjectURL(url), 10000);
        return 'download';
      } catch { /* fall through to the clipboard */ }
    }
    if (nav && nav.clipboard && nav.clipboard.writeText) {
      await nav.clipboard.writeText(text);
      return 'clipboard';
    }
    throw new Error('This browser could not share, download or copy the file.');
  }

  return { toGPX, toRideCSV, ridesSummaryCSV, batteryCSV, filenameFor, csvCell, xmlEscape, deliver };
});
