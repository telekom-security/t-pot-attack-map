#!/bin/sh
# tools/publish_basemap.sh — publish the pinned basemap artefact as an immutable
# GitHub release. Maintainer tool: needs an authenticated `gh` CLI with release
# permissions. Everything (repository, tag, asset name, release notes) is
# derived from tools/basemap.lock, so nothing can mismatch the pinned download
# URL. An immutable release cannot be corrected afterwards, only superseded —
# therefore the local artefact is verified against the lock BEFORE any upload
# and the published asset is re-downloaded and verified afterwards.
#
# Usage:
#   tools/publish_basemap.sh [--dry-run] [--lock PATH] [--artefact PATH]
#
#   --dry-run   run every preflight check and print the exact commands and
#               release notes, but write nothing
#
# Prerequisite (once, BEFORE creating the release): enable immutable releases
# in the repository settings — see docs/BASEMAP.md.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

LOCK="$SCRIPT_DIR/basemap.lock"
ARTEFACT="$REPO_ROOT/static/dist/world.pmtiles"
DRY_RUN=0

usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --lock) LOCK="$2"; shift 2 ;;
    --artefact) ARTEFACT="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage ;;
  esac
done

fail() { echo "FAIL: $*" >&2; exit 1; }
note() { echo "[*] $*"; }

# ---- read the lock and derive every publish parameter from it --------------
[ -f "$LOCK" ] || fail "lock not found: $LOCK"
# shellcheck disable=SC1090
. "$LOCK"
[ -n "${WORLD_PMTILES_URL:-}" ]    || fail "WORLD_PMTILES_URL empty in $LOCK"
[ -n "${WORLD_PMTILES_SHA256:-}" ] || fail "WORLD_PMTILES_SHA256 empty in $LOCK"
[ -n "${PM_MAXZOOM:-}" ]           || fail "PM_MAXZOOM empty in $LOCK"
[ -n "${PM_BUILD:-}" ]             || fail "PM_BUILD empty in $LOCK"
[ -n "${PMTILES_CLI:-}" ]          || fail "PMTILES_CLI empty in $LOCK"

case "$WORLD_PMTILES_URL" in
  https://github.com/*/*/releases/download/*/*) ;;
  *) fail "WORLD_PMTILES_URL is not a GitHub release-asset URL: $WORLD_PMTILES_URL" ;;
esac
rest=${WORLD_PMTILES_URL#https://github.com/}      # owner/repo/releases/download/tag/asset
OWNER=${rest%%/*};  rest=${rest#*/}
REPONAME=${rest%%/*}; rest=${rest#*/}
rest=${rest#releases/download/}
TAG=${rest%%/*}
ASSET=${rest#*/}
REPO="$OWNER/$REPONAME"
case "$TAG" in */*) fail "could not parse tag from $WORLD_PMTILES_URL" ;; esac
case "$ASSET" in ""|*/*) fail "could not parse asset name from $WORLD_PMTILES_URL" ;; esac

TITLE="Basemap $(echo "$TAG" | sed 's/^basemap-//; s/-z[0-9]*$//' \
  | sed 's/\([0-9][0-9][0-9][0-9]\)\([0-9][0-9]\)\([0-9][0-9]\)/\1-\2-\3/') (z${PM_MAXZOOM})"
NOTES="Immutable basemap artefact for the T-Pot Attack Map.
Protomaps build ${PM_BUILD}, extracted z0-${PM_MAXZOOM} (go-pmtiles ${PMTILES_CLI}).
SHA-256 ${ASSET}: ${WORLD_PMTILES_SHA256}
Licence: ODbL (© OpenStreetMap contributors), see https://www.openstreetmap.org/copyright"

note "repository: $REPO"
note "tag:        $TAG"
note "asset:      $ASSET  <-  $ARTEFACT"
note "title:      $TITLE"

# ---- preflight checks (always run, dry run included) ------------------------
note "preflight: artefact matches the lock (pre-upload check)"
[ -f "$ARTEFACT" ] || fail "artefact not found: $ARTEFACT — see docs/BASEMAP.md (re-pin procedure)"
sh "$SCRIPT_DIR/fetch_basemap.sh" --lock "$LOCK" --out "$ARTEFACT" --check \
  || fail "local artefact does not match WORLD_PMTILES_SHA256 — never upload it"

note "preflight: gh CLI available and authenticated"
command -v gh >/dev/null 2>&1 || fail "gh CLI not found (https://cli.github.com)"
gh auth status >/dev/null 2>&1 || fail "gh is not authenticated — run: gh auth login"

note "preflight: release/tag does not exist yet"
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  fail "release $TAG already exists on $REPO — immutable releases cannot be replaced; re-pin with a NEW tag instead (docs/BASEMAP.md)"
fi

# ---- publish -----------------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  echo
  echo "DRY RUN — all preflight checks passed. Would execute:"
  echo
  echo "  gh release create $TAG --draft --title \"$TITLE\" --notes \"...\" --repo $REPO"
  echo "  gh release upload $TAG $ARTEFACT --repo $REPO"
  echo "  gh release edit $TAG --draft=false --repo $REPO"
  echo "  tools/fetch_basemap.sh --force && tools/fetch_basemap.sh --check"
  echo
  echo "Release notes:"
  echo "$NOTES" | sed 's/^/  | /'
  echo
  echo "Reminder: immutable releases must be ENABLED in the $REPO settings first."
  exit 0
fi

note "creating draft release $TAG on $REPO"
gh release create "$TAG" --draft --title "$TITLE" --notes "$NOTES" --repo "$REPO"
note "uploading $ASSET"
gh release upload "$TAG" "$ARTEFACT" --repo "$REPO"
note "publishing (leaving draft state)"
gh release edit "$TAG" --draft=false --repo "$REPO"

# ---- post-publish verification: the pinned path end to end -------------------
note "verifying the published asset end to end (re-download + hash check)"
sh "$SCRIPT_DIR/fetch_basemap.sh" --lock "$LOCK" --out "$ARTEFACT" --force
sh "$SCRIPT_DIR/fetch_basemap.sh" --lock "$LOCK" --out "$ARTEFACT" --check

echo
echo "DONE: $WORLD_PMTILES_URL is live and verified."
echo "Next: tools/check_all.sh --release, then update the lifecycle status table in docs/BASEMAP.md."
