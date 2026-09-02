# Dependency freeze report (4.0.0)

Dependency Freeze Gate executed **2026-09-01**, before implementation started
(defined in the migration design record, [docs/history/HANDOFF-v2.md](history/HANDOFF-v2.md)).
Sources queried live: PyPI, the npm registry, GitHub releases/refs, the GitHub Advisory
Database, `pkgs.alpinelinux.org` (v3.23), and the local tpotce working tree.

**Result: every selected version is still the newest stable compatible release — nothing
moved since the 2026-08-31 verification. All pins are hereby frozen.**

## 1. Python runtime (`requirements.txt`)

| Dependency | Repo (3.0.1) | Latest upstream | Selected pin | Advisories | Compatibility evidence | Reason if not latest |
|---|---|---|---|---|---|---|
| aiohttp | 3.13.2 | **3.14.3** | `aiohttp==3.14.3` | GHSA-cq5v-8q36-5273 (high) affects ≤ 3.14.2 → **3.14.3 clean** | Python ≥ 3.10; Alpine 3.23 ships 3.12.14. Range/206, `.gz` siblings, `web.static`, WebSocket verified at tag v3.14.3 against the source; re-proven empirically by the browser test suite | — (latest) |
| elasticsearch | 8.18.1 | 9.5.0 | `elasticsearch==9.3.0` | none on record | tpotce ships ES server **9.3.5** (`tpotce/docker/elk/elasticsearch/Dockerfile:3`, verified 2026-09-01). Steady-state rule: same major, client minor ≤ server minor → 9.3.0. `DataServer.py` already uses the keyword API; 8→9 is mechanical | steady-state compatibility rule (9.4/9.5 clients exceed server minor 9.3) |
| redis | 7.1.0 | **8.1.0** | `redis==8.1.0` | advisories only in 4.x range → clean | `map_redis` = Alpine 3.23 Redis server **8.4.2** (verified 2026-09-01). Only APIs used: `redis.asyncio.Redis.from_url`, pubsub, `RedisError` — unchanged in 8.x | — (latest) |
| pytz | 2025.2 | **2026.3.post1** | `pytz==2026.3.post1` | none | tzdata refresh only | — (latest) |
| tzlocal | 5.3.1 | **5.4.4** | `tzlocal==5.4.4` | none | Python ≥ 3.10; `get_localzone()` unchanged | — (latest) |

## 2. Frontend runtime (vendored)

| Dependency | Latest upstream | Selected | Exact immutable pin | Advisories |
|---|---|---|---|---|
| MapLibre GL JS | **6.6.0** | 6.6.0 | npm `maplibre-gl@6.6.0` | none |
| PMTiles JS | **4.5.0** | 4.5.0 | npm `pmtiles@4.5.0` | none |
| `@protomaps/basemaps` | **5.7.2** | 5.7.2 | npm `@protomaps/basemaps@5.7.2` (in `tools/styles/package-lock.json`) | none |
| basemaps-assets (glyphs/sprites) | — (unversioned repo) | commit pin | `protomaps/basemaps-assets@028c18f713baecad011301ff7a69acc39bcc2ae7` (verified reachable 2026-09-01) | — |
| Natural Earth 50m admin-0 map units | v5.1.2 | v5.1.2 | tag `v5.1.2` = `f1890d9f152c896d250a77557a5751a93d494776` (ref re-resolved 2026-09-01) | — |

## 3. Retained legacy frontend (upgrades/removals during the migration)

| Dependency | Repo version | Latest upstream | Resolution | Exact pin |
|---|---|---|---|---|
| Bootstrap CSS | 5.3.3 | **5.3.8** | upgrade (CSS only) | npm `bootstrap@5.3.8` |
| Chart.js | 4.4.0 | **4.5.1** | upgrade | npm `chart.js@4.5.1` |
| Font Awesome Free | 6.5.1 | **7.3.1** | upgrade (icon audit passed) | npm `@fortawesome/fontawesome-free@7.3.1` |
| Inter | unknown legacy subset | **v4.1** | re-vendor | `rsms/inter@v4.1` (`e3a3d4c57d5ecc01453a575621882a384c1995a3`) |
| JetBrains Mono | unknown legacy subset | **v2.304** | re-vendor | `JetBrains/JetBrainsMono@v2.304` (`cd5227bd1f61dff3bbd6c814ceaf7ffd95e947d9`) |
| Flagpack (flags) | v2.1.0 (byte-identified) | **v2.1.0** | verify/pin | `Yummygum/flagpack-core@v2.1.0` (`094849d2ccc7e677dbb1663244fd0ca91759dab4`) |
| jQuery | 3.7.1 | 4.0.0 | **removed** (zero usage) | — |
| Luxon | 3.5.0 | 3.7.2 | **removed** (zero usage) | — |
| Bootstrap JS (`bootstrap.min.js`) | 5.3.3 | 5.3.8 | **removed** (zero usage; stale `.css.map` also deleted) | — |

## 4. Development tooling

| Tool | Latest | Selected | Notes |
|---|---|---|---|
| go-pmtiles | **v1.31.2** | 1.31.2 | via `tools/pmtiles_cli.sh` only; SHA-256 pinned per OS+arch |
| Playwright | **1.62.1** | 1.62.1 | exact pin in `tools/e2e/package-lock.json` |
| Node.js | **24.20.0 LTS** (latest v24 release, verified 2026-09-01) | 24.20.0 | Generation baseline, committed as `.node-version`. The local machine runs 24.18.0 (≥ 20 floor); generation steps use a locally cached pinned 24.20.0 runtime (no system-wide install) |
| npm | 11 (bundled) | 11 | lockfileVersion 3 |

## 5. Platform / servers (tpotce environment)

| Component | Version | Verified |
|---|---|---|
| Alpine | 3.23 | tpotce `docker/elk/map/Dockerfile` (`FROM alpine:3.23`) |
| Python (Alpine 3.23) | 3.12.14 | pkgs.alpinelinux.org, 2026-09-01 |
| Redis server (Alpine 3.23) | 8.4.2 | pkgs.alpinelinux.org, 2026-09-01 |
| Elasticsearch server | **9.3.5** | `tpotce/docker/elk/elasticsearch/Dockerfile:3`, local working tree, 2026-09-01 |

## 6. Gate verdict

- Every selected pin equals the newest stable compatible upstream release, or carries the
  written justification above (elasticsearch client 9.3.0 by the compatibility rule).
- No selected dependency has a relevant open HIGH/CRITICAL advisory
  (aiohttp 3.14.3 is above every advisory range; redis-py 8.1.0 and elasticsearch-py clean).
- No floating version anywhere (`latest`, `^`, `>=` absent from runtime pins).
- Maintainer action satisfied: ES server confirmed **9.3.5** → client pin 9.3.0 stands.

**Pins frozen 2026-09-01. Re-check required at the release gate (see docs/RELEASING.md, step 2).**
