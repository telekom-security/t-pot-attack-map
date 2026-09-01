# WP0 — Baseline and behaviour inventory (3.0.1, commit `e798fcb`)

Temporary document. Created in WP0, consumed by WP1 (screenshots), WP6 (parity review) and
WP8 (visual verification); deleted in WP10 after sign-off (HANDOFF-v2 §11 WP0, §24 item 11).

All line numbers verified against the working tree at `e798fcb` on 2026-09-01.

---

## 1. Behaviours to preserve (with line references)

| # | Behaviour | Where (3.0.1) | Preservation target (4.0) |
|---|---|---|---|
| B01 | Attacker circles: one circle per unique src coordinate, colour = protocol colour, `fillOpacity 0.2`, `weight 2`; LRU cap **200** with eviction | `static/map.js:512-654`, `L.circle(srcLatLng, 50000, …)` at `:633` | Native MapLibre `attackers` source + circle layer; **semantics change to zoom-scaled pixel radius by decision D19** (§9.5); LRU cap 200 and `{key, color}` features unchanged |
| B02 | Attacker popup: aggregated per coordinate, lists multiple `src_ip`s, protocol counts, IP reputation; `maxWidth 350`, class `modern-popup attacker-popup`; refresh on click | `createAttackerPopup` `static/map.js:805`, popup wiring `:634-654` | `maplibregl.Popup`, `maxWidth '350px'`, same DOM builder reused, built on click (§9.6) |
| B03 | Honeypot markers: icon `static/images/honeypot-marker.svg`, `iconSize [48,48]`, `iconAnchor [24,40]`, `popupAnchor [0,-48]`; LRU cap **200** | `static/map.js:656-745`, `L.marker` at `:719` | DOM `maplibregl.Marker` (`anchor:'bottom'`, popup `offset [0,-48]`), same SVG, cap 200 (§9.6) |
| B04 | Honeypot popup: per-destination stats; `maxWidth 400`, class `honeypot-popup` | `createHoneypotPopup` `static/map.js:1009` | Same DOM builder reused (§9.6) |
| B05 | Attack animation: source ring, curved trail (Bézier, dash), head dot, impact ring; phases travel 0-700 ms, impact 700-1400 ms, source ring 0-700 ms | `handleParticle` `:421-445`, `handleTraffic` `:447-510`, `calcMidpoint` `:370-403`, `translateAlong` `:405-419` | Canvas 2D renderer, same phase timings, screen-space bend (§9.3, §9.4) |
| B06 | Protocol colours: colour arrives in the message (`DataServer.py:318-320` from `service_rgb` `:30`); frontend fallback via `getProtocolColor`/`normalizeProtocol` | `static/map.js:260-349` | Unchanged; the renderer consumes `event.color` |
| B07 | `Stats` handling: `last_1m/last_1h/last_24h` counters every 10 s | `handleStats` `static/map.js:747+`, emitted by `DataServer.py:228` | Unchanged (data channel is map-independent, D29) |
| B08 | WebSocket lifecycle: connect at `DOMContentLoaded`, reconnect with backoff, connection-status pill | `static/map.js:1273-1463`; URL from `window.location.host` at `:1292`; `DOMContentLoaded` hook `:1459-1461` | Unchanged; formalised as `startDataChannel()` (D29) |
| B09 | Tab-wake suppression: `visibilitychange` + `isWakingUp` grace period, animations cleared on wake | `static/map.js:1496-1520` | Kept; clear via `renderer.clear()` (WP6) |
| B10 | Theme switching: `data-theme` MutationObserver swaps basemap; dashboard theming is CSS-only | `static/map.js:1465-1477` (`updateMapTheme`), observer `:1480-1494`; `dashboard.js:940-942` | `setStyle(styleObject,{diff:true})` + revision counter + lifecycle guard (§7.6, D44) |
| B11 | Clear Cache: clears map layer groups + dashboard state | `static/dashboard.js:2158-2185` (guards with `if (window.map)`) | `window.clearMapVisuals()` per D38 (always clears queues; READY also clears registries/choropleth) |
| B12 | Map resize on layout change | `static/dashboard.js:1099-1101` (`window.map.invalidateSize()` behind `if (window.map)`) | `window.map?.resize?.()` (D37 keeps `window.map` contract) |
| B13 | Fullscreen: map control (Leaflet.fullscreen) + dashboard `fullscreen-toggle` (browser API) | `static/map.js:60-81` (`fullscreenControl`), `static/dashboard.js:2582` | `maplibregl.FullscreenControl()`; dashboard toggle untouched |
| B14 | Map view: center (0,0), zoom 3, minZoom 2, maxZoom 8 (256 px raster) | `static/map.js:60-81` | 512 px vector equivalence: zoom 2, `minZoom max(1, header.minZoom)`, `maxZoom = header.maxZoom` (§7.4) |
| B15 | Country tracking stats: `hits`, `countryCode`, `uniqueIPs`, `protocolCounts` per country | `static/dashboard.js:3210-3258` (`updateCountryTracking`) | Unchanged; additionally feeds the D39 choropleth bridge in WP7 |
| B16 | Traffic message handling: dedupe/aggregation keyed by `"lat,lng"` strings in `circleAttackData`/`markerAttackData` | `static/map.js:1124-1266` (`messageHandlers.Traffic`) | Keys stay **byte-identical** (§9.2); dashboard update becomes unconditional, map work lifecycle-gated (D34) |
| B17 | Cache restore into dashboard state (IndexedDB, 500-event batches) | `static/dashboard.js:354-364`, `434+` (`initializeCache` → `restoreFromCache`) | Unchanged; the *map* restore contract stays dormant (§7.2, D30) |
| B18 | SRI maintenance: `update_hashes.py` update/`--check`/`--verbose`; regex requires `src|href` before `integrity`, `static/…` paths only | `update_hashes.py:68` | Kept; gains `modulepreload` discovery + `--check-vendor` (WP3) |
| B19 | Backend tests | `tests/test_DataServer.py` (`test_update_honeypot_data_timing`) | Must keep passing unchanged |
| B20 | Server routes: `GET /` → `static/index.html`, `GET /websocket`, `web.static` for `/static/`, `/images/`, `/flags/`; Redis channel `attack-map-production`; port 64299 | `AttackMapServer.py:105-110`, `:18-20`, `:75` | Unchanged; adds argparse flags, demo task, `.mjs` middleware (D21, D31) |

## 2. Screenshot matrix for WP1 (captured against the Leaflet map, `--demo-seed 42`)

| Shot | Theme | Zoom | Popup | Notes |
|---|---|---|---|---|
| S01/S02 | dark / light | 3 (initial) | none | world view, several attacker circles |
| S03/S04 | dark / light | 5 | none | Europe region detail |
| S05/S06 | dark / light | 7 | none | max useful detail level (Leaflet 8 ≙ MapLibre 7) |
| S07 | dark | 5 | attacker popup open | popup content reference (B02) |
| S08 | dark | 5 | honeypot popup open | popup content reference (B04) |
| S09 | dark | 3 | none | **mid-animation frame** — arc shape reference for WP6 calibration (`FACTOR`, `MIN/MAX_BEND_PX`) and circle radii (`R1`/`R7`) |
| S10 | dark | 3 | none | dashboard chrome: charts, tables, pill — legacy-upgrade reference for WP8 (Bootstrap/Chart.js/FA/fonts/flags) |

Stored under `docs/baseline-screenshots/` (deleted with this file in WP10).

## 3. Cleanups to perform during migration (recorded, not yet executed)

| # | Finding | Evidence |
|---|---|---|
| C1 | Duplicate `window.map = map` assignment | `static/map.js:84` and `:89` — replaced by the single D37 assignment |
| C2 | `attackLines` layer group is created and added but never drawn into | `static/map.js:94`, `:98` — deleted in WP6 |
| C3 | Dead `getCoordinates` fallback: called, defined nowhere (would throw if reached) | `static/map.js:144-145`; no definition repository-wide — replaced by a warning in WP6 |
| C4 | Dormant cache→map restore contract: `window.restoreAttackToMap` defined, never called | `static/cache-bridge.js:7` only — kept dormant, queue-protected (§7.2, D30) |
| C5 | 3.0.1 dashboard-init race: unguarded `window.attackMapDashboard.*` calls vs `window.load`-time polling init | `static/map.js:1261-1264` vs `static/dashboard.js:3661-3676` — fixed by D43 in WP6 |
| C6 | Gecko tile-gap hack and retina handling become obsolete with raster tiles | `static/map.js:22-34`, `detectRetina` `:44` — deleted in WP6 |
| C7 | Raster tile CSS filter | `static/index.css:2644` — deleted in WP8, not ported |

## 4. Defect re-confirmation (WP0 acceptance, run 2026-09-01)

```
$ grep -rn getCoordinates --include='*.js' --include='*.html' .
static/map.js:144:            getCoordinates(restoredMsg.country, restoredMsg.iso_code),
static/map.js:145:            getCoordinates(restoredMsg.dst_country_name, restoredMsg.dst_iso_code)
# → call sites only, no definition anywhere.

$ grep -rn restoreAttackToMap --include='*.js' --include='*.html' .
static/cache-bridge.js:7:window.restoreAttackToMap = function(event) {
# → definition only, no caller anywhere.
```

Both match HANDOFF-v2 §0.1 item 11 and §0.3 item 32.
