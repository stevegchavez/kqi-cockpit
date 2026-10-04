/**
 * planner.js — NIU Companion Web Dashboard
 *
 * Trip planning: look up a place, ask for a cycling-style route, turn the answer into
 * readable directions, estimate time and battery, and follow the rider along the route.
 *
 * The network is injected (`fetchFn`) so everything is unit tested against canned replies.
 * Two public OpenStreetMap services are used, only when the rider taps Search / Route:
 *   - Nominatim            place search      https://nominatim.openstreetmap.org
 *   - routing.openstreetmap.de  OSRM "bike"  https://routing.openstreetmap.de/routed-bike
 * Both receive the text typed and the start / end coordinates, and nothing else. No keys,
 * no accounts. Bike routing is used because it keeps a scooter off motorways, but bike paths
 * are not always open to e-scooters: the rider is responsible for local rules.
 *
 * Pure apart from `fetchFn`: no DOM, no storage.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NIU = root.NIU || {};
    root.NIU.Planner = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const GEOCODE_URL = 'https://nominatim.openstreetmap.org/search';
  const ROUTE_URL = 'https://routing.openstreetmap.de/routed-bike/route/v1/driving';
  const R_EARTH = 6371000;
  const METERS_PER_MILE = 1609.344;
  const OFF_ROUTE_METERS = 45;
  const ARRIVED_METERS = 25;
  const DEFAULT_SPEED_FRACTION = 0.7;   // plan at 70% of the scooter's limit unless the rider's own rides say otherwise
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

  class PlannerError extends Error {
    constructor(message) { super(message); this.name = 'PlannerError'; }
  }

  function haversine(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // ------------------------------------------------------------------ place search

  /** Returns up to `limit` {name, lat, lon} for a typed query. */
  async function geocode(query, fetchFn, opts) {
    const q = String(query || '').trim();
    if (q.length < 2) throw new PlannerError('Type at least two characters to search.');
    const o = Object.assign({ limit: 5, near: null, signal: undefined }, opts);
    let url = `${GEOCODE_URL}?format=jsonv2&limit=${o.limit}&q=${encodeURIComponent(q)}`;
    if (o.near && isNum(o.near.lat) && isNum(o.near.lon)) {           // prefer results close to the rider, without excluding others
      const d = 0.5;
      url += `&viewbox=${o.near.lon - d},${o.near.lat + d},${o.near.lon + d},${o.near.lat - d}`;
    }
    const body = await getJSON(url, fetchFn, o.signal, 'Place search');
    if (!Array.isArray(body)) throw new PlannerError('Place search returned something unexpected.');
    return body
      .map((r) => ({ name: String(r.display_name || r.name || '').slice(0, 200), lat: Number(r.lat), lon: Number(r.lon) }))
      .filter((r) => r.name && isNum(r.lat) && isNum(r.lon) && Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180);
  }

  async function getJSON(url, fetchFn, signal, what) {
    let res;
    try {
      res = await fetchFn(url, { headers: { Accept: 'application/json' }, signal });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw new PlannerError(`${what} could not reach the internet. Check your connection and try again.`);
    }
    if (!res || !res.ok) throw new PlannerError(`${what} failed (${res ? res.status : 'no reply'}). Try again in a moment.`);
    try { return await res.json(); } catch { throw new PlannerError(`${what} sent a reply that could not be read.`); }
  }

  // ------------------------------------------------------------------ routing

  /**
   * Asks for a route between two {lat, lon} points.
   * @returns {{distance:number, duration:number, coords:number[][], steps:object[]}} coords are [lat, lon].
   */
  async function route(from, to, fetchFn, opts) {
    for (const p of [from, to]) {
      if (!p || !isNum(p.lat) || !isNum(p.lon)) throw new PlannerError('Both a start and a destination are needed.');
    }
    if (haversine(from.lat, from.lon, to.lat, to.lon) < 30) throw new PlannerError('Start and destination are almost the same place.');
    const url = `${ROUTE_URL}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=true`;
    const body = await getJSON(url, fetchFn, opts && opts.signal, 'Routing');
    if (!body || body.code !== 'Ok' || !Array.isArray(body.routes) || !body.routes.length) {
      const why = body && body.code === 'NoRoute' ? 'No route was found between those places.' : 'Routing did not find a route.';
      throw new PlannerError(why);
    }
    return parseRoute(body.routes[0]);
  }

  /** Turns an OSRM route into {distance, duration, coords, steps[{text, meters, at, location, type}]}. */
  function parseRoute(r) {
    const coords = ((r.geometry && r.geometry.coordinates) || [])
      .filter((c) => Array.isArray(c) && isNum(c[0]) && isNum(c[1]))
      .map((c) => [c[1], c[0]]);
    if (coords.length < 2) throw new PlannerError('The route came back empty.');
    const cum = cumulative(coords);
    const rawSteps = [];
    for (const leg of r.legs || []) for (const s of leg.steps || []) rawSteps.push(s);
    let searchFrom = 0;
    const steps = rawSteps.map((s) => {
      const m = s.maneuver || {};
      const loc = Array.isArray(m.location) ? [m.location[1], m.location[0]] : null;
      let idx = searchFrom;
      if (loc) {                                    // the nearest vertex at or after the previous maneuver
        let best = Infinity;
        for (let i = searchFrom; i < coords.length; i++) {
          const d = haversine(loc[0], loc[1], coords[i][0], coords[i][1]);
          if (d < best) { best = d; idx = i; }
          if (best < 1) break;
        }
        searchFrom = idx;
      }
      return {
        type: m.type || '', modifier: m.modifier || '',
        text: instruction(m, s.name),
        meters: isNum(s.distance) ? s.distance : 0,
        at: cum[idx],
        location: loc || coords[idx],
      };
    });
    return {
      distance: isNum(r.distance) ? r.distance : cum[cum.length - 1],
      duration: isNum(r.duration) ? r.duration : 0,
      coords, cum, steps,
    };
  }

  function cumulative(coords) {
    const out = [0];
    for (let i = 1; i < coords.length; i++) out.push(out[i - 1] + haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
    return out;
  }

  const MODIFIER = {
    left: 'left', right: 'right', 'slight left': 'slightly left', 'slight right': 'slightly right',
    'sharp left': 'sharp left', 'sharp right': 'sharp right', straight: 'straight on', uturn: 'around (U-turn)',
  };
  const ORDINAL = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'];

  /** A short human sentence for one OSRM maneuver. */
  function instruction(m, name) {
    const road = name ? ` onto ${name}` : '';
    const onRoad = name ? ` on ${name}` : '';
    const mod = MODIFIER[m.modifier] || '';
    switch (m.type) {
      case 'depart': return name ? `Head out on ${name}` : 'Start riding';
      case 'arrive': return mod && m.modifier !== 'straight' ? `Arrive: destination is on your ${mod.replace('slightly ', '')}` : 'Arrive at your destination';
      case 'turn': return mod ? `Turn ${mod}${road}` : `Turn${road}`;
      case 'end of road': return mod ? `At the end of the road, turn ${mod}${road}` : `At the end of the road, turn${road}`;
      case 'fork': return mod ? `Keep ${m.modifier.includes('left') ? 'left' : 'right'} at the fork${onRoad}` : `Take the fork${onRoad}`;
      case 'merge': return `Merge${onRoad}`;
      case 'new name': case 'continue': return mod && m.modifier !== 'straight' ? `Continue ${mod}${onRoad}` : `Continue${onRoad}`;
      case 'roundabout': case 'rotary': {
        const n = ORDINAL[m.exit] || (m.exit ? `${m.exit}th` : '');
        return n ? `At the roundabout, take the ${n} exit${road}` : `Enter the roundabout${onRoad}`;
      }
      case 'roundabout turn': return mod ? `At the roundabout, turn ${mod}${road}` : `Turn at the roundabout${road}`;
      case 'exit roundabout': case 'exit rotary': return `Exit the roundabout${road}`;
      case 'on ramp': case 'off ramp': return `Take the ramp${onRoad}`;
      case 'notification': return `Continue${onRoad}`;
      default: return mod ? `Go ${mod}${onRoad}` : `Continue${onRoad}`;
    }
  }

  // ------------------------------------------------------------------ estimates

  /**
   * Time and battery for a route.
   * @param {{distance:number}} rt
   * @param {{maxKph?:number, avgMovingKph?:number, soc?:number|null, milesPerPct?:number|null}} ctx
   *   avgMovingKph: the rider's own typical moving speed (from recorded rides), if known.
   *   milesPerPct:  from Insights.rangeEstimate, if there is enough ride history.
   */
  function estimate(rt, ctx) {
    const c = ctx || {};
    const maxKph = isNum(c.maxKph) && c.maxKph > 0 ? c.maxKph : 30;
    const cruiseKph = isNum(c.avgMovingKph) && c.avgMovingKph > 3 ? Math.min(c.avgMovingKph, maxKph) : maxKph * DEFAULT_SPEED_FRACTION;
    const miles = rt.distance / METERS_PER_MILE;
    const minutes = (rt.distance / 1000 / cruiseKph) * 60;
    const out = { miles, minutes, cruiseKph, speedSource: isNum(c.avgMovingKph) && c.avgMovingKph > 3 ? 'your rides' : 'assumed', batteryNeededPct: null, arriveSOC: null, returnSOC: null, verdict: 'unknown' };
    if (isNum(c.milesPerPct) && c.milesPerPct > 0) {
      out.batteryNeededPct = miles / c.milesPerPct;
      if (isNum(c.soc)) {
        out.arriveSOC = c.soc - out.batteryNeededPct;
        out.returnSOC = c.soc - 2 * out.batteryNeededPct;
        out.verdict = out.arriveSOC < 10 ? 'no' : out.arriveSOC < 25 ? 'tight' : 'ok';
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ following the rider

  /**
   * Where is the rider on the route? Searches forward from `hint` (the previous index) first, so
   * a route that doubles back on itself does not make the position jump.
   * @returns {{index:number, offRoute:number, progress:number, remaining:number, next:object|null,
   *            toNext:number|null, arrived:boolean, isOff:boolean}}
   */
  function locate(rt, pos, hint) {
    const n = rt.coords.length;
    const from = Math.max(0, Math.min(n - 1, hint || 0));
    const WINDOW = 400;                                       // vertices to look ahead of the last known position
    let best = Infinity, index = from;
    const scan = (lo, hi) => {
      for (let i = lo; i <= hi; i++) {
        const d = haversine(pos.lat, pos.lon, rt.coords[i][0], rt.coords[i][1]);
        if (d < best) { best = d; index = i; }
      }
    };
    scan(Math.max(0, from - 5), Math.min(n - 1, from + WINDOW));
    if (best > OFF_ROUTE_METERS * 2) scan(0, n - 1);          // lost: look everywhere
    const progress = rt.cum[index];
    const remaining = Math.max(0, rt.distance - progress);
    const next = rt.steps.find((s, i) => i > 0 && s.at > progress + 8) || null;
    return {
      index, offRoute: best, progress, remaining,
      next, toNext: next ? Math.max(0, next.at - progress) : null,
      arrived: remaining <= ARRIVED_METERS,
      isOff: best > OFF_ROUTE_METERS,
    };
  }

  // ------------------------------------------------------------------ formatting

  function formatDistance(meters, useMiles) {
    if (useMiles) {
      const ft = meters * 3.28084;
      return ft < 500 ? `${Math.round(ft / 10) * 10} ft` : `${(meters / METERS_PER_MILE).toFixed(meters < 16093 ? 2 : 1)} mi`;
    }
    return meters < 1000 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1000).toFixed(meters < 10000 ? 2 : 1)} km`;
  }

  function formatMinutes(min) {
    const m = Math.max(1, Math.round(min));
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  }

  return {
    PlannerError, geocode, route, parseRoute, instruction, estimate, locate,
    formatDistance, formatMinutes, haversine, METERS_PER_MILE, OFF_ROUTE_METERS, ARRIVED_METERS,
  };
});
