# Releasing 4.0.0 — consolidated maintainer checklist

One page, in order. Each step links to the detailed procedure; nothing here
duplicates it. Steps marked **[maintainer]** need repository permissions or a
human decision; the rest can be executed by anyone with the repo.

## 1. Publish the basemap artefact **[maintainer]**

The single blocker for everything below. Procedure incl. the exact `gh`
commands: [BASEMAP.md — Immutable-release procedure](BASEMAP.md#immutable-release-procedure-maintainer).
Summary: enable immutable releases (once, BEFORE creating the release) →
`tools/fetch_basemap.sh --check` on the local artefact → draft release
`basemap-20260901-z6`, asset `world.pmtiles`, publish.

Afterwards, against the live release:

```sh
tools/fetch_basemap.sh --force && tools/fetch_basemap.sh --check
tools/check_all.sh --release
```

and update the WP2 status table in BASEMAP.md (steps 5, 10, 11).

## 2. Release gate

Work through [HANDOFF-v2 §24](HANDOFF-v2.md) — the authoritative checklist
(G-DEP re-check, WP4 gate evidence in the PR, no `legacy` vendor.lock entries,
no floating pins, `vendor_countries.mjs --verify`, performance criteria).

## 3. Acceptance tests **[maintainer]**

- **Offline acceptance** (HANDOFF-v2 §17.1): fresh clone, `tools/check_all.sh
  --bootstrap` once, `tools/fetch_basemap.sh --preset dev` once, then block
  external network and run `tools/check_all.sh` — must stay green.
- **Manual browser matrix** (HANDOFF-v2 §17.4): three real browsers, both
  themes, both base URIs (`/` and `/map/`); record browser versions in the PR.
- **Baseline sign-off**: compare against `docs/BASELINE.md` +
  `docs/baseline-screenshots/`; after sign-off delete both (they are
  temporary WP1 artefacts).

## 4. Publish the code **[maintainer]**

1. Push branch `4.0.0`, open the PR against `master` (attach WP4 gate results
   and the §24 evidence).
2. Merge, tag `4.0.0`.

## 5. tpotce integration **[maintainer]**

Requires steps 1 and 4 (the Dockerfile builds `-b 4.0.0` from the
telekom-security origin and runs `fetch_basemap.sh` against the pinned
release):

1. Commit and push the prepared `docker/elk/map/Dockerfile` change in the
   tpotce working tree.
2. Answer tpotce discussion #1913.
