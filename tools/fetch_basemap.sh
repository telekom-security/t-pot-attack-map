#!/bin/sh
# tools/fetch_basemap.sh — the single committed way to obtain any basemap variant
# (HANDOFF-v2 D10, §8.3, §11 WP2). POSIX sh (macOS sh and Alpine busybox ash).
#
# Usage:
#   tools/fetch_basemap.sh [--out PATH] [--lock PATH] [--preset full|dev|dev-ci|dev-europe]
#                          [--maxzoom N] [--bbox W,S,E,N]
#                          [--from-upstream [--upstream-build BUILD_ID]] [--force] [--check]
#
# Presets:
#   full       (default) plain GET of the immutable T-Pot release asset, SHA-256
#              verified against tools/basemap.lock — the production/Docker path.
#   dev        world z0-4 extract of the release asset (a few MB)
#   dev-ci     world z0-2 extract (a few hundred KB)
#   dev-europe bbox -31,34,69,72 z0-6 extract (labels/detail work only — NOT
#              suitable for antimeridian or world-copy testing)
#
# Dev presets are ranged sub-pyramid extracts of the pinned artefact; their
# SHA-256 is intentionally NOT compared against the lock (they are not the
# pinned asset) — the script prints the header zoom range it produced instead.
#
# --from-upstream is the maintainer bootstrap/re-pin path against the Protomaps
# build channel. The build id is an explicit input: --upstream-build BUILD_ID is
# REQUIRED while PM_BUILD in the lock is empty; once the lock is filled it
# defaults to PM_BUILD.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

LOCK="$SCRIPT_DIR/basemap.lock"
OUT="$REPO_ROOT/static/dist/world.pmtiles"
PRESET=full
MAXZOOM=""
BBOX=""
FROM_UPSTREAM=0
UPSTREAM_BUILD=""
FORCE=0
CHECK=0

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --lock) LOCK="$2"; shift 2 ;;
    --preset) PRESET="$2"; shift 2 ;;
    --maxzoom) MAXZOOM="$2"; shift 2 ;;
    --bbox) BBOX="$2"; shift 2 ;;
    --from-upstream) FROM_UPSTREAM=1; shift ;;
    --upstream-build) UPSTREAM_BUILD="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --check) CHECK=1; shift ;;
    -h|--help) usage ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage ;;
  esac
done

[ -f "$LOCK" ] || { echo "ERROR: lock file not found: $LOCK" >&2; exit 1; }
# shellcheck disable=SC1090
. "$LOCK"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

fetch() { # url dest
  if command -v curl >/dev/null 2>&1; then
    curl -fSL -o "$2" "$1"
  else
    wget -O "$2" "$1"
  fi
}

# No .gz/.br sibling may ever exist next to a .pmtiles file (§8.1): aiohttp
# would serve the sibling with Content-Encoding and break byte-range semantics.
for sib in "$OUT.gz" "$OUT.br"; do
  if [ -e "$sib" ]; then
    echo "ERROR: compressed sibling $sib exists — this breaks PMTiles range requests." >&2
    echo "Remove it first: rm \"$sib\"" >&2
    exit 1
  fi
done

# ---------- --check: verify only ----------
if [ "$CHECK" = 1 ]; then
  [ -n "${WORLD_PMTILES_SHA256:-}" ] || { echo "ERROR: WORLD_PMTILES_SHA256 empty in $LOCK" >&2; exit 1; }
  if [ ! -f "$OUT" ]; then
    echo "FAIL: $OUT missing." >&2
    echo "Fix: tools/fetch_basemap.sh --out \"$OUT\"" >&2
    exit 1
  fi
  GOT=$(sha256 "$OUT")
  if [ "$GOT" != "$WORLD_PMTILES_SHA256" ]; then
    echo "FAIL: $OUT does not match WORLD_PMTILES_SHA256." >&2
    echo "  expected: $WORLD_PMTILES_SHA256" >&2
    echo "  got:      $GOT" >&2
    echo "Fix: tools/fetch_basemap.sh --force --out \"$OUT\"" >&2
    exit 1
  fi
  echo "OK: $OUT matches the pinned artefact."
  exit 0
fi

mkdir -p "$(dirname "$OUT")"
TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT INT TERM

# ---------- maintainer path: --from-upstream ----------
if [ "$FROM_UPSTREAM" = 1 ]; then
  if [ -z "$UPSTREAM_BUILD" ]; then
    if [ -n "${PM_BUILD:-}" ]; then
      UPSTREAM_BUILD="$PM_BUILD"
    else
      echo "ERROR: --from-upstream needs --upstream-build BUILD_ID while PM_BUILD is empty in $LOCK." >&2
      echo "Pick a build id from https://maps.protomaps.com/builds (e.g. 20260831)." >&2
      exit 1
    fi
  fi
  [ -n "$MAXZOOM" ] || { echo "ERROR: --from-upstream needs --maxzoom N." >&2; exit 1; }
  SRC="https://build.protomaps.com/${UPSTREAM_BUILD}.pmtiles"
  echo "[*] Extracting z0-$MAXZOOM from upstream build $UPSTREAM_BUILD (ranged reads)..."
  "$SCRIPT_DIR/pmtiles_cli.sh" --lock "$LOCK" extract "$SRC" "$TMPD/out.pmtiles" --maxzoom="$MAXZOOM"
  mv "$TMPD/out.pmtiles" "$OUT"
  SIZE=$(wc -c < "$OUT" | tr -d ' ')
  HASH=$(sha256 "$OUT")
  echo "[*] Wrote $OUT"
  echo "    build:   $UPSTREAM_BUILD"
  echo "    maxzoom: $MAXZOOM"
  echo "    size:    $SIZE bytes"
  echo "    sha256:  $HASH"
  echo "    (record these in tools/basemap.lock / the basemap release)"
  exit 0
fi

# ---------- presets ----------
case "$PRESET" in
  full) ;;
  dev)        MAXZOOM=${MAXZOOM:-4} ;;
  dev-ci)     MAXZOOM=${MAXZOOM:-2} ;;
  dev-europe) MAXZOOM=${MAXZOOM:-6}; BBOX=${BBOX:--31,34,69,72} ;;
  *) echo "ERROR: unknown preset: $PRESET" >&2; usage ;;
esac

[ -n "${WORLD_PMTILES_URL:-}" ] || {
  echo "ERROR: WORLD_PMTILES_URL empty in $LOCK — the immutable basemap release is not pinned yet." >&2
  exit 1
}

if [ "$PRESET" = full ]; then
  [ -n "${WORLD_PMTILES_SHA256:-}" ] || { echo "ERROR: WORLD_PMTILES_SHA256 empty in $LOCK" >&2; exit 1; }
  if [ -f "$OUT" ] && [ "$FORCE" = 0 ] && [ "$(sha256 "$OUT")" = "$WORLD_PMTILES_SHA256" ]; then
    echo "OK: $OUT is up to date."
    exit 0
  fi
  echo "[*] Downloading pinned basemap artefact..."
  fetch "$WORLD_PMTILES_URL" "$TMPD/world.pmtiles"
  GOT=$(sha256 "$TMPD/world.pmtiles")
  if [ "$GOT" != "$WORLD_PMTILES_SHA256" ]; then
    echo "ERROR: downloaded artefact does not match WORLD_PMTILES_SHA256." >&2
    echo "  expected: $WORLD_PMTILES_SHA256" >&2
    echo "  got:      $GOT" >&2
    exit 1
  fi
  mv "$TMPD/world.pmtiles" "$OUT"
  echo "OK: $OUT downloaded and verified."
else
  echo "[*] Extracting preset '$PRESET' (z0-$MAXZOOM${BBOX:+, bbox $BBOX}) from the release asset (ranged reads)..."
  if [ -n "$BBOX" ]; then
    "$SCRIPT_DIR/pmtiles_cli.sh" --lock "$LOCK" extract "$WORLD_PMTILES_URL" "$TMPD/out.pmtiles" --maxzoom="$MAXZOOM" --bbox="$BBOX"
  else
    "$SCRIPT_DIR/pmtiles_cli.sh" --lock "$LOCK" extract "$WORLD_PMTILES_URL" "$TMPD/out.pmtiles" --maxzoom="$MAXZOOM"
  fi
  mv "$TMPD/out.pmtiles" "$OUT"
  echo "OK: $OUT written. Note: dev extracts are not the pinned asset; their"
  echo "    SHA-256 is intentionally not compared against the lock."
  echo "[*] Resulting header zoom range:"
  "$SCRIPT_DIR/pmtiles_cli.sh" --lock "$LOCK" show "$OUT" | grep -iE 'zoom' || true
fi
