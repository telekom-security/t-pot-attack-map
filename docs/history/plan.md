# T-Pot Attack Map 4.0.0 — migration brief

> **Historical document.** Internal planning record of the 4.0.0 migration, kept for
> provenance — NOT user or developer documentation; see [README.md](../../README.md),
> [docs/BASEMAP.md](../BASEMAP.md) and [docs/RELEASING.md](../RELEASING.md).
>
> **Plan of record: [`HANDOFF-v2.md`](HANDOFF-v2.md).**
> This file states the problem and the architectural intent it must satisfy. Everything that has
> since been decided, measured or disproven lives in the handoff — where the two ever disagree,
> the handoff wins.
>
> An earlier draft (`docs/HANDOFF-attack-map-carto.md`) has been superseded and removed; the
> corrections that replaced it are listed in §0 of the handoff.

---

## Problem

The Attack Map loads CARTO raster basemaps without a key (`static/map.js:38-52`). CARTO now
requires an API key for unauthenticated tile access and renders an "API KEY REQUIRED" watermark,
and it is retiring raster basemaps entirely, so every T-Pot installation worldwide shows the
watermark (tpotce discussion #1913).

A CARTO API key is explicitly **not** the solution: it postpones a dependency we do not want.
The objective is to remove CARTO and every external runtime basemap dependency.

## Direction

```
  Leaflet + D3/SVG            ->  MapLibre GL JS
  CARTO raster basemap        ->  local vector tiles
  remote tile service         ->  PMTiles (one file, HTTP range requests)
  separate dark/light data    ->  one dataset + several styles
  Internet-dependent map      ->  fully offline / air-gap capable
```

The map must make **zero third-party network requests at runtime**.

## Architectural intent (binding unless the handoff documents a reason to deviate)

**A. One map subsystem, including future Globe.** MapLibre + vector tiles + PMTiles was chosen so
that a future 3D globe needs no second engine, no second dataset and no per-projection style file.
4.0 is 2D Mercator and must be globe-*ready*, not globe-enabled.

**B. Attack data stays geographic and renderer-independent.** Canonical event state is
source/destination lng-lat plus metadata and timing. Projected screen coordinates must never be
the canonical model: `geographic model -> renderer -> current projection`.

**C. The animation renderer is a deliberate choice, not an inheritance.** It must be judged on
animation quality, throughput, pan/zoom behaviour, antimeridian handling, world copies, globe
compatibility, horizon clipping, maintainability and CPU/GPU cost. If a Canvas renderer is chosen,
it must be explicitly a replaceable Mercator renderer, with the event model kept independent.

**D. Security-oriented basemap.** The visual goal is countries, coastlines, borders and useful
place labels — not a general-purpose OSM map with residential streets, dense road networks, POIs
and house-level detail. Two separate questions must be answered separately: what data is
physically in `world.pmtiles`, and what the T-Pot styles actually render. A general-purpose
extract with a suppressing style is acceptable; claiming such an extract *is* a reduced
security-specific dataset is not.

**E. Offline / air-gap behaviour.** All runtime assets local: MapLibre, PMTiles client, tiles,
styles, glyphs, sprites, icons, GeoJSON, application JS/CSS. Runtime traffic only to the local
T-Pot service and its WebSocket. No external fallback basemap, no API key. If the basemap asset is
missing or invalid, the dashboard stays alive and the map area shows a useful failure state.

**F. Reproducible basemap artefact.** `world.pmtiles` is never committed. One committed source of
truth for acquisition, used by local development and the Docker build alike, with: pinned source
data, pinned tooling, SHA-256 verification, architecture-aware downloads, POSIX shell, macOS and
Alpine support, atomic output, idempotency, a verification mode, no system-wide installation, and
output ignored by git. Upstream artefacts must be assumed mutable and short-lived.

**G. Local development without T-Pot infrastructure.** No Elasticsearch, Redis or Docker required.
An opt-in synthetic event mode that reproduces the real wire format, is deterministic with a seed,
and exercises protocols/colours, several sensors and honeypots, repeated source coordinates,
attacker aggregation, antimeridian cases, high latitudes, floods and Stats messages. Demo mode
must never silently become a production default.

**H. Vendored dependencies, strict CSP.** Frontend dependencies stay vendored locally with SRI for
static script/link resources, maintained by `update_hashes.py`. Runtime-fetched data (style JSON,
glyphs, sprites, PMTiles, GeoJSON) need not use SRI but must stay same-origin and CSP-covered.
Worker behaviour must be validated against the exact MapLibre version selected.

**I. Dark/light styles.** One dataset, one style per theme. Changing theme must never download map
data. Custom sources, layers and feature-state must survive or be correctly restored across
`setStyle()`.

**J. Country choropleth.** Desired feature; requires verified country geometry with usable ISO
ids, correct `promoteId`/feature-state behaviour and correct restoration after a style reload. A
separate small country-polygon dataset is acceptable if the basemap schema does not provide one.

## Design priorities

Correctness, offline operation, maintainability, future globe compatibility, minimal
production-server changes, reproducible builds, easy local development, testability, least
disruption to existing Attack Map behaviour, and a clear separation of basemap data, map style,
attack event model, attack rendering and dashboard logic.

Not goals: the smallest possible diff at the cost of architectural debt, unnecessary
infrastructure (a dedicated tile server when PMTiles suffices), an online fallback, a CARTO
API-key option, terrain, or a dashboard redesign.

## Where the open questions went

Every question this brief used to pose is answered in the handoff. Five maintainer design
reviews (recorded in `HANDOFF-v2.md` §5) resolved every finding; the third review re-pinned
every direct dependency to the newest stable compatible release and made that a binding rule
(D35); the fourth extended it to the legacy frontend stack (removing unused libraries on usage
evidence), closed the basemap bootstrap cycle inside WP2 and eliminated the last startup/cache
races; the fifth turned the freshness rule into a named Dependency Freeze Gate (D42), made the
offline-check promise a tested invariant, fixed a measured 3.0.1 dashboard-init race (D43) and
removed the last stale historical claims.

| Topic | See |
|---|---|
| Exact MapLibre / PMTiles / CLI versions and why | `HANDOFF-v2.md` §4, §4.1, §6 |
| Dependency freshness policy, freeze gate, advisory evidence | §6.0, D35, D42 |
| Legacy frontend dependencies: usage evidence, removals, upgrades | §6.4, D36 |
| Design review findings and their resolutions | §5 (§5.3–§5.5 for the dependency/consistency reviews) |
| Startup domains (data channel vs map), no load-order race | §7.1 |
| Cache-restore contract under async startup | §7.2 |
| Style loading, glyph/sprite/PMTiles URL resolution, sub-path hosting | §7.3 |
| Zoom semantics (PMTiles header is authoritative) | §7.4 |
| Theme switching, partial-state recovery, feature-state | §7.6 |
| Basemap source, artefact lifecycle, dev presets, measurement | §8.2, §8.3, §14 |
| General-purpose data vs. T-Pot visual style, hidden layers | §8.4 |
| Country geometry and choropleth semantics | §8.5, §8.6 |
| Renderer choice, event model, arc geometry (screen-space bend), antimeridian, world copies | §9 |
| Attacker circle semantics (deliberate change) | §9.5 |
| What "Globe-ready" does and does not mean | §10 |
| Work packages and their dependency proof | §11, §11.0 |
| Committed vs generated vs downloaded, removed files | §12.3, §12.4 |
| CSP, worker loading, offline statement, failure modes | §13 |
| Supply chain, immutable release, reproducibility controls | §14 |
| Docker/tpotce integration | §15 |
| Demo mode and production safety | §16 |
| Verification: check script modes, bootstrap, smoke test, honest test scope | §17 |
| Licensing and attribution (incl. sprite MIT notice) | §20 |
| Maintainer decisions (all closed) and remaining actions | §23 |
| Implementation readiness | "Implementation readiness check" |
