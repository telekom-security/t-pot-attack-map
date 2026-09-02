# Basemap artefact — provenance, measurement and lifecycle

The Attack Map's basemap is a single PMTiles archive (`static/dist/world.pmtiles`),
served by the existing aiohttp server via HTTP range requests. It is **never committed**;
it is pinned by URL + SHA-256 in `tools/basemap.lock` and obtained through
`tools/fetch_basemap.sh`.

## Pinned artefact

| Field | Value |
|---|---|
| Release | `basemap-20260901-z6` on `telekom-security/t-pot-attack-map` |
| Asset | `world.pmtiles` |
| SHA-256 | `375d8d83385b7bba46a518f97edff487d4c0f54d9ceea42ef4f1e76dbe773ff8` |
| Size | 44,861,930 bytes (≈ 45 MB) |
| Source | Protomaps daily build channel, build id **20260831** (`https://build.protomaps.com/20260831.pmtiles`) |
| Extraction | `pmtiles extract <build> --maxzoom=6` (full z0–6 sub-pyramid, ranged reads) |
| Tileset | Protomaps Basemap v4.15.2 (Planetiler 0.10.2), tile type MVT, z0–6, gzip |
| CLI | go-pmtiles **1.31.2** via `tools/pmtiles_cli.sh` |
| Measured | 2026-09-01 (macOS Apple Silicon) |

## Maxzoom measurement and decision

Maxzoom rule: `PM_MAXZOOM = 7` if the z7 artefact is ≤ 150 MB, otherwise 6.

| Candidate | Command | Exact size | SHA-256 |
|---|---|---|---|
| z6 | `tools/fetch_basemap.sh --from-upstream --upstream-build 20260831 --maxzoom 6 --out /tmp/z6.pmtiles` | **44,861,930 B (42.8 MiB)** | `375d8d83…` |
| z7 | `tools/fetch_basemap.sh --from-upstream --upstream-build 20260831 --maxzoom 7 --out /tmp/z7.pmtiles` | **187,447,390 B (178.8 MiB)** | `0dc6b9ca…` |

187 MB > 150 MB → **`PM_MAXZOOM = 6`**. The z6 candidate byte-identical becomes the
release asset. Docker image delta: +45 MB (one layer, shared by `map_web` and `map_data`).

Zoom semantics at runtime are header-driven: MapLibre's `maxZoom` is read from the
PMTiles header, so display limit and data limit cannot disagree. Visual scale note: MapLibre
vector tiles are 512 px, so z6 corresponds to the old Leaflet raster z7.

## Why the pinned source is a T-Pot release asset

Protomaps keeps roughly one week of daily builds, publishes BLAKE3 (not SHA-256) hashes and
discourages hotlinking; `pmtiles extract` output is not guaranteed byte-identical across CLI
versions. The artefact is therefore produced **once** by a maintainer and stored as an
immutable T-Pot GitHub release asset; Protomaps is touched only by the re-pin path below.

## Immutable-release procedure (maintainer)

1. Enable **immutable releases** in the repository settings (once; existing releases stay
   mutable — the basemap release must be created after the setting is on).
2. Run the publish script — first as a dry run, then for real:

```sh
tools/publish_basemap.sh --dry-run   # every preflight check + prints the exact commands, writes nothing
tools/publish_basemap.sh             # verify -> draft -> upload -> publish -> re-verify
```

The script derives repository, tag, asset name and release notes from
`tools/basemap.lock` (nothing is re-typed, so nothing can mismatch the pinned
download URL), refuses to run unless the local artefact matches the pinned
SHA-256 (an immutable release cannot be corrected afterwards, only superseded),
refuses if the release already exists, and after publishing re-downloads the
asset and verifies it end to end. It needs an authenticated `gh` CLI with
release permissions on the repository.

3. Run `tools/check_all.sh --release` and update the lifecycle status table below
   (steps 5, 10, 11).

## Obtaining the artefact

```sh
tools/fetch_basemap.sh                      # full: pinned release asset, SHA-256 verified (Docker path)
tools/fetch_basemap.sh --check              # verify only
tools/fetch_basemap.sh --preset dev         # world z0-4 extract of the release asset (a few MB)
tools/fetch_basemap.sh --preset dev-ci      # world z0-2 (a few hundred KB)
tools/fetch_basemap.sh --preset dev-europe  # bbox -31,34,69,72 z0-6 — labels/detail work only,
                                            # NOT suitable for antimeridian/world-copy testing
```

Dev presets are ranged sub-pyramid extracts of the release asset — they never depend on
Protomaps retention, and their SHA-256 is intentionally not compared against the lock (the
script prints the produced header zoom range instead).

## Re-pin procedure (maintainer, network-enabled)

1. Pick a build id from <https://maps.protomaps.com/builds>.
2. `tools/fetch_basemap.sh --from-upstream --upstream-build <BUILD_ID> --maxzoom 6 --out /tmp/z6.pmtiles`
   (and z7; re-apply the maxzoom rule above — each zoom level roughly doubles the file).
3. Publish a new `basemap-<YYYYMMDD>-z<N>` release (procedure above).
4. Update `WORLD_PMTILES_URL`, `WORLD_PMTILES_SHA256`, `PM_MAXZOOM`, `PM_BUILD` in
   `tools/basemap.lock`; update this document; commit.
5. `tools/fetch_basemap.sh --force && tools/check_all.sh --release`.

## Artefact lifecycle status (twelve steps)

| # | Step | Status |
|---|---|---|
| 1 | Build id selected (20260831) | done |
| 2 | z6/z7 candidates extracted | done |
| 3 | Sizes measured | done (table above) |
| 4 | Maxzoom rule applied → maxzoom 6 | done |
| 5 | Immutable release published | done 2026-09-02 (`tools/publish_basemap.sh`, maintainer) |
| 6–9 | Lock values recorded | done (URL is the deterministic post-publish asset URL) |
| 10 | `--preset full` verified against the lock | done 2026-09-02 (post-publish re-download + `--check`; `check_all.sh --release` green) |
| 11 | `dev`/`dev-ci` extracts from the release asset | done 2026-09-02 (ranged extracts from the live asset, header z0–4 / z0–2) |
| 12 | This document | done |
