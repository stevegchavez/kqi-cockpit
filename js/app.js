/**
 * app.js — NIU Companion Web Dashboard
 *
 * Wires BLEManager + GeoTracker + RideStore to the DOM, and drives the
 * instrument-cluster visuals: the radial speed gauge, battery cell strip,
 * rocker switches, ignition power-on sweep, and per-ride sparklines.
 */
(function () {
  const ble = new NIU.BLEManager();
  const geo = new NIU.GeoTracker();
  const store = new NIU.RideStore();

  // Cosmetic scale for the gauge only — does not gate or validate real
  // telemetry. KQi 200F's top speed is roughly this ballpark; adjust freely.
  const GAUGE_MAX_KPH = 32;
  const GAUGE_START_ANGLE = -130; // degrees, 0 = 12 o'clock, clockwise positive
  const GAUGE_END_ANGLE = 130;
  const GAUGE_REDLINE_PCT = 0.85;
  const CELL_COUNT = 10;

  const state = {
    unit: localStorage.getItem('niu.unit') || 'mph', // display preference only, not ride data
    scooter: { speedKPH: 0, batterySOC: 0, odometerMeters: 0, faultFlags: 0, headlightOn: false, motorLocked: false },
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
  const headlightBtn = el('headlightBtn');
  const lockBtn = el('lockBtn');
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
    return ['M', start.x, start.y, 'A', r, r, 0, largeArcFlag, 0, end.x, end.y].join(' ');
  }

  const GAUGE_CX = 100, GAUGE_CY = 100, GAUGE_R = 86;
  let gaugeArcLength = 0;

  function initGauge() {
    const d = describeArc(GAUGE_CX, GAUGE_CY, GAUGE_R, GAUGE_START_ANGLE, GAUGE_END_ANGLE);
    gaugeTrack.setAttribute('d', d);
    gaugeValue.setAttribute('d', d);
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
    gaugeValue.classList.toggle('redline', pct >= GAUGE_REDLINE_PCT);
  }

  /** Plays a brief 0→max→actual sweep, like a car dash powering on. */
  function playIgnitionSequence() {
    gaugeValue.classList.add('igniting');
    setGaugePercent(1);
    setTimeout(() => {
      setGaugePercent(state.scooter.speedKPH / GAUGE_MAX_KPH);
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
    statusLabel.textContent = e.detail.name || 'Scooter connected';
    playIgnitionSequence();
  });

  ble.addEventListener('telemetry', (e) => applyTelemetry(e.detail));

  connectBtn.addEventListener('click', async () => {
    try { await ble.connect(); }
    catch (err) { showToast(err.message); }
  });

  function applyTelemetry(t) {
    Object.assign(state.scooter, t);
    if (t.speedKPH !== undefined) {
      speedValue.textContent = Math.round(kphToDisplay(t.speedKPH));
      setGaugePercent(t.speedKPH / GAUGE_MAX_KPH);
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
    if (t.headlightOn !== undefined) {
      headlightBtn.dataset.active = String(t.headlightOn);
      headlightBtn.querySelector('.switch').setAttribute('aria-checked', String(t.headlightOn));
    }
    if (t.motorLocked !== undefined) {
      lockBtn.dataset.active = String(t.motorLocked);
      lockBtn.querySelector('.switch').setAttribute('aria-checked', String(t.motorLocked));
    }
  }

  // ---------- Unit toggle ----------
  function refreshUnitLabels() {
    speedUnit.textContent = state.unit.toUpperCase();
    unitToggle.textContent = state.unit === 'mph' ? 'KM/H' : 'MPH';
    el('tripDistLabel').textContent = `Trip ${distanceUnitLabel()}`;
    el('tripTopLabel').textContent = `Top ${state.unit}`;
  }
  unitToggle.addEventListener('click', () => {
    state.unit = state.unit === 'mph' ? 'kph' : 'mph';
    localStorage.setItem('niu.unit', state.unit);
    refreshUnitLabels();
    speedValue.textContent = Math.round(kphToDisplay(state.scooter.speedKPH));
  });

  // ---------- Hardware controls ----------
  function flashToggle(rocker) {
    rocker.dataset.justToggled = 'true';
    setTimeout(() => { rocker.dataset.justToggled = 'false'; }, 260);
  }
  headlightBtn.addEventListener('click', async () => {
    flashToggle(headlightBtn);
    try { await ble.setHeadlight(!state.scooter.headlightOn); }
    catch (err) { showToast(err.message); }
  });
  lockBtn.addEventListener('click', async () => {
    flashToggle(lockBtn);
    try { await ble.setMotorLock(!state.scooter.motorLocked); }
    catch (err) { showToast(err.message); }
  });

  // ---------- Ride lifecycle ----------
  rideBtn.addEventListener('click', () => { state.isRiding ? finishRide() : startRide(); });

  function startRide() {
    state.isRiding = true;
    state.rideStart = Date.now();
    state.topSpeedKPH = 0;
    state.speedSamples = [];
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
      applyTelemetry({ speedKPH, batterySOC: Math.max(0, 78 - Math.floor(t / 4)), faultFlags: 0 });
    }, 400);
  });

  // ---------- Tab navigation ----------
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
      btn.classList.add('active');
      el(btn.dataset.target).classList.add('active');
      if (btn.dataset.target === 'ridesScreen') renderRidesList();
    });
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
  async function renderRidesList() {
    const rides = await store.getAllRides();
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
  function openRideDetail(ride) {
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
      const polyline = L.polyline(latlngs, { color: '#ffb020', weight: 5 }).addTo(detailMap);
      L.circleMarker(latlngs[0], { radius: 6, color: '#ffb020', fillOpacity: 1 }).addTo(detailMap);
      L.circleMarker(latlngs[latlngs.length - 1], { radius: 6, color: '#ff4438', fillOpacity: 1 }).addTo(detailMap);
      detailMap.fitBounds(polyline.getBounds(), { padding: [30, 30] });
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

  if (!ble.isSupported) {
    dot.className = 'dot unsupported';
    statusLabel.textContent = 'Web Bluetooth unavailable — use Bluefy on iOS';
    connectBtn.textContent = 'Bluetooth unsupported in this browser';
    connectBtn.disabled = true;
  }
  renderRidesList();
})();
