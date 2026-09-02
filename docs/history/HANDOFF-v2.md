# HANDOFF v2: T-Pot Attack Map
# Leaflet + D3 + CARTO -> MapLibre GL + PMTiles
# Offline-first, Globe-ready architecture

> **Historical document.** This is the internal planning and design record of the
> 4.0.0 migration, kept for provenance. It is NOT user or developer documentation —
> see [README.md](../../README.md), [docs/BASEMAP.md](../BASEMAP.md) and
> [docs/RELEASING.md](../RELEASING.md) instead. Where implemented behaviour later
> changed by maintainer decision (recorded in the git history), the code wins.

Plan of record for the 4.0.0 migration. Self-contained: an implementing session needs this
document, the repository, and nothing else.

- Primary repository: `/Users/A3918320/Documents/GitHub/master/t-pot-attack-map`
  (`telekom-security/t-pot-attack-map`, branch `master`)
- Verified state: `e798fcb`, version `3.0.1`. Every line number below was read from this commit.
- Companion repository: `/Users/A3918320/Documents/GitHub/tpotce`
  (relevant: `docker/elk/map/Dockerfile`, `docker/nginx/dist/conf/tpotweb.conf`)
- Upstream facts verified on 2026-08-31 against the exact selected versions (MapLibre 6.6.0,
  PMTiles 4.5.0, `@protomaps/basemaps` 5.7.2, go-pmtiles 1.31.2, aiohttp 3.14.3,
  elasticsearch-py 9.3.0, redis-py 8.1.0, Playwright 1.62.1, Alpine 3.23 / Python 3.12.14,
  Natural Earth v5.1.2, Bootstrap 5.3.8, Chart.js 4.5.1, Font Awesome 7.3.1, Inter v4.1,
  JetBrains Mono v2.304, Flagpack v2.1.0, Node.js 24.20.0 LTS / npm 11). Numbers that require a
  large download are marked **MEASURE** and carry the command producing them.
- Revision 6. §5 records the five maintainer design reviews and how each finding was resolved.
  An earlier draft (`docs/HANDOFF-attack-map-carto.md`) was superseded and removed.

---

## 0. What changed compared with the previous plans

### 0.1 Corrections to the first draft (`HANDOFF-attack-map-carto.md`)

1. **Production runs under a sub-path — root-relative asset URLs are wrong.**
   `tpotce/docker/nginx/dist/conf/tpotweb.conf:154-171` serves the app at
   `https://<host>:64297/map/` with `rewrite /map/(.*)$ /$1 break;`. The draft's
   `glyphs: "/static/…"`, `sprite: "/static/…"` and `pmtiles:///static/…` all resolve outside
   `/map/`. Today the app works only because `static/index.html` uses document-relative URLs.
2. **MapLibre "v5.x" is not a viable target.** MapLibre does not backport: no 4.x release after
   v5.0.0 (2024-12-31), no 5.x release after v6.0.0 (2026-07-22). Target is **exactly 6.6.0**.
3. **Self-hosted v6 needs no `blob:` worker.** `src/util/web_worker.ts` @ v6.6.0 calls
   `new Worker(url,{type:'module'})` for same-origin URLs; the Blob path is cross-origin only.
4. **SRI was over-valued** for same-origin files whose hashes live in the same `index.html`;
   `static/vendor.lock` is the authoritative integrity/provenance manifest (§14.4).
5. **SHA-256-pinning a Protomaps daily build is not reproducible** (one-week retention, BLAKE3
   hashes, hotlinking discouraged) — hence a T-Pot-owned immutable release asset (§14).
6. **`ADD --checksum` and a second Docker stage are unnecessary** — the image already clones this
   repository (§15).
7. **Screen-space Bézier arcs replaced** — see §0.3 item 31 for where that landed after review.
8. **"Reduced security basemap" is a style decision, not a data decision** (§8.4).
9. **The choropleth needs its own geometry**: Protomaps v4 `boundaries` is a *line* layer
   (`styles/src/base_layers.ts:1065`, `:1083`), so there are no country polygons and no ISO ids.
10. **Unverified size estimates removed**; sizes are **MEASURE** items (§8.2).
11. **`getCoordinates` is confirmed dead** — called at `static/map.js:144-145`, defined nowhere.

### 0.2 From the first design review (revision 2)

12. Work-package order rebuilt with a dependency proof; every stage leaves the repo runnable
    (§11.0).
13. The ESM bootstrap no longer relies on load order or polling: `map.js` awaits its own dynamic
    imports (§7.1).
14. The PoC gets a temporary `GET /poc.html` route so it tests the real `/` and `/map/` base
    directories (§11 WP4).
15. The basemap lifecycle is closed: dev presets are `extract` sub-pyramids of the T-Pot
    artefact, and a dedicated immutable `basemap-*` release exists before the code release (§8.3,
    §14).
16. The PMTiles header is the runtime authority for zoom, read by a preflight before MapLibre is
    constructed (§7.4, §13.5).
17. Longitude unwrapping, world-copy choice and the arc shape were re-specified (revised again in
    §0.3 item 31).
18. The Globe claim was toned down (§10).
19. Glyph URL normalisation fixed — `new URL()` percent-encodes `{fontstack}` (§7.3).
20. `reAddCustomLayers()` guards per object; feature-state always re-applied (§7.6).
21. Choropleth semantics defined, including the source-IP-geolocation caveat (§8.6).
22. The attacker circle's changed semantics stated as a decision (§9.5).
23. WebGL statement corrected: WebGL1 removal is a **6.0.0** change; v6 exposes
    `GPUInitializationError` via `map.on('error')` (§13.4, §19).
24. Early map-init failure keeps the dashboard's APIs safe (§13.6).
25. Pure geometry lives in an importable module used by browser and Node tests (§9.2).
26. Canvas pixel determinism was overclaimed; testing is tiered (§17.5).
27. Sprite licensing added — and the sprite proved to be *required*, not decorative (§8.4, §20).
28. The Natural Earth trimming step got a committed implementation (§11 WP3).
29. No GitHub Actions: everything runs locally through `tools/check_all.sh` (§17.1).
30. M1-M3 decided (D23-D25); the two product choices were decided as D27/D28.

### 0.3 From the second design review (revision 3)

31. **The 2D arc is now visually normalised, not geodetically normalised.** The Mercator renderer
    projects the two geographic endpoints and bends in **screen space** with a bounded pixel
    offset, so apparent arc height no longer depends on latitude or route orientation. Great-circle
    sampling is **not shipped in 4.0**; it is specified as future globe-renderer work instead
    (§9.3, §9.4, §10). The bend is renderer-local: it never enters `AttackEvent`, the wire format,
    the cache or the geometry module.
32. **Cache restore is made safe — and turned out to be dead code today.**
    `window.restoreAttackToMap` is defined in `static/cache-bridge.js:7` and **called from
    nowhere** in 3.0.1 (a repository-wide grep finds only the definition), so cache-restored
    attacks never reach the map. 4.0 keeps the dormant contract, adds a bounded queue so an async
    map startup can never drop or throw on a restore call, and deliberately does **not** wire
    restoration into the map as new behaviour (§7.2, §13.6).
33. **The data channel is independent of the map.** `startDataChannel()` (WebSocket, stats,
    dashboard) and `initMap()` are separate startup domains; a map failure can never stop data
    acquisition. *(Refined in revision 4, item 49: events arriving during the normal startup
    interval are now held in a bounded startup-only queue instead of being dropped from the map;
    after a permanent failure nothing is buffered — the map still has no recovery path in 4.0.)*
34. **`check_all.sh` had a dev-vs-release contradiction** — a z2 dev artefact can satisfy neither
    `WORLD_PMTILES_SHA256` nor `PM_MAXZOOM`. There are now two modes, with exact paths, and the
    smoke test never writes to `static/dist/` (§17.1).
35. **One implementation of the pinned-CLI logic.** `tools/pmtiles_cli.sh` owns detection,
    download, SHA-256 verification and execution; `fetch_basemap.sh`, `check_all.sh` and the
    measurement commands all call it. Nothing is ever expected on `PATH` (§14.4).
36. **The country dataset was measured, and 110m is not sufficient.** Natural Earth 110m admin-0
    lacks **Singapore, Hong Kong, Macao, Malta, Monaco, Liechtenstein, Bahrain, Mauritius** and 23
    further GeoIP-relevant codes. 4.0 ships **Natural Earth 50m admin-0 map units** (§8.5), with a
    committed coverage report.
37. **Raw counts are the choropleth's source of truth**, not normalised intensity; three explicit
    state layers (§8.6).
38. **The low-zoom content claim was wrong.** At z≤7 Protomaps *does* contain `landcover`
    (`setZoomRange(0, 7)`), `landuse` (from z2) and roads (highways from z3) — only `buildings`
    (z11+) and `pois` (z11+) are genuinely absent. The reduced T-Pot look is therefore a **style**
    decision; the zoom cap only limits detail (§8.4).
39. **The style filter is an allowlist, not a deny-list**, and the generator fails on unknown
    upstream layer ids instead of silently passing them through (§8.4).
40. **`new Protocol()` instead of `new Protocol({metadata:true})`.** Verified in the PMTiles 4.5.0
    ESM source: with `metadata` enabled the protocol's `json` branch calls `getTileJson()` →
    `getMetadata()`, an **extra ranged request** on the startup critical path; with it disabled the
    TileJSON is built from the header we already read (§7.1).
41. **`vendor.lock` has an explicit schema** with a `provenance_type` of `vendored` / `generated` /
    `local`, so the manifest's scope is unambiguous (§14.4).
42. **Licence files are a concrete, verified inventory** under `static/licenses/` (§6.1, §12.2,
    §20).
43. **The check suite has a bootstrap story**: `tools/check_all.sh --bootstrap` may use the
    network; the normal run never downloads anything (§17.1).
44. **`.mjs` MIME type is pinned server-side and tested** (mechanism corrected in revision 4,
    §0.4 item 47).
45. **`modulepreload integrity` stays optional** — an optimisation whose enforcement is measured,
    never a correctness dependency (§14.4).

### 0.4 From the third review (revision 4 — dependency freshness and final consistency)

46. **Every Python runtime dependency re-pinned to the newest stable compatible release** (§6.0).
    aiohttp 3.13.2 → **3.14.3** (≤ 3.14.2 is affected by a high-severity parser advisory,
    CVE-2026-69244, and ≤ 3.14.1 by a WebSocket-upgrade request-smuggling advisory,
    CVE-2026-69243); elasticsearch 8.18.1 → **9.3.0** (selected after checking the actual T-Pot
    Elasticsearch 9.x server and Elastic's Python client compatibility rules — see the corrected
    wording in §0.5 item 64 and the §5.3 note; the steady-state rule is same major, client minor
    ≤ server minor); redis 7.1.0 → **8.1.0**
    (`map_redis` runs Alpine 3.23's Redis **8.4.2**); pytz → **2026.3.post1**; tzlocal → **5.4.4**.
    The frontend pins (MapLibre 6.6.0, PMTiles 4.5.0, `@protomaps/basemaps` 5.7.2,
    go-pmtiles 1.31.2) were re-verified as current stable and retained. Binding rule: the version
    matrix is regenerated immediately before implementation (D35).
47. **The `.mjs` MIME guarantee is a response middleware, not `mimetypes.add_type`.** aiohttp
    3.14.3 resolves static MIME types through a module-private `MimeTypes()` instance
    (`web_fileresponse.py:52`, `CONTENT_TYPES: Final[MimeTypes] = MimeTypes()`), which the global
    `mimetypes.add_type()` never reaches. `FileResponse.prepare()` only guesses when no
    `Content-Type` is set yet (`if hdrs.CONTENT_TYPE not in self._headers`, verified at v3.14.3),
    so a small middleware that sets `text/javascript` for `.mjs` paths is the correct public-API
    mechanism (D31, §7.5). Alpine 3.23's Python 3.12.14 already maps `.mjs` correctly in its
    built-in table; the middleware makes the guarantee independent of the Python version.
48. **`vendor.lock` no longer has a work-package forward dependency.** WP3 writes the manifest for
    every asset that exists by WP3; WP5 adds its two local modules and updates the manifest in the
    same package, re-running `--check-vendor` (§11 WP5, §14.4).
49. **Map lifecycle is explicit: `INITIALIZING` → `READY` | `FAILED`** (D34). All map side effects
    of a Traffic event — attacker circle, honeypot marker, transient animation — are gated
    together, not just `renderer.spawn()`. Events arriving during `INITIALIZING` go into a bounded
    startup-only queue (cap 400, drop-oldest) drained in order on `READY` and discarded on
    `FAILED`; dashboard state always updates immediately (§7.1, §13.6).
50. **World-copy selection is frozen at spawn** (D15 revised). Recomputing the copy per frame can
    jump ±360° when the centre crosses the half-world threshold mid-animation. The renderer now
    chooses the copy nearest the map centre once at spawn, stores `worldCopyOffsetLng` in
    renderer-local state, and uses it for the event's whole lifetime (§9.3).
51. **Country features are merged to exactly one GeoJSON feature per ISO-2 code.**
    `vendor_countries.mjs` groups map units by `ISO_A2_EH` and merges geometry into one
    (Multi)Polygon, asserting no duplicate ids remain — instead of calling duplicate `promoteId`
    values "harmless" (§8.5).
52. **ISO coverage is not claimed to be visual coverage.** WP7 gains a tiny-state visual check
    (SG, HK, MC, LI, MT, AD, SM, VA …); a supplemental tiny-country point layer is explicitly
    deferred, not silently omitted (§8.5, §22).
53. **Natural Earth / Protomaps alignment wording corrected.** Rounding adds negligible positional
    error, but exact alignment with the independent Protomaps/OSM boundaries is *not* guaranteed;
    the fill ships without its own outline so the basemap's boundary lines stay authoritative
    (§8.5).
54. **`--bootstrap` prepares all development tooling**, not only Playwright: both npm workspaces
    plus the pinned go-pmtiles binary cache; normal and `--release` runs never download tooling
    (§17.1).
55. **Restore-queue drop policy fixed to match its prose**: keep the newest entries
    (`shift` oldest, append newest) — the previous pseudocode silently dropped the *new* event.
    The same policy and wording apply to the startup traffic queue (§7.2, §7.1).
56. **`requirements.txt` is updated in WP1** and the dependency matrix (§6.0) is part of the
    release checklist; a known-vulnerable selected dependency is a release blocker (D35, §24).

### 0.5 From the fourth review (revision 5 — legacy dependencies and final startup races)

57. **The D35 freshness policy now covers the legacy frontend stack, with measured usage
    evidence** (§6.4, D36). jQuery 3.7.1 and Luxon 3.5.0 are loaded by `index.html` but used by
    **nothing** (repository-wide grep: no `$(`, `$.`, `jQuery`, `luxon`, `DateTime` in any
    application script) — both are **removed**, not upgraded. Bootstrap's JS bundle is equally
    unused (no `data-bs-` attribute, no `bootstrap.*` API call; modals are driven by
    `style.display`) and is removed; the CSS is used (69 class matches) and upgraded to 5.3.8.
    Chart.js 4.4.0 → 4.5.1. Font Awesome 6.5.1 → 7.3.1 after a full icon audit (all 24 used
    names exist in 7.3.1 canonically or as maintained aliases; the `fas` prefix is retained
    upstream). Fonts and flags are re-vendored from pinned upstream refs.
58. **All supply-chain placeholders replaced by immutable refs** (§6.1, §14.4):
    `basemaps-assets` = commit `028c18f713baecad011301ff7a69acc39bcc2ae7`; Natural Earth =
    tag `v5.1.2`, commit `f1890d9f152c896d250a77557a5751a93d494776`; Inter = `v4.1`
    (`e3a3d4c57d5ecc01453a575621882a384c1995a3`); JetBrains Mono = `v2.304`
    (`cd5227bd1f61dff3bbd6c814ceaf7ffd95e947d9`); flags identified as **Flagpack** `v2.1.0`
    (`094849d2ccc7e677dbb1663244fd0ca91759dab4`, size "l", byte-identical sample check).
59. **The basemap bootstrap cycle is closed** (D10 revised). `--from-upstream` takes an explicit
    `--upstream-build <BUILD_ID>` (defaulting to `PM_BUILD` only once the lock is filled), and
    **WP2 is complete only when the entire artefact lifecycle is closed** — build id selected,
    z6/z7 measured, D23 applied, immutable release published, all four lock values recorded,
    `full` verified and dev presets extracted (§8.3, §11 WP2, §14.3). No "sometime before WP6"
    scheduling ambiguity remains.
60. **`window.map` has exactly one successful assignment** (D37): `null` synchronously, the
    MapLibre instance immediately after construction, and back to `null` (after `map.remove()`)
    on a fatal post-construction failure. Asserted in the smoke test for both outcomes (§7.1,
    §13.6, §11 WP6).
61. **Clear Cache cancels pending startup and restore events** (D38). The early
    `clearMapVisuals` stub is not a no-op: it always empties `startupTrafficQueue` and
    `pendingRestored`, so no pre-clear event can resurrect when the map later becomes READY.
    Tested explicitly for both queues (§7.1, §7.2, §13.6, §11 WP6).
62. **The failure panel's functional markup ships in WP6**, not WP8 — WP6's failure tests never
    depend on markup from a later package; WP8 contributes styling only (§11 WP6/WP8, §12.1).
63. **The choropleth raw-count bridge is explicit** (D39): `dashboard.js` pushes **absolute
    counts** over `window.updateChoropleth(iso2, absoluteHits)`; `map.js` keeps its own
    `choroplethHits` mirror and never reads `countryTrackingStats` directly. Four state levels,
    all cleared by Clear Cache (§8.6).
64. **The Elasticsearch compatibility wording is corrected**: Elastic provides a REST API
    compatibility mode that lets an 8.x client talk to a 9.x server during upgrade windows, so
    "unsupported" was too categorical. The steady-state rule (same major, client minor ≤ server
    minor → client 9.3.0 for server 9.3.5) and the selected pin are unchanged (§5.3, §6.0).
65. **The CSP wording no longer overstates WebSocket enforcement**: `connect-src 'self' ws: wss:`
    does not literally restrict WebSocket destinations to same-origin; same-origin WebSocket
    behaviour is enforced by the application's URL construction and verified by the runtime
    network tests (§13.1, §13.3). The policy itself is unchanged.
66. **Theme switching is protected against async reordering** (§7.6): a revision counter discards
    stale `loadStyle` results, and the WP4 theme test now includes rapid non-awaited toggling
    with a final-style assertion.
67. **`pip` is no longer floating** (D40): the Dockerfile drops `pip3 install --upgrade pip` —
    Alpine 3.23's `py3-pip` (25.1.1) installs the pinned wheels as-is. Policy distinction
    documented: application/tool dependencies are exact-pinned; Alpine OS packages inside the
    pinned 3.23 channel are intentionally refreshed at image build (`apk -U upgrade`); the image
    is not claimed to be bit-for-bit reproducible (§15).
68. **Supported local tooling platforms made precise** (D41): macOS Apple Silicon, Linux x86_64,
    Linux arm64. Intel macOS is **not** supported (no `darwin_x86_64` hash is pinned). The CLI
    cache is keyed by OS **and** architecture (§14.4, §11 WP2).

### 0.6 From the fifth review (revision 6 — final verification and consistency pass)

All pins re-verified against every authoritative upstream on 2026-08-31 immediately before this
revision: **no upstream moved** — every §6.0/§6.2/§6.4 selection remains the latest stable
(compatible) release.

69. **One named Dependency Freeze Gate (G-DEP)** opens WP1 (D42): a single step that re-checks
    **every** dependency category — Python, frontend runtime, retained legacy, vendored asset
    refs, tooling, platform, and the tpotce ES/Redis server versions — and writes one
    consolidated report (`docs/DEPENDENCIES.md`). Pins are frozen only after this gate; any
    change updates the HANDOFF, the locks/ref constants, `vendor.lock` expectations and affected
    API assumptions. The former "WP1 re-checks the Python pins" sentence is superseded.
70. **The stale Elasticsearch rationale in the revision history was corrected** (§0.4 item 46):
    the document no longer contains "an 8.x client against a 9.x server is unsupported" as a
    standing claim anywhere.
71. **`vendor_countries.mjs` verification is split so the offline promise is literal** (Finding
    2, Option B): `--verify` is fully offline (structure, hashes vs `vendor.lock`, unique ids,
    ISO coverage, committed provenance metadata incl. the recorded source SHA-256);
    `--rebuild` is the network-enabled maintainer operation that fetches the pinned Natural Earth
    v5.1.2 source, verifies its recorded SHA-256, regenerates and diffs (§8.5, §11 WP3, §17.1).
72. **The `startDataChannel()` → dashboard dependency graph was measured — and 3.0.1 has a real
    race** (D43). `messageHandlers.Traffic` calls `window.attackMapDashboard.addAttackEvent()` /
    `.processAttackForDashboard()` **unguarded** (`map.js:1261-1264`), while
    `window.attackMapDashboard` is only created on **`window.load`** behind a Chart.js
    **polling** loop (`dashboard.js:3661-3676`) — a Traffic message arriving between
    `DOMContentLoaded` (socket connect) and dashboard init throws today. 4.0 fixes this without
    polling: `dashboard.js` instantiates `window.attackMapDashboard` **synchronously at script
    evaluation** (safe: Chart.js at `index.html:23` is a deferred script that executes before
    `dashboard.js` at line 554 — document order is a spec guarantee), the `initWhenReady` /
    `updateStatusWithRetry` polling loops are deleted, and the WebSocket still connects at
    `DOMContentLoaded`, which fires only after **all** deferred scripts have executed (§7.1).
73. **Theme changes are lifecycle-safe** (D44): during `INITIALIZING` the desired theme is
    remembered and applied on `READY`; after `FAILED` map work is skipped while the dashboard
    theme keeps working; the revision counter continues to protect the `READY` path. Tests added
    (§7.6, §11 WP6).
74. **The interim WP3 provenance state is truthful** (Finding 5): `vendor.lock` gains a fourth
    `provenance_type`, **`legacy`** (`source = repository baseline e798fcb`,
    `upstream_ref = unknown`), for the pre-4.0 third-party files WP3 records but has not proven
    against an upstream ref. WP8 removes or replaces every `legacy` entry; the release check
    asserts none remains (§14.4, §11 WP3/WP8, §24).
75. **The Node toolchain baseline is concrete** (D45): generated committed artefacts are produced
    under **Node.js 24.20.0 LTS** (npm 11, `package-lock.json` lockfileVersion 3), recorded in a
    committed `.node-version`; Node ≥ 20 remains the compatibility floor (Playwright 1.62
    requires it), 24.20.0 is the tested/reproducibility baseline.
76. **Floating development examples pinned** (Finding 7): the full-chain example uses
    `redis:8.4.6-alpine` (matching the tested Redis 8.4 server line) instead of `redis:alpine`.
77. **"No network after bootstrap" is an acceptance test, not prose** (Finding 8): §17.1 defines
    the negative test — bootstrap once, fetch a dev artefact once, block external network, run
    `tools/check_all.sh` → green — and names the only commands allowed to touch the network.
78. **The 2D-arc visual claim is stated precisely** (Finding 9): the bend is
    **screen-space-normalised, not latitude-scaled** — routes of comparable projected screen
    length get comparable curvature; Mercator still changes projected distances with latitude, so
    no blanket "nothing changes visually with latitude" claim remains (§9.3, §17.4).

---

## 1. Executive summary

CARTO now requires an API key for raster basemaps and is retiring them; `static/map.js:38-52`
loads `basemaps.cartocdn.com` unauthenticated, so every T-Pot installation shows a watermark.
4.0.0 removes the dependency instead of authenticating it:

- **Leaflet 1.x + Leaflet.fullscreen + D3 v7 are removed**, replaced by MapLibre GL JS 6.6.0.
- **The basemap becomes one local `world.pmtiles`** served by the existing aiohttp server over
  HTTP range requests. No tile server, no API key, no online fallback.
- **One dataset, two styles**, generated at development time from `@protomaps/basemaps` and
  committed; theme switching never downloads map data.
- **Attack state is geographic**; the visual arc shape is renderer-local. Animations survive pan
  and zoom — today everything is wiped on `zoomstart` (`static/map.js:364-366`).
- **The archive is the runtime authority**: a PMTiles preflight reads the header before MapLibre
  is constructed, so zoom limits always match the shipped artefact and a missing or corrupt
  archive fails cleanly and early.
- **Two independent startup domains**: the data channel (WebSocket, stats, dashboard) never
  depends on map initialisation succeeding.
- **Zero third-party requests at runtime**, enforced by a strict CSP and verified in the browser.
- **Local development needs neither Elasticsearch, Redis nor Docker** (`AttackMapServer.py --demo`).
- **A blocking proof-of-concept gate (WP4)** proves PMTiles + MapLibre + local assets + CSP at
  both deployment base URIs *before* `map.js` is rewritten.
- The choropleth ships in 4.0 over Natural Earth 50m map units (one merged feature per ISO code),
  with defined semantics and a measured ISO-code coverage report.
- **Every direct dependency starts current — the legacy stack included**: the full Python stack is
  re-pinned to the newest stable compatible releases (§6.0 — aiohttp 3.14.3 fixes a high-severity
  advisory; the Elasticsearch client moves to the 9.x major matching tpotce's 9.3.5 server), the
  frontend pins were re-verified as latest stable, unused legacy libraries (jQuery, Luxon,
  Bootstrap's JS bundle) are **removed** on usage evidence, the retained ones are upgraded and
  provenance-recorded (§6.4), and D35 makes the freshness check a binding pre-implementation and
  release-gate step.
- All verification runs locally via `tools/check_all.sh`; there is no CI service in the loop.

There is deliberately **no stopgap 3.0.x release**: a CARTO API key would only postpone a
dependency that is being retired, so this migration *is* the fix for tpotce discussion #1913.

Estimated effort: 10–13 working days, sequential, with WP4 as the go/no-go (WP2 now closes the
full basemap lifecycle including the immutable release; WP8 additionally carries the legacy
dependency cleanup).

---

## 2. Verified current repository architecture

### 2.1 Backend

- `AttackMapServer.py` (121 lines). aiohttp app. Routes at lines 105-110:
  `GET /` → `web.FileResponse('static/index.html')` (line 75), `GET /websocket`,
  `web.static('/static/', 'static')`, `web.static('/images/', 'static/images')`,
  `web.static('/flags/', 'static/flags')`. Redis pubsub channel `attack-map-production`
  (`redis_url = 'redis://map_redis:6379'`, line 18; commented local variant at 15-17).
  `version = 'Attack Map Server 3.0.1'` (line 20). `web_port = 64299` (line 19).
- `DataServer.py`. Elasticsearch producer. `service_rgb` at line 30 (53 protocol keys),
  `PORT_MAP` at line 85, `port_to_type()` at line 329, colour assignment at 318-320, `Stats`
  message at line 228 (`last_1m`/`last_1h`/`last_24h`, every 10 s), `Traffic` payload at 362-384.
  Source country codes come from Elasticsearch GeoIP: `alert["iso_code"] =
  hit["_source"]["geoip"]["country_code2"]` (line 302) and `alert["dst_iso_code"] =
  …["geoip_ext"].get("country_code2","")` (line 292) — i.e. **MaxMind-style ISO-3166-1 alpha-2**,
  which is what the choropleth must be able to match (§8.5). `version = 'Data Server 3.0.1'` (16).
- `requirements.txt` (3.0.1 state, replaced in WP1 by the §6.0 pins): `aiohttp==3.13.2`,
  `elasticsearch==8.18.1`, `pytz==2025.2`, `redis==7.1.0`, `tzlocal==5.3.1`.
- `tests/test_DataServer.py`: one unittest (`test_update_honeypot_data_timing`). Must keep passing.
- `update_hashes.py`: SHA384 SRI maintenance; regex at line 68
  `r'(?:src|href)="(static/[^"]+)"[^>]*?integrity="(sha384-[^"]+)"'` — `src`/`href` must precede
  `integrity`, and only `static/…` paths are discovered. Modes: update, `--check`, `--verbose`.
- `.gitignore`: venv artefacts only. `.github/`: `copilot-instructions.md` only — **no CI**.

### 2.2 Frontend

`static/index.html` (30 KB): CSP meta tag at line 7; 16 `integrity` attributes; scripts/links at
14 (d3), 17 (jquery), 20 (luxon), 23 (chart.js), 26-27 (bootstrap), 30-31 (leaflet),
34-35 (leaflet.fullscreen), 38 (fonts), 41 (fontawesome), 43 (`index.css?v=6`), and at the end of
`<body>`: `cache-bridge.js` (552), `map.js` (553), `dashboard.js` (554). All references are
document-relative.

`static/map.js` (1538 lines) — Leaflet/D3 coupling:

| Lines | What it does |
|---|---|
| 22-34 | `L.Browser.gecko` guard + `L.GridLayer._initTile` 1 px tile-gap hack |
| 37-55 | two `L.tileLayer(...cartocdn...)`, `subdomains`, `detectRetina`, `tileSize: 256` |
| 57-58 | `currentTheme` from `data-theme`; `base = mapLayers[currentTheme]` |
| 60-81 | `window.map.remove()` guard; `L.map('map', {...})`: `center (0,0)`, `zoom 3`, `minZoom 2`, `maxZoom 8`, `zoomSnap/Delta 0.2`, `worldCopyJump`, `tap:false`, `fullscreenControl` |
| 84, 89 | `window.map = map` twice (duplicate) |
| 92-98 | `L.LayerGroup` `circles`, `markers`, `attackLines`; `attackLines` never drawn into |
| 101-158 | `window.processRestoredAttack` — the cache contract; `new L.LatLng` at 137-138; **dead `getCoordinates` fallback at 143-157** |
| 160-258 | `restoreMarkerData` → `addCircle` (253), `addMarker` (255) |
| 260-349 | `getProtocolColor`, `normalizeProtocol` |
| 352-361 | `L.svg({clickable:true})` + `d3.select(...).append("g")` + `pointer-events:none` |
| 364-366 | `map.on("zoomstart", () => svg.selectAll("*").remove())` — **the pan/zoom bug** |
| 370-403 | `calcMidpoint(x1,y1,x2,y2,bend)` — **pixel-space** control point |
| 405-419 | `translateAlong(path)` — `getPointAtLength` tween |
| 421-445 | `handleParticle(color, srcPoint)` — source ring, `d3.easeCircleIn` |
| 447-510 | `handleTraffic(color, srcPoint, hqPoint)` — `d3.line().curve(d3.curveBasis)`, dash trail, head dot, impact ring |
| 512-654 | `circlesObject`, `circleAttackData`, `addCircle`: `L.circle(srcLatLng, 50000, …)` at 633, LRU cap 200, popup `maxWidth 350` |
| 656-745 | `markersObject`, `markerAttackData`, `addMarker`: `L.marker` at 719, `L.icon({iconSize:[48,48], iconAnchor:[24,40], popupAnchor:[0,-48]})`, popup `maxWidth 400`, LRU cap 200 |
| 747-1122 | `handleStats`, `createAttackerPopup` (805), `createHoneypotPopup` (1009), formatters |
| 1124-1270 | `messageHandlers`: `Traffic` 1125-1266 (`new L.LatLng` 1129-1130, `map.latLngToLayerPoint` 1131-1132, `"lat,lng"` keys, calls at 1187-1190), `Stats` 1267-1269 |
| 1273-1463 | WebSocket lifecycle; `WS_HOST = protocol + '//' + window.location.host + '/websocket'` (1292); **`document.addEventListener('DOMContentLoaded', () => connectWebSocket())` at 1459-1461 — already independent of map construction** |
| 1465-1477 | `updateMapTheme` — removes layers whose `_url` contains `basemaps.cartocdn.com` (1470) |
| 1480-1494 | `MutationObserver` on `data-theme` |
| 1496-1520 | `visibilitychange`: `isWakingUp` grace period, `svg.selectAll("*").remove()` |

`static/dashboard.js` (3679 lines) — four touch points, two already guarded: `toggleTheme()`
940-942; `if (window.map) { … invalidateSize() }` 1099-1101; clear-cache 2158-2185 (`if (window.map)`
then `clearLayers()` on the groups, each behind its own `if`); `updateCountryTrackingStats`
3210-3258 (`hits`, `countryCode`, `uniqueIPs`, `protocolCounts`). Cache restore runs in
`initializeCache()` → `restoreFromCache()` (354-364, 434+), asynchronously, in 500-event batches.
`fullscreen-toggle` (2582) uses the browser API and is unaffected. **D3 is used only by `map.js`.**

`static/cache-bridge.js`: defines `window.restoreAttackToMap` (line 7), which forwards to
`window.processRestoredAttack` **if that function exists**. A repository-wide grep shows
`restoreAttackToMap` has **no caller** — so in 3.0.1 cache-restored attacks never reach the map,
and a missing `processRestoredAttack` cannot throw. The contract is dormant, not broken (§7.2).

`static/index.css` (2655 lines) — `.leaflet-*` rules at 436, 443, 448, 456, 463, 468, 1874, 1883,
1890, 2235, 2245, 2361, 2392, 2402, 2559, 2635, 2639, 2644 (the last one a raster tile filter to
delete, not port).

### 2.3 Production environment (tpotce)

- `docker/elk/map/Dockerfile`: `FROM alpine:3.23`; build deps + `py3-pip`;
  `git clone https://github.com/t3chn0m4g3/t-pot-attack-map -b 3.0.1`;
  `mv DataServer.py DataServer_v2.py`; `pip3 install -r requirements.txt`;
  `setcap cap_net_bind_service`; user/group `map` (2000); `chown map:map -R`; `apk del`;
  `rm -rf .git`; `CMD ["/bin/sh","-c","/usr/bin/python3 $MAP_COMMAND"]`.
- `docker/nginx/dist/conf/tpotweb.conf:154-171`: `location /map/` → `http://map_web:64299` with
  `rewrite /map/(.*)$ /$1 break;`, plus a root-level `location /websocket` (172-187) — which is why
  `map.js:1292` uses an absolute `/websocket` path.
- The image runs twice from one image (`map_web`, `map_data`, chosen by `MAP_COMMAND`), e.g.
  `compose/tpot_services.yml:1036-1055`. One image layer holds the basemap for both.

---

## 3. Architectural goals and invariants

1. **No CARTO, no API key, no online fallback.** Runtime traffic only to the local service.
2. **One map subsystem.** MapLibre owns projection; a future globe needs no second engine,
   dataset or per-projection style file.
3. **Geographic attack model, renderer-local presentation.** Canonical state is lng/lat +
   metadata + spawn time. Projection and visual shaping happen inside the renderer and are never
   persisted or transmitted.
4. **Style and data are separate**, and the archive — not the style — is authoritative for zoom.
5. **Reproducible basemap artefact.** Not in git; pinned by hash; one committed acquisition script
   and one committed CLI-pinning helper for local development, testing and the Docker build.
6. **Strict CSP, everything vendored, everything hashed, every notice shipped.** Same-origin only.
7. **Deterministic startup.** No load-order races, no polling, no timing assumptions.
8. **Map failure is contained.** Data acquisition, dashboard and cache paths keep working.
9. **Local development without T-Pot infrastructure**; demo mode can never become a production
   default.
10. **All verification runnable locally with one command**, with an explicit bootstrap step for
    anything that needs the network.
11. **Least disruption outside the map.** No dashboard redesign, no server architecture change.

---

## 4. Decisions

| # | Decision |
|---|---|
| D1 | MapLibre GL JS **6.6.0**, self-hosted ESM (`maplibre-gl.mjs`, `maplibre-gl-shared.mjs`, `maplibre-gl-worker.mjs`, `maplibre-gl.css`), exact pin |
| D2 | `map.js` awaits its own dependencies: `await Promise.all([import('./map-boot.mjs'), import('./attack-renderer.mjs')])`. No `<script type="module">` tag, no readiness global, no polling |
| D3 | PMTiles JS **4.5.0**, ESM entry `dist/esm/index.js` |
| D4 | `go-pmtiles` **1.31.2**, always obtained through `tools/pmtiles_cli.sh`; never expected on `PATH`, never inside the Docker build |
| D5 | Styles generated at development time from `@protomaps/basemaps` **5.7.2**, committed, **without** source `url` or `maxzoom` (both injected at runtime) |
| D6 | Glyphs and sprites vendored from `protomaps/basemaps-assets` @ commit `028c18f713baecad011301ff7a69acc39bcc2ae7`. The sprite is **required**: `places_locality` uses `icon-image` (`capital`/`townspot`) below zoom 8 |
| D7 | Asset URLs resolved at runtime against `document.baseURI`; templated URLs built as resolved base + literal template; the style is passed to MapLibre as an **object** |
| D8 | CSP: `default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; form-action 'none'` |
| D9 | Integrity: SRI on script/link tags; `modulepreload integrity` as a measured optimisation only; `static/vendor.lock` (explicit schema, §14.4) as the authority |
| D10 | Basemap acquisition: `tools/basemap.lock` + `tools/fetch_basemap.sh` (+ `tools/pmtiles_cli.sh`). `full` = plain GET of the immutable T-Pot release asset; dev presets = `extract` sub-pyramids **of that artefact**; `--from-upstream --upstream-build <BUILD_ID>` = maintainer path only — the build id is an **explicit input** (it defaults to `PM_BUILD` only once the lock is filled), so nothing needs `PM_BUILD` before it exists |
| D11 | Docker: single stage, script from the clone, artefact baked into the image |
| D12 | The tileset stays general-purpose Protomaps; the T-Pot look is produced by a style **allowlist** (§8.4). Physical reduction deferred |
| D13 | **PMTiles preflight** with `new Protocol()` (no `metadata`): open the archive, `getHeader()`, validate, `protocol.add(archive)`, then construct the map with `maxZoom = header.maxZoom` |
| D14 | Hybrid rendering: attacker circles, honeypot markers and the choropleth are native MapLibre sources/layers; transient animations are a Canvas 2D overlay |
| D15 | **The 2D arc is visually normalised.** Geographic endpoints → longitude unwrap → **world-copy choice frozen at spawn** (`worldCopyOffsetLng`, renderer-local) → `map.project()` per frame → **screen-space** quadratic bend with `bendPx = clamp(screenDist * FACTOR, MIN_BEND_PX, MAX_BEND_PX)`. Bend and copy offset are renderer-local. Great-circle sampling is **not** part of 4.0 (§9.3, §10) |
| D16 | Map view: `minZoom = max(1, header.minZoom)`, initial `zoom 2`, `maxZoom = header.maxZoom`, `renderWorldCopies: true`, `maxPitch 0`, rotation disabled |
| D17 | Theme switching via `map.setStyle(styleObject, {diff:true})` + an idempotent `style.load` hook with **per-object** guards and unconditional feature-state re-application |
| D18 | Choropleth in 4.0 over **Natural Earth 50m admin-0 map units**, trimmed and **merged to exactly one feature per `ISO_A2_EH`** (MultiPolygon), keyed with `promoteId`; raw counts are the source of truth (§8.5, §8.6) |
| D19 | Attacker circles adopt **visual-marker semantics** (zoom-scaled pixel radius instead of a metric 50 km radius) |
| D20 | Demo mode: `demo_events.py` (stdlib only) + `AttackMapServer.py --demo`; no `DemoServer.py` |
| D21 | `AttackMapServer.py` and `DataServer.py` gain `argparse` overrides with today's values as defaults |
| D22 | Target version **4.0.0**; WebGL2 becomes required because MapLibre 6.0.0 removed WebGL1 |
| D23 | `PM_MAXZOOM` by pre-committed rule: **7 if the measured artefact is ≤ 150 MB, otherwise 6** |
| D24 | The immutable artefact lives in `telekom-security/t-pot-attack-map` as release `basemap-<YYYYMMDD>-z<N>`, created **before** the 4.0.0 code release |
| D25 | The tpotce Dockerfile clones `telekom-security/t-pot-attack-map` |
| D26 | **No CI service.** All checks run locally via `tools/check_all.sh` (two modes + `--bootstrap`) |
| D27 | A "DEMO DATA" badge is shown while incoming messages carry `demo: true` |
| D28 | The choropleth is **on by default**, with a settings toggle and the source-IP caveat as small print |
| D29 | **Two startup domains.** `startDataChannel()` (WebSocket, stats, dashboard) is independent of `initMap()`; map failure never stops data acquisition. Dashboard state always updates immediately; map side effects follow the D34 lifecycle |
| D30 | **Cache restore is queue-protected but stays dormant.** `window.processRestoredAttack` is installed synchronously as a bounded queue (cap 1000, **keep-newest**: full → shift the oldest, append the new, warn once) and swapped for the real implementation after a successful map init; if the map never initialises the queue is discarded with one log line and no exception. 4.0 does **not** add a caller for `restoreAttackToMap` |
| D31 | **`.mjs` MIME middleware.** `AttackMapServer.py` installs an aiohttp response middleware that sets `Content-Type: text/javascript` on `FileResponse`s for paths ending in `.mjs`, before `prepare()` runs. Verified against aiohttp 3.14.3: `FileResponse` resolves MIME types through a module-private `MimeTypes()` instance that global `mimetypes.add_type()` never reaches, and only guesses when `Content-Type` is not already set — so the middleware is the smallest robust public-API guarantee (§7.5) |
| D32 | `static/data/countries.geojson` is committed together with a precompressed `countries.geojson.gz` sibling (aiohttp 3.14.3 serves `.gz`/`.br` siblings and sets `Content-Encoding`; `ENCODING_EXTENSIONS` verified at that tag); WP4 verifies it, and the pair is generated by one command |
| D33 | Licence notices live in `static/licenses/` as a concrete, verified file list (§20) |
| D34 | **Explicit map lifecycle `INITIALIZING` → `READY` \| `FAILED`.** Dashboard state updates on every Traffic event regardless of state. **All** map side effects (attacker circle, honeypot marker, transient animation) are gated together behind `READY`. During `INITIALIZING`, events go into a bounded **startup-only** queue (cap 400, keep-newest) drained in order on `READY`; on `FAILED` the queue is discarded and no map work runs. This is not a recovery queue — 4.0 has no map-recovery path (§7.1, §13.6) |
| D35 | **Dependency freshness invariant — all direct dependencies, legacy included.** The §6.0/§6.2/§6.4 version matrices are regenerated immediately before implementation; each direct dependency is pinned exactly to the newest stable version compatible with the actual T-Pot environment; a pin older than upstream stable requires an explicit justification in this document; a known relevant HIGH/CRITICAL vulnerability in a selected direct dependency is a release blocker; no floating production dependency (`latest`, `^`, `>=`) anywhere |
| D36 | **Legacy frontend stack resolved on usage evidence (§6.4).** Removed as unused: jQuery 3.7.1, Luxon 3.5.0, `bootstrap.min.js` (plus the stale `bootstrap.min.css.map`). Upgraded: Bootstrap CSS → 5.3.8, Chart.js → 4.5.1, Font Awesome → 7.3.1 (icon audit: all 24 used names present, `fas` prefix retained). Re-vendored from pinned refs: Inter v4.1, JetBrains Mono v2.304, Flagpack v2.1.0 flags. All retained third-party frontend assets appear in `vendor.lock` with version and provenance |
| D37 | **`window.map` single-assignment lifecycle.** `window.map = null` synchronously in `installSafeGlobals()`; exactly one successful assignment `window.map = map` immediately after `new maplibregl.Map(...)`; on a fatal post-construction init failure `map.remove(); window.map = null; mapLifecycle = 'FAILED'`. Dashboard compatibility code keeps checking `window.map` / `window.map?.resize?.()` — never a lexical `map` only |
| D38 | **Clear-Cache invariant: no pre-clear event may later appear on the map.** `window.clearMapVisuals()` — including its early pre-READY stub — always empties `startupTrafficQueue` and `pendingRestored`; when READY it additionally clears the renderer queue, the attacker source/registry, the marker registry and the choropleth state |
| D39 | **Explicit choropleth bridge, absolute counts.** `dashboard.js` calls `window.updateChoropleth?.(iso2, absoluteHits)` whenever a country's absolute hit count changes; `map.js` mirrors into its own `choroplethHits` map and derives `intensityCache` + feature-state from that mirror. `map.js` never reads `countryTrackingStats` (§8.6) |
| D40 | **No floating pip.** The Dockerfile does not upgrade pip; Alpine 3.23's `py3-pip` (25.1.1) installs the exact-pinned wheels. Application/tool dependencies: exact pins. Alpine OS packages: intentionally refreshed within the pinned 3.23 channel at image build (`apk -U upgrade`); bit-for-bit image reproducibility is explicitly not a goal (§15) |
| D41 | **Supported local tooling platforms: macOS Apple Silicon, Linux x86_64, Linux arm64.** Intel macOS is not supported (no `darwin_x86_64` hash pinned; documented, not implied). The pinned-CLI cache is keyed by OS **and** architecture (e.g. `go-pmtiles-1.31.2-darwin-arm64`) |
| D42 | **Dependency Freeze Gate (G-DEP)** — the first step of WP1, before any functional change: re-check **every** direct dependency category (Python, frontend runtime, retained legacy, vendored asset refs, tooling, Node/npm baseline, Alpine/Python platform, tpotce ES/Redis server versions) against its authoritative upstream and write one consolidated report to `docs/DEPENDENCIES.md` (columns: dependency/asset, current repo/HANDOFF version, latest stable upstream, selected version/ref, exact immutable pin, advisory status, compatibility evidence, reason if not latest). Pins are frozen only after the gate; if anything moved, update HANDOFF-v2, requirements/lockfiles/ref constants, `vendor.lock` expectations, release notes, and re-check the affected API assumptions. A relevant HIGH/CRITICAL advisory in a selected dependency stops the release |
| D43 | **The data channel must not race dashboard initialization — and must not poll.** `dashboard.js` assigns `window.attackMapDashboard` **synchronously at script evaluation** (Chart.js is a deferred script earlier in document order, so `Chart` is guaranteed to exist); the 3.0.1 `window.load` + `initWhenReady`/`updateStatusWithRetry` polling loops are deleted. Ordering chain, all spec-guaranteed: deferred scripts execute in document order → all complete before `DOMContentLoaded` → `connectWebSocket` runs at `DOMContentLoaded` → the first WebSocket event arrives later still. The dashboard-facing calls keep optional-chaining guards as defense in depth |
| D44 | **Theme changes are lifecycle-safe.** If `mapLifecycle !== 'READY'`, `updateMapTheme` records the desired theme and returns (no fetch, no `map` dereference, no unhandled rejection); on `READY` the current document theme is applied once; after `FAILED` map theme work is skipped while the dashboard theme continues; on `READY` the revision counter protects against async reordering |
| D45 | **Node toolchain baseline.** Generated committed artefacts (styles, country geometry, lockfiles) are produced under **Node.js 24.20.0 LTS** with its bundled npm 11 (lockfileVersion 3), recorded in a committed `.node-version`. Node ≥ 20 remains the compatibility floor for running the tooling; 24.20.0 is the recorded reproducibility baseline — "generated under Node X" is always known |

### 4.1 Answers to the mandated questions

| Q | Answer |
|---|---|
| 1-2 MapLibre version and why | 6.6.0; actively maintained line, no backports to v5, mature globe, same-origin worker without `blob:`, `GPUInitializationError` failure hook |
| 3-4 PMTiles JS / CLI | 4.5.0 ESM; go-pmtiles 1.31.2 via `tools/pmtiles_cli.sh` |
| 5 WebGL2 | Required since MapLibre **6.0.0** (v5 still had a WebGL1 fallback); T-Pot inherits it and degrades gracefully (§13.4) |
| 6 Distribution | Two small ESM graphs pulled in by `await import()` from the existing classic scripts |
| 7-8 CSP / worker | D8; same-origin module worker, `setWorkerUrl` set explicitly (§13.2) |
| 9-11 Glyph / sprite / PMTiles URLs | Resolved base + literal template for glyphs; absolute URLs for sprite and archive (§7.3) |
| 12 Sub-path hosting | Production case; `document.baseURI` strategy, tested at `/poc.html` and `/map/poc.html` |
| 13-15 Production artefact, maxzoom, size | Immutable T-Pot release asset; D23 rule; **MEASURE** in WP2 |
| 16 Dev presets | `dev` (world z0-4), `dev-ci` (world z0-2), `dev-europe` (bbox z0-6), all extracted from the T-Pot artefact |
| 17-18 Data vs style | General-purpose Protomaps + a style **allowlist**; the zoom cap alone does not remove landcover, landuse or roads (§8.4) |
| 19-20 Renderer and Globe | Hybrid; geographic endpoints, screen-space bend; globe work listed in §10 |
| 21 Event representation | `{id, src:{lng,lat}, dst:{lng,lat}, color, protocol, spawnedAt, seed}` — no shape data |
| 22 Antimeridian | `unwrapLongitude` on the destination + `chooseWorldCopy` **once at spawn**, offset frozen for the event's lifetime (§9.3) |
| 23 Globe routing | Future renderer derives a great-circle arc from the same endpoints (§10) |
| 24-26 Circles, markers, popups | §9.5, §9.6 |
| 27-28 Theme switching, feature-state | §7.6 |
| 29-30 Choropleth and geometry | Yes, WP7; Natural Earth 50m map units (§8.5) |
| 31 Licences | §20, files under `static/licenses/` |
| 32 aiohttp ranges | `FileResponse` implements `Range` (206 + `Content-Range` + `Accept-Ranges: bytes`, re-verified in `web_fileresponse.py` @ v3.14.3); still proven by the WP4 curl test, direct and proxied |
| 33-34 Failure UX | Preflight before construction (§13.5); WebGL2 probe + `GPUInitializationError` (§13.4) |
| 35-37 Demo mode | `--demo` only; four safeguards; no `DemoServer.py` |
| 38-39 Test determinism, flood | §17.5, §18 |
| 40 Release acceptance | §24 |
| 41-43 tpotce, duplication, mutable upstream | §15, §14 |
| 44-45 Asset categories, removals | §12.4, §12.3 |

---

## 5. Design review findings and resolutions

### 5.1 First review (18 findings, all valid)

Work-package order (B1), ESM bootstrap (B2), PoC base URI (B3), artefact lifecycle (B4), PMTiles
preflight (B5), arc geometry and globe wording (B6.1-6.4), glyph templates (I7), restoration guards
(I8), choropleth semantics (I9), circle semantics (I10), the WebGL2 version error (I11), safe
dashboard globals (I12), the geometry module (I13), canvas determinism (I14), sprite licensing
(I15), the trimming script (I16), automated regression (I17) and M1-M3 (I18). Resolutions are
listed in §0.2 with pointers into the body; two were accepted with refinements (I12: two of three
call sites were already guarded; I15: the sprite proved to be functionally required) and I17's scope
changed to local-only by maintainer decision.

### 5.2 Second review (this revision)

| ID | Finding | Severity | Verdict | Evidence | Resolution |
|---|---|---|---|---|---|
| B1 | The geodetic bend prioritises mathematical consistency over visual consistency on the 2D map | Blocker | **VALID** | Revision 2 argued the bend is "physically consistent everywhere" as a virtue. On Mercator, an equal angular displacement projects to very different pixel heights by latitude, so identical routes look unequal — the opposite of the product requirement | Screen-space bend with bounded pixel offset, renderer-local; great-circle sampling removed from 4.0 and documented as globe-renderer work (§9.3, §9.4, §10). `AttackEvent` carries no shape data |
| B2 | Async startup can break the cache-restore contract | Blocker | **PARTIALLY VALID — and the path is dead today** | `window.restoreAttackToMap` is defined at `static/cache-bridge.js:7` and has **no caller** anywhere in the repository; it also guards with `typeof window.processRestoredAttack === 'function'`, so a missing implementation silently skips rather than throwing. The hazard is therefore silent data loss in a dormant path, not an exception | A bounded queue is installed synchronously and drained after map init (D30); the dormant contract is preserved and explicitly not activated in 4.0 (§7.2) |
| B2.1 | The WebSocket lifecycle must not sit behind map success | Blocker | **VALID as a requirement; already structurally true** | `map.js:1459-1461` starts the socket from its own `DOMContentLoaded` listener, not from the map path. The risk is that the rewrite couples them | Two named startup domains, `startDataChannel()` and `initMap()`, plus an explicit invariant and an active failure test (D29, §7.1, §13.6) |
| B3 | `check_all.sh` mixes dev-ci and full-artefact checks | Blocker | **VALID** | A `dev-ci` artefact is z2; `PM_MAXZOOM` is 6 or 7 and `WORLD_PMTILES_SHA256` belongs to the full asset, so the two check sets cannot both pass on one file | Two modes with exact paths; the smoke test never writes `static/dist/` (§17.1) |
| B3.1 | `pmtiles show` assumed a system-installed CLI | Blocker | **VALID** | Revision 2 called `pmtiles show` directly while also stating that nothing is installed system-wide | `tools/pmtiles_cli.sh` is the single implementation of pin/download/verify/exec; all callers use it (§14.4) |
| B4 | 110m may not cover GeoIP ISO-2 codes | Blocker | **VALID — measured** | Downloaded and counted: 110m admin-0 countries = 177 features / 175 usable `ISO_A2_EH`, missing 31 of a 47-code GeoIP-relevant sample including **SG, HK, MO, MT, MC, LI, SM, VA, AD, BH, MV, MU, SC, BB, GU, VI, JE, GG, IM, GI, CW, AW, SX, BM, KY, VG, AI, MS, TC, FO, AX**. 50m countries = 242/237 (missing only GI). 50m map units = 265/247 (missing only GI), adding BQ, CC, CX, GF, GP, MQ, RE, SJ, TK, YT. Trimmed sizes: 110m ≈ 189 KB, 50m countries ≈ 1636 KB, 50m map units ≈ 1648 KB (3 decimals, deduped) | 4.0 ships **50m map units**; a committed coverage report lists matched and unmatched codes (§8.5) |
| B5 | Intensity must not be the authoritative choropleth state | Blocker | **VALID** | Revision 2 named `Map<iso2, intensity>` the source of truth, which loses the counts needed to renormalise when `maxHits` grows | Three explicit state layers with `countryTrackingStats` authoritative (§8.6) |
| I6 | The low-zoom Protomaps content claim is wrong | Important | **VALID** | Read from `protomaps/basemaps` `tiles/src/.../layers/`: `Landcover.java` `setZoomRange(0, 7)`, `Landuse.java` `setZoomRange(2, 15)`, `Roads.java` highways `pm:minzoom 3` / trunk 6, while `Buildings.java` starts at 11 and `Pois.java` at 11-17. So at z≤7 buildings and POIs are genuinely absent, but landcover, landuse and roads are present | §8.4 rewritten: the reduced look is a **style** decision; the zoom cap only limits detail |
| I6.1 | Prefer an allowlist over a deny-list | Important | **VALID** | A deny-list silently admits any new upstream layer id after a version bump | Allowlist plus a generator that **fails** on unknown ids and prints all/retained/dropped (§8.4) |
| I7 | Near-antipodal great-circle fallback is unsafe | Important | **PARTIALLY VALID — and now moot for 4.0** | The criticism is correct (`B = -A` gives a zero vector at `u = 0.5`, and identical vs antipodal are different cases), but with D15 the shipped renderer no longer interpolates on the sphere | 4.0 tests the cases that remain reachable: identical endpoints, exactly ±180 longitude difference, and both poles. The antipodal handling is specified for the future globe renderer in §10 so the knowledge is not lost |
| I8 | Is `Protocol({metadata:true})` needed? | Important | **VALID** | PMTiles 4.5.0 ESM source, `tilev4`: `if (t.type === "json") { … if (this.metadata) { return {data: yield p.getTileJson(t.url)} } let f = yield p.getHeader(); return {data:{tiles:[…], minzoom:f.minZoom, maxzoom:f.maxZoom, bounds:[…]}} }`. `getTileJson()` calls `getMetadata()`, an extra ranged fetch of the JSON metadata section, on the startup critical path. Attribution comes from our style and zoom from the header, so nothing consumes it | `new Protocol()`; WP4 records the request count (§7.1) |
| I9 | `vendor.lock` scope is ambiguous | Important | **VALID** | Revision 2 listed local source files (`map-boot.mjs`, `attack-geometry.mjs`) in a manifest described as a download product | Option B: explicit schema with `provenance_type` ∈ {`vendored`,`generated`,`local`} (§14.4) |
| I10 | Licence inventory and file inventory disagree | Important | **VALID** | Revision 2 required notices for six components but listed only `OFL.txt` and a sprite notice in the file inventory | `static/licenses/` with a named file per component, fetched by the vendor tool, hashed in `vendor.lock`, cross-referenced from §6.1, §12.2 and §20 |
| I11 | "One command from a fresh clone" needs a Playwright bootstrap | Important | **VALID** | A fresh clone has neither `tools/e2e/node_modules` nor a Chromium binary | `tools/check_all.sh --bootstrap` (network allowed) vs the normal run (never downloads); exact Playwright pin recorded in `tools/e2e/package-lock.json` (§17.1) |
| I12 | Test the `.mjs` MIME type explicitly | Important | **VALID** | aiohttp derives the type from the stdlib `mimetypes` database (`web_fileresponse.py` uses `MimeTypes()` and falls back to `application/octet-stream`), so the answer depends on the host Python version; Python 3.14 maps `.mjs` → `text/javascript`, older versions may not, and the container's Python is a moving target | Resolved in revision 2 with `mimetypes.add_type(...)`; **superseded in revision 4** — the third review proved that call ineffective for `FileResponse` (module-private `MimeTypes()` instance), so D31 is now a response middleware (§5.3 DB2, §7.5), still with explicit `curl -I` assertions direct and through nginx (§11 WP4) |
| A13 | Keep modulepreload/SRI hierarchy as it is | Additional | **VALID (agreement)** | — | §14.4 states the hierarchy explicitly and notes that dynamic-import correctness never depends on modulepreload |

Nothing in this round was rejected outright. Two findings are recorded as partially valid with
evidence (B2: the path is dead today, so the failure mode is silent loss rather than an exception;
I7: correct mathematics, but the code it criticises is no longer shipped in 4.0).

### 5.3 Third review (revision 4 — dependency freshness and final consistency)

All upstream facts verified 2026-08-31 against PyPI, the npm registry, the GitHub advisory
database, the tpotce repository and the aiohttp/CPython sources at the exact tags.

| ID | Finding | Severity | Verdict | Evidence | Resolution |
|---|---|---|---|---|---|
| DB1 | aiohttp 3.13.2 is stale and vulnerable; all server assumptions must be revalidated against the selected release | Blocker | **VALID** | GitHub advisories: CVE-2026-69244 (high, OOB heap read in the C response parser, ≤ 3.14.2), CVE-2026-69243 (WebSocket-upgrade request smuggling, ≤ 3.14.1), CVE-2026-59881 (≤ 3.14.1) and five further advisories ≤ 3.14.0. The map server performs a WebSocket upgrade behind nginx, so the smuggling fix is directly relevant | Pin **aiohttp==3.14.3** (latest stable, 2026-07-23, requires Python ≥ 3.10; Alpine 3.23 ships 3.12.14). Re-verified at v3.14.3 source: Range/206/`Content-Range`/`Accept-Ranges` (`web_fileresponse.py:340-419`), `.gz`/`.br` sibling serving (`ENCODING_EXTENSIONS`), MIME resolution via private `MimeTypes()` (line 52), `web.static` and WebSocket APIs unchanged for this app. WP4 re-proves everything empirically (§6.0, §11 WP4) |
| DB2 | `mimetypes.add_type` does not control aiohttp `FileResponse` | Blocker | **VALID** | `web_fileresponse.py` @ v3.14.3 line 52: `CONTENT_TYPES: Final[MimeTypes] = MimeTypes()` — a module-private instance seeded from CPython's built-in table; the global `mimetypes.add_type()` mutates the default DB, which this instance never reads. Guessing happens only `if hdrs.CONTENT_TYPE not in self._headers` (line 385), so a middleware-set type is respected | D31 rewritten: response middleware setting `text/javascript` for `.mjs` paths (§7.5). MIME assertions enumerate every shipped `.mjs` file, direct and through `/map/` (§11 WP4, §17.3) |
| DB3 | `vendor.lock` had a WP3→WP5 forward dependency | Blocker | **VALID** | WP3 created the final manifest including `attack-geometry.mjs` / `attack-renderer.mjs`, which WP5 introduces | WP3 writes the manifest for assets existing by WP3; WP5 adds its two modules, updates `static/vendor.lock` (now in its file list) and re-runs `--check-vendor` as acceptance (§11 WP3/WP5, §14.4) |
| DB4 | Map side effects beyond `renderer.spawn()` were not lifecycle-gated, and startup-interval events silently vanished from the map | Blocker | **VALID** | A Traffic event also updates the attacker-circle source and honeypot markers, which need an initialized map; the WebSocket typically connects before dynamic imports, preflight and `style.load` complete | D34: explicit `INITIALIZING`/`READY`/`FAILED` lifecycle; all map side effects gated together; bounded startup-only queue (400, keep-newest) drained on READY, discarded on FAILED; five timing tests added (§7.1, §13.6, §11 WP6) |
| DB5 | Per-frame world-copy recomputation can teleport a live arc by ±360° | Blocker | **VALID** | `k = round((centerLng − routeMeanLng)/360)` flips between two frames when the centre crosses the half-world threshold (e.g. centre 179 → 181 with route mean 0) | World copy chosen once at spawn, `worldCopyOffsetLng` stored renderer-locally for the event's lifetime; continuity tests at centres 170/179/181/190 (§9.3) |
| DI6 | Duplicate `promoteId` values must not be shipped as "harmless" | Important | **VALID** | 50m map units contain several features per code (GB, NO, PT, RS, PS, TZ, BE, BA, PG, AG, AU); future `GeoJSONSource` APIs and feature-id semantics assume unique ids | `vendor_countries.mjs` merges by `ISO_A2_EH` into one (Multi)Polygon feature per code and asserts uniqueness; report prints source/merged/final counts (§8.5) |
| DI7 | ISO coverage does not guarantee visual coverage of tiny states | Important | **VALID** | SG, HK, MC, LI, MT, AD, SM, VA are polygons of near-zero screen area at world zoom | WP7 tiny-state visual check; supplemental tiny-country point layer **explicitly deferred** (§22 item 11), not claimed as covered (§8.5) |
| DI8 | "The fill cannot visibly misalign" overclaims Natural Earth ↔ Protomaps alignment | Important | **VALID** | Independent datasets: coastlines, political and disputed boundaries and generalisation differ regardless of rounding | Wording replaced; the fill ships without its own outline so Protomaps boundary lines remain the visual authority (§8.5) |
| DI9 | `--bootstrap` prepared only Playwright | Important | **VALID** | `tools/styles` needs `npm ci` too, and `--release` invokes go-pmtiles, which would otherwise download outside bootstrap | Bootstrap now runs both `npm ci` workspaces, installs pinned Chromium and pre-caches the pinned go-pmtiles binary via `tools/pmtiles_cli.sh --fetch-only`; non-bootstrap modes pass `--require-cached` (§17.1); `.gitignore` gains `tools/styles/node_modules/` |
| DI10 | Restore-queue prose said oldest-drop but the pseudocode dropped the new event | Important | **VALID** | `if (pendingRestored.length >= 1000) return` returns before pushing | Keep-newest everywhere: `shift()` oldest, push newest, warn once — in D30, §7.2 code, tests and risk table; the startup queue (D34) uses the same policy and wording |

Elasticsearch note (client vs server): tpotce master ships Elasticsearch server **9.3.5**
(`tpotce/docker/elk/elasticsearch/Dockerfile:3`, Kibana/Logstash agree). Per Elastic's Python
client compatibility rules, the steady-state policy is **same major, client minor ≤ server
minor** — language clients are forward compatible with greater-or-equal server minors, so with a
9.3 server the newest client covered by that rule is **9.3.0**, not 9.5.0. (An 8.x client *can*
talk to a 9.x server through Elastic's REST API compatibility mode, but that path is intended for
upgrade windows, not as a steady-state configuration — which is why 8.18.1 is replaced rather
than retained.) If tpotce bumps the server to ≥ 9.4/9.5 before the 4.0.0 release, the client pin
is raised to match (**MAINTAINER / TPOTCE DEPENDENCY ACTION**: confirm the shipped ES version at
implementation start; see §23).

### 5.4 Fourth review (revision 5 — legacy dependencies, startup races, supply-chain closure)

All upstream facts re-verified 2026-08-31 (same-day re-check of every §5.3 pin included: all
unchanged). Usage evidence measured against the repository at `e798fcb`.

| ID | Finding | Severity | Verdict | Evidence | Resolution |
|---|---|---|---|---|---|
| EB1 | The basemap bootstrap had a circular dependency (`--from-upstream` needs `PM_BUILD`, which is only written afterwards), and the release timing was left as "sometime before WP6" | Blocker | **VALID** | §14.3 filled `PM_BUILD` in step 4 while `fetch_basemap.sh --from-upstream` consumed it in step 1 | `--upstream-build <BUILD_ID>` is an explicit input (D10); once the lock is filled it becomes the default. WP2 is complete only when the full 12-step lifecycle is closed, immutable release included (§11 WP2, §14.3) |
| EB2 | `window.map` had no explicitly specified successful assignment (and no reset on post-construction failure) | Blocker | **VALID** | The safe-globals sketch set `window.map = null` and WP6 removed the duplicate assignments, but no step said where the single real assignment happens; `dashboard.js:1099/2158` depend on `window.map` | D37: one assignment after construction, `map.remove(); window.map = null` on fatal failure; smoke-test assertions for both outcomes (§7.1, §13.6) |
| EB3 | Clear Cache raced the startup/restore queues: a pre-clear event could resurrect on READY | Blocker | **VALID** | The early `clearMapVisuals` stub was `() => {}` while `startupTrafficQueue`/`pendingRestored` buffered events for a later drain | D38: the stub always clears both queues; READY additionally clears renderer queue, attacker/marker registries and choropleth state; explicit tests for both queues (§13.6, §11 WP6) |
| EB4 | The failure panel's markup had no owning work package | Blocker | **VALID** | WP6 tested `showMapFailure()` but §12.1 listed "failure-panel markup" under `index.html` without a WP; WP8 carried the styles | WP6 introduces the functional `#map-failure-panel` markup and populates it; WP8 is styling only (§11 WP6/WP8, §12.1) |
| EB5 | The choropleth bridge was underspecified — `map.js` recomputing "from the authoritative counts" implied cross-script access to `countryTrackingStats` | Blocker | **VALID** | §8.6 named `countryTrackingStats` authoritative and §7.6 said feature-state is "recomputed from the authoritative counts" without saying which module holds what | D39: absolute counts over `window.updateChoropleth`; renderer-local `choroplethHits` mirror; four documented state levels; no hidden cross-script access (§8.6) |
| EI6 | "8.x client against a 9.x server is unsupported" was too categorical | Important | **VALID** | Elastic's REST API compatibility mode supports the previous-major client during upgrades | Wording corrected (§5.3 note, §6.0); the selected pin 9.3.0 and the steady-state rule are unchanged |
| EI7 | Supply-chain placeholders (`pinned commit`, `pinned tag`) remained | Important | **VALID** | D6, §6.1, §8.5 and §14.4 carried `@ pinned commit` / `at a pinned tag` | Real immutable refs recorded (§0.5 item 58, §6.1, §14.4): basemaps-assets `028c18f7…`, Natural Earth `v5.1.2` @ `f1890d9f…`, Inter `v4.1`, JetBrains Mono `v2.304`, Flagpack `v2.1.0` |
| EI8 | CSP wording claimed WebSocket same-origin enforcement that `connect-src 'self' ws: wss:` does not literally provide | Important | **VALID** | `ws:`/`wss:` schemes allow any host under those schemes | Threat-model wording corrected in §13.1/§13.3; policy unchanged; same-origin WebSocket behaviour is enforced by URL construction (`map.js` builds from `window.location.host`) and verified by the runtime network tests |
| EI9 | Rapid theme toggling could apply a stale style (async fetch reordering) | Important | **VALID** | `updateMapTheme` awaited `loadStyle` with no ordering guard | Revision counter in `updateMapTheme` (stale results discarded); WP4 check 12 extended with rapid non-awaited toggling and a final-style assertion (§7.6) |
| EI10 | `pip3 install --upgrade pip` is a floating build dependency | Important | **VALID** | Contradicts D35 while requirements are exact-pinned | Removed (D40); Alpine 3.23's pip 25.1.1 suffices for installing pinned wheels; OS-package vs application-dependency policy documented (§15) |
| EI11 | "macOS and Alpine" support claim vs pins for `darwin_arm64` only | Important | **VALID** | No `darwin_x86_64` hash existed in `basemap.lock` | D41: supported platforms named precisely (Apple Silicon macOS, Linux x86_64/arm64); Intel macOS explicitly unsupported; cache keyed by OS+arch |
| EI12 | Retained legacy vendored libraries lived outside the provenance model | Important | **VALID** | `vendor.lock` covered only 4.0-new assets; jQuery/Bootstrap/Chart.js/Luxon/FA/fonts/flags had no recorded provenance | §6.4 usage-evidence table; unused libraries removed; retained ones upgraded, exact-pinned and added to `vendor.lock` (WP3 records current state, WP8 performs the upgrades and updates the manifest) |

### 5.5 Fifth review (revision 6 — final verification and consistency pass)

Every §6.0/§6.2/§6.4 pin was re-queried against its authoritative upstream at the start of this
pass; none had moved. Repository evidence measured at `e798fcb`.

| ID | Finding | Severity | Verdict | Evidence | Resolution |
|---|---|---|---|---|---|
| FB1 | The revision history still asserted "8.x client against 9.x server is unsupported" | Important | **VALID** | §0.4 item 46 repeated the rationale that §0.5 item 64 had already corrected — two contradictory claims in one self-contained document | Item 46 reworded to record the change without the false rationale (§0.6 item 70); full-document sweep found no other standing stale claim |
| FB2 | `vendor_countries.mjs --verify` could not honour the offline promise if it re-derived output from the (uncommitted) Natural Earth source | Blocker | **VALID** | The raw `ne_50m_admin_0_map_units` input is not committed; the normal `check_all.sh` run bans downloads | Option B: `--verify` = fully offline structural validation of the committed output (hashes, unique ids, ISO coverage, provenance metadata incl. recorded source SHA-256); `--rebuild` = explicit network-enabled maintainer regeneration against the pinned v5.1.2 ref (§8.5, §11 WP3, §17.1) |
| FB3 | The data channel could race dashboard initialization | Blocker | **VALID — the race exists in 3.0.1** | `map.js:1261-1264` calls `window.attackMapDashboard.addAttackEvent()`/`.processAttackForDashboard()` **unguarded**; the object is created only on `window.load` inside a Chart.js polling loop (`dashboard.js:3661-3676`); the socket connects at `DOMContentLoaded`, which precedes `load` — an early Traffic message throws a TypeError today | D43: synchronous dashboard instantiation at script evaluation (Chart.js guaranteed by deferred document order), polling loops deleted, ordering chain documented, early-message test added (§7.1, §11 WP6) |
| FB4 | Theme switching unsafe during `INITIALIZING` / after `FAILED` | Important | **VALID** | `updateMapTheme` dereferences `map`, `header`, `pmtilesUrl`, which exist only after init; the §13.6 failure sweep deliberately clicks the theme toggle after failure | D44: pending-theme handling, no fetch and no map work outside `READY`; tests for toggle-during-init, toggle-after-failure, final-style == final `data-theme` (§7.6, §11 WP6) |
| FB5 | WP3 would have claimed upstream provenance for legacy files never proven against a ref | Important | **VALID** | §6.4 itself records the font subsets as "unknown legacy build", yet the WP3 manifest schema offered only `vendored`/`generated`/`local` | New `provenance_type: legacy` (source = baseline `e798fcb`, `upstream_ref = unknown`); WP8 eliminates every `legacy` entry; `--release` asserts none remains (§14.4, §24) |
| FB6 | "Node ≥ 20" is a floor, not a reproducibility baseline for generated committed artefacts | Important | **VALID** | Styles, country geometry and lockfiles are Node-generated; their output should not silently depend on an arbitrary Node ≥ 20 | D45: Node 24.20.0 LTS (npm 11, lockfileVersion 3) recorded in `.node-version`; floor stays ≥ 20 |
| FB7 | `redis:alpine` in the full-chain example is floating | Minor | **VALID** | §16 documented an unpinned image for a verification-adjacent procedure | Pinned to `redis:8.4.6-alpine`, matching the tested Redis 8.4 server line (§16) |
| FB8 | "Offline after bootstrap" was prose, not a test | Important | **VALID** | No step actually ran `check_all.sh` with the network blocked; transitive fetch surfaces (npm, Playwright, go-pmtiles, NE, browser) were unaudited as a set | §17.1: network-permission table naming the only network-allowed commands, plus the negative acceptance test (bootstrap → dev fetch → block network → `check_all.sh` green) (§0.6 item 77) |
| FB9 | "Nothing changes visually with latitude" overstates the arc guarantee | Minor | **VALID** | Mercator still scales projected distances with latitude; the algorithm normalises the **bend** in screen space, not every visual property | Wording corrected in §9.3 and §17.4 item 4: bend amplitude is screen-space-normalised and pixel-bounded, not latitude-scaled |
| FB10 | Sweep for further superseded revision text | — | **Executed** | Checked: aiohttp 3.13.x (historical mentions only, all marked), geodetic bend (§0.3/§5.2 record the correction), per-frame world copy (item 50 records the change), 110m dataset (recorded as disqualified), duplicate-id "harmless" (removed in rev 4), `Protocol({metadata:true})` (item 40 records the correction), CI (D26 stands), "untouched" legacy deps (rewritten in rev 5), placeholders (grepped, none), polling (3.0.1 polling now explicitly removed by D43) | No further standing stale claims; historical sections only describe corrections |

---

## 6. Dependency/version matrix

### 6.0 Python runtime dependencies (`requirements.txt`, updated in WP1)

Verified 2026-08-31 against PyPI, the GitHub advisory database and the tpotce sources; re-verified
unchanged at revision 6. Binding rule D35, executed as the named **Dependency Freeze Gate G-DEP**
(D42, the first step of WP1): regenerate the consolidated report (`docs/DEPENDENCIES.md`, covering
this table **and** §6.2 and §6.4) immediately before implementation; newest stable compatible,
pinned exactly, never floating; pins are frozen only after the gate.

| Dependency | 3.0.1 pin | Latest stable upstream | **Selected 4.0 pin** | Reason if not latest | Compatibility evidence | Security notes | Source |
|---|---|---|---|---|---|---|---|
| `aiohttp` | 3.13.2 | 3.14.3 (2026-07-23) | **3.14.3** | — (latest) | Requires Python ≥ 3.10; Alpine 3.23 ships Python 3.12.14. Range/206, `.gz` siblings, `web.static`, WebSocket verified at the v3.14.3 tag; WP4 re-proves empirically | Fixes CVE-2026-69244 (high, ≤ 3.14.2), CVE-2026-69243 / CVE-2026-59881 (≤ 3.14.1) and five advisories ≤ 3.14.0. **3.13.2 must not survive** | PyPI `aiohttp`, GitHub advisories, `aio-libs/aiohttp` @ v3.14.3 |
| `elasticsearch` | 8.18.1 | 9.5.0 (2026-08-04) | **9.3.0** (2026-02-03) | Steady-state rule: same major, client minor ≤ server minor; tpotce master ships ES server **9.3.5**, so 9.4/9.5 clients fall outside that rule | `DataServer.py` already uses the keyword API (`es.search(index=…, query=…, aggs=…, size=…, track_total_hits=…)`, `es.info()`) — no removed `body=` usage, so the 8→9 major is mechanical. An 8.x client against a 9.x server works only via Elastic's REST API compatibility mode (an upgrade-window mechanism, not a steady-state configuration) — hence the major bump | No open advisories for elasticsearch-py | PyPI `elasticsearch`, Elastic Python client compatibility rules, `tpotce/docker/elk/elasticsearch/Dockerfile:3` |
| `redis` | 7.1.0 | 8.1.0 (2026-07-30) | **8.1.0** | — (latest) | `map_redis` = Alpine 3.23 `redis` **8.4.2** server; `redis.asyncio.Redis.from_url`, pubsub and `RedisError` (the only APIs used, `AttackMapServer.py:11-95`) are unchanged in 8.x | No open advisories for redis-py 8.1.0 | PyPI `redis`, `pkgs.alpinelinux.org` v3.23, tpotce compose `map_redis` |
| `pytz` | 2025.2 | 2026.3.post1 (2026-07-25) | **2026.3.post1** | — (latest) | tzdata refresh only; no API change | none | PyPI `pytz` |
| `tzlocal` | 5.3.1 | 5.4.4 (2026-06-29) | **5.4.4** | — (latest) | Requires Python ≥ 3.10; `get_localzone()` unchanged | none | PyPI `tzlocal` |

Platform baseline: **Alpine 3.23** (unchanged, already used by tpotce) with **Python 3.12.14**
and **Redis server 8.4.2** from its package repository; Elasticsearch server **9.3.5** from
tpotce. Licences of all five packages are unchanged by these upgrades (Apache-2.0 / MIT); no new
notice files are required — server-side pip dependencies are not redistributed frontend assets.

### 6.1 New runtime assets (vendored, same-origin)

| File | Source | Version | Approx. size | Provenance type |
|---|---|---|---|---|
| `static/maplibre-gl.mjs` | npm `maplibre-gl` | 6.6.0 | 568 KB | vendored |
| `static/maplibre-gl-shared.mjs` | npm `maplibre-gl` | 6.6.0 | 490 KB | vendored |
| `static/maplibre-gl-worker.mjs` | npm `maplibre-gl` | 6.6.0 | 19 KB | vendored |
| `static/maplibre-gl.css` | npm `maplibre-gl` | 6.6.0 | 83 KB | vendored (SRI too) |
| `static/pmtiles.mjs` | npm `pmtiles` `dist/esm/index.js` | 4.5.0 | 15 KB | vendored |
| `static/map-boot.mjs` | repository | — | ~3 KB | local |
| `static/attack-geometry.mjs` | repository | — | ~3 KB | local |
| `static/attack-renderer.mjs` | repository | — | ~10 KB | local |
| `static/styles/{dark,light}.json` | generated from `@protomaps/basemaps` | 5.7.2 | ~120-200 KB each | generated |
| `static/basemaps/fonts/Noto Sans {Regular,Medium,Italic}/*.pbf` | `basemaps-assets` @ `028c18f713baecad011301ff7a69acc39bcc2ae7` | — | ~5 MB | vendored |
| `static/basemaps/sprites/v4/{light,dark}{,@2x}.{json,png}` | `basemaps-assets` @ `028c18f713baecad011301ff7a69acc39bcc2ae7` | — | ~100 KB | vendored |
| `static/data/countries.geojson` | Natural Earth 50m admin-0 map units, trimmed | `v5.1.2` (commit `f1890d9f152c896d250a77557a5751a93d494776`) | **1.65 MB measured** (3 decimals, deduped, pre-merge) | generated |
| `static/data/countries.geojson.gz` | same, precompressed | — | **554 KB measured** | generated |
| `static/licenses/*.txt` | upstream licence texts (§20), each fetched from the component's pinned ref above | — | ~40 KB total | vendored |
| `static/dist/world.pmtiles` | T-Pot immutable release asset | pinned by SHA-256 | **MEASURE** | not in git |

The worker and its imports cannot be covered by SRI by any mechanism (equally true in MapLibre v5);
`vendor.lock` covers them.

### 6.2 Development-time tooling (never shipped, never required at runtime)

| Tool | Version | Used for |
|---|---|---|
| Node.js | **24.20.0 LTS** — the recorded generation baseline (D45), committed as `.node-version`; ≥ 20 remains the compatibility floor (Playwright 1.62 requires it) | style generation, GeoJSON trimming, `node --test`, Playwright smoke test |
| npm | 11 (bundled with Node 24.20.0); `package-lock.json` files are lockfileVersion 3 | lockfile generation for `tools/styles` and `tools/e2e` |
| `@protomaps/basemaps` | 5.7.2 (latest stable, re-verified 2026-08-31; pinned in `tools/styles/package-lock.json`) | `layers()`, `namedFlavor()` |
| Playwright | **1.62.1** (latest stable, re-verified 2026-08-31; exact pin in `tools/e2e/package-lock.json`) | one local headless-Chromium smoke test |
| `go-pmtiles` | 1.31.2 (latest stable, re-verified 2026-08-31), fetched by `tools/pmtiles_cli.sh` | dev extracts, `show`, maintainer re-pin |
| Python | ≥ 3.10 locally (aiohttp 3.14 floor); the container runs **3.12.14** (Alpine 3.23) | servers, `update_hashes.py`, demo module |

The frontend runtime pins of §6.1 (MapLibre 6.6.0, PMTiles 4.5.0) were likewise re-verified as
the latest stable upstream releases on 2026-08-31 and retained — current, not inherited.

### 6.3 Removed dependencies

Removed by the map migration: Leaflet 1.x, Leaflet.fullscreen, D3 v7 with their CSS and sprite
assets (§12.3). Removed by the legacy dependency review on usage evidence (§6.4, WP8):
jQuery 3.7.1, Luxon 3.5.0, `bootstrap.min.js` and the stale `bootstrap.min.css.map`.

### 6.4 Legacy frontend dependencies — usage evidence and resolution (D36, executed in WP8)

Usage measured at `e798fcb` (repository-wide grep over `static/*.js` and `static/index.html`);
upstream verified 2026-08-31 against the npm registry, GitHub releases and the GitHub advisory
database.

| Dependency | Current repo version | Latest stable upstream | Usage evidence | **Resolution / selected 4.0 version** |
|---|---|---|---|---|
| jQuery | 3.7.1 (`static/jquery-3.7.1.min.js`) | 4.0.0 | **Zero usage**: no `$(`, `$.`, `jQuery` in `dashboard.js`, `map.js`, `cache-bridge.js` or inline scripts | **Removed** (outcome C). Upgrading an unused 87 KB library is carrying dead weight |
| Luxon | 3.5.0 (`static/luxon.min.js`) | 3.7.2 | **Zero usage**: no `luxon`, no `DateTime` in any application script | **Removed** (outcome C) |
| Bootstrap JS | 5.3.3 (`static/bootstrap.min.js`) | 5.3.8 | **Zero usage**: no `data-bs-*` attribute in `index.html`, no `bootstrap.*` API call; modals are driven by `style.display` in `dashboard.js` | **Removed** (outcome C). `static/bootstrap.min.css.map` is additionally a stale Bootstrap-3-era map file (references `less/`) and is deleted |
| Bootstrap CSS | 5.3.3 (`static/bootstrap.min.css`) | 5.3.8 | **Used**: 69 `modal`/`btn`/`row`/`col-*` class matches in `index.html` | **Upgrade → 5.3.8**, exact pin (patch releases within 5.3; no open advisories for 5.3.x) |
| Chart.js | 4.4.0 (`static/chart.umd.js`) | 4.5.1 | **Used**: 8 `new Chart(`/`Chart.*` call sites in `dashboard.js` | **Upgrade → 4.5.1**, exact pin (same major; only advisory on record affects < 2.9.4) |
| Font Awesome Free | 6.5.1 (`static/fontawesome/`) | 7.3.1 | **Used**: 24 icon classes in `index.html`, 2 in `dashboard.js`, prefix `fas` | **Upgrade → 7.3.1**, exact pin. **Icon audit passed**: all 24 used names exist in 7.3.1 — 19 canonical, 5 as maintained aliases (`cog`→`gear`, `save`→`floppy-disk`, `times`→`xmark`, `trash-alt`→`trash-can`, `undo`→`arrow-rotate-left`, `volume-up`→`volume-high`); the `fas` prefix remains a supported selector in 7.3.1's `all.min.css` |
| Inter (woff2 + `fonts.css`) | unknown legacy subset build | rsms/inter **v4.1** (`e3a3d4c57d5ecc01453a575621882a384c1995a3`) | **Used**: `font-family: 'Inter'` throughout `index.css` | **Re-vendor from the pinned v4.1 release** so version and provenance are known; `fonts.css` regenerated by the vendor tool; visual parity checked against the WP1 screenshots |
| JetBrains Mono (woff2) | unknown legacy subset build | JetBrains/JetBrainsMono **v2.304** (`cd5227bd1f61dff3bbd6c814ceaf7ffd95e947d9`) | **Used**: `font-family: 'JetBrains Mono'` in `index.css` | **Re-vendor from the pinned v2.304 release**, same procedure |
| Flag sprites (`static/flags/`, 251 SVG) | Flagpack, size "l" (32×24) — identified by byte-identical sample against upstream | Yummygum/flagpack-core **v2.1.0** (`094849d2ccc7e677dbb1663244fd0ca91759dab4`) | **Used**: flag rendering in popups/tables | **Pin to v2.1.0**: re-vendor/verify against the tagged commit so every file's provenance is recorded; MIT notice added to §20 |

Every retained entry lands in `static/vendor.lock` with `provenance_type: vendored`, its exact
version/ref and per-file hash (§14.4) — no vendored third-party code remains outside the
provenance model merely because it predates 4.0. The removals and upgrades are executed in WP8
(the package that already edits `index.html`, reruns `update_hashes.py` and deletes files); WP3
records the *current* legacy files in the manifest so tampering is detectable in the interim.

---

## 7. Target architecture

### 7.1 Two startup domains

`index.html` loads only classic `defer` scripts, whose execution order is document order — a spec
guarantee, not a race: `cache-bridge.js`, `map.js`, `dashboard.js`.

```js
// static/map.js — illustrative
let mapLifecycle = 'INITIALIZING';          // D34: INITIALIZING -> READY | FAILED
const startupTrafficQueue = [];             // startup-only, cap 400, keep-newest
const MAX_STARTUP_TRAFFIC = 400;

installSafeGlobals();            // §13.6: window.map = null, no-op APIs, restore queue (§7.2)
startDataChannel();              // §13.6 invariant: independent of the map
initMap();                       // async, may fail; never blocks the above

function startDataChannel() {
  document.addEventListener('DOMContentLoaded', connectWebSocket);   // as in 3.0.1 (map.js:1459)
}

// D43 — why the data channel cannot race dashboard initialization in 4.0.
// The 3.0.1 code HAS this race: messageHandlers.Traffic calls
// window.attackMapDashboard.addAttackEvent()/.processAttackForDashboard() UNGUARDED
// (map.js:1261-1264), but the object is only created on window.load inside a Chart.js
// polling loop (dashboard.js:3661-3676) — an early Traffic message throws today.
// 4.0 fix, with no polling:
//   1. dashboard.js assigns window.attackMapDashboard = new AttackMapDashboard()
//      SYNCHRONOUSLY at script evaluation. Safe because Chart.js (index.html:23) is a
//      deferred classic script that the spec executes before dashboard.js (line 554) —
//      document order, not timing.
//   2. All deferred scripts complete before DOMContentLoaded fires (spec guarantee), and
//      connectWebSocket runs at DOMContentLoaded — so the dashboard object exists before
//      the socket even starts connecting, and the first message arrives later still.
//   3. The 3.0.1 initWhenReady and updateStatusWithRetry polling loops are DELETED.
//   4. Dashboard-facing calls become optional-chained (window.attackMapDashboard?.…) as
//      defense in depth — the guard should never fire.
// "Data channel independent from the map" (D29) and "data channel never races the
// dashboard" (D43) are two separate invariants; both are tested (WP6 early-message test).

// messageHandlers.Traffic — the only entry point for live events
function handleTraffic(msg) {
  updateDashboardState(msg);                       // ALWAYS, in every lifecycle state
  const event = toAttackEvent(msg);
  if (mapLifecycle === 'READY') { renderMapTraffic(event); return; }
  if (mapLifecycle === 'INITIALIZING') {
    if (startupTrafficQueue.length >= MAX_STARTUP_TRAFFIC) {
      startupTrafficQueue.shift();                 // keep-newest: drop the OLDEST
      warnOnce('[MAP-STARTUP] queue full, dropping oldest');
    }
    startupTrafficQueue.push(event);
  }
  // FAILED: no map work; the dashboard path above already ran
}

// renderMapTraffic gates ALL map side effects together — never only renderer.spawn()
function renderMapTraffic(event) {
  addCircle(event);            // attacker source (MapLibre source update)
  addMarker(event);            // honeypot marker
  renderer.spawn(event);       // transient animation
}

async function initMap() {
  let boot, rendererModule;
  try {
    [boot, rendererModule] = await Promise.all([
      import('./map-boot.mjs'),        // maplibregl, openBasemap()
      import('./attack-renderer.mjs')  // AttackRenderer (imports attack-geometry.mjs)
    ]);
  } catch (e) { showMapFailure('Map engine failed to load', String(e)); return; }

  if (!hasWebGL2()) { showMapFailure('WebGL2 required', …); return; }        // §13.4
  const pmtilesUrl = new URL('static/dist/world.pmtiles', document.baseURI).href;
  let header;
  try { header = await boot.openBasemap(pmtilesUrl); }                      // §13.5
  catch (e) { showMapFailure('Basemap missing or unreadable', …); return; }

  const map = new maplibregl.Map({…});
  window.map = map;                       // D37: the ONE successful assignment —
                                          // dashboard.js checks window.map / window.map?.resize?.()
  …attach listeners, sources, renderer; await required initial readiness (style load)…
  mapLifecycle = 'READY';
  for (const e of startupTrafficQueue) renderMapTraffic(e);  // drain in order
  startupTrafficQueue.length = 0;
  …drain the restore queue (§7.2)…
}

// every showMapFailure() path (D37, D38)
if (window.map) { window.map.remove(); window.map = null; }  // fatal failure AFTER construction
mapLifecycle = 'FAILED';
startupTrafficQueue.length = 0;   // one log line; dashboard and WebSocket continue
pendingRestored.length = 0;       // §7.2
```

`installSafeGlobals()` sets `window.map = null` synchronously (§13.6); the assignment above is
the **only** place it ever becomes non-null — the duplicate `window.map = map` of 3.0.1
(`map.js:84`/`:89`) does not return. Browser assertions (smoke test): after a successful startup
`window.map` is the MapLibre instance; after a forced failure it is `null`.

Properties: no `<script type="module">` tag and therefore no cross-mode ordering question; awaiting
the dynamic import *is* the synchronisation; the renderer exists before anything can call it; the
vendored engine (WP3) and the renderer (WP5) are two independent module graphs introduced by
different work packages; a bootstrap failure is a caught rejection. Relative specifiers in a classic
script's `import()` resolve against that script's own URL, so `'./map-boot.mjs'` is
`static/map-boot.mjs` at both `/` and `/map/` — asserted in WP4.

**Invariant (D29): map failure must never stop the data channel.** `startDataChannel()` runs before
`initMap()` and shares no state with it. Traffic messages update dashboard state unconditionally
and in every lifecycle state.

**The startup queue is not a recovery queue (D34).** Between WebSocket connect and map readiness
lies a real asynchronous interval (dynamic imports → WebGL2 probe → PMTiles preflight → style
fetch → MapLibre construction → style load). The bounded queue (cap 400, keep-newest) exists only
so events received during that normal startup interval do not vanish from the map. After `READY`
it is drained in order, cleared, and never used again; on `FAILED` it is discarded with one log
line. There is no buffering for a later map recovery — 4.0 has no map-recovery path.

`map-boot.mjs`:

```js
import * as maplibregl from './maplibre-gl.mjs';
import {PMTiles, Protocol, TileType} from './pmtiles.mjs';

maplibregl.setWorkerUrl(new URL('./maplibre-gl-worker.mjs', import.meta.url).href);
const protocol = new Protocol();                 // D13: no metadata -> no extra request
maplibregl.addProtocol('pmtiles', protocol.tile);

export {maplibregl};
export async function openBasemap(absoluteUrl) {
  const archive = new PMTiles(absoluteUrl);
  const header = await archive.getHeader();      // one ~16 KB range request, cached
  if (header.tileType !== TileType.Mvt) throw new Error(`unexpected tile type ${header.tileType}`);
  if (header.maxZoom < header.minZoom) throw new Error('invalid zoom range in PMTiles header');
  protocol.add(archive);                         // key = source URL -> the warm cache is reused
  return header;
}
```

`protocol.add()` registers the instance under `archive.source.getKey()` (the URL), and the protocol
looks tiles up by the same key, so the preflight's header read is not repeated. With `metadata`
disabled the protocol builds the source's TileJSON from that header — `tiles`, `minzoom`, `maxzoom`,
`bounds` — and never fetches the archive's JSON metadata section.

### 7.2 Cache-restore contract (dormant, but safe)

Today `static/cache-bridge.js:7` defines `window.restoreAttackToMap`, which forwards to
`window.processRestoredAttack` when that exists — and **nothing calls it**, so cache-restored
attacks never reach the map in 3.0.1. 4.0 keeps the contract intact and makes it async-safe without
changing behaviour:

```js
// installSafeGlobals(), synchronous, before any await
const pendingRestored = [];
const MAX_PENDING_RESTORED = 1000;
window.processRestoredAttack = (event) => {
  if (pendingRestored.length >= MAX_PENDING_RESTORED) {
    pendingRestored.shift();                              // keep-newest: drop the OLDEST
    warnOnce('[MAP-RESTORE] queue full, dropping oldest');
  }
  pendingRestored.push(event);
};

// after a successful map init (mapLifecycle === 'READY')
window.processRestoredAttack = realProcessRestoredAttack;
for (const e of pendingRestored) realProcessRestoredAttack(e);
pendingRestored.length = 0;

// in every showMapFailure() path (mapLifecycle === 'FAILED')
pendingRestored.length = 0;   // plus one log line: restore skipped, map unavailable
```

Rules: the queue is bounded (1000, **keep-newest**: when full, shift the oldest and append the new
event, with a single warning — the same policy, and the same wording, as the startup traffic queue
of §7.1); if the map fails permanently, restore calls never throw, the queue is discarded with one
log line, and the non-map dashboard stays alive; **Clear Cache empties `pendingRestored` in every
lifecycle state** (D38 — a cleared event must never resurface when the map becomes READY); and
**4.0 adds no caller for `restoreAttackToMap`** — activating cache-to-map restoration would be new
behaviour and is out of scope (§22).

### 7.3 Style loading and URL rules

```js
async function loadStyle(theme, header, pmtilesUrl) {
  const res = await fetch(`static/styles/${theme}.json`, {cache: 'no-cache'});
  if (!res.ok) throw new Error(`style ${theme}: HTTP ${res.status}`);
  const style = await res.json();
  style.glyphs = new URL('static/basemaps/fonts/', document.baseURI).href + '{fontstack}/{range}.pbf';
  style.sprite = new URL(`static/basemaps/sprites/v4/${theme}`, document.baseURI).href;
  style.sources.protomaps.url = `pmtiles://${pmtilesUrl}`;
  style.sources.protomaps.maxzoom = header.maxZoom;
  return style;
}
```

| Asset | Committed form | Runtime form |
|---|---|---|
| style JSON | `static/styles/<theme>.json` | browser-resolved against `document.baseURI` |
| glyphs (templated) | placeholder, overwritten | **resolved base + literal template** |
| sprite | placeholder, overwritten | `new URL('static/basemaps/sprites/v4/<theme>', document.baseURI).href` |
| pmtiles | — | `pmtiles://` + `new URL('static/dist/world.pmtiles', document.baseURI).href` |
| countries GeoJSON | `static/data/countries.geojson` | absolute via `document.baseURI` |
| marker icon | `static/images/honeypot-marker.svg` | plain relative `<img src>` |
| websocket | — | `location`-derived `//host/websocket` (root-level nginx location) |

**Never** a leading slash, and **never** `new URL()` on a string containing `{…}` — it
percent-encodes the braces (`%7Bfontstack%7D`) and MapLibre then cannot substitute them. Assertions
(WP4 and the smoke test):

```js
console.assert(style.glyphs.includes('{fontstack}') && style.glyphs.includes('{range}'));
console.assert(!/%7B/i.test(style.glyphs));
console.assert(style.sprite.startsWith(location.origin));
console.assert(style.sources.protomaps.url.startsWith('pmtiles://' + location.origin));
```

### 7.4 Zoom semantics (archive is authoritative)

- Old Leaflet map: 256 px raster tiles, `minZoom 2`, `zoom 3`, `maxZoom 8`.
- MapLibre vector sources use 512 px tiles, so the same visual scale is one level lower: initial
  `zoom 2`, `minZoom = max(1, header.minZoom)`.
- **`maxZoom` comes from the PMTiles header**, never from a constant or the style: production z7 →
  `maxZoom 7` (today's Leaflet 8), `dev` z4 → 4, `dev-ci` z2 → 2. Display limit and data limit can
  never silently disagree, and no level is synthesised.
- `basemap.lock`'s `PM_MAXZOOM` is the *build-time* expectation; `tools/check_all.sh --release`
  asserts `tools/pmtiles_cli.sh show static/dist/world.pmtiles` reports it.
- v6 slices vector tiles instead of overscaling (`zoomLevelsToOverscale` default). WP4 records how
  `header.maxZoom` compares with `header.maxZoom + 1`; 4.0 ships the former.
- Fractional zoom is native; `zoomSnap`/`zoomDelta` are dropped. `renderWorldCopies: true`
  reproduces `worldCopyJump`'s visual effect.

### 7.5 Server changes (deliberately minimal)

- `AttackMapServer.py`: `argparse` (`--port`, `--redis-url`, `--demo`, `--demo-*`); the demo
  background task; the `.mjs` MIME middleware (D31); version string. No permanent routing change —
  `static/dist/world.pmtiles` is already covered by `web.static('/static/', 'static')`. WP4 adds a
  temporary `GET /poc.html` route, removed again in the same work package.

```python
# D31 — the .mjs MIME guarantee. Public API only: FileResponse.prepare() guesses the type
# only when Content-Type is not already set (aiohttp 3.14.3 web_fileresponse.py:385), and
# its guesser is a module-private MimeTypes() instance that mimetypes.add_type() never
# reaches (line 52). Do not touch aiohttp internals.
@web.middleware
async def mjs_content_type(request, handler):
    resp = await handler(request)
    if request.path.endswith(".mjs") and isinstance(resp, web.FileResponse):
        resp.content_type = "text/javascript"
    return resp
```

  Invariant: **every shipped `.mjs` file is served with a valid JavaScript MIME type**, both
  directly (`/static/*.mjs`) and through nginx (`/map/static/*.mjs`). The browser PoC is not the
  proof — the explicit header assertions of WP4 and §17.3 are.
- Commented Redis variants (15-17) replaced by the CLI flag, with today's values as defaults.
- `DataServer.py`: `argparse` (`--redis-host`, `--es-url`) and the version string only;
  `tests/test_DataServer.py` must still pass unchanged.

### 7.6 Theme switching and custom-layer restoration

`updateMapTheme(theme)` loads the style asynchronously and must therefore be **guarded against
async reordering**: a rapid dark → light → dark sequence can complete its fetches out of order,
and the last `setStyle` to run — not the last requested theme — would win. A revision counter is
the smallest robust fix:

It must also be **lifecycle-safe** (D44): the `MutationObserver` fires on every `data-theme`
change, including during `INITIALIZING` (before `map`, `header` and `pmtilesUrl` exist) and after
`FAILED` (the §13.6 failure sweep deliberately clicks the theme toggle then). Neither case may
dereference an undefined map, fetch a style pointlessly, or leak an unhandled rejection:

```js
let themeRevision = 0;
let pendingTheme = null;

async function updateMapTheme(theme) {
  if (mapLifecycle !== 'READY') {          // D44: INITIALIZING -> remember; FAILED -> no map work.
    pendingTheme = theme;                  // The dashboard's own theming is pure CSS and
    return;                                // continues regardless.
  }
  const revision = ++themeRevision;
  const style = await loadStyle(theme, header, pmtilesUrl);
  if (revision !== themeRevision) return;  // a newer request superseded this one
  map.setStyle(style, {diff: true});
}

// on becoming READY, after the queues are drained (§7.1):
const startTheme = pendingTheme ?? currentDocumentTheme();
pendingTheme = null;
if (startTheme !== themeTheMapWasBuiltWith) updateMapTheme(startTheme);
```

One handler is registered once: `map.on('style.load', reAddCustomLayers)`. (Caching both style
objects at init would also remove the fetch from the toggle path; the counter is kept because it
is smaller and also covers a future third theme.) After `FAILED`, theme toggles change only the
dashboard: `updateMapTheme` returns immediately and no style fetch happens.

```js
function reAddCustomLayers() {
  if (!map.getSource('countries'))      map.addSource('countries', countriesSourceSpec);
  if (!map.getLayer('choropleth'))      map.addLayer(choroplethLayerSpec, firstLabelLayerId());
  if (!map.getSource('attackers'))      map.addSource('attackers', attackersSourceSpec);
  if (!map.getLayer('attackers-layer')) map.addLayer(attackersLayerSpec);
  if (map.getSource('attackers'))       map.getSource('attackers').setData(attackersFeatureCollection());
  reapplyChoroplethFeatureState();      // ALWAYS — never inside a "source was missing" branch
}
```

- Guards are **per object**, because a reload can leave partial state (source present, layer gone).
- `firstLabelLayerId()` looks the insertion anchor up in the *current* style, so changing the
  allowlist cannot break insertion.
- `reapplyChoroplethFeatureState()` recomputes intensities from the renderer-local
  `choroplethHits` mirror (§8.6, D39) and pushes them with `map.setFeatureState` — no
  `dashboard.js` state is touched.
- Honeypot markers are DOM `maplibregl.Marker`s and survive `setStyle` untouched.
- `{diff:true}` is an optimisation only; correctness does not depend on it. WP6 calls the function
  twice in a row and asserts no duplicate layers.

---

## 8. Basemap / data architecture

### 8.1 Format and serving

One PMTiles archive at `static/dist/world.pmtiles`, read through the `pmtiles` protocol using HTTP
range requests against the existing static route. No tile server, no unpacking, one file to verify.

Guard: **no `.gz`/`.br` sibling may ever exist next to a `.pmtiles` file.** aiohttp 3.14.3 serves
precompressed siblings and sets `Content-Encoding` (`web_fileresponse.py`, `ENCODING_EXTENSIONS`),
which would break byte-range semantics for the PMTiles client. `tools/check_all.sh` asserts no such
file exists.

### 8.2 Size measurement (MEASURE, WP2)

```sh
# BUILD_ID = the Protomaps build selected from https://maps.protomaps.com/builds — an explicit
# input (D10): nothing reads PM_BUILD before basemap.lock is filled.
tools/fetch_basemap.sh --from-upstream --upstream-build "$BUILD_ID" --maxzoom 6 --out /tmp/z6.pmtiles
tools/fetch_basemap.sh --from-upstream --upstream-build "$BUILD_ID" --maxzoom 7 --out /tmp/z7.pmtiles
ls -l /tmp/z6.pmtiles /tmp/z7.pmtiles
tools/pmtiles_cli.sh show /tmp/z7.pmtiles
```

Rule **D23**: `PM_MAXZOOM = 7` if the z7 artefact is ≤ 150 MB, otherwise 6. Record in
`docs/BASEMAP.md`: size per candidate, chosen value, Protomaps build id, CLI version, date, Docker
image delta. Protomaps documents that each zoom level roughly doubles the file.

### 8.3 Artefact lifecycle and presets

```
  Protomaps build channel (mutable, 1-week retention, BLAKE3)
        |  maintainer only: tools/fetch_basemap.sh --from-upstream --upstream-build <BUILD_ID> --maxzoom N
        |  (BUILD_ID is an explicit input; it defaults to PM_BUILD only once basemap.lock is filled)
        v
  T-Pot immutable release  basemap-<YYYYMMDD>-z<N>   (tag + assets locked, SHA-256 in basemap.lock)
        +-- full       : plain GET of the release asset                    -> production, Docker
        +-- dev        : tools/pmtiles_cli.sh extract <asset> --maxzoom=4        (world, a few MB)
        +-- dev-ci     : tools/pmtiles_cli.sh extract <asset> --maxzoom=2        (world, few hundred KB)
        +-- dev-europe : tools/pmtiles_cli.sh extract <asset> --maxzoom=6 --bbox=-31,34,69,72
```

- **Local developers never depend on Protomaps retention.** The CLI's `extract` subcommand accepts
  a local *or remote* clustered archive, and the CLI documentation states that extracting a full sub-pyramid
  from zoom 0 "is always an efficient operation that makes minimal I/O or network requests to the
  source archive" — so a dev artefact can be pulled straight from the release URL by ranged reads.
- `dev` is deliberately **global**: a Europe-only extract cannot validate Japan → California,
  Auckland → Seattle, antimeridian routing or world copies. `dev-europe` exists only for
  label/detail work and is documented as unsuitable for those tests.
- Dev artefacts are not the pinned asset, so their SHA-256 is not compared against the lock; the
  script says so and prints the header zoom range it produced.
- Because zoom limits come from the header at runtime (§7.4), switching presets needs no config
  change and no style regeneration.

### 8.4 Visual reduction: measured facts, then a style allowlist

**Correction of an earlier claim.** It is *not* true that a maxzoom of 6-7 removes most detail
layers. Measured from `protomaps/basemaps` `tiles/src/main/java/com/protomaps/basemap/layers/`:

| Layer | Zoom availability | Present at z ≤ 7? |
|---|---|---|
| `Landcover.java` | `setZoomRange(0, 7)` | **yes — entirely inside our range** |
| `Landuse.java` | `setZoomRange(2, 15)`, subsets from 7 and 8 | **yes** |
| `Roads.java` | highways `pm:minzoom 3`, trunk 6, others 14 | **yes (major roads)** |
| `Buildings.java` | `setZoomRange(11, 15)` at the earliest | no |
| `Pois.java` | `pm:minzoom` 11-17 | no |

So the zoom cap removes buildings and POIs, and nothing else that matters. **The reduced T-Pot
appearance is a style decision.** The PMTiles archive remains a general-purpose Protomaps basemap
and this document does not claim otherwise.

**Allowlist, not deny-list.** `tools/styles/generate_styles.mjs` keeps only ids in a committed
`allowlist.json` — baseline: `background`, `earth`, `water*`, `boundaries`, `boundaries_country`,
and the country/region/locality label layers (`places_country`, `places_region`, `places_locality`,
plus the subregion label layer if present). Everything else (landcover, landuse, roads, transit,
buildings, pois, and anything new) is dropped.

The generator prints three lists — all upstream ids, retained ids, dropped ids — and **fails** if an
upstream id appears that is in neither the allowlist nor a committed `known_dropped.json`. A
`@protomaps/basemaps` upgrade therefore forces an explicit human decision instead of silently
changing the map's appearance.

`places_locality` uses `icon-image` (`capital` / `townspot`, empty from zoom 8 up), so keeping
locality labels means the sprite sheet is **required**, not decorative.

Physically reducing the tileset would need a Planetiler run over a planet PBF (hours, ~100 GB
scratch). Deferred (§22).

### 8.5 Country geometry: measured selection

Protomaps has no country polygons (`boundaries` is a line layer), so the choropleth needs its own
geometry. The relevant requirement is **matching the ISO-3166-1 alpha-2 codes the product actually
emits** — `DataServer.py:302` and `:292` take them from Elasticsearch GeoIP (`country_code2`), i.e.
MaxMind-style codes including small states and dependent territories.

Measured on 2026-08-31 against a 47-code sample of GeoIP-relevant codes (hosting hubs, micro-states
and territories):

| Candidate | Features | Usable `ISO_A2_EH` | Missing from the sample | Trimmed size (3 decimals, deduped) |
|---|---|---|---|---|
| `ne_110m_admin_0_countries` | 177 | 175 | **31**, incl. SG, HK, MO, MT, MC, LI, BH, MU, SC, BB, GU, VI, JE, GG, IM, GI, CW, AW, SX, BM, KY, VG, AI, MS, TC, FO, AX | 189 KB |
| `ne_50m_admin_0_countries` | 242 | 237 | 1 (GI) | 1636 KB |
| **`ne_50m_admin_0_map_units`** | 265 | **247** | 1 (GI) | **1648 KB / 554 KB gzip** |

110m is disqualified: Singapore and Hong Kong alone are among the most common source countries in
honeypot data, and both are absent. Map units add BQ, CC, CX, GF, GP, MQ, RE, SJ, TK and YT over
50m countries for +12 KB. Map units contain several features per code for some states (GB, NO,
PT, RS, PS, TZ, BE, BA, PG, AG, AU) — these are **merged during vendoring**, see below; duplicate
feature ids are not shipped.

**Decision (D18): `ne_50m_admin_0_map_units.geojson`** from Natural Earth **v5.1.2**
(commit `f1890d9f152c896d250a77557a5751a93d494776` — the tag's commit is recorded because tags
can move), transformed by `tools/vendor_countries.mjs`:

1. keep `ISO_A2_EH` and `NAME`, drop `-99`/empty ids;
2. **group features by `ISO_A2_EH` and merge their geometry into a single Feature per code**
   (a `Polygon`, or a `MultiPolygon` when a state has several parts — e.g. the GB pieces become
   one GB MultiPolygon). Result: **exactly one GeoJSON Feature per ISO-2 code**, so feature ids
   are unique, `promoteId`/feature-state behaviour is predictable, future `GeoJSONSource` APIs
   stay safe, and all overseas or disconnected parts still shade with the same intensity;
3. round coordinates to 3 decimals and drop consecutive duplicate points. Rounding introduces
   negligible additional positional error at the supported zoom levels; **exact alignment with the
   Protomaps/OSM boundary geometry is not guaranteed**, because the two datasets are independent
   (coastlines, political and disputed boundaries and generalisation differ). The choropleth is
   therefore a **fill with no independent outline**, rendered underneath the Protomaps boundary
   lines, so the basemap remains the visual boundary authority (§8.6, WP7).

Output: `static/data/countries.geojson` (~1.65 MB before merge; re-measured after merge) plus
`countries.geojson.gz` for aiohttp's precompressed serving (D32).

**Two modes, so the offline promise is literal (Option B).** The raw Natural Earth input is not
committed, so verification and regeneration are explicitly separate commands:

- **`node tools/vendor_countries.mjs --verify` — fully offline**, used by every `check_all.sh`
  mode. It validates only the **committed** output: GeoJSON structure, hashes against
  `vendor.lock`, **no duplicate feature id**, the ISO coverage report against the committed
  `tools/iso_universe.txt` / `tools/iso_unsupported.txt`, and the provenance metadata the
  generator recorded (source ref `v5.1.2` @ `f1890d9f…` and the **source file's SHA-256**, stored
  as constants in the tool and echoed into the report). It performs no network access; a missing
  or tampered file yields a non-zero exit naming it.
- **`node tools/vendor_countries.mjs --rebuild` — network-enabled, maintainer-only** (like
  `vendor_frontend.sh --update` and `fetch_basemap.sh --from-upstream`). It downloads the pinned
  Natural Earth v5.1.2 source, verifies the recorded source SHA-256 **before** processing (a
  moved upstream fails loudly), regenerates `countries.geojson(.gz)`, prints the full report —
  source tag, source feature count, merged feature count, final unique ISO count, features
  dropped with ISO values and names, output sizes and hashes — and diffs against the committed
  output.

`tools/check_all.sh` fails if a code is missing from both the geometry and the unsupported list
(`iso_universe.txt` = ISO-3166-1 alpha-2 officially assigned codes plus `XK`, which MaxMind emits
for Kosovo; `GI` and non-geolocated entities live in `iso_unsupported.txt`, so a future dataset
change makes the diff visible). The runtime additionally logs, once per session, any incoming
`iso_code` that matches no feature.

**ISO coverage is not visual coverage.** 50m geometry contains states that are effectively
invisible at world zoom (SG, HK, MC, LI, MT, AD, SM, VA — and GI has no polygon at all). WP7
includes a visual check for exactly these codes. A supplemental tiny-country **point layer**
driven from the same derived intensity (visible at low zoom, hidden once the polygon is visually
sufficient) is a sound design but is **explicitly deferred** in 4.0 (§22 item 11); this document
does not claim complete visual coverage merely because the ISO polygon exists.

### 8.6 Choropleth semantics and state layers

```
  dashboard.js  countryTrackingStats (3210-3258)   authoritative application statistics
        |
        |   window.updateChoropleth?.(iso2, absoluteHits)     <- the ONLY bridge (D39):
        |   called whenever a country's ABSOLUTE hit count     absolute counts, never +1 deltas
        |   changes; map.js never reads countryTrackingStats
        v
  map.js        choroplethHits: Map<iso2, number>  renderer-local raw-count mirror
        |   flush, at most 1x/s (scheduleChoroplethFlush)
        v
  map.js        intensityCache: Map<iso2, number>  derived rendering cache
        |
        v
  MapLibre      feature-state {intensity}          derived GPU/style state
```

```js
// map.js — the receiving side of the bridge
const choroplethHits = new Map();
const intensityCache = new Map();
window.updateChoropleth = (iso2, absoluteHits) => {
  choroplethHits.set(iso2, absoluteHits);
  scheduleChoroplethFlush();                       // batches to at most one flush per second
};
// on flush: maxHits = max(choroplethHits.values()); recompute ALL intensities from
// choroplethHits into intensityCache; push feature-state.
```

The bridge carries **absolute counts** so `map.js` can renormalise at any time without replaying
history, and so a missed call degrades to a stale value rather than a permanently wrong sum.
There is **no** hidden cross-script access: `dashboard.js` owns `countryTrackingStats`; `map.js`
owns everything below the bridge. Clear Cache clears **all four levels** (D38); a theme/style
reload rebuilds feature-state from the renderer-local `choroplethHits` (§7.6) without touching
`dashboard.js`.

| Question | Answer |
|---|---|
| What is counted | `Traffic` events grouped by the geolocation of the source IP — exactly the counter the dashboard already maintains |
| Aggregation window | the current cache/session lifecycle, including events restored from the IndexedDB cache into dashboard state |
| Authoritative state | **the raw counts**, never the normalised intensity: `intensity` alone cannot be renormalised when a new maximum appears. `countryTrackingStats` is the application authority; `choroplethHits` is the renderer's raw-count mirror fed over the D39 bridge |
| Denominator | `maxHits = max(choroplethHits.values())`, recomputed on each flush |
| Scale | `intensity(c) = log1p(hits(c)) / log1p(maxHits)`, clamped to `[0,1]` |
| Recomputation | when `maxHits` changes, **all** intensities are recomputed and re-pushed |
| Flush rate | at most once per second, batched |
| Reset | only "Clear Cache", which resets all three layers together |
| After a style reload | the cache and feature-state are rebuilt from the authoritative counts (§7.6) |

Product statement, repeated as small print beside the settings toggle:

> The choropleth shows **where observed events geolocate by source IP address**. It is not
> attribution: it does not establish that an attacker, operator or state actor is physically located
> in that country. Proxies, VPNs, hosting providers and compromised hosts all shift the apparent
> origin.

---

## 9. Attack-event model and rendering architecture

### 9.1 Renderer decision

| Approach | Animation quality | Throughput | Pan/zoom | Antimeridian | Globe reuse | Complexity |
|---|---|---|---|---|---|---|
| Native GeoJSON layers, `setData` per frame | good | poor — a worker round-trip per frame | correct | correct | good | low code, high runtime cost |
| Native layers + `line-trim-offset` | trim is per layer, not per feature | poor | correct | correct | good | high |
| Custom WebGL layer | excellent | excellent | correct | manual | needs the projection-aware variant | highest |
| **Canvas 2D overlay over projected endpoints** | equal to today's D3 output | good: one pass per frame | correct | correct via unwrap | endpoints reusable; arc shape re-derived | moderate |

Chosen: **hybrid** (D14). Persistent geometry is native (GPU-side, zero per-frame JS); transient
animation is a Canvas 2D overlay behind an `AttackRenderer` interface:

```
AttackEventModel  (geographic endpoints + metadata, no shape data)
      |
      +-- MercatorCanvasRenderer   # 4.0: project endpoints, bend in screen space
      +-- GlobeRenderer            # future: derive a globe-appropriate arc (§10)
      +-- CustomWebGLRenderer      # future: only if event volume demands it
```

Interface: `spawn(event)`, `renderFrame(tMs)`, `clear()`, `resize()`, `attach(map)`, `detach()`.
Nothing in the WebSocket path, the cache path or the model knows a canvas exists.

### 9.2 Model and module split

```js
// static/attack-geometry.mjs — pure, geographic, imported by the renderer AND by node --test
export function unwrapLongitude(refLng, lng)      // nearest ±360 representation of lng to refLng
export function chooseWorldCopy(srcLng, dstLng, centerLng)  // k*360 offset toward centre — called ONCE per spawn (§9.3)
export function easeCircleIn(t)

// static/attack-renderer.mjs — renderer-local presentation maths, also unit-tested
export function bendPixels(screenDistance)        // clamp(dist*FACTOR, MIN_BEND_PX, MAX_BEND_PX)
export function quadraticPoint(p0, c, p1, u)
export class AttackRenderer
```

```js
// canonical event — created in messageHandlers.Traffic, stored geographically
AttackEvent = { id, src:{lng,lat}, dst:{lng,lat}, color, protocol, spawnedAt, seed }

// renderer-local state — created by MercatorCanvasRenderer.spawn(), never persisted
RendererEvent = {
  event,                 // the canonical AttackEvent above
  dstLngUnwrapped,       // unwrapLongitude(src.lng, dst.lng), chosen once
  worldCopyOffsetLng,    // k * 360, chosen once at spawn (§9.3) — frozen for the lifetime
}
```

`RendererEvent` lives only inside the renderer's animation queue. `worldCopyOffsetLng` is never
written into `AttackEvent`, the cache, the wire format or dashboard state.

Rules:

- `messageHandlers.Traffic` (`static/map.js:1125-1266`) stops calling `map.latLngToLayerPoint`
  (today 1131-1132) and hands an `AttackEvent` to the renderer if one exists (§7.1).
- **No shape, bend, pixel or projection value is ever stored** in the event, the wire format, the
  cache or the geometry module. `seed` only carries per-event randomness (bend direction and small
  variation) so the shape is stable across frames; the renderer decides what it means.
- Persistence keeps lng/lat, and the `"lat,lng"` string keys of `circleAttackData` /
  `markerAttackData` stay byte-identical.
- Browser and Node import the same modules; there is no `window.__attackGeo` back door.

### 9.3 Geometry: geographic where it matters, visual where it matters

Priorities, deliberately split:

| Geographic correctness | Visual consistency |
|---|---|
| source and destination position | apparent arc height |
| shortest-path / antimeridian choice | line appearance |
| world-copy binding to what the user sees | head-dot and ring appearance |
| endpoints re-projected every frame (pan/zoom-proof) | uniformity across latitudes and route lengths |

**Per spawn (geographic, chosen once, frozen for the event's lifetime).**
`dstLngUnwrapped = unwrapLongitude(src.lng, dst.lng)` so the route takes the short way; then
`worldCopyOffsetLng = chooseWorldCopy(src.lng, dstLngUnwrapped, map.getCenter().lng)` selects the
world copy **nearest the map centre at spawn time**. Both values are stored in the
`RendererEvent` (§9.2) and never recomputed. Rationale: recomputing
`k = round((centerLng − routeMeanLng)/360)` per frame jumps by ±1 the moment the centre crosses
the half-world threshold (route mean 0: centre 179 → k=0, centre 181 → k=1), which would teleport
a running arc by an entire world copy between two frames. With the offset frozen, panning away
simply moves the attack naturally out of view — it never teleports to another copy to stay
visible; a *newly spawned* event picks the copy nearest the centre at its own spawn time.

**Per frame (visual).**

```
  srcLng = event.src.lng + worldCopyOffsetLng          // frozen offset, no per-frame choice
  dstLng = dstLngUnwrapped + worldCopyOffsetLng
  S = map.project([srcLng, src.lat]);  D = map.project([dstLng, dst.lat])
  dist   = hypot(D.x - S.x, D.y - S.y)
  dir    = (seed % 2) ? +1 : -1                                // direction only, from the event seed
  bendPx = dir * clamp(dist * FACTOR, MIN_BEND_PX, MAX_BEND_PX)
  C      = midpoint(S, D) + unitNormal(S, D) * bendPx        // perpendicular in screen space
  trail  = 24 samples of quadraticPoint(S, C, D, u), u in [0, easeCircleIn(t)]
```

`FACTOR`, `MIN_BEND_PX` and `MAX_BEND_PX` are calibrated once in WP6 against the WP1
before-screenshots (starting points: 0.22, 12 px, 140 px). Stated precisely: **the bend is
screen-space-normalised, not latitude-scaled** — its amplitude derives from the projected screen
distance and is bounded in pixels, so routes of comparable screen-space length get comparable
visual curvature regardless of geographic latitude, and a Tokyo → San Jose arc and a
Frankfurt → Amsterdam arc look like the same kind of object. (Mercator still changes the
projected distance between geographic endpoints with latitude — that is inherent to the
projection; what a fixed *angular* displacement could not achieve is exactly this bounded,
distance-derived pixel bend.)

Degenerate cases the shipped code must handle, all unit-tested:

- `dist < 1 px` (identical or nearly identical endpoints): draw the rings only, no trail, no
  normal vector computed (no division by zero);
- exactly ±180 longitude difference: `unwrapLongitude` picks the deterministic (positive) direction,
  so behaviour is stable rather than sign-flipping between frames;
- both poles / extreme latitudes: `map.project` stays finite because Mercator clamps latitude;
  the renderer additionally skips events whose projected points are non-finite;
- panning across the half-world threshold during a live animation: `worldCopyOffsetLng` is frozen
  at spawn, so the projected geometry changes continuously with the centre and an in-flight arc
  **never snaps to another copy** — it may move out of view, which is correct.

Unit tests (`node --test`, exact): `unwrapLongitude(139.7, -121.9)` yields a span ≤ 180;
`unwrapLongitude(0, 180)` and `(0, -180)` return the same deterministic value; `chooseWorldCopy`
for centres 0, ±350, +710 keeps the shifted pair's mean within 180° of the centre; **world-copy
continuity**: for an event spawned at centre 170, moving the centre through 179 → 181 → 190 keeps
`worldCopyOffsetLng` constant while the projected midpoint moves continuously (no ±360°
discontinuity between consecutive centres); `bendPixels` is monotone and respects both bounds;
`quadraticPoint(…, 0)` and `(…, 1)` return the endpoints exactly; `easeCircleIn(0) === 0`,
`easeCircleIn(1) === 1`.

### 9.4 Canvas renderer specifics

- One `<canvas class="attack-canvas">` appended to `#map`, `inset: 0`, `pointer-events: none`, above
  `.maplibregl-canvas` and below `.maplibregl-marker` / `.maplibregl-popup` (verified visually in
  WP6). Backing store sized by `devicePixelRatio`, `ctx.scale(dpr, dpr)`, resized on the map
  `resize` event.
- Per frame: two `map.project()` calls per event (using the frozen `worldCopyOffsetLng` of §9.3 —
  no per-frame copy choice), then the screen-space bend and
  24-point trail of §9.3; head dot r = 6 at the progress point; impact and source rings r 0→50,
  `lineWidth 3`, alpha 1→0. Phase timings as today: travel 0-700 ms, impact 700-1400 ms, source ring
  0-700 ms. Trail `lineWidth 2`, `globalAlpha 0.8`.
- Loop management: `requestAnimationFrame` only while the queue is non-empty and `!document.hidden`;
  events self-expire after ≤ 1.4 s; hard cap 300 concurrent, oldest dropped (flood fuse). The
  existing `isWakingUp` / `document.hidden` spawn guards are preserved.
- Deleted with this change: `svgRenderer`, `svg`, the `zoomstart` clear (`map.js:364-366`),
  `translateAlong`, the pixel-space `calcMidpoint`, and the D3 include.
- Cost per frame: 2 projections + 24 curve evaluations per event; at the 300-event cap that is 600
  projections — an order of magnitude cheaper than sampling geography per point (§18).

### 9.5 Attacker circles: an intentional change of semantics

Today: `L.circle(srcLatLng, 50000, …)` (`static/map.js:633`) — a **metric** 50 km radius that
shrinks on screen when zooming out. Evidence that the number carries no product meaning: it appears
exactly once in the repository, and no legend, tooltip, popup or documentation mentions a distance,
radius or accuracy.

**Decision D19 — visual-marker semantics.** The circle layer uses a zoom-interpolated pixel radius
(`circle-radius: ['interpolate',['exponential',2],['zoom'], 1,R1, 7,R7]`, `R1`/`R7` calibrated in
WP6 against the WP1 screenshots), so the marker stays useful at world view. This is a deliberate
change, not an accidental loss. Rejected alternative: generating geodesic circle polygons to keep a
true 50 km radius — cost and geometry for a value nothing consumes.

Unchanged: features carry `{key, color}`; paint uses `['get','color']`, `circle-opacity 0.2`,
`circle-stroke-width 2`; the LRU cap of 200 and its eviction ending in `source.setData(fc)`.

### 9.6 Markers and popups

- `new maplibregl.Marker({element, anchor:'bottom', offset:[0,8]})`, `element` being
  `<img src="static/images/honeypot-marker.svg" width="48" height="48" class="honeypot-marker">`.
  The Leaflet original used `iconSize [48,48]`, `iconAnchor [24,40]`, `popupAnchor [0,-48]`, so the
  attached popup takes `offset: [0,-48]`. DOM markers survive `setStyle`. LRU cap 200 unchanged.
- Popups: `maplibregl.Popup` (`maxWidth '350px'` + `modern-popup attacker-popup`, `'400px'` +
  `honeypot-popup` for markers) with `setDOMContent(createAttackerPopup(...))`. The existing DOM
  builders (`map.js:805`, `:1009`) are reused unchanged; attacker popups are built on click, which
  also replaces the old refresh-on-click logic; `mouseenter`/`mouseleave` set the pointer cursor.

---

## 10. Future Globe compatibility (stated conservatively)

Not implemented in 4.0. What 4.0 guarantees:

1. **One engine, one dataset, one style per theme.** Enabling a globe is
   `map.setProjection({type:'globe'})` after `style.load`.
2. **No change to the event model, the wire format or persistence.** `AttackEvent` holds geographic
   endpoints and metadata only — no projected values, no bend, no shape.
3. **Native layers are projection-agnostic** (circles, fills, markers).

What a globe renderer will have to add — explicitly *not* solved by 4.0:

- **A different arc derivation.** The Mercator renderer's bounded screen-space bend is
  intentionally 2D. A globe renderer should derive a geographic arc from the same endpoints, e.g.
  great-circle sampling with a small out-of-plane rotation:
  `N = normalize(A × B)`, `S(u) = slerp(A,B,u)`, `S'(u) = normalize(cos θ(u)·S(u) + sin θ(u)·N)`,
  `θ(u) = k·σ·sin(πu)`. That formula needs its own degenerate-case handling, which 4.0 does not
  ship: `σ ≈ 0` (identical endpoints → no arc) and `σ ≈ π` (antipodal → `A × B` vanishes and linear
  interpolation gives the zero vector, so a deterministic orthogonal axis must be chosen). Tests for
  identical, near-identical, exactly antipodal and near-antipodal endpoints belong to that work.
- **Horizon / back-side visibility**: `map.project()` also returns coordinates for points behind the
  planet, so samples must be culled.
- **Limb crossing**: a path leaving and re-entering the visible hemisphere must be split into
  several polylines.
- **Adaptive subdivision**: fixed sampling is ample in Mercator at zoom ≤ 7; on a globe, screen-space
  spacing varies with orientation.
- **Projection-specific clipping and depth cues** if the result is to look right.

Accurate summary: *4.0 stores projection-independent geographic attack events and keeps the renderer
replaceable, so a globe needs no change to the data model, the wire format or persistence; the globe
renderer itself is real work, not a switch.*

Out of scope and not designed here: terrain, pitch, 3D arcs. 4.0 sets `maxPitch: 0`.

---

## 11. Detailed sequential work packages

### 11.0 Order and dependency proof

| WP | Title | Depends on | Introduces | State afterwards |
|---|---|---|---|---|
| WP0 | Baseline / behaviour inventory | — | `docs/BASELINE.md` | runnable (3.0.1 unchanged) |
| WP1 | **G-DEP dependency freeze gate**, demo generator, before-screenshots | WP0 | `docs/DEPENDENCIES.md` (D42), `demo_events.py`, CLI flags, `.mjs` MIME middleware, **`requirements.txt` §6.0 pins** | runnable, Leaflet map + demo mode; all pins frozen |
| WP2 | Basemap acquisition, CLI helper, measurement, **immutable release** | — | `tools/pmtiles_cli.sh`, `tools/fetch_basemap.sh`, `tools/basemap.lock` (fully filled), `docs/BASEMAP.md`, the published `basemap-<date>-z<N>` release | runnable; **artefact lifecycle completely closed** — every later WP operates against the released artefact or extracts of it |
| WP3 | Vendor engine, assets, styles, countries, licences | — | `static/maplibre-*`, `pmtiles.mjs`, `map-boot.mjs`, styles, glyphs, sprites, `countries.geojson(.gz)`, `static/licenses/*`, `vendor.lock`, `tools/vendor_*`, `tools/iso_*` | runnable; new files not referenced by `index.html` |
| WP4 | **PoC gate (blocking)** | WP2, WP3 | temporary `static/poc.html` + temporary `GET /poc.html` | runnable; both temporaries deleted in WP4 |
| WP5 | Attack geometry + renderer | WP3 | `attack-geometry.mjs`, `attack-renderer.mjs`, `tests/js/*`, **`vendor.lock` update (adds the two local modules)** | runnable; modules tested and manifest-covered, not yet wired in |
| WP6 | map.js migration | WP3, WP4, WP5 | rewritten `map.js`, `index.html` swap, dashboard touch points | runnable on MapLibre; Leaflet files still on disk |
| WP7 | Choropleth | WP3, WP6 | choropleth layer, `window.updateChoropleth`, settings toggle | runnable |
| WP8 | CSS / CSP / badge / removals / **legacy dependency cleanup** | WP6, WP7 | `index.css` port, new CSP, demo badge, Leaflet+D3 deletion, §6.4 legacy removals and upgrades, `vendor.lock` update, failure-panel **styling** | runnable; Leaflet, jQuery, Luxon and Bootstrap JS gone; retained legacy libs current |
| WP9 | Docker / tpotce | WP2, WP8 | `tpotce/docker/elk/map/Dockerfile` | image builds with the artefact |
| WP10 | Local checks, docs, release | all | `tools/check_all.sh`, `tools/e2e/*`, README, versions | release-ready |

No work package references a file created by a later one: WP1 owns the before-screenshots (WP0 only
defines them), WP4 consumes only WP2/WP3, WP6 is the first package that calls the WP5 renderer, and
**no work package validates a manifest entry for a file introduced by a later WP** — `vendor.lock`
always describes the repository as it exists at the end of the package that last touched it (WP3
covers everything existing by WP3; WP5 adds its own modules and re-verifies).

### WP0 — Baseline and behaviour inventory (0.5 d)

**Objective.** Freeze the "before" state. **Files.** `docs/BASELINE.md` (deleted in WP10).

1. List every behaviour to preserve with its line reference: attacker circles and popups, honeypot
   markers and popups, `handleStats`, protocol colours, both LRU caps, connection-status pill,
   clear-cache, theme switching, fullscreen, tab-wake suppression, and the WebSocket lifecycle at
   `map.js:1459-1461`.
2. Define the screenshot matrix for WP1: dark and light, Leaflet zoom 3/5/7, with and without an
   open popup, plus one frame mid-animation for arc-shape comparison.
3. Record cleanups: duplicate `window.map = map` (84, 89), unused `attackLines` (94), dead
   `getCoordinates` branch (143-157), and the dormant `restoreAttackToMap` contract (§7.2).
4. Re-confirm both defects: `grep -rn getCoordinates .` (call sites only) and
   `grep -rn restoreAttackToMap .` (definition only).

**Acceptance.** Every preserved behaviour has a line reference; the screenshot matrix is defined.

### WP1 — Demo tooling, dependency pins and before-screenshots (1 d)

**Objective.** Frontend work without Elasticsearch, Redis or Docker; deterministic event content;
the server stack on current, non-vulnerable dependencies.
**Files.** `docs/DEPENDENCIES.md`, `demo_events.py`, `tests/test_demo_events.py`,
`AttackMapServer.py`, `DataServer.py`, `requirements.txt`, `docs/BASELINE.md`.

- **Step 0 — Dependency Freeze Gate G-DEP (D42), before any functional change.** Re-check
  **every** direct dependency category against its authoritative upstream: Python (§6.0),
  frontend runtime and tooling (§6.2), retained legacy and vendored asset refs (§6.4), the
  Node/npm baseline (D45), the Alpine/Python platform, and the ES/Redis server versions tpotce
  actually ships. Write the consolidated report to `docs/DEPENDENCIES.md` (dependency/asset;
  current repo/HANDOFF version; latest stable upstream; selected version/ref; exact immutable
  pin; advisory status; compatibility evidence; reason if not latest). **Gate acceptance:** the
  report exists and is current; every selected pin is newest-stable-compatible or justified; no
  relevant HIGH/CRITICAL advisory. If anything moved: update this HANDOFF, the lock/ref
  constants, `vendor.lock` expectations, and re-check the affected API assumptions before
  proceeding. Only after the gate are the pins frozen.
- **`requirements.txt` → the frozen §6.0 pins** (as of this revision: `aiohttp==3.14.3`,
  `elasticsearch==9.3.0`, `redis==8.1.0`, `pytz==2026.3.post1`, `tzlocal==5.4.4`).
  Revalidate against the running server: `python3 -m unittest discover tests` green,
  WebSocket connect/reconnect works, and the §17.2 range test passes — WP4 then re-proves every
  aiohttp assumption (Range, MIME, siblings, WebSocket) against exactly this version.

- `demo_events.py`, stdlib only at import time (the Redis publisher imports `redis` lazily).
- Emits exactly the `Traffic` field set of `DataServer.py:362-384` plus `"demo": true`, and `Stats`
  every 10 s with counters derived from what was emitted.
- Curated fixtures: ~25 source cities on all continents including antimeridian pairs (Tokyo → San
  Jose, Auckland → Seattle), high latitudes (Reykjavík, Ushuaia) and the equator/prime-meridian
  region; one exact repeated coordinate with several `src_ip`s; 3 synthetic sensors; real honeypot
  names; a curated ~15-entry subset of `service_rgb` ordered so the first N events cover every
  protocol once. The subset is duplicated with a comment naming `DataServer.py:30` as the source of
  truth, so `DataServer.py` and its test stay untouched.
- **Country coverage in the fixtures:** include at least SG, HK, MO, MT, MC, LI, GF, RE, XK and one
  code that is intentionally unsupported (GI), so the choropleth's matching path is exercised
  against exactly the cases §8.5 cares about. The 25-city set is not treated as proof of coverage —
  §8.5's ISO report is.
- Flags: `--demo`, `--demo-seed`, `--demo-rate` (default 2), `--demo-burst`,
  `--demo-scenario basic|antimeridian|single-location|flood`.
- Entry points: `python3 AttackMapServer.py --demo` (no Redis/ES/Docker) and
  `python3 -m demo_events --publish-redis redis://…`. No `DemoServer.py`.
- Safety: no env-var equivalent; banner at start and every 60 s; `"demo": true` on every message.
- Also: `--port` / `--redis-url` on `AttackMapServer.py`, `--redis-host` / `--es-url` on
  `DataServer.py`, deletion of the commented dev lines (15-17), and the `.mjs` MIME middleware
  (D31, §7.5) — it belongs here because WP4 depends on it.
- Capture the WP0 screenshot matrix against the **current Leaflet map** with `--demo-seed 42`.

**Tests.** `python3 -m unittest discover tests` green. `tests/test_demo_events.py`: same seed →
identical sequence; every curated protocol within the first N events; the antimeridian scenario
contains a pair with `|src_long - dst_long| > 180`; every event has `demo is True`; the listed ISO
codes all appear.

**Acceptance.** Live attacks render with no Redis/ES/Docker; banner visible; screenshots attached.

### WP2 — Basemap acquisition, pinned CLI, measurement, immutable release (1.5 d)

**Objective.** One committed way to obtain any basemap variant and one committed way to obtain the
CLI, with no binary in git and nothing installed system-wide — **and the artefact lifecycle
completely closed**: WP2 ends with the immutable release published and every `basemap.lock` value
filled, so no later package inherits a "release must exist sometime before WP6" scheduling
ambiguity.

**Files.** `tools/pmtiles_cli.sh`, `tools/fetch_basemap.sh`, `tools/basemap.lock`,
`static/dist/.gitkeep`, `.gitignore`, `docs/BASEMAP.md`; the published GitHub release
`basemap-<YYYYMMDD>-z<N>` (requires release permissions on `telekom-security/t-pot-attack-map`).

- `tools/basemap.lock` — committed, POSIX-sourceable, the only place pins live:

```sh
WORLD_PMTILES_URL=            # immutable T-Pot release asset (default source)
WORLD_PMTILES_SHA256=         # sha256 of that asset
PM_MAXZOOM=                   # build-time expectation, asserted in --release checks
PM_BUILD=                     # Protomaps build id it came from (provenance)
PMTILES_CLI=1.31.2
PMTILES_CLI_SHA256_linux_x86_64=
PMTILES_CLI_SHA256_linux_arm64=
PMTILES_CLI_SHA256_darwin_arm64=
```

- **`tools/pmtiles_cli.sh` — the single implementation of the CLI pin logic** (B3.1):
  `tools/pmtiles_cli.sh [--lock PATH] [--require-cached] <pmtiles-subcommand> [args...]` plus
  `tools/pmtiles_cli.sh --fetch-only` (download/verify into the cache and exit — the bootstrap
  entry point, §17.1). It detects `uname -s`/`uname -m`, downloads the pinned release asset into a
  cache directory (`${TMPDIR:-/tmp}/tpot-pmtiles-<version>-<arch>/`, overridable with
  `PMTILES_CLI_CACHE`), verifies the SHA-256 from the lock **before** the first execution, then
  `exec`s the binary with the given arguments. The cache is keyed by **OS and architecture**
  (`${TMPDIR:-/tmp}/tpot-pmtiles-<version>-<os>-<arch>/`, e.g. `…-1.31.2-darwin-arm64/`), never by
  architecture alone. Supported platforms per D41: macOS Apple Silicon, Linux x86_64, Linux arm64
  — an unsupported OS/arch pair (including Intel macOS) fails with a clear message instead of
  running unverified binaries. With `--require-cached` it never downloads: a missing cache fails
  with the `--bootstrap` hint (used by the non-bootstrap `check_all.sh` modes). Nothing is
  installed system-wide, nothing is expected on `PATH`, and a cached binary is re-verified on
  every run. `fetch_basemap.sh`, `check_all.sh` and every measurement command in
  this document call only this helper — the OS/arch/hash logic exists exactly once.
- `tools/fetch_basemap.sh` — POSIX `sh` (macOS `sh` and Alpine busybox `ash`; no bashisms, no
  python, no jq; prefers `curl`, falls back to `wget -O`):

```
tools/fetch_basemap.sh [--out PATH] [--lock PATH] [--preset full|dev|dev-ci|dev-europe]
                       [--maxzoom N] [--bbox W,S,E,N]
                       [--from-upstream [--upstream-build BUILD_ID]] [--force] [--check]
```
  - `full` (default): download `WORLD_PMTILES_URL`, verify `WORLD_PMTILES_SHA256`
    (`sha256sum -c`, `shasum -a 256` fallback), atomic `mv`. No CLI needed — the Docker path.
  - `dev` / `dev-ci` / `dev-europe`: `tools/pmtiles_cli.sh extract "$WORLD_PMTILES_URL" "$tmp/out.pmtiles"
    --maxzoom=<N> [--bbox=…]` — a ranged sub-pyramid of the T-Pot artefact. Lock hash intentionally
    not compared; the script says so and prints the resulting header zoom range.
  - `--from-upstream`: maintainer bootstrap/re-pin path against the Protomaps build channel.
    The build id is an **explicit input**: `--upstream-build <BUILD_ID>` is **required** while
    `PM_BUILD` in the lock is empty (first bootstrap — this breaks the former circular
    dependency); once the lock is filled, `--upstream-build` may be omitted and defaults to
    `PM_BUILD`. Prints size and sha256 for the release and lock update.
  - Idempotent for `full` (hash match → "up to date"); `--force` re-downloads; `--check` verifies
    only and prints the exact fix command; `trap` cleans the temp dir; the final `mv` is the only
    mutation of `--out`.
  - Refuses to run if a `.gz`/`.br` sibling of `--out` exists (§8.1).
- `.gitignore` gains `static/dist/*.pmtiles`, `tools/e2e/node_modules/`,
  `tools/styles/node_modules/` and `.DS_Store`; `static/dist/.gitkeep` is committed.
- **Close the lifecycle (formerly §14.3, now part of WP2).** WP2 is complete only after all
  twelve steps:

  1. upstream Protomaps build id selected (explicit `BUILD_ID`);
  2. z6 and z7 candidates extracted (`--from-upstream --upstream-build …`, §8.2);
  3. candidate sizes measured;
  4. D23 chooses the production maxzoom;
  5. the immutable release `basemap-<YYYYMMDD>-z<N>` is **published** (draft → attach → publish,
     §14.2);
  6. `WORLD_PMTILES_URL` recorded in `tools/basemap.lock`;
  7. `WORLD_PMTILES_SHA256` recorded;
  8. `PM_MAXZOOM` recorded;
  9. `PM_BUILD` recorded;
  10. `--preset full` downloads and verifies successfully against the lock;
  11. `dev` and `dev-ci` presets extract successfully from the release asset;
  12. `docs/BASEMAP.md` completed (pins, measurements, chosen maxzoom, bootstrap/re-pin
      procedure, immutable-release procedure, why the release asset is the pinned source).

**Tests.** `sh -n tools/*.sh`; a busybox run
(`docker run --rm -v "$PWD":/w -w /w alpine:3.23 sh tools/fetch_basemap.sh --check`); corrupting one
byte makes `--check` fail naming the file; a second run prints "up to date"; `dev` produces an
artefact whose `tools/pmtiles_cli.sh show` maxzoom is 4; tampering with the cached CLI binary makes
`pmtiles_cli.sh` refuse to run; `--from-upstream` without `--upstream-build` and an empty
`PM_BUILD` fails with a usage message; `git status` clean after a fetch.

**Acceptance.** All twelve lifecycle steps done; `full`, `dev` and `dev-ci` each obtainable with
one command on macOS (Apple Silicon) and Alpine; `docs/BASEMAP.md` records the measurements;
`PM_MAXZOOM` set by D23; every `basemap.lock` value non-empty and matching the published release.

### WP3 — Vendor engine, assets, styles, countries, licences (1.5 d)

**Objective.** Every new runtime asset present, hashed, provenance-recorded, reproducible — without
touching the running application. `static/index.html` is **not** modified in WP3.

**Files.** `tools/vendor_frontend.sh`, `tools/vendor_countries.mjs`, `tools/iso_universe.txt`,
`tools/iso_unsupported.txt`, `.node-version` (Node 24.20.0, D45), `static/vendor.lock`,
`tools/styles/{package.json,package-lock.json,generate_styles.mjs,allowlist.json,known_dropped.json}`,
`static/map-boot.mjs`, `static/maplibre-gl*.mjs`, `static/maplibre-gl.css`, `static/pmtiles.mjs`,
`static/basemaps/**`, `static/styles/{dark,light}.json`, `static/data/countries.geojson(.gz)`,
`static/licenses/*`, `update_hashes.py`, `docs/UPDATE_HASHES_README.md`.

- `tools/vendor_frontend.sh` downloads every pinned file (npm tarballs from
  `https://registry.npmjs.org`; `basemaps-assets` @ `028c18f713baecad011301ff7a69acc39bcc2ae7`;
  fonts from rsms/inter `v4.1` and JetBrains/JetBrainsMono `v2.304`; flags from
  Yummygum/flagpack-core `v2.1.0`; the licence texts of §20) and writes `static/vendor.lock` in
  the §14.4 schema, **covering every asset that exists by the end of WP3** — including the
  *current* legacy files (jQuery 3.7.1, Bootstrap 5.3.3, Chart.js 4.4.0, Luxon 3.5.0,
  Font Awesome 6.5.1, fonts, flags) at their present hashes with
  **`provenance_type: legacy`** (`source = repository baseline e798fcb`,
  `upstream_ref = unknown`) — a truthful tamper-evidence record, **not** an upstream provenance
  claim, since none of these files has been proven byte-identical to a ref at this point. WP8
  removes or replaces every `legacy` entry; the release check asserts none remains (§14.4). (The WP5 modules `attack-geometry.mjs` / `attack-renderer.mjs` do
  not exist yet and are added to the manifest by WP5 — no forward dependency.) On later runs it
  verifies and refuses to overwrite a differing file without `--update`. Subcommands:
  `--countries` (delegates to `vendor_countries.mjs`), `--fonts`, `--flags`, `--legacy`
  (Bootstrap/Chart.js/Font Awesome at their §6.4 pins, used by WP8), `--licenses`, `--all`. All
  upstream refs are constants at the top of the script — the single place they live.
- `tools/vendor_countries.mjs`: `--rebuild` (network, run once here and by later maintainer
  re-pins) performs the §8.5 transformation — download of the pinned Natural Earth v5.1.2 source,
  verification of its recorded SHA-256, **merge to one Feature per `ISO_A2_EH`** with a hard
  assertion that no duplicate ids remain — writes both `countries.geojson` and
  `countries.geojson.gz`, and prints source tag, source/merged/final feature counts,
  retained/dropped features with ISO values and names, output sizes, hashes, and the ISO coverage
  report (matched, unsupported, **unmatched or duplicate id → non-zero exit**). `--verify`
  re-validates the committed output **fully offline** (§8.5) and is what `check_all.sh` runs.
- `tools/styles/generate_styles.mjs`: `layers("protomaps", namedFlavor(theme), {lang:"en"})`,
  filtered by `allowlist.json`, wrapped into a style with `version: 8` and
  `sources.protomaps = {type:'vector', attribution:'<a href="https://github.com/protomaps/basemaps">Protomaps</a> © <a href="https://osm.org/copyright">OpenStreetMap</a>'}`
  — **no `url`, no `maxzoom`** — plus placeholder `glyphs`/`sprite` overwritten at runtime. Prints
  all/retained/dropped ids and **exits non-zero** on an id that is in neither `allowlist.json` nor
  `known_dropped.json` (§8.4).
- `static/map-boot.mjs` per §7.1, with `new Protocol()` and `openBasemap()`.
- `update_hashes.py` gains `--check-vendor` (verify every `vendor.lock` entry, including
  `provenance_type: local` files) and recognises `<link rel="modulepreload" … integrity>` tags.
  `docs/UPDATE_HASHES_README.md` documents both plus the §14.4 hierarchy.
- Fonts: only `Noto Sans Regular|Medium|Italic` (the `text-font` values used by the style) — the
  Devanagari stack is not vendored.

**Tests.** `update_hashes.py --check` and `--check-vendor` exit 0; flipping a byte in
`static/pmtiles.mjs` makes `--check-vendor` fail; `node tools/vendor_countries.mjs --verify`
validates the committed hashes, provenance metadata and coverage report **with the network
blocked**, and asserts zero duplicate feature ids (a synthetically injected duplicate makes it
exit non-zero); `--rebuild` against the pinned source reproduces the committed hashes;
`grep -c '"maxzoom"' static/styles/*.json` returns 0; adding a fake layer id to the generator's
input makes it exit non-zero; `grep -o 'http[s]*://[^"]*' static/styles/*.json` returns only the
two attribution links.

**Acceptance.** All assets, licences and locks present; the app still runs on Leaflet unchanged;
styles, countries and licences each regenerate from one documented command.

### WP4 — Integration proof-of-concept **gate** (1 d, blocking)

**Objective.** Prove MapLibre 6.6.0 + PMTiles 4.5.0 + local assets + strict CSP + the
`document.baseURI` strategy at **both** deployment base URIs, before any application change.

**Files.** `static/poc.html` (temporary) and a temporary `GET /poc.html` route in
`AttackMapServer.py`; both removed in the commit that records the results.

**Why the temporary route.** `static/poc.html` at `/map/static/poc.html` has base directory
`/map/static/`, so `static/styles/dark.json` would resolve to `/map/static/static/…`. Serving it at
`/poc.html` reproduces the real base directories: `http://127.0.0.1:64299/poc.html` ↔ `/` and
`https://<host>:64297/map/poc.html` ↔ `/map/`.

**Checks, each with its criterion.**

1. **MIME types — every `.mjs` file that exists at this point, direct and proxied.**
```sh
for f in maplibre-gl.mjs maplibre-gl-shared.mjs maplibre-gl-worker.mjs pmtiles.mjs map-boot.mjs; do
  curl -sI  "http://127.0.0.1:64299/static/$f"    | grep -i content-type
  curl -skI "https://<host>:64297/map/static/$f"  | grep -i content-type
done
```
   Expect `text/javascript` for every file on both paths, proving the D31 middleware works and the
   proxy does not rewrite it. The WP5 modules (`attack-geometry.mjs`, `attack-renderer.mjs`) do not
   exist yet; the middleware is extension-based, so coverage generalises, and §17.3 re-asserts the
   header for **every** shipped `.mjs` file — including the WP5 pair — once they exist. The browser
   PoC alone is not accepted as the proof; these explicit header assertions are.
2. **Range requests, direct.** `curl -s -D - -o /dev/null -r 0-127 …/static/dist/world.pmtiles` →
   `HTTP/1.1 206 Partial Content`, `Content-Range: bytes 0-127/<total>`, `Content-Length: 128`;
   `Accept-Ranges: bytes` on a plain `HEAD`.
3. **Range requests through nginx.** Same via `https://<host>:64297/map/…`, and **no
   `Content-Encoding` header**. Also assert no `world.pmtiles.gz` exists (§8.1).
4. **GeoJSON precompression.** `curl -s -D - -o /dev/null -H 'Accept-Encoding: gzip'
   …/static/data/countries.geojson` → `Content-Encoding: gzip` and `Vary: Accept-Encoding`. If
   absent, drop the `.gz` sibling (D32) and record the raw size instead.
5. **PMTiles preflight.** `openBasemap()` resolves; log `tileType`, `minZoom`, `maxZoom`, bounds.
   Then point it at a missing file and at a copy truncated to 100 bytes: both must reject and reach
   the failure UI **without** constructing a map.
6. **Browser load** at `/poc.html` in Chromium, Firefox and Safari: zero requests to any other
   origin (screenshot for the PR); `.pmtiles` requests are 206; no glyph/sprite 404s; console free
   of errors and CSP violations; the worker request is `static/maplibre-gl-worker.mjs`, same-origin,
   **not** a `blob:` URL; `addProtocol('pmtiles', new Protocol().tile)` renders tiles (PMTiles 4.5.0
   types `Protocol#tile` as `V3OrV4Protocol`; the pairing is unproven until it renders here).
7. **Request count.** Record the number of requests before first paint and confirm there is **no**
   request to the archive's JSON metadata section — evidence that dropping `metadata: true` removed a
   round trip (I8).
8. **URL assertions** (§7.3) pass at both base URIs.
9. **Sub-path parity.** `/map/poc.html` behaves identically; every asset request is `/map/`-prefixed.
10. **CSP.** Serve with exactly D8: no violations while idle, panning, zooming, switching theme,
    opening a popup, entering fullscreen. Negative control: reduce to `worker-src 'none'` and confirm
    map init fails. Record whether anything requires `blob:` in `img-src`.
11. **modulepreload integrity.** With the link present for `maplibre-gl.mjs`, flip one byte and
    reload; record per browser whether the module is rejected (enforcement) or loaded anyway (hint
    only). `vendor.lock` remains the authority (§14.4).
12. **Theme switch.** (a) 20 × `setStyle(styleObject,{diff:true})`: basemap changes, no console
    error, no WebGL-context or heap growth after GC. (b) **Rapid, non-awaited toggling**: fire
    `updateMapTheme('dark'); updateMapTheme('light'); updateMapTheme('dark'); updateMapTheme('light')`
    without awaiting, wait for quiescence, and assert the applied style matches the **final**
    requested theme (`data-theme`) — the §7.6 revision counter must discard the stale fetches.
13. **Zoom semantics.** Compare `header.maxZoom` with `header.maxZoom + 1`; 4.0 ships the former.
14. **Dynamic-import resolution.** A classic script logs the resolved URL of
    `await import('./x.mjs')`: expect `/static/x.mjs` and `/map/static/x.mjs`.
15. **Measurement.** Time to first rendered frame on a cold cache, tile requests for the initial
    view, bytes transferred, artefact size.

**Acceptance.** All fifteen checks pass and are recorded in the PR. Only then does WP5 begin.

**Rollback/debug.** Self-contained. Debug order: MIME → 206 → preflight → CSP → glyphs/sprites →
worker → URL assertions.

### WP5 — Attack geometry and renderer (1.5 d)

**Objective.** A unit-tested geometry module and a Canvas renderer, both standalone and
manifest-covered.
**Files.** `static/attack-geometry.mjs`, `static/attack-renderer.mjs`, **`static/vendor.lock`**,
`tests/js/attack-geometry.test.mjs`, `tests/js/attack-renderer.test.mjs`, `static/index.css`
(`.attack-canvas`). Not yet referenced by `index.html`.

**Implementation.** §9.2-§9.4. `attack-renderer.mjs` imports the geometry module, exports
`AttackRenderer`, `bendPixels` and `quadraticPoint`, takes an injectable clock and an explicit
`renderFrame(tMs)` so tests need no `requestAnimationFrame`, and touches no DOM at module level so
Node can import it. `spawn()` freezes `worldCopyOffsetLng` per §9.3. Finally, **update
`static/vendor.lock`** with `provenance_type: local` entries for both new modules (this completes
the manifest lifecycle started in WP3).

**Tests.** `node --test tests/js/` covering every assertion of §9.3 (including the world-copy
continuity test at centres 170/179/181/190) plus: `renderFrame(t)` with a stubbed `map.project`
and a spy context produces the expected stroke sequence per phase; identical endpoints produce
rings but no trail and no NaN; a non-finite projection result is skipped; the 300-event cap drops
the oldest event.

**Acceptance.** All tests green from a clean clone without network access;
`python3 update_hashes.py --check-vendor` passes with the two new entries; nothing in production
imports the modules yet.

### WP6 — Core map-engine migration (2-3 d, the big one)

**Objective.** Replace Leaflet with MapLibre in `map.js` without changing behaviour outside the map.
**Files.** `static/map.js`, `static/index.html`, `static/dashboard.js`.
**Dependencies.** WP3, WP4 (gate passed), WP5.

- `index.html`: add `maplibre-gl.css` (SRI) and the `modulepreload` links for `map-boot.mjs`,
  `maplibre-gl.mjs`, `maplibre-gl-shared.mjs`, `pmtiles.mjs`, `attack-renderer.mjs`,
  `attack-geometry.mjs`; remove the d3 tag (14) and both Leaflet tag pairs (30-31, 34-35); add the
  **functional `#map-failure-panel` markup** (hidden by default; title + hint slots populated by
  `showMapFailure(title, hint)`) — the markup ships **here** so WP6's failure tests never depend
  on a later package; WP8 contributes only its final styling. Run `update_hashes.py`.
- `map.js`, in this order: `installSafeGlobals()` (§13.6, including the restore queue of §7.2) →
  `startDataChannel()` → `initMap()` (§7.1, with the D34 lifecycle and the startup traffic queue).
  Then, following §2.2: delete 22-34 and 37-55; keep the
  `remove()` guard; WebGL2 probe → preflight → `loadStyle` → `new maplibregl.Map({container:'map',
  style, center:[0,0], zoom:2, minZoom:Math.max(1,header.minZoom), maxZoom:header.maxZoom,
  renderWorldCopies:true, maxPitch:0, dragRotate:false, attributionControl:{compact:true}})`,
  `touchZoomRotate.disableRotation()`, `addControl(new maplibregl.FullscreenControl())`,
  `map.on('error', handleMapError)`; drop the duplicate `window.map = map`; delete `attackLines`;
  replace the layer groups with the `attackers` source and a `Map` of markers while keeping the
  global names/shapes of `circlesObject`, `markersObject`, `circleAttackData`, `markerAttackData`;
  `processRestoredAttack` gets plain `{lng,lat}`, unchanged keys, and a warning instead of the dead
  `getCoordinates` branch; `addCircle`/`addMarker` per §9.5/§9.6; `messageHandlers.Traffic` updates
  dashboard state unconditionally, builds an `AttackEvent` and routes it through the D34 lifecycle
  (`READY` → `renderMapTraffic()` — which gates **all** map side effects: circle, marker, spawn;
  `INITIALIZING` → startup queue; `FAILED` → nothing); `updateMapTheme` per §7.6;
  `visibilitychange` uses `renderer.clear()`; **`window.map` per D37** — assigned exactly once
  after `new maplibregl.Map(...)`, reset to `null` via `map.remove()` in any fatal
  post-construction failure path; implement `window.clearMapVisuals()` per D38 (always empties
  `startupTrafficQueue` and `pendingRestored`; when READY additionally clears the renderer queue,
  the `attackers` source/registry, the marker registry and the choropleth state),
  `showMapFailure()` (populates `#map-failure-panel`, sets `FAILED`, removes the map if
  constructed, discards both queues), `handleMapError()`; on `READY` drain the startup traffic
  queue in order, then the restore queue.
- `dashboard.js`: `invalidateSize()` → `window.map?.resize?.()` (1101, existing guard kept);
  clear-cache calls `window.clearMapVisuals?.()` (2158-2185) and keeps its loops; **D43**:
  replace the `window.load` + `initWhenReady` Chart.js polling block (3661-3676) with a
  synchronous `window.attackMapDashboard = new AttackMapDashboard()` at script evaluation
  (Chart.js is a deferred script earlier in document order — a spec guarantee, not timing).
- `map.js` dashboard-facing calls (D43): the unguarded `window.attackMapDashboard.*` calls in the
  Traffic path (1261-1264) become optional-chained (`window.attackMapDashboard?.…`), and the
  `updateStatusWithRetry` polling helper (1317-1330) is deleted in favour of a guarded direct
  call — the dashboard object provably exists by then.
- **Calibration:** set `FACTOR`, `MIN_BEND_PX`, `MAX_BEND_PX` (§9.3) and `R1`/`R7` (§9.5) by
  comparing against the WP1 screenshots at zoom 2, 4 and 7, and record the chosen values with a
  one-line rationale.

**Tests.** §17.4 matrix with `--demo`; `reAddCustomLayers()` twice → no duplicates;
`update_hashes.py --check` after each `index.html` edit; the §13.6 failure sweep; and the five
**startup-timing tests** (D34, with instrumented delays around the awaited stages):

1. Traffic arrives before the dynamic imports resolve → queued, dashboard updated, no exception;
2. Traffic arrives during the PMTiles preflight → same;
3. Traffic arrives after map construction but before `style.load` → same;
4. init succeeds → the queued events appear on the map, in order, and the queue is empty;
5. init fails (basemap removed) → dashboard keeps updating, no exception, both queues cleared,
   and `window.map === null` (D37);
6. **Clear-Cache race (D38, startup queue)**: Traffic arrives during `INITIALIZING`, the user
   triggers Clear Cache, the map then becomes `READY` → the pre-clear event **must not** appear
   on the map;
7. **Clear-Cache race (D38, restore queue)**: same sequence with `processRestoredAttack` events
   queued in `pendingRestored` → none of them reaches the map after the clear;
8. **Early WebSocket message (D43)**: deliver a Traffic message as early as the harness allows
   after page load (demo server emits immediately on connect) → no exception, dashboard state
   updated — proving the synchronous `window.attackMapDashboard` instantiation and the deleted
   polling loops;
9. **Theme during INITIALIZING (D44)**: toggle the theme while init is delayed, let the map
   become READY → the final map style matches the final `data-theme`, no error;
10. **Theme after FAILED (D44)**: toggle the theme after a forced failure → dashboard theme
    changes, no style fetch, no exception, no unhandled promise rejection.

Plus the D37 assertions: after a successful startup `window.map` is the MapLibre instance; after
a forced failure `window.map === null` (also asserted in the §17.3 smoke test).

**Acceptance.** Parity with `docs/BASELINE.md` except the intended changes; zero console errors;
zero third-party requests; data channel keeps running when the map is forced to fail.

**Rollback.** One commit over three files; WP3/WP5 assets are additive and Leaflet survives on disk
until WP8.

### WP7 — Country activity choropleth (1 d)

**Files.** `static/map.js`, `static/dashboard.js`, `static/index.css`, `static/index.html`.

- Source `countries` (`promoteId: 'ISO_A2_EH'`, one feature per code per §8.5), `fill` layer
  before `firstLabelLayerId()`,
  `fill-opacity: ['interpolate',['linear'],['coalesce',['feature-state','intensity'],0], 0,0, 1,0.35]`.
  **No independent outline layer** — the Protomaps boundary lines remain the visual boundary
  authority (§8.5).
- State levels exactly as §8.6 (D39): `countryTrackingStats` (dashboard authority) →
  `window.updateChoropleth?.(iso2, absoluteHits)` — **absolute counts, never deltas** —
  → `choroplethHits` (renderer-local mirror) → `intensityCache` → feature-state.
  `dashboard.js:3210-3258` calls the bridge whenever a country's absolute count changes; `map.js`
  recomputes **all** intensities from `choroplethHits` when `maxHits` changes and flushes at most
  1×/s. `map.js` never reads `countryTrackingStats`.
- Clear Cache resets all four levels (D38).
- Settings-modal checkbox, **default on** (D28), plus the §8.6 small print.
- Unmatched incoming ISO codes are logged once per session (and expected to be limited to the
  committed unsupported list).

**Tests.** Theme switch with a populated choropleth → identical shading afterwards; toggle off/on →
no errors; Clear Cache → shading gone and caches empty; a new `maxHits` re-pushes all intensities
(assert two countries via `map.getFeatureState`); the WP1 fixture's SG/HK/MO/MT/MC/LI/GF/RE/XK all
shade (asserted via `getFeatureState`, since several are invisible at world zoom), GI is logged as
unsupported; **tiny-state visual check**: at world zoom, record for SG, HK, MC, LI, MT, AD, SM and
VA whether the shaded polygon is visually discernible, and attach the finding to the PR — this
documents the §22 item 11 deferral (tiny-country point layer) with evidence instead of claiming
visual coverage.

**Acceptance.** Shading appears within ~1 s, survives theme switching, sits below labels, and its
meaning is stated in the UI; the tiny-state findings are recorded.

### WP8 — CSS, CSP, badge, removals and legacy dependency cleanup (1 d)

- Port the `.leaflet-*` rules (§2.2 list) to `.maplibregl-*`; the scoped popup selectors map 1:1
  because `className` lands on `.maplibregl-popup`. **Delete** the raster tile filter (2644).
- Add `.attack-canvas`, `#demo-badge` and the failure-panel **styles** (the functional markup
  exists since WP6 — this package only styles it).
- Demo badge (D27): visible while messages carry `demo: true`.
- **Legacy dependency cleanup (D36, §6.4):**
  - remove `static/jquery-3.7.1.min.js`, `static/luxon.min.js`, `static/bootstrap.min.js` and
    `static/bootstrap.min.css.map` plus their `index.html` tags (17, 20, and the JS half of
    26-27) — all proven unused;
  - upgrade `static/bootstrap.min.css` → 5.3.8, `static/chart.umd.js` → 4.5.1 and
    `static/fontawesome/` → 7.3.1 via `tools/vendor_frontend.sh --legacy`;
  - re-vendor `static/fonts/` from Inter v4.1 + JetBrains Mono v2.304 (regenerating `fonts.css`)
    and verify `static/flags/` against Flagpack v2.1.0 via `--fonts` / `--flags`;
  - update `static/vendor.lock` (remove the deleted entries, re-hash the upgraded ones) and rerun
    `update_hashes.py`;
  - visually verify against the WP1 screenshots: modals, buttons, charts, all 24 icons (the five
    alias-named ones explicitly: `fa-cog`, `fa-save`, `fa-times`, `fa-trash-alt`, `fa-undo`,
    `fa-volume-up`), fonts and flags.
- Bump `index.css?v=6` → `?v=7`; replace the CSP meta tag with D8; run `update_hashes.py`.
- Delete the Leaflet/D3 files (§12.3).

**Acceptance.** `grep -n leaflet static/index.css static/index.html` empty;
`grep -n "jquery\|luxon\|bootstrap.min.js" static/index.html` empty;
`grep -rn "cartocdn\|openstreetmap.org" static/` returns only the style attributions;
`update_hashes.py --check` and `--check-vendor` exit 0; **no `provenance_type: legacy` entry
remains in `vendor.lock`** (every retained third-party asset now carries a proven upstream ref);
the icon audit findings are recorded.

### WP9 — Docker / tpotce (0.5 d)

**Files.** `tpotce/docker/elk/map/Dockerfile` (§15). **Tests.** Build; `docker image inspect` size
delta; run and `curl -r 0-127` the artefact from inside the container; confirm `map:map` ownership
and that no runtime network access is required.

**Acceptance.** Artefact present, hash-verified, owned correctly; `MAP_COMMAND` unchanged; origin
`telekom-security`; tag `4.0.0`; size delta recorded.

### WP10 — Local checks, docs, versions, release (1 d)

**Files.** `tools/check_all.sh`, `tools/e2e/{package.json,package-lock.json,smoke.mjs}`,
`README.md`, `docs/BASEMAP.md`, `docs/UPDATE_HASHES_README.md`, `AttackMapServer.py`,
`DataServer.py`, removal of `docs/BASELINE.md`.

- `tools/check_all.sh` with the two modes and the bootstrap of §17.1.
- `tools/e2e/smoke.mjs` per §17.3, with an exact Playwright pin in `package-lock.json`.
- README: WebGL2 requirement, offline statement, local-development section
  (`tools/fetch_basemap.sh --preset dev` → `python3 AttackMapServer.py --demo` → open
  `http://127.0.0.1:64299`), demo flags, the "never in production" note, the regeneration commands
  (styles, countries, licences, vendor), `tools/check_all.sh [--release|--bootstrap]`, and the
  updated licence list (§20).
- Version strings → `4.0.0` (§12.5).

**Acceptance.** `tools/check_all.sh` green on a fresh clone after `--bootstrap` and a `dev` fetch;
`--release` green against the pinned artefact; §24 checklist complete.

---

## 12. File-by-file change inventory

### 12.1 Modified

| File | Change |
|---|---|
| `AttackMapServer.py` | `argparse` (`--port`, `--redis-url`, `--demo`, `--demo-*`), demo task, `.mjs` MIME middleware (D31, §7.5), delete commented lines 15-17, version → `4.0.0` (line 20). Temporary `GET /poc.html` exists only during WP4 |
| `DataServer.py` | `argparse` (`--redis-host`, `--es-url`), version → `4.0.0` (line 16). No behaviour change (the elasticsearch 8→9 client bump needs no code change — keyword API already in use, §6.0) |
| `requirements.txt` | the §6.0 pins: `aiohttp==3.14.3`, `elasticsearch==9.3.0`, `redis==8.1.0`, `pytz==2026.3.post1`, `tzlocal==5.4.4` (WP1) |
| `static/index.html` | WP6: remove d3 (14) and Leaflet (30-31, 34-35); add `maplibre-gl.css` + `modulepreload` links; add the functional `#map-failure-panel` markup. WP8: CSP (7); remove jQuery (17), Luxon (20) and the Bootstrap JS tag; `index.css?v=7` (43); demo badge markup. `update_hashes.py` re-run in both |
| `static/map.js` | The migration (WP6/WP7) |
| `static/dashboard.js` | `window.map?.resize?.()` (1101); clear-cache calls `window.clearMapVisuals?.()` and resets choropleth state (2158-2185); `window.updateChoropleth?.()` (≈3227); demo badge toggle |
| `static/index.css` | `.leaflet-*` → `.maplibregl-*`, delete the tile filter (2644), add `.attack-canvas`, `#demo-badge`, failure panel |
| `update_hashes.py` | `modulepreload` discovery, `--check-vendor` |
| `.gitignore` | `static/dist/*.pmtiles`, `tools/e2e/node_modules/`, `tools/styles/node_modules/`, `.DS_Store` |
| `static/bootstrap.min.css`, `static/chart.umd.js`, `static/fontawesome/**`, `static/fonts/**`, `static/flags/**` | WP8 legacy upgrades / re-vendoring per §6.4 (D36), recorded in `vendor.lock` |
| `README.md` | WebGL2, offline statement, dev section, demo flags, regeneration commands, check script, licence list |
| `docs/UPDATE_HASHES_README.md` | new asset families, integrity hierarchy (§14.4) |
| `tpotce/docker/elk/map/Dockerfile` | basemap fetch, origin `telekom-security`, tag `4.0.0` (§15) |

### 12.2 Added

`demo_events.py`, `tests/test_demo_events.py`, `tests/js/attack-geometry.test.mjs`,
`tests/js/attack-renderer.test.mjs`, `tools/pmtiles_cli.sh`, `tools/fetch_basemap.sh`,
`tools/basemap.lock`, `tools/vendor_frontend.sh`, `tools/vendor_countries.mjs`,
`tools/iso_universe.txt`, `tools/iso_unsupported.txt`,
`tools/styles/{package.json,package-lock.json,generate_styles.mjs,allowlist.json,known_dropped.json}`,
`tools/check_all.sh`, `tools/e2e/{package.json,package-lock.json,smoke.mjs}`,
`static/vendor.lock`, `static/map-boot.mjs`, `static/attack-geometry.mjs`,
`static/attack-renderer.mjs`, `static/maplibre-gl.mjs`, `static/maplibre-gl-shared.mjs`,
`static/maplibre-gl-worker.mjs`, `static/maplibre-gl.css`, `static/pmtiles.mjs`,
`static/styles/{dark,light}.json`, `static/basemaps/fonts/**`, `static/basemaps/sprites/v4/**`,
`static/data/countries.geojson`, `static/data/countries.geojson.gz`, `static/licenses/*` (§20),
`static/dist/.gitkeep`, `docs/BASEMAP.md`.

Also added: `docs/DEPENDENCIES.md` (the G-DEP consolidated dependency report, WP1) and
`.node-version` (Node 24.20.0 LTS, WP3).

Temporary, created and deleted within one work package: `docs/BASELINE.md` (WP0→WP10),
`static/poc.html` + the `GET /poc.html` route (WP4).

### 12.3 Removed

Map migration (WP8): `static/leaflet.js`, `static/leaflet.js.map`, `static/leaflet.css`,
`static/leaflet.fullscreen.js`, `static/leaflet.fullscreen.css`, `static/d3.v7.min.js`,
`static/images/icon-fullscreen.svg`, `static/images/icons-000000@2x.png`.
`static/images/marker.svg` only after `grep -rn "marker.svg" static/` confirms it is unused.

Legacy dependency review (WP8, D36/§6.4): `static/jquery-3.7.1.min.js`, `static/luxon.min.js`,
`static/bootstrap.min.js`, `static/bootstrap.min.css.map` — all proven unused (the `.css.map` is
additionally a stale Bootstrap-3-era artefact).

Total ≈ 1 MB of vendored JS/CSS removed.

### 12.4 Committed vs generated vs downloaded

| Category | Files |
|---|---|
| **Committed source** | all Python/JS/CSS/HTML, tools, locks, allowlists, ISO lists |
| **Vendored (downloaded once, committed)** | MapLibre, PMTiles, glyphs, sprites, licence texts |
| **Generated at development time, committed** | `static/styles/*.json`, `static/data/countries.geojson(.gz)`, `static/vendor.lock`, SRI hashes |
| **Downloaded at build time, never committed** | `static/dist/world.pmtiles` only |

Every committed generated asset has exactly one documented regeneration command, and each generator
prints what it produced.

### 12.5 Version strings that actually change

`AttackMapServer.py:20`, `DataServer.py:16`, `static/index.html:43` (`index.css?v=`), `README.md`,
git tag `4.0.0`, and in tpotce the clone origin plus `-b 3.0.1` in `docker/elk/map/Dockerfile`.
Verify with `grep -rn "3\.0\.1" . --exclude-dir=.git`; only history text may remain.

---

## 13. CSP, security and offline behaviour

### 13.1 Policy

```
default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; font-src 'self';
img-src 'self' data: blob:; connect-src 'self' ws: wss:; object-src 'none';
base-uri 'self'; form-action 'none'
```

`script-src 'self'` covers classic scripts, dynamically imported modules and `modulepreload`, and
forbids inline script — no import map is used, so no inline JSON script and no CSP hash is needed.
`worker-src 'self'` suffices because the worker is same-origin (§13.2). `img-src` keeps `data:` for
inline icons and `blob:` per MapLibre's documented CSP. `connect-src 'self' ws: wss:` covers the
WebSocket and the same-origin fetches for style, glyphs, sprites, GeoJSON and PMTiles ranges. No
external host appears in the policy.

**What the policy does and does not enforce (stated precisely).** All runtime application HTTP
asset requests are restricted to same-origin by `'self'`. The `ws:`/`wss:` schemes, however, do
**not** literally restrict WebSocket destinations to same-origin — they are kept for browser
compatibility. WebSocket same-origin behaviour is enforced by the application's URL construction
(`map.js` builds the socket URL exclusively from `window.location.host`) and verified by the
runtime network tests (WP4 6, §17.4 item 1), not solely by CSP. The runtime behaviour is strict;
only the threat-model claim is worded to match what CSP actually provides.

The policy stays a `<meta http-equiv>` tag: it is what the project uses today, travels through the
nginx proxy without touching tpotce, and lives in the file `update_hashes.py` already edits. Moving
it to an HTTP header (which would additionally allow `frame-ancestors`) is deferred (§22).

### 13.2 Worker loading

MapLibre 6.6.0 resolves the worker via `import.meta.url` and, per `src/util/web_worker.ts`, calls
`new Worker(url,{type:'module'})` **directly for same-origin URLs**; the Blob branch runs only
cross-origin. `map-boot.mjs` additionally calls `setWorkerUrl()` with an absolute same-origin URL, so
the guarantee does not depend on module-URL resolution. The module worker imports
`maplibre-gl-shared.mjs` itself — same-origin, covered by `script-src 'self'`.

### 13.3 Offline / air-gap statement

No third-party network requests at runtime. Every asset — MapLibre, PMTiles JS, worker, styles,
glyphs, sprites, tiles, icons, GeoJSON, application JS/CSS, licence texts — is same-origin. Runtime
traffic: the page and its assets, the WebSocket (whose URL the application constructs from the
current host, §13.1), and range requests against `static/dist/world.pmtiles`. No online mode, no
fallback basemap, no API key. Verified by the WP4 network-panel check and a grep in
`tools/check_all.sh` — the network tests, together with the CSP, are the enforcement evidence.

### 13.4 Missing WebGL2

Two independent hooks:

1. **Probe** before constructing anything:
```js
const probe = document.createElement('canvas').getContext('webgl2');
if (!probe) { showMapFailure('WebGL2 required', '…enable hardware acceleration…'); return; }
probe.getExtension('WEBGL_lose_context')?.loseContext();      // release the context slot
```
2. **Authoritative hook**: `map.on('error', e => { if (e.error instanceof maplibregl.GPUInitializationError)
   showMapFailure('WebGL2 required', e.error.message); })`. MapLibre 6 added this class for exactly
   this case; it is a public export (`src/index.ts:49`, `:235` at v6.6.0) and carries the requested
   attributes plus the browser's `statusMessage`.

Both end in the same panel; the dashboard keeps working (§13.6). Tested with `webgl.disabled=true`
in Firefox `about:config`.

### 13.5 Missing or invalid basemap — deterministic, before MapLibre starts

```
resolve absolute world.pmtiles URL
   v
new PMTiles(url); await getHeader()      <- 404, truncation, bad magic, broken Range -> rejects
   v
validate tileType === Mvt and the zoom range
   v
protocol.add(archive)                    <- reuse the instance and its warm cache
   v
loadStyle(theme, header, url)            <- 404 / invalid JSON -> rejects
   v
new maplibregl.Map({… maxZoom: header.maxZoom …})
```

Any rejection before the last step calls `showMapFailure('Basemap missing or unreadable', 'run:
tools/fetch_basemap.sh --preset dev')`, clears the restore queue (§7.2) and returns — MapLibre is
never constructed, so there is no half-initialised map and no reliance on asynchronous source
errors. PMTiles' own `FetchSource` also raises a specific error when a server ignores byte ranges
("Server returned no content-length header or content-length exceeding request"), which surfaces here
rather than as a blank map. Tile-level failures *after* construction land in `map.on('error')` and
are logged at most once per minute. Tested by renaming the artefact away and by truncating a copy to
100 bytes.

### 13.6 Failure containment: dashboard, data channel, cache

Three invariants, each with an active test:

1. **Compatibility surface exists before any await.**
```js
window.map = null;                      // falsy: the existing `if (window.map)` guards short-circuit;
                                        // set non-null exactly once after construction (D37)
window.clearMapVisuals = () => {        // D38: NOT a no-op — Clear Cache must cancel pending events
  startupTrafficQueue.length = 0;
  pendingRestored.length = 0;
};                                      // the READY implementation additionally clears renderer
                                        // queue, attacker source/registry, markers, choropleth state
window.updateChoropleth = () => {};     // replaced by the D39 bridge receiver after map init
window.processRestoredAttack = queueingStub;   // §7.2
```
   Call sites use optional calls (`window.map?.resize?.()`), so a later refactor cannot reintroduce
   the hazard. Two of the three existing call sites (`dashboard.js:1099`, `:2158`) already guard;
   the third is the new choropleth feed. `window.map` transitions: `null` → the MapLibre instance
   (once, D37) → `null` again only via `map.remove()` on a fatal failure.
2. **The data channel is independent** (D29) **and map side effects follow the D34 lifecycle.**
   `startDataChannel()` is called before `initMap()` and shares no state with it;
   `messageHandlers.Traffic` updates dashboard state unconditionally, then routes map work through
   `mapLifecycle`: `READY` → `renderMapTraffic()` (circle + marker + animation, gated together);
   `INITIALIZING` → bounded startup queue (400, keep-newest); `FAILED` → nothing. On `FAILED` the
   startup queue is discarded with one log line.
3. **The cache path never throws and never silently loses data unnoticed** (§7.2): the queueing stub
   is installed synchronously, bounded at 1000 (keep-newest, single warning), drained after a
   successful init, and discarded with one log line if the map fails — restored events never
   throw, and the non-map dashboard stays alive.

**Active failure test** (WP6, repeated in §17.4): with WebGL2 disabled, and again with the basemap
removed, click the theme toggle, Clear Cache, the fullscreen button, open the settings modal and
toggle the choropleth; then confirm that (a) no exception appears, (b) the connection pill still
shows a live socket, (c) `Stats` messages still update the dashboard counters, and (d) new `Traffic`
messages still update charts, tables and the heatmap.

---

## 14. Basemap reproducibility and supply-chain controls

### 14.1 Why the pinned source is a T-Pot release asset

Protomaps keeps only the last week of daily builds plus the latest build per patch version,
publishes BLAKE3 hashes and discourages hotlinking; `pmtiles extract` output is not guaranteed
byte-identical across CLI versions. So the pinned artefact is produced once and stored immutably,
and Protomaps is touched only by the maintainer's re-pin path.

### 14.2 Immutable release, operationally defined

- Enable **GitHub immutable releases** for the repository. Once published, the release's tag is
  locked to a commit and its assets cannot be modified or deleted; publishing also produces a
  release attestation (tag, commit SHA, asset digests). Existing releases stay mutable unless
  republished, so the basemap release must be created after the setting is enabled.
- Procedure: create a **draft** release, attach `world.pmtiles`, then publish the draft.
- Naming: `basemap-<YYYYMMDD>-z<N>`, separate from application releases, so the artefact exists
  before any 4.0.0 code.
- Independent of that setting: `basemap.lock` carries `WORLD_PMTILES_SHA256`, `fetch_basemap.sh`
  verifies every download, and `tools/check_all.sh --release` re-verifies.

### 14.3 Bootstrap sequence (executed inside WP2 — the lifecycle closes there)

The full twelve-step procedure and its acceptance live in §11 WP2. In short, with the selected
`BUILD_ID` as an **explicit input** (D10 — nothing reads `PM_BUILD` before the lock is filled):

1. `tools/fetch_basemap.sh --from-upstream --upstream-build <BUILD_ID> --maxzoom 6|7 --out /tmp/zN.pmtiles`.
2. Record sizes in `docs/BASEMAP.md`; apply D23.
3. Create the draft release `basemap-<date>-z<N>`, attach the artefact, publish.
4. Fill `WORLD_PMTILES_URL`, `WORLD_PMTILES_SHA256`, `PM_MAXZOOM`, `PM_BUILD=<BUILD_ID>` in
   `tools/basemap.lock`; commit.
5. Verify `--preset full` against the lock and extract the dev presets.

From then on every consumer uses the release path, dev presets are extracts of it, and
`--from-upstream` may default to `PM_BUILD`. Because WP2 completes this, WP3-WP10 never face a
missing release; WP4 uses the release asset or a dev extract of it.

### 14.4 Controls, and the integrity hierarchy

`static/vendor.lock` schema — one record per line, tab-separated, sorted by path:

```
path                              sha384        provenance_type  source                                  version
static/maplibre-gl.mjs            sha384-…      vendored         npm:maplibre-gl/dist/maplibre-gl.mjs    6.6.0
static/styles/dark.json           sha384-…      generated        tools/styles/generate_styles.mjs        @protomaps/basemaps 5.7.2
static/attack-geometry.mjs        sha384-…      local            repository source                       -
static/bootstrap.min.css          sha384-…      vendored         npm:bootstrap/dist/css/bootstrap.min.css 5.3.8
static/chart.umd.js               sha384-…      vendored         npm:chart.js/dist/chart.umd.js          4.5.1
static/fontawesome/css/all.min.css sha384-…     vendored         npm:@fortawesome/fontawesome-free       7.3.1
static/fonts/…                    sha384-…      vendored         rsms/inter@v4.1 / JetBrainsMono@v2.304  v4.1 / v2.304
static/flags/DE.svg               sha384-…      vendored         Yummygum/flagpack-core@v2.1.0 (svg/l)   2.1.0
static/licenses/tangram-icons-MIT.txt sha384-…  vendored         protomaps/basemaps-assets@028c18f7…     -
```

The manifest covers **every shipped direct third-party frontend asset** — the retained legacy
libraries of §6.4 included — so no vendored code exists outside the provenance model merely
because it predates 4.0.

`provenance_type` is one of `vendored` (third-party download, proven against the named upstream
ref), `generated` (produced by a committed tool from a pinned input), `local` (repository source)
or **`legacy`** (a pre-4.0 third-party file recorded at the baseline `e798fcb` whose upstream ref
has **not** been proven — `source = repository baseline e798fcb`, `upstream_ref = unknown`).
`--check-vendor` verifies all four kinds by hash; for `local` and `legacy` files the manifest is a
tamper-evidence record rather than an upstream provenance claim — a file is never labelled
`vendored` from a ref it has not been proven byte-identical to. `legacy` is **interim only**: WP8
removes or replaces every `legacy` entry, and `tools/check_all.sh --release` fails if any remains
(the final release invariant: no retained third-party asset has unknown provenance).

**Manifest lifecycle.** `vendor.lock` always describes the repository as it exists at the end of
the work package that last touched it: WP3 creates it covering every asset present by WP3 and runs
`--check-vendor`; WP5 adds `static/attack-geometry.mjs` and `static/attack-renderer.mjs` when it
creates them and runs `--check-vendor` again. No entry ever precedes its file.

| Control | Mechanism |
|---|---|
| No binary in git | `.gitignore: static/dist/*.pmtiles`; `static/dist/.gitkeep` committed |
| Pinned data | `WORLD_PMTILES_URL` + `WORLD_PMTILES_SHA256`, immutable release + attestation |
| Pinned tool, one implementation | `tools/pmtiles_cli.sh` detects platform, downloads, verifies SHA-256 and execs; every caller uses it; nothing on `PATH`, nothing installed system-wide |
| Lock ↔ artefact agreement | `check_all.sh --release` asserts `pmtiles_cli.sh show` maxzoom equals `PM_MAXZOOM` |
| No compressed sibling next to `.pmtiles` | asserted by `check_all.sh`; `fetch_basemap.sh` refuses to write in that case |
| Atomicity / idempotency | `mktemp -d` + single final `mv`; hash match → "up to date" |
| Verification mode | `--check` prints the exact fix command and exits non-zero |
| Portability | POSIX `sh`; `curl` with `wget -O` fallback; `sha256sum` with `shasum -a 256` fallback |
| Provenance of frontend assets | `vendor.lock` schema above, `--check-vendor` |
| Licence completeness | `vendor_frontend.sh --licenses` fetches every file of §20; `--check-vendor` fails if one is missing |
| Regeneration paths | one documented command per generated committed asset (§12.4) |

**Integrity hierarchy (unchanged by design):**

1. `vendor.lock` + committed hashes — the authoritative build-integrity mechanism, verified locally.
2. SRI on ordinary `<script>`/`<link>` tags — an additional browser-side consistency control.
3. `modulepreload integrity` — a browser-dependent optimisation whose enforcement is *measured* in
   WP4 check 11. **Dynamic-import correctness never depends on it**; if a browser ignores it, the
   module still loads and `vendor.lock` still catches tampering.

---

## 15. Docker / tpotce integration

Single stage, because the image already clones this repository — so script and lock are in the build
context by definition and nothing is duplicated across repositories:

```dockerfile
FROM alpine:3.23
RUN apk --no-cache -U upgrade && \
    apk --no-cache -U add build-base git libcap py3-pip python3 python3-dev tzdata curl && \
    mkdir -p /opt && cd /opt/ && \
    git clone https://github.com/telekom-security/t-pot-attack-map -b 4.0.0 && \
    cd t-pot-attack-map && \
    mv DataServer.py DataServer_v2.py && \
    sh tools/fetch_basemap.sh && \
    sh tools/fetch_basemap.sh --check && \
    pip3 install --break-system-packages -r requirements.txt && \
    setcap cap_net_bind_service=+ep $(readlink -f $(type -P python3)) && \
    addgroup -g 2000 map && \
    adduser -S -H -s /bin/ash -u 2000 -D -g 2000 map && \
    chown map:map -R /opt/t-pot-attack-map && \
    apk del --purge build-base git python3-dev curl && \
    rm -rf /root/* /var/cache/apk/* /opt/t-pot-attack-map/.git
```

- **No floating pip (D40).** The former `pip3 install --upgrade pip` is gone: Alpine 3.23's
  `py3-pip` (25.1.1) installs the exact-pinned wheels of `requirements.txt` as-is. Policy
  distinction, stated once: **application/tool dependencies are exact-pinned** (requirements.txt,
  npm lockfiles, CLI hashes); **Alpine OS packages** are intentionally refreshed within the pinned
  3.23 release channel at image build (`apk -U upgrade` consumes its security fixes). Bit-for-bit
  image reproducibility is explicitly not a project goal — reproducibility claims apply to the
  application dependencies and the basemap artefact, not the OS layer.
- `curl` is a build dependency and removed again; the script falls back to busybox `wget -O`.
- The fetch runs **before** `chown map:map -R`, so the artefact is owned by `map:map`; the extra
  `--check` turns a partial download into a build failure.
- Default preset is `full`: a plain GET of the immutable release asset — **no `go-pmtiles` binary and
  no Protomaps traffic inside the Docker build**.
- No `ADD --checksum`, no second stage, no `BASEMAP_REF`: script and lock come from the clone, which
  `-b 4.0.0` already pins. Each image build downloads the artefact once.
- Origin `telekom-security/t-pot-attack-map` (D25), changed from the current `t3chn0m4g3` fork.
- `MAP_COMMAND`, compose files, ports and the two-container layout are unchanged; `MAP_COMMAND` must
  never point at demo code (asserted by `check_all.sh`).
- Image size grows by the artefact size (**MEASURE**). Both containers share one image layer.

---

## 16. Local development and demo mode

```sh
tools/fetch_basemap.sh --preset dev              # world z0-4, a few MB, extracted from the T-Pot asset
python3 AttackMapServer.py --demo --demo-seed 42 --demo-rate 3
# open http://127.0.0.1:64299
```

No Elasticsearch, no Redis, no Docker. Scenarios: `--demo-scenario
antimeridian|single-location|flood|basic`, `--demo-burst 200`.

Full-chain check (real pubsub path):

```sh
docker run --rm -p 6379:6379 redis:8.4.6-alpine   # pinned; matches the tested Redis 8.4 server line
python3 AttackMapServer.py --redis-url redis://127.0.0.1:6379
python3 -m demo_events --publish-redis redis://127.0.0.1:6379 --demo-rate 5 --demo-seed 42
```

Minimal fallback without tooling:

```sh
redis-cli PUBLISH attack-map-production '{"type":"Traffic","protocol":"SSH","color":"#FF9800","iso_code":"CN","honeypot":"cowrie","src_port":12345,"event_time":"2026-08-31 12:00:00","src_lat":39.9,"src_long":116.4,"src_ip":"1.2.3.4","ip_rep":"Known Attacker","dst_long":8.68,"dst_lat":50.11,"country":"China","dst_port":22,"dst_ip":"10.0.0.1","dst_iso_code":"DE","dst_country_name":"Germany","tpot_hostname":"tpot-test","event_count":1,"continent_code":"AS"}'
```

Production safety: CLI flag only (no env var, not a default); banner at start and every 60 s;
`"demo": true` on every message with a visible badge; no shipped compose file or `MAP_COMMAND`
default references demo code, asserted by grep.

---

## 17. Verification and acceptance test plan

No CI service (D26). Everything automated lives behind one committed command with two modes and an
explicit bootstrap.

### 17.1 `tools/check_all.sh`

```
tools/check_all.sh --bootstrap     # network allowed FOR TOOLING — prepares ALL dev tooling:
                                   #   npm ci --prefix tools/styles
                                   #   npm ci --prefix tools/e2e
                                   #   npx playwright install chromium        (pinned via lockfile)
                                   #   tools/pmtiles_cli.sh --fetch-only      (cache the pinned CLI)
tools/check_all.sh                 # development mode: NO tooling downloads, ANY valid artefact
tools/check_all.sh --release       # everything above plus pinned full-artefact checks; NO tooling downloads
```

**Network policy.** `--bootstrap` is the only mode allowed to download tooling. The normal and
`--release` runs pass `--require-cached` to `tools/pmtiles_cli.sh`, which then fails with the
bootstrap hint instead of downloading; missing `node_modules` or a missing Chromium likewise print
the `--bootstrap` command and exit non-zero. Fetching the deliberately external **basemap
artefact** is a separate, explicit developer action (`tools/fetch_basemap.sh`, §8.3) and is never
performed by any `check_all.sh` mode. After `--bootstrap`, a fresh clone runs
`tools/check_all.sh` (and, with the pinned artefact present, `--release`) fully offline.

| Step | Command | Mode |
|---|---|---|
| Python tests | `python3 -m unittest discover tests` | both |
| SRI | `python3 update_hashes.py --check` | both |
| Vendor manifest | `python3 update_hashes.py --check-vendor` | both |
| Shell syntax | `sh -n tools/*.sh` | both |
| Geometry / renderer units | `node --test tests/js` | both |
| ISO coverage | `node tools/vendor_countries.mjs --verify` | both |
| Style allowlist | `node tools/styles/generate_styles.mjs --verify` (regenerate to a temp dir and diff) | both |
| No compressed sibling for `.pmtiles` | `test ! -e static/dist/world.pmtiles.gz -a ! -e static/dist/world.pmtiles.br` | both |
| Browser smoke | `node tools/e2e/smoke.mjs` against whatever artefact is at `static/dist/world.pmtiles` | both |
| No external hosts | `grep -rn "cartocdn\|openstreetmap.org\|unpkg\|jsdelivr\|protomaps.github.io" static/` | both |
| No demo in production paths | grep over shipped compose/`MAP_COMMAND` defaults | both |
| No stale version | `grep -rn "3\.0\.1" . --exclude-dir=.git` | both |
| Artefact hash | `tools/fetch_basemap.sh --check` | `--release` only |
| Lock ↔ artefact zoom | `tools/pmtiles_cli.sh show static/dist/world.pmtiles` maxzoom equals `PM_MAXZOOM` | `--release` only |

**Why two modes (B3).** A `dev`/`dev-ci` artefact is intentionally z2/z4 and is not the pinned
asset, so it can satisfy neither `WORLD_PMTILES_SHA256` nor `PM_MAXZOOM`. Development mode therefore
never asserts either; it only requires *some* readable archive and checks internal consistency
(`map.getMaxZoom() === header.maxZoom`). Release mode requires the pinned `full` artefact.

**Paths, exactly.** The server always serves `static/dist/world.pmtiles`; that is the only artefact
path. `tools/check_all.sh` and `tools/e2e/smoke.mjs` **never write** to it: the smoke test uses
whatever is there, reports the header it found, and if the file is missing prints
`tools/fetch_basemap.sh --preset dev-ci` and exits non-zero. Measurement runs write to `/tmp`.
Switching between presets is an explicit developer action.

The normal run downloads nothing: if `tools/styles/node_modules`, `tools/e2e/node_modules`, the
Chromium binary or the cached go-pmtiles CLI is missing, it prints the `--bootstrap` command and
exits non-zero. `--bootstrap` is the only mode that touches the network for tooling; the go-pmtiles
acquisition has exactly one implementation (`tools/pmtiles_cli.sh`, §14.4), shared by
`fetch_basemap.sh`, the check scripts and the measurement tooling — no duplicated OS/arch/hash
logic.

**The complete network-permission table.** These are the only commands allowed to access the
network; everything else in the repository must run offline:

| Command | Network | Purpose |
|---|---|---|
| `tools/check_all.sh --bootstrap` | yes | tooling: both `npm ci` workspaces, pinned Chromium, go-pmtiles cache |
| `tools/fetch_basemap.sh` (all presets) | yes | the deliberately external basemap artefact / release extracts |
| `tools/fetch_basemap.sh --from-upstream` | yes | maintainer bootstrap/re-pin (WP2) |
| `tools/vendor_frontend.sh` (incl. `--update`, `--legacy`, `--fonts`, `--flags`, `--licenses`) | yes | maintainer vendoring (WP3/WP8) |
| `tools/vendor_countries.mjs --rebuild` | yes | maintainer regeneration from the pinned Natural Earth source |
| everything else — `check_all.sh` (normal and `--release`), `--verify` modes, `node --test`, unittest, `update_hashes.py`, the smoke test and its server | **no** | verification, fully offline |

Every step of the normal run was audited for transitive fetch surfaces: `npm ci` never runs
outside bootstrap; Playwright launches only the already-installed Chromium (no browser download at
launch); `pmtiles_cli.sh --require-cached` refuses to download; `vendor_countries.mjs --verify`
and `generate_styles.mjs --verify` read only committed/cached files; the smoke-test browser talks
only to the local server (asserted — zero third-party requests).

**Offline acceptance test (release checklist item):**

```sh
tools/check_all.sh --bootstrap                 # once, network allowed
tools/fetch_basemap.sh --preset dev            # once, network allowed
# then block external network (e.g. firewall rule / airplane mode / netns) and run:
tools/check_all.sh                             # MUST be green offline
```

A green offline run proves both halves at once: the tooling caches are complete, and the runtime
browser tests make no third-party request.

### 17.2 Range-request smoke test

```sh
curl -s -D - -o /dev/null -r 0-127 http://127.0.0.1:64299/static/dist/world.pmtiles \
  | grep -E "^HTTP|Content-Range|Content-Length|Content-Encoding"
```
Expect exactly `HTTP/1.1 206 Partial Content`, `Content-Range: bytes 0-127/<total>`,
`Content-Length: 128`, and **no** `Content-Encoding`. Repeat through `/map/…`.

### 17.3 Automated browser smoke test (local, pinned Chromium)

`node tools/e2e/smoke.mjs`:

1. require an artefact at `static/dist/world.pmtiles` (else print the fetch command and fail);
2. start `AttackMapServer.py --demo --demo-seed 42 --demo-rate 5` on a free port;
3. **MIME assertions**: enumerate every `static/**/*.mjs` on disk (which by now includes
   `attack-geometry.mjs` and `attack-renderer.mjs`) and assert each is served with
   `Content-Type: text/javascript` — the dynamic enumeration keeps the check complete for any
   future module without editing the test;
4. open the page, collect page errors and CSP violations, wait for map idle;
5. assert `map.getSource('protomaps')`, `map.getSource('attackers')`, `map.getLayer('attackers-layer')`
   exist, `map.getMaxZoom() === header.maxZoom`, `window.map` is the MapLibre instance (D37), and
   no errors were collected;
6. wait for a demo event; assert `Object.keys(window.circleAttackData).length > 0`;
7. switch theme, wait for `style.load`;
8. assert `attackers` and `countries`/`choropleth` restored, at least one non-zero
   `feature-state.intensity`, still no errors;
9. trigger Clear Cache; assert the map still renders a subsequent event and the choropleth caches are
   empty;
10. in a second context launched without WebGL2, assert the failure panel appears, **and** the
    dashboard still receives `Stats` updates (the §13.6 invariant), **and** `window.map === null`
    (D37) — while in the successful context of steps 4-5 `window.map` is the MapLibre instance
    (asserted in step 5);
11. trigger Clear Cache while an event sits in the startup queue of a delayed-init context and
    assert it never appears after READY (D38).

This is the regression net that survives the deletion of the WP4 PoC page.

### 17.4 Manual browser matrix (Chromium, Firefox, Safari; dark and light)

1. Zero third-party requests; `.pmtiles` responses 206.
2. Console clean: no errors, no CSP violations, no glyph/sprite 404s.
3. Pan, zoom and fullscreen during a demo burst: arcs stay glued to geography.
4. **Arc uniformity (new):** with `--demo-scenario basic`, compare a high-latitude short route
   (Reykjavík → Oslo), an equatorial short route and a long route (Tokyo → San Jose): bend
   amplitude must follow the projected screen distance and stay within the pixel bounds — i.e.
   screen-space-normalised, not latitude-scaled (§9.3).
5. Theme toggle mid-burst: basemap swaps; circles and choropleth reappear; markers and open popups
   survive; animations continue.
6. `--demo-scenario antimeridian` at zoom 1 with several world copies: short-path arcs; a newly
   spawned arc appears on the copy nearest the current centre, and **no running arc ever teleports
   ±360° while panning continuously** (it may move out of view — that is correct, §9.3).
7. `--demo-scenario single-location`: one coordinate accumulates several IPs; popup lists them; the
   LRU cap does not evict the live set.
8. Popup content identical to the WP1 screenshots.
9. Tab away and back: no animation burst; socket reconnects after a server restart; pill correct.
10. Clear Cache empties map and choropleth without errors; later events still render.
11. WebGL2 disabled: panel shown, and the §13.6 active sweep raises no exception while data keeps
    flowing.
12. Basemap renamed away, and separately truncated to 100 bytes: panel with the fetch command,
    dashboard usable, data still flowing.
13. Sub-path: repeat 1-5 behind `/map/`.

### 17.5 Deterministic visual regression — honest scope

Seeded generation makes event *content* deterministic; it does not make frames deterministic, and
Canvas 2D output is **not** byte-identical across platforms (rasterisation and antialiasing differ by
OS, browser, graphics backend and version).

| Level | Scope | Determinism |
|---|---|---|
| Unit tests (`node --test`) | geometry, bend bounds, easing, curve endpoints, degenerate cases | **exact** |
| Structural browser assertions (`smoke.mjs`) | sources, layers, zoom limits, feature-state, error counts | **exact** |
| Screenshot comparison | the attack canvas only, injected clock + explicit `renderFrame(t)`, in the **one pinned Chromium** of `tools/e2e` | tolerance-based (per-pixel threshold + allowed-diff ratio), never cross-platform |
| Human review | dark/light parity against the WP1 screenshots, including arc uniformity | judgement |

Cross-platform pixel tests are deliberately not created.

---

## 18. Performance test plan

| Scenario | Command | Criterion |
|---|---|---|
| Steady state | `--demo-rate 2` | ≥ 55 fps on a 2019-class laptop, main-thread frame time < 8 ms |
| Realistic peak | `--demo-rate 20` | ≥ 30 fps, queue within the cap |
| Flood fuse | `--demo-burst 200` / `--demo-scenario flood` | queue capped at 300, memory bounded, UI interactive |
| 10-minute soak | `--demo-rate 5` for 600 s | heap flat within ±15 % after GC; markers and circles capped at 200 |
| Cold load | reload with an empty cache | first rendered frame < 3 s locally; record bytes and request count |
| Theme thrash | 20 × `setStyle` | no WebGL-context leak, no monotonic memory growth |
| Pan under load | continuous drag during `--demo-rate 20` | no frame > 50 ms attributable to per-event `project` calls (world-copy offsets are frozen at spawn, §9.3) |

Per frame the renderer performs 2 projections and 24 curve evaluations per event: 600 projections at
the 300-event cap — an order of magnitude below sampling geography per point, which is a direct
benefit of the screen-space bend (§9.3).

---

## 19. Browser compatibility

- **Required:** WebGL2, ES modules with dynamic `import()`, module workers, `fetch`, IndexedDB
  (already required by the cache).
- WebGL1 support was removed in **MapLibre 6.0.0** — the changelog entry reads "⚠️ WebGL (v1) support
  has been removed; WebGL2 is now required" — while v5 still had a WebGL1 fallback. T-Pot inherits
  this by choosing 6.6.0, which is part of what makes 4.0.0 a major release. For ecosystem support
  upstream points to `caniuse.com/webgl2`; this document does not restate it.
- **No invented minimum version numbers.** The supported set is the exact Chrome/Edge, Firefox (and
  Firefox ESR) and Safari versions recorded in the release PR, on which the §17.4 matrix was run.
- Graceful degradation for missing WebGL2 (§13.4) is the guarantee given to users, not a version
  table.
- Retina handling is automatic (`devicePixelRatio`); `detectRetina` and the tile-gap hack disappear
  with raster tiles.

---

## 20. Licensing and attribution

Every redistributed third-party component that requires a notice has a committed file under
`static/licenses/`, fetched by `tools/vendor_frontend.sh --licenses` and hashed in `vendor.lock`:

| File | Component | Licence | Why it ships |
|---|---|---|---|
| `static/licenses/maplibre-BSD-3-Clause.txt` | MapLibre GL JS 6.6.0 | BSD-3-Clause | `.mjs`/`.css` redistributed |
| `static/licenses/pmtiles-BSD-3-Clause.txt` | PMTiles JS 4.5.0 | BSD-3-Clause | `.mjs` redistributed |
| `static/licenses/protomaps-basemaps-BSD-3-Clause.txt` | `@protomaps/basemaps` 5.7.2 | BSD-3-Clause | generated style layers derive from it |
| `static/licenses/tangram-icons-MIT.txt` | sprite sheets | **MIT** (`basemaps-assets`: "derived from MIT-licensed tangrams/icons") | full sprite sheets redistributed |
| `static/licenses/noto-OFL-1.1.txt` | Noto Sans glyph PBFs | OFL 1.1 | glyphs redistributed (upstream `fonts/OFL.txt`) |
| `static/licenses/natural-earth-TERMS.txt` | 50m admin-0 map units (v5.1.2) | public domain | provenance and courtesy attribution |
| `static/licenses/basemap-data-ODbL.txt` | Protomaps basemap tiles (OSM produced work) | ODbL | attribution obligation; the in-map control is the primary compliance |
| `static/licenses/bootstrap-MIT.txt` | Bootstrap CSS 5.3.8 | MIT | `bootstrap.min.css` redistributed |
| `static/licenses/chartjs-MIT.txt` | Chart.js 4.5.1 | MIT | `chart.umd.js` redistributed |
| `static/licenses/fontawesome-LICENSE.txt` | Font Awesome Free 7.3.1 | icons CC BY 4.0, fonts OFL 1.1, code MIT | CSS + webfonts redistributed |
| `static/licenses/inter-OFL-1.1.txt` | Inter v4.1 | OFL 1.1 | woff2 files redistributed |
| `static/licenses/jetbrains-mono-OFL-1.1.txt` | JetBrains Mono v2.304 | OFL 1.1 | woff2 files redistributed |
| `static/licenses/flagpack-MIT.txt` | Flagpack v2.1.0 flag SVGs | MIT | 251 flag SVGs redistributed |

In-map attribution stays visible (`attributionControl: {compact: true}`) with
"Protomaps © OpenStreetMap" from the style — removing it would breach ODbL. The README licence list
mirrors this table; Leaflet, Leaflet.fullscreen and D3 are removed from it.

---

## 21. Risks and mitigations

| # | Risk | Mitigation | Detected by |
|---|---|---|---|
| R1 | `setStyle` drops sources/layers/feature-state, possibly partially | per-object guards + unconditional feature-state re-application (§7.6) | smoke test 8, matrix 5 |
| R2 | Zoom/scale mismatch with the old map | 512 px reasoning + header-driven `maxZoom` + before/after screenshots | WP4 13, smoke test 5 |
| R3 | Module/classic load order | `await Promise.all([import(...)])` inside `map.js` | WP4 14, smoke test |
| R4 | aiohttp or nginx breaks ranges | curl tests direct and proxied incl. `Content-Encoding`; PMTiles' own byte-serving error surfaces in the failure panel | §17.2 |
| R5 | Visual parity complaints | allowlist styles, dark flavour, arc calibration against WP1 screenshots, early sign-off | WP6 review, matrix 4 |
| R6 | Antimeridian / world-copy errors | unwrap + `chooseWorldCopy` frozen at spawn, exact unit tests incl. continuity | `node --test`, matrix 6 |
| R7 | Protomaps build disappears | immutable T-Pot release is the only build input; dev presets extract from it | `--check`, §14 |
| R8 | Artefact inflates the image | measure first, rule D23, one shared layer | §8.2, WP9 |
| R9 | Per-frame cost under flood | 2 projections/event + 300 cap | §18 |
| R10 | Demo data reaching production | four safeguards + grep | `check_all.sh` |
| R11 | `vendor.lock` drift | `--check-vendor`, refuse silent overwrites | `check_all.sh` |
| R12 | Silent change from removing the dead `getCoordinates` branch | explicit warning; keys untouched; changelog entry | code review |
| R13 | MapLibre 6.x churn | exact pin; upgrades are a separate mechanical commit | `vendor.lock` |
| R14 | Choropleth ISO gaps | measured dataset choice; committed universe and unsupported lists; runtime logs unmatched codes once | `vendor_countries.mjs --verify` |
| R15 | PMTiles/MapLibre protocol pairing | proven in WP4 before anything depends on it; fallback is a thin `tilev4` adapter | WP4 6 |
| R16 | Flaky screenshot tests | tolerance comparison in one pinned Chromium only | §17.5 |
| R17 | Preflight adds a round trip | one ~16 KB range request, reused by the protocol via `protocol.add()`; dropping `metadata` removed a request | WP4 7, 15 |
| R18 | `.mjs` served with the wrong MIME type | response middleware (D31; `mimetypes.add_type` is provably ineffective for `FileResponse`) + explicit header assertions direct and proxied for every shipped `.mjs` | WP4 1, §17.3 step 3 |
| R19 | A `.gz` sibling appears next to `.pmtiles` and breaks ranges | `fetch_basemap.sh` refuses; `check_all.sh` asserts absence | both |
| R20 | Cache-restore queue grows unbounded on a slow start | bounded at 1000, keep-newest (oldest shifted out with one warning), discarded on failure | §7.2 |
| R21 | A future `@protomaps/basemaps` bump silently adds layers | allowlist + generator fails on unknown ids | `check_all.sh` |
| R22 | Traffic during the startup interval vanishes from the map or throws | D34 lifecycle; bounded startup queue (400, keep-newest), drained on READY, discarded on FAILED; all map side effects gated together | WP6 startup-timing tests 1-5 |
| R23 | A dependency pin goes stale or vulnerable between plan and release | D35: matrix regenerated immediately before implementation; advisory check recorded; vulnerable pin = release blocker | §24 item 2 |
| R24 | tpotce bumps the Elasticsearch server after the client pin | maintainer confirms the shipped ES version at implementation start; client re-pinned to newest ≤ server minor | §23 action 3 |
| R25 | Rapid theme toggling applies a stale style | revision counter in `updateMapTheme` discards superseded fetches | WP4 12b |
| R26 | Clear Cache races the startup/restore queues and a cleared event resurrects | D38: the `clearMapVisuals` stub always empties both queues | WP6 tests 6-7; smoke test 11 |
| R27 | A legacy upgrade (Bootstrap 5.3.8 / Chart.js 4.5.1 / FA 7.3.1 / fonts) changes visuals unnoticed | §6.4 icon audit recorded up front; WP8 visual verification against the WP1 screenshots | WP8 acceptance |
| R28 | `window.map` diverges from the lifecycle (stale instance after failure) | D37 single assignment + `map.remove()`/`null` reset; asserted for both outcomes | smoke test 5/10 |
| R29 | An early Traffic message races dashboard initialization (real in 3.0.1: unguarded `map.js:1261` vs `window.load`-time init) | D43: synchronous dashboard instantiation, polling deleted, spec-guaranteed ordering chain, guarded calls | WP6 test 8 |
| R30 | Theme change during INITIALIZING or after FAILED dereferences missing map state | D44: pending-theme, no map work outside READY | WP6 tests 9-10 |
| R31 | A hidden network fetch breaks the offline promise | network-permission table + offline negative acceptance test | §17.1; §24 |
| R32 | Generated artefacts silently depend on the contributor's Node version | D45: `.node-version` = 24.20.0 LTS, npm 11 lockfileVersion 3 | `check_all.sh` warns on mismatch |

---

## 22. Explicitly deferred work

1. **Globe projection** — 4.0 is globe-*ready* as defined in §10.
2. **Physically reduced T-Pot tileset** — needs a Planetiler run over a planet PBF.
3. **Reduced sprite sheet** — only `capital` and `townspot` are used; a two-icon sheet via `spreet`
   would shrink the payload and the licence surface.
4. **Activating cache-to-map restoration** — the contract exists and is queue-protected, but nothing
   calls it today (§7.2); wiring it up is new behaviour.
5. **CSP as an HTTP response header** (enables `frame-ancestors`).
6. **MapLibre 7 / future distribution changes** — the vendoring procedure makes this mechanical.
7. **Terrain, pitch, 3D arcs.**
8. **A CI service** — `tools/check_all.sh` is the contract.
9. **Refactoring `service_rgb`/`PORT_MAP` into a shared module.**
10. **Gibraltar (GI) and other codes without polygons** — listed in `tools/iso_unsupported.txt`; a
    10m supplement could close them if it ever matters.
11. **Tiny-country point layer.** Small states (SG, HK, MC, LI, MT, AD, SM, VA, …) have polygons
    and correct feature-state but are effectively invisible at world zoom. A supplemental point
    layer driven from the same derived intensity — visible at low zoom, hidden once the polygon is
    visually sufficient — is the designed remedy; 4.0 records the WP7 tiny-state findings instead
    of shipping it. This is a deliberate deferral, not a claim of visual coverage.

---

## 23. Maintainer decisions

**None open.** All technical questions are decided in §4; the former M1-M3 became D23-D25 and the
two product choices became D27/D28 (badge shown, choropleth on).

Three maintainer *actions* remain, none of them a question:

1. Release permissions on `telekom-security/t-pot-attack-map` for WP2, which now **includes**
   publishing the immutable `basemap-*` release (§11 WP2, §14.3) — no separate "before WP6"
   scheduling step remains.
2. Write access to `tpotce` for the WP9 Dockerfile change (origin and tag).
3. Execute the **Dependency Freeze Gate G-DEP** (D42) as WP1 step 0 — it covers every category
   and writes `docs/DEPENDENCIES.md`. Within it, confirm the Elasticsearch server version tpotce
   will ship with the 4.0.0 release (currently **9.3.5** on master); if it moved to ≥ 9.4/9.5,
   raise the `elasticsearch` client pin to the newest release whose minor is ≤ the server minor
   (§5.3, §6.0).

---

## 24. Release checklist (4.0.0)

1. `basemap-<date>-z<N>` release exists, is immutable, and `basemap.lock` matches its SHA-256.
2. **Dependency Freeze Gate satisfied (D35/D42):** `docs/DEPENDENCIES.md` was regenerated at the
   G-DEP gate (WP1 step 0) and re-checked before release, covering **all** categories —
   §6.0 Python, §6.2 tooling/platform, §6.4 legacy/vendored refs, Node/npm baseline, and the
   tpotce ES/Redis server versions; every pin is the newest stable compatible version or carries
   a written justification; the advisory check (PyPI/npm/GitHub advisories) is recorded in the
   PR; no selected dependency has an unresolved relevant high/critical advisory — if one does,
   the release **stops** and the problem is surfaced; no floating version anywhere
   (`grep -E '\^|>=|latest' requirements.txt tools/*/package.json` finds nothing for runtime
   deps, and the Dockerfile contains no `--upgrade pip`); no supply-chain placeholder
   (`grep -n "pinned commit\|pinned tag\|<commit>\|<tag>" docs/HANDOFF-v2.md tools/` finds
   nothing); `grep -n "jquery\|luxon\|bootstrap.min.js" static/index.html` is empty; **no
   `provenance_type: legacy` entry remains in `vendor.lock`**.
3. WP4 gate results attached to the PR (all fifteen checks), including the `.mjs` MIME assertions,
   the request-count evidence for dropping `metadata`, and the modulepreload-integrity outcome per
   browser.
4. `docs/BASEMAP.md` records measured sizes, the D23 outcome, build id, CLI version, date and the
   image delta.
5. `tools/check_all.sh` green (after `--bootstrap`) and `tools/check_all.sh --release` green against
   the pinned artefact; shell steps also run under Alpine busybox.
6. `node tools/vendor_countries.mjs --verify` green: no unmatched ISO code outside
   `tools/iso_unsupported.txt`, and exactly one feature per ISO code (no duplicate ids).
7. Manual matrix §17.4 completed in three browsers, both themes, plus `/map/`; browser versions
   recorded in the PR.
8. Range smoke test §17.2 passes direct and proxied, no `Content-Encoding`; the **offline
   acceptance test** (§17.1: bootstrap once, dev fetch once, external network blocked,
   `tools/check_all.sh` green) has been executed and recorded.
9. Performance criteria §18 recorded; arc calibration values recorded with their rationale; WP7
   tiny-state findings recorded (§22 item 11).
10. Grep assertions clean (no external hosts, no demo defaults, no `3.0.1`, no `.gz` next to
   `.pmtiles`).
11. `docs/BASELINE.md` screenshots compared and signed off, then the file deleted.
12. Version strings bumped (§12.5); README licence list mirrors §20; removed files actually deleted;
    `git status` clean with no `*.pmtiles` tracked.
13. `static/poc.html` and the temporary route are gone (`grep -rn poc.html .`).
14. Tag `4.0.0`; then tpotce: origin and tag updated, image rebuilt and pushed, size change recorded.
15. Answer tpotce discussion #1913: CARTO now requires a key and is retiring raster basemaps; T-Pot
    ships a fully offline vector basemap instead, and no API-key configuration is planned.

---

## 25. Prior art and external references

- tpotce discussion #1913 — the CARTO watermark report:
  <https://github.com/telekom-security/tpotce/discussions/1913>. Keys are free (5M tiles/month) but
  raster basemaps are being retired, which is why a key was rejected.
- Home Assistant migrated to self-hosted vector assets for the same reason:
  <https://github.com/home-assistant/frontend/pull/53816>.
- MapLibre GL JS: <https://github.com/maplibre/maplibre-gl-js>; v5→v6 migration guide
  <https://maplibre.org/maplibre-gl-js/docs/guides/v5-to-v6-migration-guide/>. Read at tag `v6.6.0`:
  `src/util/web_worker.ts` (same-origin worker), `CHANGELOG.md` 6.0.0 (WebGL2),
  `src/util/gpu_initialization_error.ts` and `src/index.ts` (`GPUInitializationError`,
  `setWorkerUrl`, `addProtocol`).
- PMTiles: <https://github.com/protomaps/PMTiles>. Read at 4.5.0: `dist/esm/index.d.ts` (`Header`,
  `PMTiles#getHeader`, `Protocol#add`) and `dist/esm/index.js` (`tilev4`'s `json` branch, which shows
  that `metadata: true` costs an extra `getMetadata()` request, and `FetchSource`'s byte-serving
  error). CLI: <https://docs.protomaps.com/pmtiles/cli> (`extract` from local or remote archives);
  releases <https://github.com/protomaps/go-pmtiles/releases>.
- Protomaps basemap: schema <https://docs.protomaps.com/basemaps/layers>, flavors
  <https://docs.protomaps.com/basemaps/flavors>, downloads and retention
  <https://docs.protomaps.com/basemaps/downloads>, build channel <https://maps.protomaps.com/builds>.
  Layer zoom ranges read from `tiles/src/main/java/com/protomaps/basemap/layers/` (`Landcover`,
  `Landuse`, `Roads`, `Buildings`, `Pois`); style code from `styles/src/base_layers.ts`; glyphs,
  sprites and their licence statement from <https://github.com/protomaps/basemaps-assets>.
- Natural Earth: <https://github.com/nvkelso/natural-earth-vector> — 110m/50m admin-0 countries and
  50m admin-0 map units were downloaded and counted for §8.5.
- aiohttp <https://github.com/aio-libs/aiohttp>, read at tag **v3.14.3**:
  `aiohttp/web_fileresponse.py` — `Range`/206/`Content-Range`/`Accept-Ranges` handling
  (lines 340-419), `ENCODING_EXTENSIONS` for precompressed `.gz`/`.br` siblings, and MIME
  resolution via the **module-private** `CONTENT_TYPES = MimeTypes()` instance (line 52) that the
  global `mimetypes.add_type()` never reaches; `FileResponse.prepare()` guesses only when
  `Content-Type` is unset (line 385). Security: GitHub advisories CVE-2026-69244 (≤ 3.14.2),
  CVE-2026-69243 and CVE-2026-59881 (≤ 3.14.1). CPython v3.12.14 `Lib/mimetypes.py:435-436` maps
  `.js`/`.mjs` → `text/javascript` (Alpine 3.23's Python).
- GitHub immutable releases:
  <https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases>.
- Legacy frontend upstreams (verified 2026-08-31): Bootstrap <https://github.com/twbs/bootstrap>
  (5.3.8); Chart.js <https://github.com/chartjs/Chart.js> (4.5.1); Font Awesome
  <https://github.com/FortAwesome/Font-Awesome> — the §6.4 icon audit was run against
  `metadata/icons.json` and `css/all.min.css` at tag `7.3.1`; Inter <https://github.com/rsms/inter>
  (v4.1); JetBrains Mono <https://github.com/JetBrains/JetBrainsMono> (v2.304); Flagpack
  <https://github.com/Yummygum/flagpack-core> (v2.1.0, size "l" — `static/flags/` sample verified
  byte-identical); jQuery 4.0.0 and Luxon 3.7.2 exist upstream but both libraries are removed as
  unused (§6.4).

---

## Architectural consistency check

| Requirement | Design mechanism | Verification | Status |
|---|---|---|---|
| No CARTO | tile layers deleted; CSP without external hosts | `grep -rn cartocdn static/` → attribution only | Designed |
| Zero external runtime requests | everything vendored same-origin, licences included | WP4 6; grep in `check_all.sh` | Designed |
| Single PMTiles basemap | one archive, `pmtiles://`, no `.gz` sibling | WP4 2-3; `check_all.sh` | Designed |
| Dark/light from one dataset | two committed styles over the same source | matrix 5; smoke test 7-8 | Designed |
| Reproducible basemap | immutable release + SHA-256 + atomic/idempotent script | `--check`, `--release` | Designed |
| One CLI-pin implementation | `tools/pmtiles_cli.sh`, used by every caller; nothing on `PATH` | tamper test in WP2 | Designed |
| Dev artefacts independent of upstream retention | extracts of the T-Pot asset | §8.3; WP2 tests | Designed |
| Dev vs release checks separated | two modes, exact paths, smoke test never writes `static/dist/` | §17.1 | Designed |
| Artefact exists before it is needed | dedicated `basemap-*` release before 4.0.0 | checklist 1 | Designed |
| No Redis/ES for frontend work | `--demo` + stdlib generator | §16 | Designed |
| No forward WP dependency | dependency table with "introduces" column | §11.0 | Designed |
| Deterministic startup | `await Promise.all([import()])`; no globals, no polling | WP4 14; smoke test | Designed |
| Renderer available before use | renderer is part of the awaited module set | §7.1 | Designed |
| Cache restore safe under async start | synchronous bounded queue, drained or discarded | §7.2; WP6 test | Designed |
| Map failure never stops data | `startDataChannel()` separate from `initMap()` | §13.6 active sweep; smoke test 10 | Designed |
| Base-URI strategy proven for `/map/` | temporary `/poc.html` route; both URLs tested | WP4 9, 14 | Designed |
| Glyph template survives normalisation | resolved base + literal template; braces asserted | WP4 8 | Designed |
| Correct `.mjs` MIME type | D31 response middleware (public API, verified against aiohttp 3.14.3) + header assertions for every shipped `.mjs`, direct and proxied | WP4 1; §17.3 step 3 | Designed |
| Current, non-vulnerable dependencies | D35 invariant; §6.0 matrix with advisory evidence; exact pins only | §24 item 2; WP1 | Designed |
| Traffic during startup neither lost nor throwing | D34 lifecycle + bounded startup queue (keep-newest), all map side effects gated together | WP6 startup-timing tests 1-5 | Designed |
| Queue drop policy consistent everywhere | keep-newest (shift oldest, append newest) in both queues, same wording in code, prose, tests, risks | §7.1, §7.2, R20, R22 | Designed |
| `vendor.lock` has no forward dependency | WP3 covers assets existing by WP3; WP5 adds its modules and re-verifies | §14.4 lifecycle; WP5 acceptance | Designed |
| Unique country feature ids | merge by `ISO_A2_EH` to one Feature per code; duplicate id → non-zero exit | `vendor_countries.mjs --verify` | Designed |
| Visual coverage honestly stated | tiny-state check in WP7; point layer explicitly deferred | WP7 test; §22 item 11 | Designed |
| Basemap/choropleth alignment honestly stated | fill without own outline under Protomaps boundary lines; no exact-alignment claim | §8.5 wording; WP7 | Designed |
| Legacy frontend stack reviewed, not inherited | §6.4 usage evidence; unused libs removed; retained libs upgraded, pinned, in `vendor.lock` | WP8 acceptance; §24 item 2 | Designed |
| Basemap bootstrap acyclic and closed in WP2 | explicit `--upstream-build`; twelve-step WP2 acceptance incl. published release | §11 WP2; §14.3 | Designed |
| Exactly one successful `window.map` assignment | D37 lifecycle, reset via `map.remove()` on fatal failure | smoke test 5/10 | Designed |
| Clear Cache cancels pre-clear events | D38 stub clears both queues in every lifecycle state | WP6 tests 6-7; smoke test 11 | Designed |
| Failure panel markup precedes its tests | functional markup in WP6, styling in WP8 | WP6/WP8 file lists | Designed |
| Choropleth bridge explicit, absolute counts | D39: `updateChoropleth(iso2, absoluteHits)` → renderer-local `choroplethHits`; no cross-script state access | §8.6; WP7 tests | Designed |
| CSP claims match enforcement | ws:/wss: wording corrected; WebSocket same-origin via URL construction + network tests | §13.1; WP4 6 | Designed |
| Theme switch immune to async reordering | revision counter | WP4 12b | Designed |
| No floating pip; OS vs app dependency policy stated | D40; Dockerfile without `--upgrade pip` | §15; §24 item 2 | Designed |
| Tooling platform support precise | D41: three named platforms; cache keyed by OS+arch | §14.4; WP2 | Designed |
| One named dependency freeze gate for ALL categories | D42/G-DEP: consolidated `docs/DEPENDENCIES.md` at WP1 step 0 | WP1 gate acceptance; §24 item 2 | Designed |
| Data channel never races dashboard init | D43: synchronous instantiation, polling deleted, spec-guaranteed ordering | WP6 test 8 | Designed |
| Theme changes lifecycle-safe | D44: pending-theme; no map work outside READY; revision counter when READY | WP6 tests 9-10; WP4 12b | Designed |
| Offline verification literal, not prose | `--verify` offline / `--rebuild` network split; network-permission table; offline negative test | §8.5; §17.1; §24 item 8 | Designed |
| Interim provenance truthful | `provenance_type: legacy` for unproven baseline files; eliminated by WP8; asserted at `--release` | §14.4; WP8 acceptance | Designed |
| Toolchain baseline recorded | D45: `.node-version` = 24.20.0 LTS, npm 11 | §6.2; WP3 | Designed |
| No stale historical claim standing | rev-6 sweep (FB1/FB10): corrections recorded as corrections only | §0.6; §5.5 | Designed |
| No unnecessary startup requests | `new Protocol()`; preflight header reused via `protocol.add()` | WP4 7 | Designed |
| Zoom limits cannot disagree with data | `maxZoom = header.maxZoom`; styles carry no `maxzoom` | smoke test 5; `--release` | Designed |
| Missing/corrupt basemap caught early | preflight before construction | §13.5 tests | Designed |
| Partial style state recoverable | per-object guards; feature-state always re-applied | double-call test | Designed |
| Choropleth state correct under renormalisation | raw counts authoritative; full recompute on `maxHits` change | WP7 test | Designed |
| Choropleth ISO coverage adequate | measured dataset choice; committed universe/unsupported lists | `vendor_countries.mjs --verify` | Designed |
| Clear Cache resets choropleth | one handler resets all three layers | WP7 test; smoke test 9 | Designed |
| Pan/zoom-safe rendering | endpoints re-projected per frame; `zoomstart` clear removed | matrix 3; `grep zoomstart` empty | Designed |
| Antimeridian-safe rendering | `unwrapLongitude` + `chooseWorldCopy` once at spawn; offset frozen, no mid-animation teleport | `node --test` incl. continuity test; matrix 6 | Designed |
| Visually uniform arcs | bounded screen-space bend, calibrated against WP1 | matrix 4; unit tests on bounds | Designed |
| Event model renderer-neutral | no shape/pixel/projection data in `AttackEvent` | code review; §9.2 | Designed |
| Globe claim not overstated | §10 lists the outstanding renderer work incl. antipodal handling | wording review | Designed |
| Style filter predictable | allowlist + generator fails on unknown ids | `check_all.sh` | Designed |
| Low-zoom content claim accurate | measured per-layer zoom ranges in §8.4 | source references | Designed |
| Strict CSP | D8; no inline script; same-origin worker | WP4 10 incl. negative control | Designed |
| Integrity hierarchy explicit | `vendor.lock` authoritative; SRI additional; modulepreload measured | `--check-vendor`; WP4 11 | Designed |
| `vendor.lock` scope unambiguous | schema with `provenance_type` | §14.4 | Designed |
| Licences complete and present | `static/licenses/` table; fetch + hash + check | `--check-vendor` | Designed |
| Every generated asset regenerable | one documented command each, each printing a report | §12.4 | Designed |
| Fresh clone can run all checks | `--bootstrap`, then offline runs | §17.1 | Designed |
| No flaky cross-platform pixel tests | tolerance screenshots in the pinned Chromium only | §17.5 | Designed |
| Docker integration | single stage, script from the clone, fetch before `chown` | WP9 | Designed |
| Demo-mode production safety | CLI-only, banner, `demo:true`, badge, grep | `check_all.sh` | Designed |
| Checklist matches WP order | §24 items map to WP0-WP10 outputs | review | Designed |

"Designed" means the mechanism is specified here and its verification is defined; it becomes
"Verified" once the named check has been executed and recorded in the PR.

---

## Implementation readiness check

Remaining items are classified: **[M]** = maintainer action, **[C]** = deliberate calibration
work, **[G]** = executed at the G-DEP gate. There are **no open technical blockers**.

| Area | Ready? | Remaining dependency |
|---|---|---|
| Dependency freeze | Yes | **[G]** run G-DEP (D42) as WP1 step 0: re-check every category, write `docs/DEPENDENCIES.md`, freeze pins — all selections verified current as of 2026-08-31 (revision 6 re-check: nothing moved) |
| Python runtime dependencies | Yes | §6.0 pins verified against PyPI, advisories, tpotce and Alpine 3.23 on 2026-08-31; re-confirmed at the gate **[G]** |
| Frontend/tooling dependencies | Yes | MapLibre 6.6.0, PMTiles 4.5.0, `@protomaps/basemaps` 5.7.2, go-pmtiles 1.31.2 re-verified latest stable 2026-08-31; Playwright 1.62.1 pinned at `npm ci` time |
| Legacy frontend dependencies | Yes | §6.4 decided on usage evidence: remove jQuery/Luxon/Bootstrap-JS, upgrade Bootstrap CSS 5.3.8 / Chart.js 4.5.1 / FA 7.3.1 (icon audit passed), re-vendor fonts and flags from pinned refs; executed in WP8; interim state truthfully marked `legacy` in `vendor.lock` |
| Supply-chain refs | Yes | none — every placeholder replaced by an immutable commit/tag (§0.5 item 58) |
| MapLibre version, distribution, worker, CSP | Yes | none — pinned; worker path and WebGL2 statement read from v6.6.0 source and changelog |
| PMTiles client, protocol, preflight | Yes | WP4 6 confirms the `addProtocol` pairing (R15); API shapes read from 4.5.0 sources |
| Startup, bootstrap, failure containment | Yes | none — dynamic import, two startup domains, D34 lifecycle with bounded startup queue, bounded restore queue (both keep-newest); D43 removes the measured 3.0.1 dashboard-init race and its polling; D44 makes theme changes lifecycle-safe |
| `.mjs` MIME type | Yes | none — D31 middleware verified against aiohttp 3.14.3 semantics; WP4 1 and §17.3 step 3 assert every shipped `.mjs` |
| Asset URL strategy incl. sub-path | Yes | none — assertions defined and executed at both base URIs |
| Zoom semantics | Yes | none — header-driven; the `maxzoom+1` comparison is recorded, not blocking |
| Basemap artefact lifecycle | Yes | closed **inside WP2** (twelve-step acceptance incl. the published immutable release); no downstream scheduling constraint remains |
| Production maxzoom | Yes, by rule D23 | **[M]** WP2 measurement feeds the rule; release publishing needs repo release permissions |
| Pinned CLI availability | Yes | none — `tools/pmtiles_cli.sh` is the single implementation |
| Style generation and allowlist | Yes | none — generator, lockfile, allowlist, known-dropped list, failure mode |
| Country geometry and ISO coverage | Yes | none — dataset chosen on measured evidence; merged to one feature per ISO code with a uniqueness assertion; `iso_universe.txt` is committed in WP3; visual coverage of tiny states is measured in WP7 and the point layer deferred (§22 item 11) |
| Choropleth semantics and state layers | Yes | none |
| Attack model and geometry | Yes | none — formulas, degenerate cases and unit assertions specified |
| Renderer visual parameters | Calibration pending by design | **[C]** `FACTOR`, `MIN/MAX_BEND_PX`, `R1`/`R7` are set in WP6 against the WP1 screenshots and recorded |
| Globe readiness | Yes | none in 4.0; §10 lists the future renderer work |
| Test strategy and tooling | Yes | Playwright's exact version is pinned when `tools/e2e/package-lock.json` is generated (under Node 24.20.0/npm 11, D45); offline acceptance test defined (§17.1) |
| Local check suite | Yes | none — two modes plus `--bootstrap` |
| Licensing | Yes | none — file list, fetch step and verification defined |
| Docker / tpotce | Yes | **[M]** maintainer write access for D25 |
| Open product choices | None | P1/P2 decided as D27/D28 |

Nothing in this table blocks the start of WP0. The former scheduling constraint (basemap release
before WP6) is gone: WP2's acceptance closes the entire artefact lifecycle, including the
published immutable release, before any later package begins.
