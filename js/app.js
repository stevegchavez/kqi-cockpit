/**
 * app.js — NIU Companion Web Dashboard
 *
 * Wires BLEManager + GeoTracker + RideStore + KeyStore to the DOM, and drives
 * the instrument-cluster visuals: the radial speed gauge, battery cell strip,
 * ignition power-on sweep, and per-ride sparklines. READ-ONLY: the app only
 * reads status from the scooter; it has no controls that change it.
 */
(function () {
  const ble = new NIU.BLEManager({ catalogue: NIU.Fields });
  const geo = new NIU.GeoTracker();
  const store = new NIU.RideStore();
  // Battery history has its own IndexedDB; if storage is blocked the cockpit still works without it.
  let battery = null;
  try { battery = new NIU.Battery.BatteryStore(); } catch { battery = null; }

  // Cosmetic scale for the gauge only — does not gate or validate real
  // telemetry. Starts at a KQi-ish default and follows the scooter's own
  // reported max speed once it is known.
  let gaugeMaxKph = 32;
  const GAUGE_START_ANGLE = -130; // degrees, 0 = 12 o'clock, clockwise positive
  const GAUGE_END_ANGLE = 130;
  // Efficiency zones as a share of the gauge: a scooter's energy use per km climbs steeply with
  // speed (air drag), so the low end of the dial is the efficient end. This is an estimate from
  // speed alone; no live power or current field has been confirmed on the 200F yet.
  const EFF_GOOD_PCT = 0.45;   // up to here: green
  const EFF_FAIR_PCT = 0.70;   // up to here: yellow, then orange; beyond EFF_POOR_PCT: red
  const EFF_POOR_PCT = 0.85;
  const CELL_COUNT = 10;

  const state = {
    unit: localStorage.getItem('niu.unit') || 'mph', // display preference only, not ride data
    scooter: { speedKPH: 0, batterySOC: 0, faultFlags: 0, batteryHealth: null, poweredOn: null, maxSpeedKPH: null, chargeCycles: null },
    rides: [],                 // cached saved rides, for the range estimate
    haveBattery: false,        // true once a REAL battery reading has arrived this connection
    lastBatterySample: null,
    rideStartSOC: null,
    rideSimulated: false,
    isRiding: false,
    rideStart: null,
    topSpeedKPH: 0,
    speedSamples: [],
    elapsedTimer: null,
    demoTimer: null,
    hasIgnited: false,
  };

  // ---------- DOM refs ----------
  const el = (id) => document.getElementById(id);
  const dot = el('statusDot');
  const statusLabel = el('statusLabel');
  const faultLabel = el('faultLabel');
  const connectBtn = el('connectBtn');
  const speedValue = el('speedValue');
  const speedUnit = el('speedUnit');
  const unitToggle = el('unitToggle');
  const batteryPct = el('batteryPct');
  const cellStrip = el('cellStrip');
  const tripDist = el('tripDist');
  const tripTime = el('tripTime');
  const tripTop = el('tripTop');
  const healthVal = el('healthVal');
  const powerVal = el('powerVal');
  const maxSpeedVal = el('maxSpeedVal');
  const cyclesVal = el('cyclesVal');
  const rangeLine = el('rangeLine');
  const keysInput = el('keysInput');
  const keysStatus = el('keysStatus');
  const rideBtn = el('rideBtn');
  const demoToggleBtn = el('demoToggleBtn');
  const ridesList = el('ridesList');
  const emptyState = el('emptyState');
  const toast = el('toast');
  const gaugeTrack = el('gaugeTrack');
  const gaugeValue = el('gaugeValue');
  const gaugeTicks = el('gaugeTicks');

  // ---------- Gauge geometry ----------
  function polarToCartesian(cx, cy, r, angleDeg) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }
  function describeArc(cx, cy, r, startAngle, endAngle) {
    const start = polarToCartesian(cx, cy, r, endAngle);
    const end = polarToCartesian(cx, cy, r, startAngle);
    const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
    // Drawn from the start angle round to the end angle (left to right over the top), so the
    // value arc fills in the direction the needle would move.
    return ['M', end.x, end.y, 'A', r, r, 0, largeArcFlag, 1, start.x, start.y].join(' ');
  }

  const GAUGE_CX = 100, GAUGE_CY = 100, GAUGE_R = 86;
  let gaugeArcLength = 0;

  function initGauge() {
    const d = describeArc(GAUGE_CX, GAUGE_CY, GAUGE_R, GAUGE_START_ANGLE, GAUGE_END_ANGLE);
    gaugeTrack.setAttribute('d', d);
    gaugeValue.setAttribute('d', d);
    // Colour ramp along the arc, with each stop at the horizontal position of its speed zone
    // (the gradient is horizontal, x 34..186, so the stops are converted from arc angle to x).
    const xAt = (pct) => GAUGE_CX + GAUGE_R * Math.sin(((GAUGE_START_ANGLE + (GAUGE_END_ANGLE - GAUGE_START_ANGLE) * pct) * Math.PI) / 180);
    const stopAt = (id, pct) => { const s = el(id); if (s) s.setAttribute('offset', String(Math.max(0, Math.min(1, (xAt(pct) - 34) / 152)))); };
    stopAt('effStop1', EFF_GOOD_PCT); stopAt('effStop2', EFF_FAIR_PCT); stopAt('effStop3', EFF_POOR_PCT);
    // In a browser, getTotalLength() gives the real path length for the
    // dasharray/dashoffset reveal technique. jsdom doesn't implement SVG
    // geometry, so guard for that environment rather than throwing there.
    gaugeArcLength = typeof gaugeValue.getTotalLength === 'function' ? gaugeValue.getTotalLength() : 300;
    gaugeValue.style.strokeDasharray = String(gaugeArcLength);
    gaugeValue.style.strokeDashoffset = String(gaugeArcLength);

    // Tick marks: 11 minor ticks across the sweep, every 3rd one "major".
    const tickCount = 11;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < tickCount; i++) {
      const angle = GAUGE_START_ANGLE + ((GAUGE_END_ANGLE - GAUGE_START_ANGLE) * i) / (tickCount - 1);
      const isMajor = i % 3 === 0;
      const outer = polarToCartesian(GAUGE_CX, GAUGE_CY, GAUGE_R + 10, angle);
      const inner = polarToCartesian(GAUGE_CX, GAUGE_CY, GAUGE_R + (isMajor ? 2 : 5), angle);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', inner.x); line.setAttribute('y1', inner.y);
      line.setAttribute('x2', outer.x); line.setAttribute('y2', outer.y);
      line.setAttribute('class', isMajor ? 'gauge-tick major' : 'gauge-tick');
      frag.appendChild(line);
    }
    gaugeTicks.appendChild(frag);
  }

  function setGaugePercent(pct) {
    pct = Math.max(0, Math.min(1, pct));
    gaugeValue.style.strokeDashoffset = String(gaugeArcLength * (1 - pct));
    const zone = pct <= 0.02 ? '' : pct <= EFF_GOOD_PCT ? 'good' : pct <= EFF_FAIR_PCT ? 'fair' : 'poor';
    const label = el('effLabel');
    if (label) {
      label.textContent = { good: 'Efficient', fair: 'Moderate', poor: 'High drain' }[zone] || '';
      label.dataset.zone = zone;
    }
  }

  /** Plays a brief 0→max→actual sweep, like a car dash powering on. */
  function playIgnitionSequence() {
    gaugeValue.classList.add('igniting');
    setGaugePercent(1);
    setTimeout(() => {
      setGaugePercent(state.scooter.speedKPH / gaugeMaxKph);
      setTimeout(() => gaugeValue.classList.remove('igniting'), 400);
    }, 420);
    renderCellStrip(0);
    setTimeout(() => renderCellStrip(state.scooter.batterySOC), 200);
  }

  // ---------- Battery cell strip ----------
  function renderCellStrip(soc) {
    cellStrip.innerHTML = '';
    const litCount = Math.round((soc / 100) * CELL_COUNT);
    const warn = soc < 20;
    for (let i = 0; i < CELL_COUNT; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell' + (i < litCount ? ' lit' + (warn ? ' warn' : '') : '');
      cellStrip.appendChild(cell);
    }
  }

  // ---------- Helpers ----------
  function kphToDisplay(kph) { return state.unit === 'mph' ? kph * 0.621371 : kph; }
  function metersToDisplayDistance(m) { return state.unit === 'mph' ? m / 1609.344 : m / 1000; }
  function distanceUnitLabel() { return state.unit === 'mph' ? 'mi' : 'km'; }
  function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
  }
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('visible'), 2400);
  }

  // ---------- Connection UI ----------
  ble.addEventListener('statechange', (e) => {
    const s = e.detail;
    dot.className = `dot ${s}`;
    statusLabel.textContent = {
      disconnected: 'Disconnected — tap to connect',
      connecting: 'Connecting…',
      connected: 'Connected',
      unsupported: 'Web Bluetooth unavailable — use Bluefy on iOS',
    }[s] || s;
    connectBtn.style.display = s === 'connected' ? 'none' : 'block';
    rideBtn.disabled = s !== 'connected' && !state.demoTimer;
  });

  ble.addEventListener('connected', (e) => {
    // Forget values from a previous connection or from demo mode; fresh reads fill these in.
    Object.assign(state.scooter, { batteryHealth: null, poweredOn: null, maxSpeedKPH: null, chargeCycles: null });
    statusLabel.textContent = e.detail.name || 'Scooter connected';
    playIgnitionSequence();
  });

  ble.addEventListener('telemetry', (e) => applyTelemetry(e.detail, { simulated: false }));
  ble.addEventListener('error', (e) => showToast(e.detail.message));
  ble.addEventListener('disconnected', () => {
    state.scooter.poweredOn = null;
    state.haveBattery = false;
    renderInfoStrip();
    updateRange();
  });

  connectBtn.addEventListener('click', async () => {
    const keys = NIU.KeyStore.load();
    if (!keys) {
      showToast('Add your scooter keys in Setup first.');
      showTab('setupScreen');
      return;
    }
    try { await ble.connect(keys); }
    catch (err) { showToast(err.message); }
  });

  function applyTelemetry(t, opts) {
    const simulated = !!(opts && opts.simulated);
    Object.assign(state.scooter, t);
    if (simulated && state.isRiding) state.rideSimulated = true;
    if (!simulated && t.batterySOC !== undefined) state.haveBattery = true;
    if (t.speedKPH !== undefined) {
      speedValue.textContent = Math.round(kphToDisplay(t.speedKPH));
      setGaugePercent(t.speedKPH / gaugeMaxKph);
      if (state.isRiding) {
        state.speedSamples.push(t.speedKPH);
        state.topSpeedKPH = Math.max(state.topSpeedKPH, t.speedKPH);
        tripTop.textContent = Math.round(kphToDisplay(state.topSpeedKPH));
      }
    }
    if (t.batterySOC !== undefined) {
      batteryPct.textContent = `${t.batterySOC}%`;
      renderCellStrip(t.batterySOC);
    }
    if (t.faultFlags !== undefined) {
      faultLabel.style.display = t.faultFlags === 0 ? 'none' : 'flex';
    }
    if (t.maxSpeedKPH) gaugeMaxKph = Math.max(10, Math.ceil(t.maxSpeedKPH * 1.1));
    renderInfoStrip();
    if (!simulated) recordBattery();
    if (t.batterySOC !== undefined) updateRange();
  }

  /** Appends a battery-history sample when the rules say it is worth keeping. Never in demo mode. */
  function recordBattery() {
    if (!battery || !state.haveBattery || state.demoTimer) return;
    const s = state.scooter;
    const sample = { t: Date.now(), soc: s.batterySOC };
    if (s.batteryHealth != null) sample.soh = s.batteryHealth;
    if (s.chargeCycles != null) sample.cycles = s.chargeCycles;
    if (s.poweredOn != null) sample.on = s.poweredOn;
    if (!NIU.Battery.shouldRecord(state.lastBatterySample, sample)) return;
    state.lastBatterySample = sample;
    battery.add(sample)
      .then(() => { if (el('batteryScreen').classList.contains('active')) renderBatteryScreen(); })
      .catch(() => { /* history is a bonus; never break the cockpit over it */ });
  }

  /** "About X left", learned from your own real rides. */
  function updateRange() {
    const est = NIU.Insights.rangeEstimate(state.rides, state.haveBattery ? state.scooter.batterySOC : null);
    if (!est) {
      rangeLine.textContent = 'Range estimate appears after a few rides with the scooter connected.';
      return;
    }
    const perPct = state.unit === 'mph' ? est.milesPerPct : est.milesPerPct * 1.609344;
    const basis = `${est.confidence === 'good' ? '' : 'rough, '}from ${est.rides} ride${est.rides === 1 ? '' : 's'}`;
    if (est.miles === null) {
      rangeLine.textContent = `Typically ${perPct.toFixed(2)} ${distanceUnitLabel()} per 1% battery (${basis}).`;
      return;
    }
    const left = state.unit === 'mph' ? est.miles : est.miles * 1.609344;
    rangeLine.innerHTML = `\u2248 <b>${left.toFixed(1)} ${distanceUnitLabel()}</b> left \u00b7 ${basis}`;
  }

  /** Hands text to the share sheet / download / clipboard and tells the rider which happened. */
  async function exportFile(prefix, ext, mime, text, t) {
    try {
      const how = await NIU.Exporters.deliver(NIU.Exporters.filenameFor(prefix, t, ext), mime, text);
      if (how === 'clipboard') showToast('Copied to the clipboard.');
      else if (how === 'download') showToast('Downloaded.');
    } catch (err) { showToast(err.message); }
  }

  /** Battery health, power state and max speed — all read from the scooter. */
  function renderInfoStrip() {
    const s = state.scooter;
    healthVal.textContent = s.batteryHealth == null ? '\u2013' : `${s.batteryHealth}%`;
    powerVal.textContent = s.poweredOn == null ? '\u2013' : (s.poweredOn ? 'ON' : 'OFF');
    powerVal.className = 'v ' + (s.poweredOn == null ? 'off' : (s.poweredOn ? 'on' : 'off'));
    maxSpeedVal.textContent = s.maxSpeedKPH == null ? '\u2013' : Math.round(kphToDisplay(s.maxSpeedKPH));
    cyclesVal.textContent = s.chargeCycles == null ? '\u2013' : String(s.chargeCycles);
  }

  // ---------- Unit toggle ----------
  function refreshUnitLabels() {
    speedUnit.textContent = state.unit.toUpperCase();
    unitToggle.textContent = state.unit === 'mph' ? 'KM/H' : 'MPH';
    el('tripDistLabel').textContent = `Trip ${distanceUnitLabel()}`;
    el('tripTopLabel').textContent = `Top ${state.unit}`;
    el('maxSpeedLabel').textContent = `Max ${state.unit}`;
    renderInfoStrip();
    updateRange();
  }
  unitToggle.addEventListener('click', () => {
    state.unit = state.unit === 'mph' ? 'kph' : 'mph';
    localStorage.setItem('niu.unit', state.unit);
    refreshUnitLabels();
    speedValue.textContent = Math.round(kphToDisplay(state.scooter.speedKPH));
  });

  // ---------- Ride lifecycle ----------
  rideBtn.addEventListener('click', () => { state.isRiding ? finishRide() : startRide(); });

  function startRide() {
    state.isRiding = true;
    state.rideStart = Date.now();
    state.topSpeedKPH = 0;
    state.speedSamples = [];
    state.rideSimulated = !!state.demoTimer;
    state.rideStartSOC = state.haveBattery && !state.demoTimer ? state.scooter.batterySOC : null;
    rideBtn.textContent = 'FINISH RIDE';
    rideBtn.classList.add('riding');
    requestWakeLock();

    try { geo.start(); }
    catch (err) { showToast(err.message + ' — recording speed/time only, no route.'); }

    state.elapsedTimer = setInterval(() => {
      const elapsed = (Date.now() - state.rideStart) / 1000;
      tripTime.textContent = formatDuration(elapsed);
    }, 1000);
  }

  async function finishRide() {
    state.isRiding = false;
    rideBtn.textContent = 'START RIDE';
    rideBtn.classList.remove('riding');
    clearInterval(state.elapsedTimer);

    const { points, distanceMeters } = geo.stop();
    const endDate = Date.now();
    const avgSpeedKPH = state.speedSamples.length
      ? state.speedSamples.reduce((a, b) => a + b, 0) / state.speedSamples.length
      : 0;

    const ride = {
      id: `ride_${state.rideStart}`,
      startDate: state.rideStart,
      endDate,
      distanceMeters,
      topSpeedKPH: state.topSpeedKPH,
      averageSpeedKPH: avgSpeedKPH,
      activeRidingSeconds: (endDate - state.rideStart) / 1000,
      points,
      // Battery at the start and end, for efficiency and the range estimate. Null when unknown.
      startSOC: state.rideStartSOC,
      endSOC: state.haveBattery && !state.rideSimulated ? state.scooter.batterySOC : null,
      simulated: state.rideSimulated,
    };

    await store.saveRide(ride);
    tripDist.textContent = '0.00';
    tripTime.textContent = '0m 0s';
    tripTop.textContent = '0';
    renderRidesList();
    showToast('Ride saved');
  }

  geo.addEventListener('point', () => {
    if (!state.isRiding) return;
    tripDist.textContent = metersToDisplayDistance(geo.distanceMeters).toFixed(2);
  });

  // ---------- Demo mode (no scooter required) ----------
  demoToggleBtn.addEventListener('click', () => {
    if (state.demoTimer) {
      clearInterval(state.demoTimer);
      state.demoTimer = null;
      demoToggleBtn.textContent = 'Simulate telemetry (no scooter)';
      rideBtn.disabled = ble.state !== 'connected';
      return;
    }
    demoToggleBtn.textContent = 'Stop simulation';
    rideBtn.disabled = false;
    playIgnitionSequence();
    let t = 0;
    state.demoTimer = setInterval(() => {
      t += 0.3;
      const speedKPH = Math.max(0, 18 + 12 * Math.sin(t));
      applyTelemetry({ speedKPH, batterySOC: Math.max(0, 78 - Math.floor(t / 4)), faultFlags: 0, batteryHealth: 93, poweredOn: true, maxSpeedKPH: 30, chargeCycles: 151 }, { simulated: true });
    }, 400);
  });

  // ---------- Tab navigation ----------
  function showTab(target) {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.target === target));
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    el(target).classList.add('active');
    if (target === 'ridesScreen') renderRidesList();
    if (target === 'batteryScreen') renderBatteryScreen();
  }
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => showTab(btn.dataset.target));
  });

  // ---------- Battery history screen ----------
  const dayLabel = (x) => new Date(x).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const chartOrEmpty = (box, svg, msg) => { box.innerHTML = svg || `<div class="empty">${msg}</div>`; };

  async function renderBatteryScreen() {
    let samples = [];
    if (battery) { try { samples = await battery.all(); } catch { samples = []; } }
    el('batteryEmpty').style.display = samples.length ? 'none' : 'block';
    el('batteryBody').style.display = samples.length ? 'block' : 'none';
    if (!samples.length) return;

    const latest = (field) => {
      for (let i = samples.length - 1; i >= 0; i--) if (typeof samples[i][field] === 'number') return samples[i][field];
      return null;
    };
    const soh = latest('soh');
    const cycles = latest('cycles');
    const charges = NIU.Battery.inferCharges(samples);
    el('bHealth').textContent = soh === null ? '\u2013' : `${soh}%`;
    el('bCycles').textContent = cycles === null ? '\u2013' : String(cycles);
    el('bCharges').textContent = String(charges.length);

    const weekAgo = Date.now() - 7 * 86400000;
    const week = samples.filter((s) => s.t >= weekAgo).map((s) => ({ x: s.t, y: s.soc }));
    chartOrEmpty(el('socChart'),
      NIU.Charts.lineChart(week, { yMin: 0, yMax: 100, unit: '%', label: 'Battery level over the last 7 days', xFormat: dayLabel }),
      'No readings in the last 7 days.');
    chartOrEmpty(el('healthChart'),
      NIU.Charts.lineChart(NIU.Battery.dailySeries(samples, 'soh'), { unit: '%', label: 'Battery health by day', xFormat: dayLabel }),
      'No health readings yet.');

    const trend = NIU.Battery.healthTrend(samples);
    let trendText = 'Not enough data for a health trend yet: it needs at least 3 days and about 10 more charge cycles.';
    if (trend) {
      const observed = trend.fromHealth === trend.toHealth
        ? `Health has held at ${trend.toHealth}%`
        : `Health went from ${trend.fromHealth}% to ${trend.toHealth}%`;
      trendText = `${observed} over ${trend.days} days and ${trend.spanCycles} charge cycles.`;
      if (trend.extrapolate && trend.perHundredCycles !== 0) {
        const dir = trend.perHundredCycles < 0 ? 'losing' : 'gaining';
        trendText += ` That is roughly ${dir} ${Math.abs(trend.perHundredCycles).toFixed(1)}% per 100 cycles.`;
      }
      trendText += ' Health is a whole number, so treat this as rough.';
    }
    el('healthTrend').textContent = trendText;

    const list = el('chargesList');
    list.innerHTML = '';
    const recent = charges.slice(-5).reverse();
    if (!recent.length) {
      const li = document.createElement('li');
      li.className = 'none';
      li.textContent = 'No charges seen yet.';
      list.appendChild(li);
    }
    for (const c of recent) {
      const li = document.createElement('li');
      const a = document.createElement('span');
      a.textContent = new Date(c.to).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const b = document.createElement('span');
      b.textContent = `${c.fromSOC}% \u2192 ${c.toSOC}%`;
      li.append(a, b);
      list.appendChild(li);
    }
  }

  el('exportBatteryBtn').addEventListener('click', async () => {
    if (!battery) return;
    try { exportFile('niu-battery', 'csv', 'text/csv', NIU.Exporters.batteryCSV(await battery.all()), Date.now()); }
    catch { showToast('Could not read the battery history.'); }
  });
  // Two taps to delete, so a stray touch can't wipe the history.
  let clearArmed = null;
  el('clearBatteryBtn').addEventListener('click', async () => {
    const btn = el('clearBatteryBtn');
    if (!clearArmed) {
      btn.textContent = 'Tap again to delete';
      clearArmed = setTimeout(() => { clearArmed = null; btn.textContent = 'Clear history'; }, 4000);
      return;
    }
    clearTimeout(clearArmed);
    clearArmed = null;
    btn.textContent = 'Clear history';
    try { if (battery) await battery.clear(); } catch { /* nothing to clear */ }
    state.lastBatterySample = null;
    renderBatteryScreen();
    showToast('Battery history cleared.');
  });

  // ---------- Diagnostics (read-only field explorer) ----------
  NIU.DiagUI.init({
    ble,
    showToast,
    exportFile,
    getMeta: () => ({
      name: ble.device ? ble.device.name : null,
      bleVersion: 10,
      dashboardVersion: state.scooter.dashboardVersion || null,
    }),
  });

  // ---------- Setup: scooter keys ----------
  function setKeysStatus(text, kind) {
    keysStatus.textContent = text;
    keysStatus.className = 'keys-status' + (kind ? ` ${kind}` : '');
  }
  function refreshKeysStatus() {
    setKeysStatus(NIU.KeyStore.has() ? 'Keys saved on this device' : 'No keys saved', NIU.KeyStore.has() ? 'ok' : '');
  }
  el('saveKeysBtn').addEventListener('click', () => {
    try {
      const keys = NIU.KeyStore.parseKeys(keysInput.value);
      if (!NIU.KeyStore.save(keys)) {
        setKeysStatus('Could not save: this browser is blocking local storage (private window?).', 'err');
        return;
      }
      keysInput.value = '';               // don't leave the secrets sitting on screen
      refreshKeysStatus();
      showToast('Keys saved. Tap Connect on the Cockpit tab.');
    } catch (err) {
      setKeysStatus(err.message, 'err');  // messages never include key material
    }
  });
  el('clearKeysBtn').addEventListener('click', () => {
    NIU.KeyStore.clear();
    keysInput.value = '';
    refreshKeysStatus();
    showToast('Keys removed from this device.');
  });

  // ---------- Sparkline ----------
  function drawSparkline(canvas, points) {
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return; // no 2D context available (e.g. jsdom) — skip silently
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!points || points.length < 2) {
      ctx.strokeStyle = '#2b2e33';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
      return;
    }
    const speeds = points.map((p) => p.speedMPS || 0);
    const max = Math.max(...speeds, 0.1);
    ctx.strokeStyle = '#ffb020';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    speeds.forEach((s, i) => {
      const x = (i / (speeds.length - 1)) * w;
      const y = h - (s / max) * (h - 4) - 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // ---------- Rides list ----------
  el('exportAllBtn').addEventListener('click', () => {
    exportFile('niu-rides', 'csv', 'text/csv', NIU.Exporters.ridesSummaryCSV(state.rides), Date.now());
  });

  async function renderRidesList() {
    const rides = await store.getAllRides();
    state.rides = rides;
    updateRange();
    el('exportAllBtn').style.display = rides.length ? 'inline-block' : 'none';
    ridesList.innerHTML = '';
    emptyState.style.display = rides.length ? 'none' : 'block';

    for (const ride of rides) {
      const li = document.createElement('li');
      li.className = 'ride-row';
      const d = new Date(ride.startDate);
      li.innerHTML = `
        <div class="when">
          <span class="date">${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
          <span class="time">${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
        </div>
        <canvas class="spark" width="140" height="26"></canvas>
        <div class="metrics">
          <span class="dist">${metersToDisplayDistance(ride.distanceMeters).toFixed(2)} ${distanceUnitLabel()}</span>
          <span class="dur">${formatDuration(ride.activeRidingSeconds)}</span>
        </div>
        <button class="delete-btn" aria-label="Delete ride">Delete</button>
      `;
      drawSparkline(li.querySelector('canvas'), ride.points);
      li.addEventListener('click', (evt) => {
        if (evt.target.closest('.delete-btn')) return;
        openRideDetail(ride);
      });
      li.querySelector('.delete-btn').addEventListener('click', async (evt) => {
        evt.stopPropagation();
        await store.deleteRide(ride.id);
        renderRidesList();
      });
      ridesList.appendChild(li);
    }
  }

  // ---------- Ride detail (Leaflet map) ----------
  let detailMap = null;
  let detailRide = null;

  const toUnitDistance = (miles) => (state.unit === 'mph' ? miles : miles * 1.609344);
  const toUnitHeight = (meters) => (state.unit === 'mph' ? `${Math.round(meters * 3.28084)} ft` : `${Math.round(meters)} m`);

  /** Facts about one ride, built with textContent so recorded data can never inject markup. */
  function renderInsights(ride) {
    const s = NIU.Insights.rideStats(ride);
    const rows = [];
    if (ride.simulated) rows.push(['Note', 'Simulated ride (demo mode)']);
    if (s.movingSeconds || s.stoppedSeconds) rows.push(['Moving / stopped', `${formatDuration(s.movingSeconds)} / ${formatDuration(s.stoppedSeconds)}`]);
    if (s.avgMovingKph != null) rows.push(['Avg moving speed', `${Math.round(kphToDisplay(s.avgMovingKph))} ${state.unit}`]);
    if (s.scooterTopKph != null || s.gpsMaxKph != null) {
      const parts = [];
      if (s.scooterTopKph != null) parts.push(`scooter ${Math.round(kphToDisplay(s.scooterTopKph))}`);
      if (s.gpsMaxKph != null) parts.push(`GPS ${Math.round(kphToDisplay(s.gpsMaxKph))}`);
      rows.push(['Top speed', `${parts.join(' \u00b7 ')} ${state.unit}`]);
    }
    if (s.batteryUsedPct != null) rows.push(['Battery used', `${s.batteryUsedPct}% (${ride.startSOC}% \u2192 ${ride.endSOC}%)`]);
    if (s.milesPerPct != null) rows.push(['Efficiency', `${toUnitDistance(s.milesPerPct).toFixed(2)} ${distanceUnitLabel()} per 1%`]);
    if (s.elevation) rows.push(['Elevation', `\u2191 ${toUnitHeight(s.elevation.gainMeters)}  \u2193 ${toUnitHeight(s.elevation.lossMeters)}`]);
    const list = el('detailInsights');
    list.innerHTML = '';
    for (const [k, v] of rows) {
      const li = document.createElement('li');
      const a = document.createElement('span'); a.textContent = k;
      const b = document.createElement('span'); b.textContent = v;
      li.append(a, b);
      list.appendChild(li);
    }
  }
  el('legendBar').style.background = `linear-gradient(to right, ${NIU.Insights.SPEED_RAMP.join(', ')})`;

  el('exportGpxBtn').addEventListener('click', () => {
    if (detailRide) exportFile('niu-ride', 'gpx', 'application/gpx+xml', NIU.Exporters.toGPX(detailRide), detailRide.startDate);
  });
  el('exportCsvBtn').addEventListener('click', () => {
    if (detailRide) exportFile('niu-ride', 'csv', 'text/csv', NIU.Exporters.toRideCSV(detailRide), detailRide.startDate);
  });

  function openRideDetail(ride) {
    detailRide = ride;
    renderInsights(ride);
    el('rideDetail').classList.add('active');
    el('detailDate').textContent = new Date(ride.startDate).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    el('detailDist').textContent = `${metersToDisplayDistance(ride.distanceMeters).toFixed(2)} ${distanceUnitLabel()}`;
    el('detailAvg').textContent = Math.round(kphToDisplay(ride.averageSpeedKPH));
    el('detailTop').textContent = Math.round(kphToDisplay(ride.topSpeedKPH));
    el('detailTime').textContent = formatDuration(ride.activeRidingSeconds);

    if (detailMap) { detailMap.remove(); detailMap = null; }
    detailMap = L.map('rideDetailMap', { zoomControl: false, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(detailMap);

    if (ride.points && ride.points.length > 1) {
      const latlngs = ride.points.map((p) => [p.lat, p.lon]);
      // Colour each stretch of the route by speed (relative to the scooter's own top speed).
      const route = NIU.Insights.colouredRoute(ride.points, state.scooter.maxSpeedKPH || 30);
      if (route.length) {
        for (const seg of route) L.polyline(seg.latlngs, { color: seg.color, weight: 5, opacity: 0.95 }).addTo(detailMap);
      } else {
        L.polyline(latlngs, { color: '#ffb020', weight: 5 }).addTo(detailMap);
      }
      L.circleMarker(latlngs[0], { radius: 6, color: '#ffb020', fillOpacity: 1 }).addTo(detailMap);
      L.circleMarker(latlngs[latlngs.length - 1], { radius: 6, color: '#ff4438', fillOpacity: 1 }).addTo(detailMap);
      detailMap.fitBounds(L.latLngBounds(latlngs), { padding: [30, 30] });
    } else {
      detailMap.setView([33.77, -118.19], 12); // fallback view if no GPS track was captured
    }
  }
  el('closeDetailBtn').addEventListener('click', () => {
    el('rideDetail').classList.remove('active');
  });

  // ---------- Screen Wake Lock (best-effort; keeps the screen on while riding) ----------
  let wakeLock = null;
  async function requestWakeLock() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); }
    catch { /* non-fatal — some WebKit versions may not support this */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.isRiding) requestWakeLock();
  });

  // ---------- Boot ----------
  initGauge();
  refreshUnitLabels();
  renderCellStrip(0);
  refreshKeysStatus();
  // Pick up where the last session left off so the 10-minute heartbeat rule spans app restarts.
  if (battery) battery.last().then((s) => { if (!state.lastBatterySample) state.lastBatterySample = s; }).catch(() => {});

  if (!ble.isSupported) {
    dot.className = 'dot unsupported';
    statusLabel.textContent = 'Web Bluetooth unavailable — use Bluefy on iOS';
    connectBtn.textContent = 'Bluetooth unsupported in this browser';
    connectBtn.disabled = true;
  }
  renderRidesList();
})();
