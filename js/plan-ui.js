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
 * updates, so a screen wake lock is requested while following. Directions are shown and, if
 * voice is on, spoken with the browser's built-in speech (no network needed).
 *
 * Also here: saved places (Home, Work, favourites), "find my scooter" (where the last ride
 * ended, or a spot marked by hand, with walking directions back), and a range circle showing
 * how far the battery reaches there-and-back. Saved places and the parked spot live in this
 * browser's localStorage only.
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
   *          geolocation?: object, L?: object, now?: Function, storage?: Storage, speech?: object}} deps
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
      reroute: $('planReroute'), mapBox: $('planMap'), clear: $('planClear'), empty: $('planEmpty'),
      quick: $('planQuick'), save: $('planSave'), parked: $('planParked'), voice: $('planVoice'),
    };
    if (!els.to || !els.search) return { onShow() {}, state: {} };

    const state = {
      dest: null, from: null, route: null, map: null, layers: null, profile: 'bike',
      watchId: null, hint: 0, following: false, wake: null, busy: false, voice: null,
    };
    const now = deps.now || (() => Date.now());

    // ---------- small persistence helpers (localStorage, never throws) ----------
    const store = deps.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const readJSON = (key, dflt) => { try { const v = store && JSON.parse(store.getItem(key)); return v == null ? dflt : v; } catch { return dflt; } };
    const writeJSON = (key, v) => { try { if (store) { if (v == null) store.removeItem(key); else store.setItem(key, JSON.stringify(v)); } } catch { /* blocked */ } };
    const validPlace = (p) => p && typeof p.name === 'string' && Number.isFinite(p.lat) && Number.isFinite(p.lon);
    const places = () => readJSON('niu.places', []).filter(validPlace).slice(0, 10);
    const parkedSpot = () => { const p = readJSON('niu.parked', null); return validPlace(Object.assign({ name: 'Your scooter' }, p)) && Number.isFinite(p.t) ? p : null; };

    // ---------- voice ----------
    const getSpeech = () => deps.speech || (typeof speechSynthesis !== 'undefined' ? speechSynthesis : null);
    let voiceOn = readJSON('niu.voice', true) !== false;
    function speak(text) {
      const sp = getSpeech();
      if (!voiceOn || !sp || !text) return;
      try {
        const U = deps.Utterance || (typeof SpeechSynthesisUtterance !== 'undefined' ? SpeechSynthesisUtterance : null);
        if (!U) return;
        sp.cancel();                                   // never queue stale instructions behind a new one
        const u = new U(text);
        u.rate = 1.0;
        sp.speak(u);
      } catch { /* speech is a bonus */ }
    }
    function renderVoice() {
      if (!els.voice) return;
      els.voice.hidden = !getSpeech() || !state.route;      // only useful once there are directions
      els.voice.textContent = voiceOn ? 'Voice: on' : 'Voice: off';
      els.voice.setAttribute('aria-pressed', String(voiceOn));
      els.voice.classList.toggle('on', voiceOn);
    }

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

    async function chooseDestination(place, profile) {
      state.dest = place;
      state.profile = profile || 'bike';
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
        const rt = await Planner.route(from, state.dest, fetchFn, { profile: state.profile });
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
      const walking = state.profile === 'foot';

      clear(els.summary);
      els.summary.hidden = false;
      if (walking) {
        const top = make('div', 'plan-top');
        top.appendChild(make('span', 'plan-big', Planner.formatDistance(rt.distance, c.useMiles)));
        top.appendChild(make('span', 'plan-big', Planner.formatMinutes((rt.distance / 1000 / 4.8) * 60)));
        els.summary.appendChild(top);
        els.summary.appendChild(make('div', 'plan-note', 'Walking route back to your scooter, at an easy 3 mph.'));
        renderSteps(c);
        renderSaveRow();
        return;
      }
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
        const rt2 = make('div', 'plan-round');
        rt2.appendChild(make('span', 'plan-round-label', 'Round trip'));
        rt2.appendChild(make('span', 'plan-round-val',
          `${Planner.formatDistance(rt.distance * 2, c.useMiles)} · ${Planner.formatMinutes(est.minutes * 2)} · ${est.returnSOC < 0 ? 'not enough battery' : `home with ~${Math.round(est.returnSOC)}%`}`));
        rt2.classList.toggle('warn', est.returnSOC < 15);
        els.summary.appendChild(rt2);
        els.summary.appendChild(make('div', 'plan-note', 'Battery estimate is rough: it uses your own recorded rides.'));
      } else if (c.soc != null) {
        els.summary.appendChild(make('div', 'plan-note', 'Record a few rides with the scooter connected and I can estimate the battery needed.'));
      } else {
        els.summary.appendChild(make('div', 'plan-note', 'Connect the scooter to see how much battery this trip needs.'));
      }

      renderSteps(c);
      renderSaveRow();
    }

    function renderSteps(c) {
      const rt = state.route;
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
      if (els.empty) els.empty.hidden = true;
      renderVoice();
      drawMap();
    }

    // ---------- saved places ----------
    function renderSaveRow() {
      if (!els.save) return;
      clear(els.save);
      const d = state.dest;
      if (!d || state.profile === 'foot') { els.save.hidden = true; return; }
      els.save.hidden = false;
      const same = (p) => Math.abs(p.lat - d.lat) < 1e-6 && Math.abs(p.lon - d.lon) < 1e-6;
      const saved = places().find(same);
      if (saved) {
        els.save.appendChild(make('span', 'plan-save-label', `Saved as ${saved.label}`));
        const rm = make('button', 'btn small ghost', 'Remove');
        rm.type = 'button';
        rm.addEventListener('click', () => { writeJSON('niu.places', places().filter((p) => !same(p))); renderSaveRow(); renderQuick(); });
        els.save.appendChild(rm);
        return;
      }
      els.save.appendChild(make('span', 'plan-save-label', 'Save as'));
      for (const label of ['Home', 'Work', 'Favourite']) {
        const b = make('button', 'btn small ghost', label);
        b.type = 'button';
        b.addEventListener('click', () => {
          let list = places().filter((p) => !same(p));
          if (label !== 'Favourite') list = list.filter((p) => p.label !== label);   // one Home, one Work
          const name = label === 'Favourite' ? d.name.split(',')[0].slice(0, 40) : label;
          list.push({ label, name, full: d.name.slice(0, 200), lat: d.lat, lon: d.lon });
          writeJSON('niu.places', list.slice(-10));
          deps.showToast(`Saved as ${label === 'Favourite' ? name : label}`);
          renderSaveRow();
          renderQuick();
        });
        els.save.appendChild(b);
      }
    }

    // ---------- quick row: saved places, parked scooter, range ----------
    function chip(text, cls, onClick) {
      const b = make('button', `plan-chip ${cls || ''}`, text);
      b.type = 'button';
      b.addEventListener('click', onClick);
      return b;
    }

    function renderQuick() {
      if (!els.quick) return;
      clear(els.quick);
      els.quick.appendChild(chip('Range', 'range', showRange));
      els.quick.appendChild(chip('Park here', 'park', parkHereNow));
      const order = { Home: 0, Work: 1, Favourite: 2 };
      for (const p of places().sort((a, b) => order[a.label] - order[b.label])) {
        const text = p.label === 'Favourite' ? `★ ${p.name}` : p.label;
        els.quick.appendChild(chip(text, p.label.toLowerCase(), () => {
          clear(els.results);
          els.to.value = p.label === 'Favourite' ? p.name : p.label;
          chooseDestination({ name: p.full || p.name, lat: p.lat, lon: p.lon });
        }));
      }
      renderParked();
    }

    function ago(t) {
      const m = Math.round((now() - t) / 60000);
      if (m < 1) return 'just now';
      if (m < 60) return `${m} min ago`;
      const h = Math.round(m / 60);
      return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
    }

    function renderParked() {
      if (!els.parked) return;
      clear(els.parked);
      const p = parkedSpot();
      els.parked.hidden = !p;
      if (!p) return;
      const info = make('div', 'plan-parked-info');
      info.appendChild(make('div', 'plan-parked-title', 'Your scooter'));
      info.appendChild(make('div', 'plan-parked-sub', `Parked ${ago(p.t)}${p.source === 'ride' ? ', where your last ride ended' : ''}`));
      els.parked.appendChild(info);
      const go = make('button', 'btn small primary', 'Walk back');
      go.type = 'button';
      go.addEventListener('click', () => {
        els.to.value = 'Your scooter';
        clear(els.results);
        chooseDestination({ name: 'Your scooter', lat: p.lat, lon: p.lon }, 'foot');
      });
      els.parked.appendChild(go);
      const forget = make('button', 'btn small ghost', 'Forget');
      forget.type = 'button';
      forget.addEventListener('click', () => { writeJSON('niu.parked', null); renderParked(); });
      els.parked.appendChild(forget);
    }

    /** Remembers where the scooter is. `source` is 'ride' (end of a recorded ride) or 'manual'. */
    function park(point, source) {
      if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return;
      writeJSON('niu.parked', { lat: point.lat, lon: point.lon, t: Number.isFinite(point.t) ? point.t : now(), source: source || 'manual' });
      renderParked();
    }

    async function parkHereNow() {
      try {
        const here = await currentPosition();
        park(Object.assign({}, here, { t: now() }), 'manual');
        deps.showToast('Parking spot saved');
      } catch (err) { say(err.message, 'err'); }
    }

    // ---------- range circle ----------
    async function showRange() {
      const c = ctx();
      const r = Planner.reachRadius({ soc: c.soc, milesPerPct: c.milesPerPct });
      if (r == null) {
        say(c.soc == null ? 'Connect the scooter to see your range.' : 'Record a few rides with the scooter connected and I can draw your range.', 'err');
        return;
      }
      let here;
      try { here = state.from || await currentPosition(); } catch (err) { say(err.message, 'err'); return; }
      say(r === 0
        ? 'Battery is at the 10% reserve: charge before heading out.'
        : `With ${c.soc}% you can go about ${Planner.formatDistance(r, c.useMiles)} (straight line) and still get back with 10% left. Roads wind, so this is rough.`);
      drawRing(here, r, true);
    }

    function drawRing(center, radius, fit) {
      const Leaflet = getLeaflet();
      if (!Leaflet || !els.mapBox || !Leaflet.circle) return;
      ensureMap(Leaflet);
      if (state.ring) state.ring.remove();
      state.ring = Leaflet.circle([center.lat, center.lon], { radius: Math.max(radius, 1), color: '#4fe07a', weight: 2, dashArray: '6 6', fillColor: '#4fe07a', fillOpacity: 0.06 }).addTo(state.map);
      if (fit) {
        state.map.invalidateSize();
        if (radius > 0 && state.ring.getBounds) state.map.fitBounds(state.ring.getBounds(), { padding: [16, 16] });
        else if (state.map.setView) state.map.setView([center.lat, center.lon], 15);
      }
    }

    function ensureMap(Leaflet) {
      els.mapBox.hidden = false;
      if (els.empty) els.empty.hidden = true;
      if (!state.map) {
        state.map = Leaflet.map(els.mapBox, { zoomControl: false, attributionControl: true });
        Leaflet.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 }).addTo(state.map);
      }
    }

    function drawMap() {
      const Leaflet = getLeaflet();
      if (!Leaflet || !els.mapBox) return;
      ensureMap(Leaflet);
      if (state.layers) state.layers.forEach((l) => l.remove());
      if (state.ring) { state.ring.remove(); state.ring = null; }
      const rt = state.route;
      const walking = state.profile === 'foot';
      const line = Leaflet.polyline(rt.coords, walking
        ? { color: '#5ec8d8', weight: 5, opacity: 0.95, dashArray: '2 8' }
        : { color: '#ffb020', weight: 6, opacity: 0.95 }).addTo(state.map);
      const a = Leaflet.circleMarker(rt.coords[0], { radius: 7, color: '#0a0b0d', weight: 2, fillColor: '#5ec8d8', fillOpacity: 1 }).addTo(state.map);
      const b = Leaflet.circleMarker(rt.coords[rt.coords.length - 1], { radius: 8, color: '#0a0b0d', weight: 2, fillColor: '#ff4438', fillOpacity: 1 }).addTo(state.map);
      state.layers = [line, a, b];
      state.map.invalidateSize();
      state.map.fitBounds(line.getBounds(), { padding: [24, 24] });
      if (!walking) {                                   // faint reach circle around the start, when known
        const c = ctx();
        const r = Planner.reachRadius({ soc: c.soc, milesPerPct: c.milesPerPct });
        if (r) drawRing({ lat: rt.coords[0][0], lon: rt.coords[0][1] }, r, false);
      }
    }

    // ---------- following ----------
    async function startFollowing() {
      if (!state.route || state.following) return;
      const geo = getGeo();
      if (!geo) { deps.showToast('This browser has no location access.'); return; }
      state.following = true;
      state.hint = 0;
      state.voice = null;
      speak(state.profile === 'foot' ? 'Walking directions to your scooter.' : 'Starting directions.');   // inside the tap, which unlocks speech on iOS
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
      const cue = Planner.voiceCue(loc, state.voice, state.route.steps, c.useMiles);
      state.voice = cue.state;
      if (cue.text) speak(cue.text + (loc.isOff ? ' Tap re-route to plan from here.' : ''));
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
    if (els.voice) {
      els.voice.addEventListener('click', () => {
        voiceOn = !voiceOn;
        writeJSON('niu.voice', voiceOn);
        renderVoice();
        if (voiceOn) speak('Voice on.');
        else { const sp = getSpeech(); try { if (sp) sp.cancel(); } catch { /* ignore */ } }
      });
    }
    renderVoice();
    renderQuick();
    els.reroute.addEventListener('click', async () => {
      try {
        const here = await currentPosition();
        await planRoute(here);
        state.hint = 0;
        state.voice = null;
      } catch (err) { say(err.message, 'err'); }
    });
    els.clear.addEventListener('click', () => {
      stopFollowing();
      state.route = null; state.dest = null; state.profile = 'bike';
      if (state.ring) { state.ring.remove(); state.ring = null; }
      els.to.value = '';
      if (els.save) els.save.hidden = true;
      renderVoice();
      clear(els.steps); clear(els.results); clear(els.summary);
      els.summary.hidden = true; els.follow.hidden = true; els.clear.hidden = true;
      if (els.empty) els.empty.hidden = false;
      if (els.mapBox) els.mapBox.hidden = true;
      say('');
    });

    return {
      state,
      /** Called when the Plan tab is shown: a map built while hidden needs to be re-measured. */
      onShow() { renderParked(); if (state.map) setTimeout(() => state.map.invalidateSize(), 50); },
      stopFollowing,
      park,
    };
  }

  return { init };
});
