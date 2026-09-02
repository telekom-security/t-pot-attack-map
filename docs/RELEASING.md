# Releasing 4.0.0 — consolidated maintainer checklist

One page, in order. Steps marked **[maintainer]** need repository permissions or
a human decision; the rest can be executed by anyone with the repo. The full
design record of the 4.0.0 migration lives in [docs/history/](history/).

## 1. Publish the basemap artefact **[maintainer]**

The single blocker for everything below. Full procedure:
[BASEMAP.md — Immutable-release procedure](BASEMAP.md#immutable-release-procedure-maintainer).
Summary:

1. Enable immutable releases in the repository settings (once, BEFORE creating
   the release).
2. `tools/publish_basemap.sh --dry-run`, then `tools/publish_basemap.sh` —
   the script verifies the local artefact against `tools/basemap.lock`, creates
   and publishes the release, and re-verifies the published asset end to end.
3. `tools/check_all.sh --release` and update the lifecycle status table in
   BASEMAP.md (steps 5, 10, 11).

## 2. Release gate

- `tools/check_all.sh` green after a fresh `--bootstrap`, and
  `tools/check_all.sh --release` green against the pinned artefact.
- `node tools/vendor_countries.mjs --verify` green: every ISO code matched
  (exceptions only in `tools/iso_unsupported.txt`), exactly one feature per
  ISO code.
- No `provenance_type: legacy` entry remains in `static/vendor.lock`.
- No floating dependency versions:
  `grep -E '\^|>=|latest' requirements.txt tools/*/package.json` finds nothing
  for runtime dependencies, and the Docker build upgrades nothing implicitly.
- `docs/DEPENDENCIES.md` re-checked shortly before release: every pin still
  the newest stable compatible version (or carries a written justification),
  no relevant open high/critical advisory — if one exists, the release stops.
- Browser test-suite results (`tools/e2e/`, three engines, both base URIs)
  attached to the PR.

## 3. Acceptance tests **[maintainer]**

**Offline acceptance** — proves the offline promise on a fresh clone:

1. `tools/check_all.sh --bootstrap` once (the only mode allowed to download
   tooling), `tools/fetch_basemap.sh --preset dev` once.
2. Block all external network access.
3. `tools/check_all.sh` must stay green.

**Manual browser matrix** — Chromium, Firefox and Safari, dark and light,
at `/` and `/map/`; record browser versions in the PR:

1. Zero third-party requests; `.pmtiles` responses are HTTP 206.
2. Console clean: no errors, CSP violations or glyph/sprite 404s.
3. Pan, zoom and fullscreen during a demo burst: arcs stay glued to geography.
4. Arc variety (`--demo-scenario basic`): bend height and side vary per event
   (seeded), high and flat arcs mixed; every arc visibly reaches its target.
5. Theme toggle mid-burst: basemap swaps; circles and country shading
   reappear; markers and open popups survive; animations continue.
6. `--demo-scenario antimeridian`: arcs never cross the antimeridian — a
   route like Hong Kong → San Francisco runs the long way across the visible
   map and ends at the destination pin; no arc ever teleports ±360° while
   panning.
7. `--demo-scenario single-location`: one coordinate accumulates several IPs;
   the popup lists them; the LRU cap does not evict the live set.
8. Popup content matches the baseline screenshots
   (`docs/baseline-screenshots/`).
9. Tab away and back: no animation burst; the socket reconnects after a server
   restart; the connection pill is correct.
10. Clear Cache empties map and country shading without errors; later events
    still render.
11. WebGL2 disabled: the failure panel shows while the dashboard keeps
    receiving data, without exceptions.
12. Basemap renamed away, and separately truncated to 100 bytes: failure panel
    with the fetch command, dashboard usable, data still flowing.

**Baseline sign-off**: compare against `docs/BASELINE.md` +
`docs/baseline-screenshots/`; after sign-off delete both (temporary
migration artefacts).

## 4. Publish the code **[maintainer]**

1. Push branch `4.0.0`, open the PR against `master` (attach the release-gate
   evidence from step 2).
2. Merge, tag `4.0.0`.

## 5. tpotce integration **[maintainer]**

Requires steps 1 and 4 (the Dockerfile builds `-b 4.0.0` from the
telekom-security origin and runs `fetch_basemap.sh` against the pinned
release):

1. Commit and push the prepared `docker/elk/map/Dockerfile` change in the
   tpotce working tree.
2. Answer tpotce discussion #1913.
