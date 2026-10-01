# Vendored Leaflet 1.9.4

Self-hosted copy of Leaflet 1.9.4 (BSD-2-Clause, see `LICENSE`), taken unmodified from the
official npm tarball `leaflet@1.9.4` so the page runs no third-party script from a CDN.

This matters because the app stores the scooter's Bluetooth keys in this origin's
localStorage; any script loaded from another host into the page could read them.

SHA-256 of the files as vendored:

```
db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a  leaflet.js
a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6  leaflet.css
```

To verify: `npm pack leaflet@1.9.4`, extract, and compare `dist/leaflet.js` / `dist/leaflet.css`.
