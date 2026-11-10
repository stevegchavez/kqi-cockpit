# KQi Cockpit for Apple Watch

A standalone watchOS app that talks to the scooter **directly from the watch**: no iPhone app
needed while riding. Built for an Apple Watch Ultra 2 (watchOS 10 or later).

- **Speed dial** with the same green → yellow → red efficiency zones as the web app, battery %,
  and a haptic tap when the scooter connects or drops.
- **Rides** are recorded as an outdoor **cycling workout**: that keeps the app running with your
  wrist down (so the scooter stays connected), records the GPS route and heart rate, and saves the
  ride to Apple Health. The page shows time, distance, the scooter's top speed and heart rate.
- **Settings**: your scooter keys (kept in the watch's Keychain, this device only), miles or km,
  and what the scooter reports (health, charge cycles, firmware).
- **Read-only**: like the web app with Lock & alarm off, it only sends the handshake and read
  requests. No lock button yet.

Things to know:
- The scooter accepts **one Bluetooth connection at a time**. While the watch is connected, the
  web app in Bluefy (and the NIU app) can't be. Close them before connecting from the watch.
- **Not yet built or run on a real watch.** The protocol code (`KQiCore`) has tests you run on
  your Mac (step 2) that check it byte-for-byte against the same reference data as the web app.
  The watch screens and Bluetooth code could only be written, not compiled, where they were made,
  so the first build may show a few errors to fix.

## What you need

- Your Mac with **Xcode** (free, Mac App Store; Xcode 26 for watchOS 26).
- Your iPhone, paired with the watch, plugged into the Mac with a cable for the first install.
- An Apple ID. With a free Apple ID the app has to be reinstalled from Xcode every **7 days**;
  with the paid Apple Developer Program ($99/year) it stays installed.

## 1. Get the code

In Terminal:

```sh
git clone https://github.com/stevegchavez/kqi-cockpit
cd kqi-cockpit/watch
```

(If you already have the folder: `cd kqi-cockpit && git pull`, then `cd watch`.)

## 2. Run the protocol tests (one command)

```sh
cd KQiCore
swift test
```

You want to see `Executed 13 tests, with 0 failures`. If it says `xcrun: error` or can't find
XCTest, run `sudo xcode-select -s /Applications/Xcode.app` once, then `swift test` again.
If any test fails, send me the output and stop here.

## 3. Create the watch app project in Xcode

1. Xcode → **Settings → Accounts** → **+** → Apple ID → sign in (once).
2. **File → New → Project…** → **watchOS** tab → **App** → Next.
3. Product Name: `KQi Watch`. Team: your name. Organization Identifier: something like
   `com.yourname` (any reverse-domain name; it doesn't have to exist). Watch-only App (not
   "with companion iOS app"). Interface **SwiftUI**, Language **Swift**. Next.
4. Save it inside the `kqi-cockpit/watch` folder.
5. In the left sidebar, open the **KQi Watch Watch App** folder and **delete** the two files Xcode
   made (`ContentView.swift` and `KQi_WatchApp.swift`) → Move to Trash.
6. In Finder, open `kqi-cockpit/watch/KQiWatch` and **drag all 7 `.swift` files** onto that same
   folder in Xcode's sidebar. In the dialog: leave "Copy items" **off**, tick the
   **KQi Watch Watch App** target → Finish.
7. **File → Add Package Dependencies… → Add Local…** → choose the `kqi-cockpit/watch/KQiCore`
   folder → Add Package → make sure **KQiCore** is added to **KQi Watch Watch App** → Add Package.

## 4. Permissions and capabilities

Click the blue project icon at the top of the sidebar → select the **KQi Watch Watch App** target.

**Signing & Capabilities** tab → **+ Capability**:
- **HealthKit**
- **Background Modes** → tick **Workout processing**

**Info** tab → hover a row → **+** to add each of these (type the name, it autocompletes),
with any short explanation as the value:

| Key | Value (suggestion) |
| --- | --- |
| Privacy - Bluetooth Always Usage Description | Connects to your NIU scooter to show its speed and battery. |
| Privacy - Health Share Usage Description | Shows your heart rate during rides. |
| Privacy - Health Update Usage Description | Saves your scooter rides as cycling workouts. |
| Privacy - Location When In Use Usage Description | Records the route and distance of your rides. |

## 5. Put it on the watch

1. Plug the iPhone into the Mac. On the watch: **Settings → Privacy & Security → Developer Mode**
   → on (the watch restarts). If the option isn't there yet, do step 2 first and it appears.
2. In Xcode's toolbar, click the device selector next to the play button and pick
   **your Apple Watch** (it can take a minute to appear; Xcode may "prepare" the watch first).
3. Press **▶ Run**. The first build takes a while.
4. If the watch says the developer isn't trusted: on the iPhone, **Settings → General → VPN &
   Device Management** → your Apple ID → Trust.

If the build fails, click the red error in Xcode's left sidebar (the ⚠️ tab), copy the
messages, and send them to me.

## 6. First use

1. Open **KQi Watch** on the watch. Swipe up twice (or turn the Digital Crown) to **Settings**.
2. Tap **Bluetooth password**. Your iPhone shows an **Apple Watch Keyboard** notification: tap it
   and paste the password there (same keys as the web app's Setup tab, from `scooter.json`).
   Do the same for **AES key**. Or paste the whole `scooter.json` into the first field and leave the
   second empty. Tap **Save keys**.
3. Turn the scooter on, **close Bluefy and the NIU app**, and swipe back to the dial. It connects
   on its own (or tap Connect). The watch taps your wrist when it's connected.
4. To record a ride: swipe to the ride page → **START RIDE**. Allow Health and Location the first
   time. **FINISH RIDE** saves it to Apple Health (Fitness app → workouts).

## Files

```
KQiCore/                 Swift package: protocol, crypto, session, keys, dial zones (+ tests)
KQiWatch/                The watch app's code: add these to the Xcode target
  KQiWatchApp.swift      Entry point: dial / ride / settings pages
  ScooterLink.swift      Core Bluetooth: find, connect, authenticate, poll once a second
  RideRecorder.swift     Rides as cycling workouts (HealthKit) with GPS route
  KeyVault.swift         Keychain storage for the scooter keys
  DashboardView.swift    Speed dial, battery, connection
  RideView.swift         Start / finish ride and ride stats
  SettingsView.swift     Keys, units, scooter info
```
