/**
 * plan-ui.js — NIU Companion Web Dashboard
 *
 * The Plan screen: search for a destination, see a route on the map with time and battery
 * estimates, read the directions, and follow them live from the phone's GPS.
 *
 * Place names and street names come from a public service, so everything from the network is
 * rendered with textContent only (never innerHTML).
 *
 * Foreground only, like ride recording: a locked screen or backgrounded browser stops GPS
 * updates, so a screen wake lock is requested while following. Directions are text, with no
 * voice, so the phone has to be glanced at: do that only when it is safe and legal to.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./planner.js'));
  } else {
    root.NIU = root.NIU || {};
    root.NIU.PlanUI = factory(root.NIU.Planner);
  }
})(typeof self !== 'undefined' ? self : this, function (Planner) {
  /**
   * @param {{getContext: Function, showToast: Function, doc?: Document, fetchFn?: Function,
   *          geolocation?: object, L?: object, now?: Function}} deps
   *   getContext() -> {soc, milesPerPct, avgMovingKph, maxKph, useMiles}
   * @returns {{onShow: Function, state: object}}
   */
  function init(deps) {
    const doc = deps.doc || document;
    const fetchFn = deps.fetchFn || ((...a) => fetch(...a));
    const getGeo = () => deps.geolocation || (typeof navigator !== 'undefined' ? navigator.geolocation : null);
    const getLeaflet = () => deps.L || (typeof L !== 'undefined' ? L : null);
    const $ = (id) => doc.getElementById(id);
    const els = {
      to: $('planTo'), search: $('planSearch'), results: $('planResults'), status: $('planStatus'),
      summary: $('planSummary'), steps: $('planSteps'), follow: $('planFollow'), banner: $('planBanner'),
      bannerText: $('planBannerText'), bannerDist: $('planBannerDist'), bannerSub: $('planBannerSub'),
      reroute: $('planReroute'), mapBox: $('planMap'), clear: $('planClear'),
    };
    if (!els.to || !els.search) return { onShow() {}, state: {} };

    const state = {
      dest: null, from: null, route: null, map: null, layers: null,
      watchId: null, hint: 0, following: false, wake: null, busy: false,
    };

    const ctx = () => Object.assign({ soc: null, milesPerPct: null, avgMovingKph: null, maxKph: 30, useMiles: true }, deps.getContext && deps.getContext());
    const say = (msg, kind) => { els.status.textContent = msg || ''; els.status.dataset.kind = kind || ''; };
    const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
    const make = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

    function currentPosition() {
      return new Promise((resolve, reject) => {
        const geo = getGeo();
        if (!geo) return reject(new Error('This browser has no location access.'));
        geo.getCurrentPosition(
          (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
          () => reject(new Error('Could not get your location. Allow location access for this site and try again.')),
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
        );
      });
    }

    // ---------- search ----------
    async function doSearch() {
      const q = els.to.value;
      clear(els.results);
      say('Searching…');
      els.search.disabled = true;
      try {
        let near = null;
        try { near = await currentPosition(); } catch { /* search works without a location */ }
        const found = await Planner.geocode(q, fetchFn, { near });
        if (!found.length) { say('No places found. Try a street name and city.'); return; }
        say('Pick a destination:');
        for (const r of found) {
          const b = make('button', 'plan-result', r.name);
          b.type = 'button';
          b.addEventListener('click', () => chooseDestination(r));
          const li = make('li');
          li.appendChild(b);
          els.results.appendChild(li);
        }
      } catch (err) {
        say(err.message || 'Search failed.', 'err');
      } finally {
        els.search.disabled = false;
      }
    }

    async function chooseDestination(place) {
      state.dest = place;
      clear(els.results);
      els.to.value = place.name.split(',').slice(0, 2).join(',');
      await planRoute();
    }

    // ---------- routing ----------
    async function planRoute(fromOverride) {
      if (!state.dest || state.busy) return;
      state.busy = true;
      say('Finding a route…');
      try {
        const from = fromOverride || await currentPosition();
        state.from = from;
        const rt = await Planner.route(from, state.dest, fetchFn);
        state.route = rt;
        state.hint = 0;
        say('');
        renderRoute();
      } catch (err) {
        say(err.message || 'Could not plan that route.', 'err');
      } finally {
        state.busy = false;
      }
    }

    function renderRoute() {
      const rt = state.route;
      const c = ctx();
      const est = Planner.estimate(rt, { maxKph: c.maxKph, avgMovingKph: c.avgMovingKph, soc: c.soc, milesPerPct: c.milesPerPct });
      state.est = est;

      clear(els.summary);
      els.summary.hidden = false;
      const top = make('div', 'plan-top');
      top.appendChild(make('span', 'plan-big', Planner.formatDistance(rt.distance, c.useMiles)));
      top.appendChild(make('span', 'plan-big', Planner.formatMinutes(est.minutes)));
      els.summary.appendChild(top);
      els.summary.appendChild(make('div', 'plan-note',
        `Time assumes about ${Math.round(c.useMiles ? est.cruiseKph * 0.621371 : est.cruiseKph)} ${c.useMiles ? 'mph' : 'km/h'} (${est.speedSource}), with no stops.`));
      if (est.batteryNeededPct != null && est.arriveSOC != null) {
        const msg = {
          ok: `Should arrive with about ${Math.max(0, Math.round(est.arriveSOC))}% battery.`,
          tight: `Tight: about ${Math.max(0, Math.round(est.arriveSOC))}% left on arrival, and ${Math.round(est.returnSOC) < 0 ? 'not enough' : `about ${Math.round(est.returnSOC)}%`} for a return trip.`,
          no: `May not make it: about ${Math.max(0, Math.round(est.arriveSOC))}% left on arrival. Charge first, or pick somewhere closer.`,
        }[est.verdict];
        const v = make('div', `plan-verdict ${est.verdict}`, msg);
        els.summary.appendChild(v);
        if (est.verdict === 'ok' && est.returnSOC < 15) els.summary.appendChild(make('div', 'plan-note', 'A round trip would leave you very low.'));
        els.summary.appendChild(make('div', 'plan-note', 'Battery estimate is rough: it uses your own recorded rides.'));
      } else if (c.soc != null) {
        els.summary.appendChild(make('div', 'plan-note', 'Record a few rides with the scooter connected and I can estimate the battery needed.'));
      } else {
        els.summary.appendChild(make('div', 'plan-note', 'Connect the scooter to see how much battery this trip needs.'));
      }

      clear(els.steps);
      rt.steps.forEach((s, i) => {
        const li = make('li', 'plan-step');
        li.dataset.i = String(i);
        li.appendChild(make('span', 'plan-step-text', s.text));
        if (s.meters > 0) li.appendChild(make('span', 'plan-step-dist', Planner.formatDistance(s.meters, c.useMiles)));
        els.steps.appendChild(li);
      });
      els.follow.hidden = false;
      els.clear.hidden = false;
      drawMap();
    }

    function drawMap() {
      const Leaflet = getLeaflet();
      if (!Leaflet || !els.mapBox) return;
      els.mapBox.hidden = false;
      if (!state.map) {
        state.map = Leaflet.map(els.mapBox, { zoomControl: false, attributionControl: true });
        Leaflet.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 }).addTo(state.map);
      }
      if (state.layers) state.layers.forEach((l) => l.remove());
      const rt = state.route;
      const line = Leaflet.polyline(rt.coords, { color: '#ffb020', weight: 6, opacity: 0.95 }).addTo(state.map);
      const a = Leaflet.circleMarker(rt.coords[0], { radius: 7, color: '#0a0b0d', weight: 2, fillColor: '#5ec8d8', fillOpacity: 1 }).addTo(state.map);
      const b = Leaflet.circleMarker(rt.coords[rt.coords.length - 1], { radius: 8, color: '#0a0b0d', weight: 2, fillColor: '#ff4438', fillOpacity: 1 }).addTo(state.map);
      state.layers = [line, a, b];
      state.map.invalidateSize();
      state.map.fitBounds(line.getBounds(), { padding: [24, 24] });
    }

    // ---------- following ----------
    async function startFollowing() {
      if (!state.route || state.following) return;
      const geo = getGeo();
      if (!geo) { deps.showToast('This browser has no location access.'); return; }
      state.following = true;
      state.hint = 0;
      els.follow.textContent = 'Stop following';
      els.banner.hidden = false;
      try { if (doc.defaultView && 'wakeLock' in doc.defaultView.navigator) state.wake = await doc.defaultView.navigator.wakeLock.request('screen'); } catch { /* best effort */ }
      state.watchId = geo.watchPosition(onPosition, () => say('Lost the GPS signal. Directions pause until it returns.', 'err'),
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
    }

    function stopFollowing() {
      state.following = false;
      const geo = getGeo();
      if (state.watchId != null && geo) geo.clearWatch(state.watchId);
      state.watchId = null;
      try { if (state.wake) state.wake.release(); } catch { /* already released */ }
      state.wake = null;
      els.follow.textContent = 'Start following';
      els.banner.hidden = true;
      els.reroute.hidden = true;
      if (state.posMarker) { state.posMarker.remove(); state.posMarker = null; }
    }

    function onPosition(p) {
      if (!state.following || !state.route) return;
      const pos = { lat: p.coords.latitude, lon: p.coords.longitude };
      const acc = p.coords.accuracy;
      if (Number.isFinite(acc) && acc > 60) return;                   // too vague to steer by
      if (els.status.dataset.kind === 'err') say('');                 // a signal warning is stale once fixes arrive again
      const loc = Planner.locate(state.route, pos, state.hint);
      state.hint = loc.index;
      const c = ctx();
      const Leaflet = getLeaflet();
      if (Leaflet && state.map) {
        if (!state.posMarker) state.posMarker = Leaflet.circleMarker([pos.lat, pos.lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#5ec8d8', fillOpacity: 1 }).addTo(state.map);
        else state.posMarker.setLatLng([pos.lat, pos.lon]);
      }
      if (loc.arrived) {
        els.bannerText.textContent = 'You have arrived';
        els.bannerDist.textContent = '';
        els.bannerSub.textContent = state.dest ? state.dest.name.split(',')[0] : '';
        els.reroute.hidden = true;
        highlight(null);
        deps.showToast('Arrived');
        stopFollowing();
        els.banner.hidden = false;                                    // keep the arrival message on screen
        return;
      }
      els.reroute.hidden = !loc.isOff;
      if (loc.isOff) {
        els.bannerText.textContent = 'Off the route';
        els.bannerDist.textContent = Planner.formatDistance(loc.offRoute, c.useMiles);
        els.bannerSub.textContent = 'Tap Re-route to plan from here.';
        highlight(null);
        return;
      }
      els.bannerText.textContent = loc.next ? loc.next.text : 'Continue to your destination';
      els.bannerDist.textContent = loc.toNext != null ? Planner.formatDistance(loc.toNext, c.useMiles) : '';
      els.bannerSub.textContent = `${Planner.formatDistance(loc.remaining, c.useMiles)} to go`;
      highlight(loc.next ? state.route.steps.indexOf(loc.next) : null);
    }

    function highlight(i) {
      els.steps.querySelectorAll('.plan-step').forEach((li) => li.classList.toggle('current', i != null && li.dataset.i === String(i)));
    }

    // ---------- wiring ----------
    els.search.addEventListener('click', doSearch);
    els.to.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
    els.follow.addEventListener('click', () => (state.following ? stopFollowing() : startFollowing()));
    els.reroute.addEventListener('click', async () => {
      try {
        const here = await currentPosition();
        await planRoute(here);
        state.hint = 0;
      } catch (err) { say(err.message, 'err'); }
    });
    els.clear.addEventListener('click', () => {
      stopFollowing();
      state.route = null; state.dest = null;
      els.to.value = '';
      clear(els.steps); clear(els.results); clear(els.summary);
      els.summary.hidden = true; els.follow.hidden = true; els.clear.hidden = true;
      if (els.mapBox) els.mapBox.hidden = true;
      say('');
    });

    return {
      state,
      /** Called when the Plan tab is shown: a map built while hidden needs to be re-measured. */
      onShow() { if (state.map) setTimeout(() => state.map.invalidateSize(), 50); },
      stopFollowing,
    };
  }

  return { init };
});
