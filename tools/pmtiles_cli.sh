#!/bin/sh
# tools/pmtiles_cli.sh — the single implementation of the pinned go-pmtiles logic
# (HANDOFF-v2 D4, D41, §14.4). Detects OS/arch, downloads the pinned release
# asset into a cache, verifies its SHA-256 against tools/basemap.lock BEFORE the
# first execution, then execs the binary. Nothing on PATH, nothing installed
# system-wide, cached binary re-verified on every run.
#
# Usage:
#   tools/pmtiles_cli.sh [--lock PATH] [--require-cached] <pmtiles-subcommand> [args...]
#   tools/pmtiles_cli.sh [--lock PATH] --fetch-only     # bootstrap: cache and exit
#
# Supported platforms (D41): macOS Apple Silicon, Linux x86_64, Linux arm64.
# Cache: ${PMTILES_CLI_CACHE:-${TMPDIR:-/tmp}/tpot-pmtiles-<version>-<os>-<arch>}

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LOCK="$SCRIPT_DIR/basemap.lock"
REQUIRE_CACHED=0
FETCH_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --lock) LOCK="$2"; shift 2 ;;
    --require-cached) REQUIRE_CACHED=1; shift ;;
    --fetch-only) FETCH_ONLY=1; shift ;;
    *) break ;;
  esac
done

[ -f "$LOCK" ] || { echo "ERROR: lock file not found: $LOCK" >&2; exit 1; }
# shellcheck disable=SC1090
. "$LOCK"
[ -n "${PMTILES_CLI:-}" ] || { echo "ERROR: PMTILES_CLI missing in $LOCK" >&2; exit 1; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

fetch() { # url dest
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$1"
  else
    wget -q -O "$2" "$1"
  fi
}

OS=$(uname -s)
ARCH=$(uname -m)
case "$OS/$ARCH" in
  Darwin/arm64)
    KEY=darwin_arm64; OSNAME=darwin; ARCHNAME=arm64
    ASSET="go-pmtiles-${PMTILES_CLI}_Darwin_arm64.zip" ;;
  Linux/x86_64)
    KEY=linux_x86_64; OSNAME=linux; ARCHNAME=x86_64
    ASSET="go-pmtiles_${PMTILES_CLI}_Linux_x86_64.tar.gz" ;;
  Linux/aarch64|Linux/arm64)
    KEY=linux_arm64; OSNAME=linux; ARCHNAME=arm64
    ASSET="go-pmtiles_${PMTILES_CLI}_Linux_arm64.tar.gz" ;;
  *)
    echo "ERROR: unsupported platform $OS/$ARCH." >&2
    echo "Supported (HANDOFF-v2 D41): macOS Apple Silicon, Linux x86_64, Linux arm64." >&2
    echo "Intel macOS is not supported (no pinned hash)." >&2
    exit 1 ;;
esac

EXPECTED=$(eval "printf '%s' \"\${PMTILES_CLI_SHA256_${KEY}:-}\"")
[ -n "$EXPECTED" ] || { echo "ERROR: PMTILES_CLI_SHA256_${KEY} missing in $LOCK" >&2; exit 1; }

CACHE="${PMTILES_CLI_CACHE:-${TMPDIR:-/tmp}/tpot-pmtiles-${PMTILES_CLI}-${OSNAME}-${ARCHNAME}}"
ARCHIVE="$CACHE/$ASSET"
BIN="$CACHE/pmtiles"
BIN_SHA_FILE="$CACHE/pmtiles.sha256"
URL="https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_CLI}/${ASSET}"

# 1. Ensure the verified archive is in the cache.
if [ ! -f "$ARCHIVE" ] || [ "$(sha256 "$ARCHIVE")" != "$EXPECTED" ]; then
  if [ "$REQUIRE_CACHED" = 1 ]; then
    echo "ERROR: pinned go-pmtiles ${PMTILES_CLI} not cached (or cache invalid) and downloads are disabled." >&2
    echo "Run: tools/check_all.sh --bootstrap   (or: tools/pmtiles_cli.sh --fetch-only)" >&2
    exit 1
  fi
  mkdir -p "$CACHE"
  TMPD=$(mktemp -d "${CACHE}/dl.XXXXXX")
  trap 'rm -rf "$TMPD"' EXIT INT TERM
  echo "[*] Downloading pinned go-pmtiles ${PMTILES_CLI} ($ASSET)..." >&2
  fetch "$URL" "$TMPD/$ASSET"
  GOT=$(sha256 "$TMPD/$ASSET")
  if [ "$GOT" != "$EXPECTED" ]; then
    echo "ERROR: SHA-256 mismatch for $ASSET" >&2
    echo "  expected: $EXPECTED" >&2
    echo "  got:      $GOT" >&2
    exit 1
  fi
  mv "$TMPD/$ASSET" "$ARCHIVE"
  rm -f "$BIN" "$BIN_SHA_FILE"
  rm -rf "$TMPD"
  trap - EXIT INT TERM
fi

# 2. Extract the binary from the just-verified archive (once), record its hash.
if [ ! -f "$BIN" ]; then
  case "$ASSET" in
    *.zip)    (cd "$CACHE" && unzip -oq "$ASSET" pmtiles) ;;
    *.tar.gz) (cd "$CACHE" && tar -xzf "$ASSET" pmtiles) ;;
  esac
  chmod +x "$BIN"
  sha256 "$BIN" > "$BIN_SHA_FILE"
fi

# 3. Re-verify the cached binary on every run; refuse to run on tampering.
if [ "$(sha256 "$BIN")" != "$(cat "$BIN_SHA_FILE")" ]; then
  echo "ERROR: cached go-pmtiles binary does not match its recorded hash — refusing to run." >&2
  echo "Clear the cache and re-fetch: rm -rf \"$CACHE\" && tools/pmtiles_cli.sh --fetch-only" >&2
  exit 1
fi

if [ "$FETCH_ONLY" = 1 ]; then
  echo "[*] go-pmtiles ${PMTILES_CLI} cached and verified at $CACHE"
  exit 0
fi

[ $# -gt 0 ] || { echo "usage: tools/pmtiles_cli.sh [--lock PATH] [--require-cached] <subcommand> [args...]" >&2; exit 2; }
exec "$BIN" "$@"
