# NIU Companion — KQi Cockpit (Web Dashboard)

A privacy-first Web Bluetooth dashboard for the NIU KQi 200F. Runs in any
Web Bluetooth capable browser — **Bluefy on iOS**, Chrome on desktop/Android
— no native build, no App Store, no NIU account.

This is the same app as the earlier Swift/SwiftUI version, reimplemented as
a static site so it can be tested and hosted without Xcode or a Mac.

## Status: what's actually verified vs. what needs your scooter

Everything in `js/protocol.js` (frame parsing/encoding) and `js/geo.js`
(distance math) is covered by a real, passing test suite — see below. The
DOM wiring (every button, every element ID `app.js` touches) is also
smoke-tested against the real `index.html` via jsdom. **None of that
requires a scooter or a browser.**

What is *not* verified, and can't be from this environment: whether the
GATT UUIDs and byte offsets actually match your physical KQi 200F. See
"Calibrating the protocol" below — same caveat as the native app, carried
over unchanged.

## Running the tests

```bash
npm install
npm test
```

22 tests across three suites:
- `test/protocol.test.js` — frame encode/decode, checksum rejection, malformed-input handling
- `test/geo.test.js` — haversine distance math against known coordinates
- `test/dom-wiring.test.js` — boots the real `index.html` + `js/*.js` in jsdom, clicks buttons, asserts no missing element IDs or thrown errors

## Running it for real

Web Bluetooth requires a **secure context** (HTTPS, or `localhost`) — it
will not work opened directly from a `file://` path. Two easy options:

**Option A — GitHub Pages (recommended, free, permanent HTTPS):**
```bash
git init && git add . && git commit -m "NIU Companion web dashboard"
git remote add origin <your-repo-url>
git push -u origin main
# then enable GitHub Pages on the repo, serving from the root of main
```
Open the resulting `https://<you>.github.io/<repo>/` URL in Bluefy.

**Option B — local testing over your LAN:**
```bash
npm run serve   # python3 -m http.server 8080
```
Bluefy still needs HTTPS for Web Bluetooth in most versions — a plain
`http://` LAN address may not work. If it doesn't, tunnel it through
something like `ngrok http 8080` for a temporary HTTPS URL, or just deploy
to GitHub Pages, which is simpler for repeated testing.

### Using it in Bluefy
1. Open the hosted HTTPS URL in Bluefy.
2. Tap **Connect to Scooter** (must be a direct tap — Web Bluetooth refuses
   to open the device picker without a user gesture).
3. Optionally tap **Add to Home Screen** from Bluefy's share sheet for an
   app-like icon (uses `manifest.json`).

### No scooter handy?
Tap **Simulate Telemetry** on the Cockpit screen — it feeds fake speed/
battery data through the exact same `applyTelemetry()` path real BLE
notifications use, so you can exercise the whole UI (including starting/
finishing a ride) before ever pairing hardware.

## Visual design

The cockpit is built around a real instrument-cluster metaphor rather than
a generic dashboard: a radial speed gauge with tick marks and a glowing
amber sweep (not a naked number), a segmented battery cell-strip (like a
physical pack indicator, not a progress bar), rocker switches for
headlight/lock, and a hairline-divided instrument strip for trip stats
instead of boxed cards. Palette is asphalt-at-night (`#0A0B0D`) with one
dominant amber accent (`#FFB020`, headlight-glow) plus a cyan used only for
the connection dot and a red reserved for alerts/lock/finish — not
decoration, each color maps to one meaning. Type is Big Shoulders Display
(condensed industrial numerals) paired with Space Grotesk.

Screenshots in `screenshots/` were captured with a headless-Chrome render
during development — `cockpit-lit.png` shows the gauge and battery strip
actively lit via the built-in demo mode, `cockpit-idle.png` shows the
disconnected state, `cockpit-compact.png` confirms the layout fits an
iPhone SE-height screen without clipping, and `rides.png` shows a saved
ride. Google Fonts couldn't load in that sandboxed render environment (no
external network access there), so those screenshots show the CSS/layout
accurately but the system fallback font instead of Big Shoulders Display /
Space Grotesk — both will load normally once hosted for real, since
`fonts.googleapis.com` isn't blocked on an actual device/browser.

## ⚠️ Two limitations that are different from the native app

**1. No true background trip logging.** The original spec called for GPS
recording to continue while the phone is locked in a pocket. That's a
CoreLocation background mode — there is no web equivalent. WebKit suspends
`watchPosition` callbacks, timers, and the BLE connection itself once
Bluefy is backgrounded or the screen locks. This dashboard:
- Requests a [Screen Wake Lock](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API)
  when you start a ride, best-effort, to keep the screen on and the tab
  foregrounded while riding (supported in recent WebKit; not guaranteed on
  every Bluefy build).
- Will simply stop accumulating route points if the screen does lock —
  it won't crash or silently corrupt data, but the recorded track will
  have a gap.

If uninterrupted background logging is a hard requirement, that's the one
capability that genuinely needs the native iOS app (CoreLocation +
`allowsBackgroundLocationUpdates`), not a web page — no framework or PWA
trick on iOS can get around WebKit's background execution suspension.

**2. No persistent device pairing across page loads.** CoreBluetooth can
silently reconnect to a previously-bound peripheral by UUID. Web
Bluetooth's `requestDevice()` must be triggered by a fresh user gesture
after a full page reload — there's no "remember and auto-reconnect on
launch" the way the native app does. Within a single page session (as long
as the tab stays open), `BLEManager.reconnect()` will retry the same
device without showing the picker again if the connection drops.

## Project structure

```
index.html            Single-page shell: Cockpit + Rides screens, tab bar, ride-detail overlay
manifest.json          PWA manifest (add-to-home-screen)
css/style.css           OLED dark theme, matches the native app's design language
js/
  constants.js          BLE UUIDs + protocol constants (kept in sync with BLEConstants.swift)
  protocol.js            Pure frame encode/decode — zero DOM/BLE dependencies, fully unit-testable
  ble.js                  navigator.bluetooth wrapper: connect, subscribe, write commands
  storage.js               IndexedDB-backed ride history (on-device only, no network calls)
  geo.js                    Foreground GPS trip recording via watchPosition + haversine distance
  app.js                     Wires everything to the DOM
test/
  protocol.test.js       Node tests for js/protocol.js
  geo.test.js              Node tests for js/geo.js
  dom-wiring.test.js        jsdom smoke test for index.html + all of js/*.js together
```

## ⚠️ Calibrating the BLE protocol against your real scooter

Unchanged from the native app's caveat: NIU has never published a spec for
this GATT protocol. The three UUIDs in `js/constants.js` match the vendor
service pattern reported by the community for KQi/M-series scooters, but
the byte-level frame layout in `js/protocol.js` (offsets for speed, SOC,
odometer, fault flags, command IDs) is a placeholder scaffold — the shape
of the protocol, not confirmed values.

Before trusting it for real rides:
1. Use [nRF Connect](https://apps.apple.com/app/nrf-connect-for-mobile/id1054362403)
   (or a BLE sniffer) to capture live notify traffic from the official NIU
   app talking to your scooter.
2. Compare captured payloads on `8EC94E31-...` against known scooter state
   (e.g. the exact battery % shown in the NIU app) to confirm/correct the
   offsets parsed in `js/protocol.js`'s `parseTelemetry()`.
3. Do the same for outgoing writes to `8EC94E32-...` when toggling
   headlight/lock in the official app, to confirm the command IDs.
4. Update `js/protocol.js` — the tests in `test/protocol.test.js` will
   immediately tell you if a change breaks the existing parsing logic;
   add new test cases alongside any offset changes.

## Privacy posture

- No accounts, no NIU cloud, no login screen.
- No third-party analytics or crash reporters.
- Ride history lives in IndexedDB, entirely on-device; nothing leaves the
  browser unless you build an explicit export feature yourself.
- The only external network requests this page makes are the Leaflet
  library/CSS from cdnjs and OpenStreetMap map tiles when viewing a ride's
  route — both only fire when you open a ride's detail view, and neither
  ever receives your ride data (only the map viewport bounding box, same
  as any map you'd scroll around on OpenStreetMap.org).
