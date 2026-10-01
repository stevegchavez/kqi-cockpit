/**
 * diag-ui.js — NIU Companion Web Dashboard
 *
 * The Diagnostics screen: scan every field the scooter answers, take snapshots and
 * compare them, watch values change live, and export a redacted report.
 *
 * READ-ONLY, and everything it shows came from the scooter, so it is rendered with
 * textContent only (never innerHTML): a hostile or odd value cannot inject markup.
 * The on-screen view hides identifiers (serials, MAC addresses, ...) until the
 * "show identifiers" box is ticked; exports always remove them regardless.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./diagnostics.js'), require('./fields.js'));
  } else {
    root.NIU = root.NIU || {};
    root.NIU.DiagUI = factory(root.NIU.Diagnostics, root.NIU.Fields);
  }
})(typeof self !== 'undefined' ? self : this, function (D, Fields) {
  const MAX_WATCH_CHANGES = 500;
  const MAX_PUSHES = 200;
  const SHOWN_CHANGES = 100;
  const WATCH_INTERVAL_MS = 800;

  /**
   * @param {{ble: object, showToast: Function, exportFile: Function, getMeta?: Function, doc?: Document}} deps
   */
  function init(deps) {
    const { ble, showToast, exportFile } = deps;
    const doc = deps.doc || document;
    const $ = (id) => doc.getElementById(id);
    const table = Fields.FIELDS;

    const st = {
      results: null,                 // latest scan: name -> {status, ...}
      snaps: { A: null, B: null },
      compare: [],                   // [{label, changes}]
      watchChanges: [],
      pushes: [],
      scanning: false,
      cancel: false,
      watcher: null,
      busy: false,                   // a snapshot is being taken
    };

    const connected = () => ble.state === 'connected';
    const answeredNames = () => (st.results ? Object.keys(st.results).filter((n) => st.results[n].status === 'ok') : []);
    const reveal = () => $('revealCheck').checked;
    const setStatus = (t) => { $('diagStatus').textContent = t; };

    // ------------------------------------------------------------ formatting
    function fmtValue(name, entry) {
      if (D.isPrivate(name) && !reveal()) return '••• hidden';
      const v = entry.value;
      // Quote text so stray spaces and odd characters are visible; hex is shown as-is.
      const s = typeof v === 'string' && table[name].type !== 'HEX' ? JSON.stringify(v) : String(v);
      return s.length > 48 ? `${s.slice(0, 47)}…` : s;
    }
    function fmtRaw(name, entry) {
      if (D.isPrivate(name) && !reveal()) return '';
      return entry.raw.length > 24 ? `${entry.raw.slice(0, 24)}…` : entry.raw;
    }
    const bitsText = (c) => {
      const parts = [];
      if (c.bitsSet && c.bitsSet.length) parts.push(`+${c.bitsSet.join(' +')}`);
      if (c.bitsCleared && c.bitsCleared.length) parts.push(`−${c.bitsCleared.join(' −')}`);
      return parts.join('  ');
    };
    function describe(c) {
      if (c.kind === 'push') return `pushed: ${Object.entries(c.fields || {}).map(([k, v]) => `${k}=${D.isPrivate(k) && !reveal() ? '•••' : v}`).join(', ') || c.error || '(undecoded)'}`;
      if (c.kind === 'added') return `answered now: ${fmtValue(c.name, c.to)}`;
      if (c.kind === 'removed') return `no longer answers (was ${fmtValue(c.name, c.from)})`;
      const bits = bitsText(c);
      return `${fmtValue(c.name, c.from)} → ${fmtValue(c.name, c.to)}${bits ? `   bits ${bits}` : ''}`;
    }

    // ------------------------------------------------------------ rendering
    function row(cls, ...cells) {
      const div = doc.createElement('div');
      div.className = `diag-row ${cls}`;
      for (const [text, c] of cells) {
        const s = doc.createElement('span');
        s.className = c;
        s.textContent = text;
        div.appendChild(s);
      }
      return div;
    }

    function renderSummary() {
      const box = $('diagSummary');
      if (!st.results) { box.textContent = 'No scan yet.'; return; }
      const c = { ok: 0, refused: 0, skipped: 0, error: 0, timeout: 0, 'not-run': 0 };
      for (const r of Object.values(st.results)) c[r.status]++;
      const parts = [`${c.ok} answered`, `${c.refused} refused`, `${c.skipped} skipped (never read)`];
      if (c.error) parts.push(`${c.error} malformed`);
      if (c.timeout) parts.push(`${c.timeout} timed out`);
      if (c['not-run']) parts.push(`${c['not-run']} not run`);
      box.textContent = parts.join(' · ');
    }

    function renderResults() {
      const box = $('diagResults');
      box.textContent = '';
      if (!st.results) return;
      const filter = $('diagFilter').value.trim().toLowerCase();
      const answeredOnly = $('answeredOnlyCheck').checked;
      const names = Object.keys(st.results).sort((a, b) => (table[a].code < table[b].code ? -1 : 1));
      const frag = doc.createDocumentFragment();
      let shown = 0;
      for (const name of names) {
        const r = st.results[name];
        if (answeredOnly && r.status !== 'ok') continue;
        if (filter && !name.includes(filter)) continue;
        shown++;
        const spec = table[name];
        if (r.status === 'ok') frag.appendChild(row('ok', [name, 'n'], [fmtValue(name, r), 'v'], [fmtRaw(name, r), 'r']));
        else {
          const why = r.status === 'refused' ? `refused (${r.code})` : r.status === 'skipped' ? `skipped: ${r.reason}` : r.status === 'error' ? r.message : r.status;
          frag.appendChild(row('no', [name, 'n'], [why, 'v'], [`${spec.type}/${spec.len}`, 'r']));
        }
      }
      if (!shown) frag.appendChild(row('empty', [answeredOnly && !filter ? 'Nothing answered yet.' : 'No fields match.', 'n']));
      box.appendChild(frag);
    }

    function renderChanges() {
      const box = $('diagChanges');
      box.textContent = '';
      const items = [];
      for (const cmp of st.compare) {
        items.push(row('head', [cmp.label, 'n']));
        if (!cmp.changes.length) items.push(row('empty', ['No differences between the two snapshots.', 'n']));
        for (const c of cmp.changes) items.push(row('chg', [c.name, 'n'], [describe(c), 'v']));
      }
      const live = [
        ...st.watchChanges.map((c) => ({ t: c.t, name: c.name, text: describe(c) })),
        ...st.pushes.map((p) => ({ t: p.t, name: `push ${p.header}`, text: describe({ kind: 'push', fields: p.fields, error: p.error }) })),
      ].sort((a, b) => b.t - a.t).slice(0, SHOWN_CHANGES);
      if (live.length) items.push(row('head', ['Live changes (newest first)', 'n']));
      for (const l of live) {
        const time = new Date(l.t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
        items.push(row('chg', [`${time} ${l.name}`, 'n'], [l.text, 'v']));
      }
      if (!items.length) items.push(row('empty', ['Nothing to show yet.', 'n']));
      const frag = doc.createDocumentFragment();
      items.forEach((i) => frag.appendChild(i));
      box.appendChild(frag);
    }

    function refreshButtons() {
      const can = connected();
      const idle = !st.scanning && !st.watcher && !st.busy;
      const have = answeredNames().length > 0;
      $('scanBtn').disabled = !(can && idle);
      $('cancelScanBtn').style.display = st.scanning ? 'inline-block' : 'none';
      $('snapABtn').disabled = !(can && idle && have);
      $('snapBBtn').disabled = !(can && idle && have);
      $('compareBtn').disabled = !(st.snaps.A && st.snaps.B);
      $('watchBtn').disabled = !(can && have && !st.scanning && !st.busy);
      $('watchBtn').textContent = st.watcher ? 'Stop watching' : 'Start watching';
      $('exportDiagBtn').disabled = !st.results;
      $('previewDiagBtn').disabled = !st.results;
      $('snapABtn').textContent = st.snaps.A ? 'Re-take snapshot A' : 'Snapshot A';
      $('snapBBtn').textContent = st.snaps.B ? 'Re-take snapshot B' : 'Snapshot B';
    }
    const renderAll = () => { renderSummary(); renderResults(); renderChanges(); refreshButtons(); };

    // ------------------------------------------------------------ actions
    function needConnection() {
      if (connected()) return true;
      showToast('Connect to your scooter on the Cockpit tab first.');
      return false;
    }

    async function runScan() {
      if (!needConnection() || st.scanning) return;
      st.scanning = true;
      st.cancel = false;
      $('scanProgress').value = 0;
      setStatus('Scanning… reading each field once, a few at a time.');
      refreshButtons();
      try {
        const r = await ble.withPollingPaused((session) => D.scan(session, {
          isCancelled: () => st.cancel,
          onProgress: (p) => {
            $('scanProgress').value = p.done / p.total;
            setStatus(`Scanning… ${p.done} of ${p.total} requests.`);
          },
        }));
        st.results = r.results;
        st.snaps = { A: null, B: null };            // a new scan makes old snapshots incomparable
        st.compare = [];
        setStatus(r.aborted === 'cancelled' ? 'Scan cancelled. Showing what was read so far.'
          : r.aborted === 'link-lost' ? 'Lost contact with the scooter. Showing what was read so far.'
          : 'Scan complete.');
      } catch (err) {
        setStatus(`Scan failed: ${err.message}`);
        showToast(err.message);
      } finally {
        st.scanning = false;
        $('scanProgress').value = 1;
        renderAll();
      }
    }

    async function takeSnapshot(label) {
      if (!needConnection() || st.busy) return;
      const names = answeredNames();
      if (!names.length) { showToast('Run a full scan first.'); return; }
      st.busy = true;
      refreshButtons();
      setStatus(`Taking snapshot ${label}…`);
      try {
        const r = await ble.withPollingPaused((session) => D.scan(session, { names, spacingMs: 20 }));
        if (r.aborted) throw new Error('Lost contact with the scooter.');
        st.snaps[label] = D.snapshot(r.results, Date.now());
        st.compare = [];
        setStatus(`Snapshot ${label} taken (${Object.keys(st.snaps[label].fields).length} fields). Now do something on the scooter, take the other snapshot, then Compare.`);
      } catch (err) {
        setStatus(`Snapshot failed: ${err.message}`);
        showToast(err.message);
      } finally {
        st.busy = false;
        renderAll();
      }
    }

    function compare() {
      if (!st.snaps.A || !st.snaps.B) return;
      st.compare = [{ label: 'Snapshot A → B', changes: D.diffSnapshots(st.snaps.A, st.snaps.B, table) }];
      setStatus(`Compared: ${st.compare[0].changes.length} field${st.compare[0].changes.length === 1 ? '' : 's'} differ.`);
      renderAll();
    }

    async function toggleWatch() {
      if (st.watcher) { st.watcher.stop(); return; }
      if (!needConnection()) return;
      const names = answeredNames();
      if (!names.length) { showToast('Run a full scan first.'); return; }
      setStatus('Watching… press, toggle or ride something, and changes appear below.');
      try {
        await ble.withPollingPaused(async (session) => {
          st.watcher = new D.Watcher({
            session, names, table,
            onChange: (c) => { st.watchChanges.push(c); if (st.watchChanges.length > MAX_WATCH_CHANGES) st.watchChanges.shift(); renderChanges(); },
            onPush: (ps) => { st.pushes.push(...ps); if (st.pushes.length > MAX_PUSHES) st.pushes.splice(0, st.pushes.length - MAX_PUSHES); renderChanges(); },
            onNoisy: (n) => setStatus(`${n} changes constantly, so it is muted. Watching the rest…`),
            onError: (err) => { setStatus(`Stopped watching: ${err.message}`); showToast('Lost contact with the scooter.'); },
          });
          refreshButtons();
          await st.watcher.run(WATCH_INTERVAL_MS);
        });
      } catch (err) {
        setStatus(`Could not watch: ${err.message}`);
      } finally {
        st.watcher = null;
        refreshButtons();
        if (/^Watching/.test($('diagStatus').textContent)) setStatus('Stopped watching.');
      }
    }

    function currentReport() {
      const m = deps.getMeta ? deps.getMeta() : {};
      return D.buildReport({
        meta: { scooter: m },
        results: st.results || {},
        comparisons: st.compare,
        watchChanges: st.watchChanges,
        pushes: st.pushes,
        note: $('diagNote').value,
      });
    }

    // ------------------------------------------------------------ wiring
    $('openDiagBtn').addEventListener('click', () => {
      $('diagScreen').classList.add('active');
      setStatus(connected() ? (st.results ? 'Ready.' : 'Ready. Start with a full scan.') : 'Not connected. Connect on the Cockpit tab first.');
      renderAll();
    });
    $('closeDiagBtn').addEventListener('click', () => {
      if (st.watcher) st.watcher.stop();
      st.cancel = true;
      $('diagScreen').classList.remove('active');
    });
    $('scanBtn').addEventListener('click', runScan);
    $('cancelScanBtn').addEventListener('click', () => { st.cancel = true; setStatus('Cancelling after the current request…'); });
    $('snapABtn').addEventListener('click', () => takeSnapshot('A'));
    $('snapBBtn').addEventListener('click', () => takeSnapshot('B'));
    $('compareBtn').addEventListener('click', compare);
    $('watchBtn').addEventListener('click', toggleWatch);
    $('revealCheck').addEventListener('change', renderAll);
    $('answeredOnlyCheck').addEventListener('change', renderResults);
    $('diagFilter').addEventListener('input', renderResults);
    $('previewDiagBtn').addEventListener('click', () => {
      const box = $('diagPreview');
      if (box.style.display === 'block') { box.style.display = 'none'; return; }
      box.value = D.reportText(currentReport());
      box.style.display = 'block';
    });
    $('exportDiagBtn').addEventListener('click', () => {
      exportFile('niu-diagnostics', 'json', 'application/json', D.reportText(currentReport()), Date.now());
    });
    ble.addEventListener('disconnected', () => {
      if (st.watcher) st.watcher.stop();
      st.cancel = true;
      setStatus('Disconnected from the scooter.');
      refreshButtons();
    });
    ble.addEventListener('connected', refreshButtons);
    renderAll();

    return { state: st, runScan, takeSnapshot, compare, toggleWatch, currentReport };
  }

  return { init };
});
