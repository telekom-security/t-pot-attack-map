#!/bin/sh
# tools/check_all.sh — the complete local verification suite (HANDOFF-v2 §17.1, D26).
# No CI service: this script IS the contract.
#
#   tools/check_all.sh --bootstrap   network allowed FOR TOOLING ONLY:
#                                    npm ci for tools/styles and tools/e2e,
#                                    pinned Playwright Chromium, go-pmtiles cache
#   tools/check_all.sh               development mode: NO downloads; ANY valid
#                                    artefact at static/dist/world.pmtiles
#   tools/check_all.sh --release     everything plus pinned full-artefact checks;
#                                    NO downloads
#
# The basemap artefact is never fetched here — that is a separate, explicit
# developer action (tools/fetch_basemap.sh, §8.3). After --bootstrap and one
# artefact fetch, the normal run is fully offline (§17.1 acceptance test).

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

MODE=dev
case "${1:-}" in
  --bootstrap) MODE=bootstrap ;;
  --release) MODE=release ;;
  "") ;;
  *) echo "usage: tools/check_all.sh [--bootstrap|--release]" >&2; exit 2 ;;
esac

PYTHON=${PYTHON:-python3}
if [ -x "$REPO_ROOT/.venv/bin/python" ]; then PYTHON="$REPO_ROOT/.venv/bin/python"; fi

FAILED=0
step() { printf '\n=== %s ===\n' "$1"; }
fail() { echo "FAIL: $1" >&2; FAILED=1; }

# ---------------------------------------------------------------------------
if [ "$MODE" = bootstrap ]; then
  step "bootstrap: tools/styles npm ci"
  (cd tools/styles && npm ci --no-audit --no-fund) || exit 1
  step "bootstrap: tools/e2e npm ci"
  (cd tools/e2e && npm ci --no-audit --no-fund) || exit 1
  step "bootstrap: pinned Playwright Chromium"
  (cd tools/e2e && npx playwright install chromium) || exit 1
  step "bootstrap: pinned go-pmtiles cache"
  "$SCRIPT_DIR/pmtiles_cli.sh" --fetch-only || exit 1
  echo
  echo "Bootstrap complete. Fetch a basemap artefact once (e.g."
  echo "  tools/fetch_basemap.sh --preset dev) and run tools/check_all.sh."
  exit 0
fi

# ---- offline preconditions (print the bootstrap hint instead of downloading)
for missing in tools/styles/node_modules tools/e2e/node_modules; do
  if [ ! -d "$missing" ]; then
    echo "ERROR: $missing missing — run: tools/check_all.sh --bootstrap" >&2
    exit 1
  fi
done

step "Python tests"
"$PYTHON" -m unittest discover tests || fail "unittest"

step "SRI hashes (update_hashes.py --check)"
"$PYTHON" update_hashes.py --check >/dev/null || fail "SRI drift in static/index.html"

step "Vendor manifest (update_hashes.py --check-vendor)"
"$PYTHON" update_hashes.py --check-vendor || fail "vendor.lock drift"

step "Shell syntax (sh -n tools/*.sh)"
for f in tools/*.sh; do sh -n "$f" || fail "syntax: $f"; done

step "Geometry / renderer unit tests (node --test)"
node --test tests/js/attack-geometry.test.mjs tests/js/attack-renderer.test.mjs || fail "node --test"

step "ISO coverage (vendor_countries.mjs --verify, offline)"
node tools/vendor_countries.mjs --verify || fail "countries verify"

step "Style allowlist (generate_styles.mjs --verify, offline)"
(cd tools/styles && node generate_styles.mjs --verify >/dev/null) || fail "style drift or unknown layer ids"

step "No compressed sibling next to .pmtiles (§8.1)"
if [ -e static/dist/world.pmtiles.gz ] || [ -e static/dist/world.pmtiles.br ]; then
  fail "compressed sibling next to world.pmtiles breaks range requests"
else echo "OK"; fi

step "No external hosts in shipped frontend code"
# Vendored library internals (maplibre-gl*.mjs) and licence texts legitimately
# mention upstream URLs; everything the application itself ships must not.
HITS=$(grep -rn "cartocdn\|unpkg\|jsdelivr\|protomaps.github.io\|basemaps.cartocdn" \
  static/ \
  --exclude='maplibre-gl*.mjs' --exclude-dir=licenses --exclude-dir=dist 2>/dev/null)
if [ -n "$HITS" ]; then echo "$HITS"; fail "external host reference in shipped code"; else echo "OK"; fi

step "Demo mode is opt-in only (no default, no env var)"
if grep -q "action='store_true'" AttackMapServer.py && \
   ! grep -qE "os\.environ|getenv" demo_events.py; then echo "OK"; else fail "demo-mode safeguards"; fi

step "No stale 3.0.1 version string in shipped code"
# comment lines describing 3.0.1 behaviour are history text and allowed (§12.5)
HITS=$(grep -rn "3\.0\.1" AttackMapServer.py DataServer.py README.md static/*.js static/*.html 2>/dev/null | grep -v '//')
if [ -n "$HITS" ]; then echo "$HITS"; fail "stale version string"; else echo "OK"; fi

step "Node toolchain baseline (D45, warning only)"
WANT=$(cat .node-version 2>/dev/null)
GOT=$(node --version 2>/dev/null | sed 's/^v//')
[ "$WANT" = "$GOT" ] || echo "WARNING: node $GOT != baseline $WANT (generated artefacts must be produced under $WANT)"

step "Browser smoke test (tools/e2e/smoke.mjs)"
if [ ! -f static/dist/world.pmtiles ]; then
  echo "ERROR: static/dist/world.pmtiles missing — run: tools/fetch_basemap.sh --preset dev-ci" >&2
  FAILED=1
else
  PYTHON="$PYTHON" node tools/e2e/smoke.mjs || fail "smoke test"
fi

# ---------------------------------------------------------------------------
if [ "$MODE" = release ]; then
  step "RELEASE: artefact hash matches the lock"
  sh tools/fetch_basemap.sh --check || fail "artefact hash"

  step "RELEASE: lock/artefact zoom agreement (PM_MAXZOOM)"
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/basemap.lock"
  GOT_MAXZOOM=$("$SCRIPT_DIR/pmtiles_cli.sh" --require-cached show static/dist/world.pmtiles | sed -n 's/^max zoom: //p')
  if [ "$GOT_MAXZOOM" = "$PM_MAXZOOM" ]; then echo "OK: maxzoom $GOT_MAXZOOM"; else fail "maxzoom $GOT_MAXZOOM != PM_MAXZOOM $PM_MAXZOOM"; fi

  step "RELEASE: no provenance_type 'legacy' remains (§14.4)"
  if grep -q "	legacy	" static/vendor.lock; then fail "legacy entries in vendor.lock"; else echo "OK"; fi

  step "RELEASE: no floating runtime dependency"
  if grep -qE '\^|>=|latest' requirements.txt; then fail "floating pin in requirements.txt"; else echo "OK"; fi
fi

echo
if [ "$FAILED" = 0 ]; then echo "check_all: ALL GREEN ($MODE mode)"; else echo "check_all: FAILURES ($MODE mode)"; fi
exit "$FAILED"
