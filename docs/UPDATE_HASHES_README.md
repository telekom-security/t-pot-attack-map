# Integrity maintenance — `update_hashes.py` and `static/vendor.lock`

## Integrity hierarchy (HANDOFF-v2 §14.4)

1. **`static/vendor.lock` + committed hashes** — the authoritative build-integrity
   mechanism, verified locally and offline by `python3 update_hashes.py --check-vendor`.
2. **SRI on ordinary `<script>`/`<link>` tags** in `static/index.html` — an additional
   browser-side consistency control, maintained by `python3 update_hashes.py`.
   The discovery regex matches any tag whose `src`/`href` precedes `integrity`,
   including `<link rel="modulepreload" … integrity="sha384-…">`.
3. **`modulepreload integrity`** — a browser-dependent optimisation whose enforcement
   was measured in WP4. Dynamic-import correctness never depends on it; if a browser
   ignores it, the module still loads and `vendor.lock` still catches tampering.

## Commands

```sh
python3 update_hashes.py                 # rewrite SRI hashes in static/index.html
python3 update_hashes.py --check         # verify SRI hashes (non-zero on drift)
python3 update_hashes.py --check-vendor  # verify every vendor.lock entry (offline)
```

Run `update_hashes.py` after every edit that changes a hashed static asset, and
commit the resulting `index.html` together with the asset.

## `static/vendor.lock`

Tab-separated, sorted by path, one record per shipped third-party/generated/local
frontend asset: `path  sha384  provenance_type  source  version`.

`provenance_type` is one of:

- `vendored` — third-party download, proven against the named upstream ref;
- `generated` — produced by a committed tool from a pinned input
  (styles, country geometry, `pmtiles.mjs` with its rewritten fflate import, `fonts.css`);
- `local` — repository source (`map-boot.mjs`, `attack-geometry.mjs`, `attack-renderer.mjs`);
- `legacy` — interim only (WP3→WP8): a pre-4.0 third-party file recorded at the
  baseline `e798fcb` whose upstream ref has not been proven. WP8 removes or replaces
  every `legacy` entry; `tools/check_all.sh --release` fails if any remains.

The manifest is regenerated **only deliberately** via
`tools/vendor_frontend.sh --write-lock` (after a vendoring change); `--check-vendor`
is the tamper check for everything else.

## Regeneration commands (one per generated committed asset, §12.4)

| Asset | Command |
|---|---|
| `static/styles/{dark,light}.json` | `node tools/styles/generate_styles.mjs` (verify: `--verify`) |
| `static/data/countries.geojson(.gz)` | `node tools/vendor_countries.mjs --rebuild` (verify offline: `--verify`) |
| `static/vendor.lock` | `tools/vendor_frontend.sh --write-lock` |
| SRI hashes in `index.html` | `python3 update_hashes.py` |
| Vendored engine/assets/licences | `tools/vendor_frontend.sh --engine --basemap-assets --licenses` |

Generation baseline: Node 24.20.0 LTS (`.node-version`, HANDOFF-v2 D45); Node ≥ 20
is the compatibility floor.
