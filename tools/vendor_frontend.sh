#!/bin/sh
# tools/vendor_frontend.sh — the single committed way to (re)vendor every pinned
# third-party frontend asset and to write static/vendor.lock (HANDOFF-v2 §11 WP3,
# §14.4). Maintainer tool: NETWORK-ENABLED (see the §17.1 network-permission
# table). Verification is offline: python3 update_hashes.py --check-vendor.
#
# Usage:
#   tools/vendor_frontend.sh [--update] <subcommand>...
# Subcommands:
#   --engine          MapLibre GL 6.6.0 (mjs/css/worker), PMTiles 4.5.0 ESM,
#                     fflate 0.8.2 ESM (see PMTILES NOTE below)
#   --basemap-assets  Noto Sans glyph PBFs + v4 light/dark sprites from
#                     protomaps/basemaps-assets @ the pinned commit
#   --licenses        every §20 licence text
#   --countries       delegates to: node tools/vendor_countries.mjs --rebuild
#   --legacy          Bootstrap CSS / Chart.js / Font Awesome at the §6.4 pins (WP8)
#   --fonts           Inter v4.1 + JetBrains Mono v2.304 re-vendor (WP8)
#   --flags           verify/re-vendor static/flags against Flagpack v2.1.0 (WP8)
#   --write-lock      (re)write static/vendor.lock from the current tree
#   --all             engine + basemap-assets + licenses + countries + write-lock
#
# Existing files that differ from the pinned download are NOT overwritten
# unless --update is given.
#
# PMTILES NOTE (deviation from HANDOFF D3, documented): pmtiles@4.5.0
# dist/esm/index.js carries a bare `import { decompressSync } from "fflate"`,
# which a browser cannot resolve without an import map (D8 forbids inline
# scripts, no import map is used). The committed transform below rewrites that
# one specifier to "./fflate.mjs" and vendors fflate@0.8.2 esm/browser.js
# (self-contained, zero imports) alongside. static/pmtiles.mjs is therefore
# provenance_type "generated" (committed transform of a pinned input), never
# claimed byte-identical to npm.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
STATIC="$REPO_ROOT/static"

# ---- pinned upstream refs: the single place they live (§0.5 item 58) ----
MAPLIBRE_VERSION=6.6.0
PMTILES_VERSION=4.5.0
FFLATE_VERSION=0.8.2
BASEMAPS_ASSETS_COMMIT=028c18f713baecad011301ff7a69acc39bcc2ae7
PROTOMAPS_BASEMAPS_VERSION=5.7.2      # licence text only; styles pin lives in tools/styles/package-lock.json
BOOTSTRAP_VERSION=5.3.8
CHARTJS_VERSION=4.5.1
FONTAWESOME_VERSION=7.3.1
INTER_TAG=v4.1
JBMONO_TAG=v2.304
FLAGPACK_TAG=v2.1.0
NATURAL_EARTH_TAG=v5.1.2              # geometry pin lives in tools/vendor_countries.mjs
TANGRAM_ICONS_COMMIT=92510779634f4a006c61ea70e50cb8c52c765a81
# licence-text pins for packages whose npm tarball ships no licence file:
PMTILES_REPO_COMMIT=182d5b3cfdc2f5a6adbc54630c612da2f6086bdd
PROTOMAPS_BASEMAPS_REPO_COMMIT=a50c699adc60a45c899971b1e11275e61f13bfbf
ODBL_TEXT_URL="https://raw.githubusercontent.com/spdx/license-list-data/v3.28.0/text/ODbL-1.0.txt"

UPDATE=0
TMPD=$(mktemp -d)
trap 'rm -rf "$TMPD"' EXIT INT TERM

fetch() { # url dest
  if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" "$1"; else wget -q -O "$2" "$1"; fi
}

npm_tgz() { # package version dest — @scope/name handled
  pkg="$1"; ver="$2"; dest="$3"
  base=${pkg##*/}
  fetch "https://registry.npmjs.org/${pkg}/-/${base}-${ver}.tgz" "$dest"
}

install_file() { # src dest
  src="$1"; dest="$2"
  if [ -f "$dest" ] && ! cmp -s "$src" "$dest"; then
    if [ "$UPDATE" = 0 ]; then
      echo "REFUSED: $dest differs from the pinned download — rerun with --update to replace it." >&2
      exit 1
    fi
    echo "  updated: $dest"
  else
    [ -f "$dest" ] && echo "  ok (unchanged): $dest" || echo "  added: $dest"
  fi
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
}

do_engine() {
  echo "[*] Vendoring MapLibre GL $MAPLIBRE_VERSION..."
  npm_tgz maplibre-gl "$MAPLIBRE_VERSION" "$TMPD/maplibre.tgz"
  mkdir -p "$TMPD/maplibre" && tar -xzf "$TMPD/maplibre.tgz" -C "$TMPD/maplibre"
  for f in maplibre-gl.mjs maplibre-gl-shared.mjs maplibre-gl-worker.mjs maplibre-gl.css; do
    install_file "$TMPD/maplibre/package/dist/$f" "$STATIC/$f"
  done

  echo "[*] Vendoring fflate $FFLATE_VERSION (esm/browser.js, self-contained)..."
  npm_tgz fflate "$FFLATE_VERSION" "$TMPD/fflate.tgz"
  mkdir -p "$TMPD/fflate" && tar -xzf "$TMPD/fflate.tgz" -C "$TMPD/fflate"
  install_file "$TMPD/fflate/package/esm/browser.js" "$STATIC/fflate.mjs"

  echo "[*] Vendoring PMTiles $PMTILES_VERSION (ESM, fflate import rewritten — see PMTILES NOTE)..."
  npm_tgz pmtiles "$PMTILES_VERSION" "$TMPD/pmtiles.tgz"
  mkdir -p "$TMPD/pmtiles" && tar -xzf "$TMPD/pmtiles.tgz" -C "$TMPD/pmtiles"
  sed 's|from"fflate"|from"./fflate.mjs"|' \
    "$TMPD/pmtiles/package/dist/esm/index.js" > "$TMPD/pmtiles.mjs"
  if cmp -s "$TMPD/pmtiles.mjs" "$TMPD/pmtiles/package/dist/esm/index.js"; then
    echo "ERROR: fflate import rewrite matched nothing — pmtiles upstream changed; review the transform." >&2
    exit 1
  fi
  install_file "$TMPD/pmtiles.mjs" "$STATIC/pmtiles.mjs"
}

do_basemap_assets() {
  echo "[*] Vendoring basemaps-assets @ $BASEMAPS_ASSETS_COMMIT (glyphs + v4 sprites)..."
  fetch "https://github.com/protomaps/basemaps-assets/archive/${BASEMAPS_ASSETS_COMMIT}.tar.gz" "$TMPD/assets.tgz"
  mkdir -p "$TMPD/assets" && tar -xzf "$TMPD/assets.tgz" -C "$TMPD/assets"
  root="$TMPD/assets/basemaps-assets-${BASEMAPS_ASSETS_COMMIT}"
  # Only the three faces the generated styles reference (§11 WP3); the
  # Devanagari stack is intentionally not vendored.
  for face in "Noto Sans Regular" "Noto Sans Medium" "Noto Sans Italic"; do
    mkdir -p "$STATIC/basemaps/fonts/$face"
    count=0
    for pbf in "$root/fonts/$face/"*.pbf; do
      cp "$pbf" "$STATIC/basemaps/fonts/$face/"
      count=$((count + 1))
    done
    echo "  $face: $count glyph ranges"
  done
  mkdir -p "$STATIC/basemaps/sprites/v4"
  for f in light.json light.png light@2x.json light@2x.png dark.json dark.png dark@2x.json dark@2x.png; do
    install_file "$root/sprites/v4/$f" "$STATIC/basemaps/sprites/v4/$f"
  done
}

do_licenses() {
  echo "[*] Fetching licence texts (§20)..."
  L="$STATIC/licenses"; mkdir -p "$L"
  npm_tgz maplibre-gl "$MAPLIBRE_VERSION" "$TMPD/l1.tgz"; tar -xzf "$TMPD/l1.tgz" -C "$TMPD" package/LICENSE.txt
  install_file "$TMPD/package/LICENSE.txt" "$L/maplibre-BSD-3-Clause.txt"; rm -rf "$TMPD/package"
# pmtiles and @protomaps/basemaps npm tarballs ship no licence file — fetch
  # from the GitHub repos at pinned commits instead.
  fetch "https://raw.githubusercontent.com/protomaps/PMTiles/${PMTILES_REPO_COMMIT}/LICENSE" "$TMPD/pmtiles-lic.txt"
  install_file "$TMPD/pmtiles-lic.txt" "$L/pmtiles-BSD-3-Clause.txt"
  npm_tgz fflate "$FFLATE_VERSION" "$TMPD/l3.tgz"; tar -xzf "$TMPD/l3.tgz" -C "$TMPD" package/LICENSE
  install_file "$TMPD/package/LICENSE" "$L/fflate-MIT.txt"; rm -rf "$TMPD/package"
  fetch "https://raw.githubusercontent.com/protomaps/basemaps/${PROTOMAPS_BASEMAPS_REPO_COMMIT}/LICENSE.md" "$TMPD/pbm-lic.txt"
  install_file "$TMPD/pbm-lic.txt" "$L/protomaps-basemaps-BSD-3-Clause.txt"
  npm_tgz bootstrap "$BOOTSTRAP_VERSION" "$TMPD/l5.tgz"; tar -xzf "$TMPD/l5.tgz" -C "$TMPD" package/LICENSE
  install_file "$TMPD/package/LICENSE" "$L/bootstrap-MIT.txt"; rm -rf "$TMPD/package"
  npm_tgz chart.js "$CHARTJS_VERSION" "$TMPD/l6.tgz"; tar -xzf "$TMPD/l6.tgz" -C "$TMPD" package/LICENSE.md
  install_file "$TMPD/package/LICENSE.md" "$L/chartjs-MIT.txt"; rm -rf "$TMPD/package"
  npm_tgz @fortawesome/fontawesome-free "$FONTAWESOME_VERSION" "$TMPD/l7.tgz"; tar -xzf "$TMPD/l7.tgz" -C "$TMPD" package/LICENSE.txt
  install_file "$TMPD/package/LICENSE.txt" "$L/fontawesome-LICENSE.txt"; rm -rf "$TMPD/package"

  fetch "https://raw.githubusercontent.com/protomaps/basemaps-assets/${BASEMAPS_ASSETS_COMMIT}/fonts/OFL.txt" "$TMPD/ofl.txt"
  install_file "$TMPD/ofl.txt" "$L/noto-OFL-1.1.txt"
  fetch "https://raw.githubusercontent.com/tangrams/icons/${TANGRAM_ICONS_COMMIT}/LICENSE.md" "$TMPD/tangram.txt"
  install_file "$TMPD/tangram.txt" "$L/tangram-icons-MIT.txt"
  fetch "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NATURAL_EARTH_TAG}/LICENSE.md" "$TMPD/ne.txt"
  install_file "$TMPD/ne.txt" "$L/natural-earth-TERMS.txt"
  fetch "$ODBL_TEXT_URL" "$TMPD/odbl.txt"
  install_file "$TMPD/odbl.txt" "$L/basemap-data-ODbL.txt"
  fetch "https://raw.githubusercontent.com/rsms/inter/${INTER_TAG}/LICENSE.txt" "$TMPD/inter.txt"
  install_file "$TMPD/inter.txt" "$L/inter-OFL-1.1.txt"
  fetch "https://raw.githubusercontent.com/JetBrains/JetBrainsMono/${JBMONO_TAG}/OFL.txt" "$TMPD/jb.txt"
  install_file "$TMPD/jb.txt" "$L/jetbrains-mono-OFL-1.1.txt"
  fetch "https://raw.githubusercontent.com/Yummygum/flagpack-core/${FLAGPACK_TAG}/LICENSE" "$TMPD/flag.txt"
  install_file "$TMPD/flag.txt" "$L/flagpack-MIT.txt"
}

do_countries() {
  echo "[*] Regenerating country geometry (network, pinned Natural Earth $NATURAL_EARTH_TAG)..."
  node "$SCRIPT_DIR/vendor_countries.mjs" --rebuild
}

do_legacy() {
  echo "[*] Vendoring legacy upgrades (§6.4, WP8): Bootstrap CSS $BOOTSTRAP_VERSION, Chart.js $CHARTJS_VERSION, Font Awesome $FONTAWESOME_VERSION..."
  npm_tgz bootstrap "$BOOTSTRAP_VERSION" "$TMPD/bs.tgz"
  mkdir -p "$TMPD/bs" && tar -xzf "$TMPD/bs.tgz" -C "$TMPD/bs"
  install_file "$TMPD/bs/package/dist/css/bootstrap.min.css" "$STATIC/bootstrap.min.css"
  npm_tgz chart.js "$CHARTJS_VERSION" "$TMPD/cj.tgz"
  mkdir -p "$TMPD/cj" && tar -xzf "$TMPD/cj.tgz" -C "$TMPD/cj"
  install_file "$TMPD/cj/package/dist/chart.umd.js" "$STATIC/chart.umd.js"
  npm_tgz @fortawesome/fontawesome-free "$FONTAWESOME_VERSION" "$TMPD/fa.tgz"
  mkdir -p "$TMPD/fa" && tar -xzf "$TMPD/fa.tgz" -C "$TMPD/fa"
  install_file "$TMPD/fa/package/css/all.min.css" "$STATIC/fontawesome/css/all.min.css"
  mkdir -p "$STATIC/fontawesome/webfonts"
  for wf in "$TMPD/fa/package/webfonts/"*; do
    install_file "$wf" "$STATIC/fontawesome/webfonts/$(basename "$wf")"
  done
}

do_fonts() {
  echo "[*] Re-vendoring Inter $INTER_TAG + JetBrains Mono $JBMONO_TAG (WP8)..."
  # Inter v4.1 release zip carries web/ woff2 files; JetBrains Mono v2.304 ships
  # fonts/webfonts. fonts.css is regenerated from what is installed.
  fetch "https://github.com/rsms/inter/releases/download/${INTER_TAG}/Inter-${INTER_TAG#v}.zip" "$TMPD/inter.zip"
  mkdir -p "$TMPD/inter" && (cd "$TMPD/inter" && unzip -oq "$TMPD/inter.zip")
  fetch "https://github.com/JetBrains/JetBrainsMono/releases/download/${JBMONO_TAG}/JetBrainsMono-${JBMONO_TAG#v}.zip" "$TMPD/jb.zip"
  mkdir -p "$TMPD/jb" && (cd "$TMPD/jb" && unzip -oq "$TMPD/jb.zip")
  rm -f "$STATIC/fonts/"*.woff2
  install_file "$TMPD/inter/web/InterVariable.woff2" "$STATIC/fonts/InterVariable.woff2"
  install_file "$TMPD/inter/web/InterVariable-Italic.woff2" "$STATIC/fonts/InterVariable-Italic.woff2"
  install_file "$TMPD/jb/fonts/webfonts/JetBrainsMono-Regular.woff2" "$STATIC/fonts/JetBrainsMono-Regular.woff2"
  install_file "$TMPD/jb/fonts/webfonts/JetBrainsMono-Bold.woff2" "$STATIC/fonts/JetBrainsMono-Bold.woff2"
  cat > "$STATIC/fonts/fonts.css" <<'CSS'
/* Generated by tools/vendor_frontend.sh --fonts — do not edit by hand.
   Inter v4.1 (variable, OFL 1.1) + JetBrains Mono v2.304 (OFL 1.1). */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url('InterVariable.woff2') format('woff2');
}
@font-face {
  font-family: 'Inter';
  font-style: italic;
  font-weight: 100 900;
  font-display: swap;
  src: url('InterVariable-Italic.woff2') format('woff2');
}
@font-face {
  font-family: 'JetBrains Mono';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('JetBrainsMono-Regular.woff2') format('woff2');
}
@font-face {
  font-family: 'JetBrains Mono';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url('JetBrainsMono-Bold.woff2') format('woff2');
}
CSS
  echo "  regenerated: $STATIC/fonts/fonts.css"
}

do_flags() {
  echo "[*] Verifying/re-vendoring flags against Flagpack $FLAGPACK_TAG (size l)..."
  fetch "https://github.com/Yummygum/flagpack-core/archive/refs/tags/${FLAGPACK_TAG}.tar.gz" "$TMPD/flagpack.tgz"
  mkdir -p "$TMPD/flagpack" && tar -xzf "$TMPD/flagpack.tgz" -C "$TMPD/flagpack"
  src="$TMPD/flagpack/flagpack-core-${FLAGPACK_TAG#v}/svg/l"
  mismatch=0
  for f in "$STATIC/flags/"*.svg; do
    name=$(basename "$f")
    if [ ! -f "$src/$name" ]; then
      echo "  NOT IN FLAGPACK: $name (kept as-is)"
      continue
    fi
    if ! cmp -s "$f" "$src/$name"; then
      if [ "$UPDATE" = 1 ]; then install_file "$src/$name" "$f"; else
        echo "  DIFFERS from Flagpack ${FLAGPACK_TAG}: $name"; mismatch=1
      fi
    fi
  done
  [ "$mismatch" = 0 ] || { echo "Rerun with --update to replace differing flags." >&2; exit 1; }
  echo "  flags verified against Flagpack ${FLAGPACK_TAG}."
}

do_write_lock() {
  echo "[*] Writing static/vendor.lock..."
  REPO_ROOT="$REPO_ROOT" \
  MAPLIBRE_VERSION="$MAPLIBRE_VERSION" PMTILES_VERSION="$PMTILES_VERSION" \
  FFLATE_VERSION="$FFLATE_VERSION" BASEMAPS_ASSETS_COMMIT="$BASEMAPS_ASSETS_COMMIT" \
  PROTOMAPS_BASEMAPS_VERSION="$PROTOMAPS_BASEMAPS_VERSION" \
  BOOTSTRAP_VERSION="$BOOTSTRAP_VERSION" CHARTJS_VERSION="$CHARTJS_VERSION" \
  FONTAWESOME_VERSION="$FONTAWESOME_VERSION" INTER_TAG="$INTER_TAG" \
  JBMONO_TAG="$JBMONO_TAG" FLAGPACK_TAG="$FLAGPACK_TAG" \
  NATURAL_EARTH_TAG="$NATURAL_EARTH_TAG" TANGRAM_ICONS_COMMIT="$TANGRAM_ICONS_COMMIT" \
  python3 - <<'PY'
import base64, hashlib, os, sys
from pathlib import Path

root = Path(os.environ["REPO_ROOT"])
static = root / "static"
E = os.environ

def sri(p: Path) -> str:
    return "sha384-" + base64.b64encode(hashlib.sha384(p.read_bytes()).digest()).decode()

records = []

def add(path: Path, prov, source, version):
    rel = path.relative_to(root).as_posix()
    records.append((rel, sri(path), prov, source, version))

def add_glob(base: Path, pattern, prov, source, version):
    for p in sorted(base.glob(pattern)):
        if p.is_file():
            add(p, prov, source, version)

# --- 4.0 vendored engine ---
for f, src in [
    ("maplibre-gl.mjs", "npm:maplibre-gl/dist/maplibre-gl.mjs"),
    ("maplibre-gl-shared.mjs", "npm:maplibre-gl/dist/maplibre-gl-shared.mjs"),
    ("maplibre-gl-worker.mjs", "npm:maplibre-gl/dist/maplibre-gl-worker.mjs"),
    ("maplibre-gl.css", "npm:maplibre-gl/dist/maplibre-gl.css"),
]:
    p = static / f
    if p.exists(): add(p, "vendored", src, E["MAPLIBRE_VERSION"])
p = static / "fflate.mjs"
if p.exists(): add(p, "vendored", "npm:fflate/esm/browser.js", E["FFLATE_VERSION"])
p = static / "pmtiles.mjs"
if p.exists():
    add(p, "generated",
        "tools/vendor_frontend.sh --engine (npm:pmtiles/dist/esm/index.js, fflate import -> ./fflate.mjs)",
        E["PMTILES_VERSION"])

# --- basemap assets ---
ba = f"protomaps/basemaps-assets@{E['BASEMAPS_ASSETS_COMMIT'][:8]}"
add_glob(static, "basemaps/fonts/**/*.pbf", "vendored", ba, "-")
add_glob(static, "basemaps/sprites/v4/*", "vendored", ba, "-")

# --- generated styles / countries ---
add_glob(static, "styles/*.json", "generated", "tools/styles/generate_styles.mjs",
         f"@protomaps/basemaps {E['PROTOMAPS_BASEMAPS_VERSION']}")
for name in ("countries.geojson", "countries.geojson.gz"):
    p = static / "data" / name
    if p.exists():
        add(p, "generated", "tools/vendor_countries.mjs",
            f"Natural Earth {E['NATURAL_EARTH_TAG']} 50m admin-0 map units")

# --- local modules ---
for name in ("map-boot.mjs", "attack-geometry.mjs", "attack-renderer.mjs"):
    p = static / name
    if p.exists(): add(p, "local", "repository source", "-")

# --- licences ---
lic_src = {
    "maplibre-BSD-3-Clause.txt": ("npm:maplibre-gl", E["MAPLIBRE_VERSION"]),
    "pmtiles-BSD-3-Clause.txt": ("npm:pmtiles", E["PMTILES_VERSION"]),
    "fflate-MIT.txt": ("npm:fflate", E["FFLATE_VERSION"]),
    "protomaps-basemaps-BSD-3-Clause.txt": ("npm:@protomaps/basemaps", E["PROTOMAPS_BASEMAPS_VERSION"]),
    "bootstrap-MIT.txt": ("npm:bootstrap", E["BOOTSTRAP_VERSION"]),
    "chartjs-MIT.txt": ("npm:chart.js", E["CHARTJS_VERSION"]),
    "fontawesome-LICENSE.txt": ("npm:@fortawesome/fontawesome-free", E["FONTAWESOME_VERSION"]),
    "noto-OFL-1.1.txt": (ba, "-"),
    "tangram-icons-MIT.txt": (f"tangrams/icons@{E['TANGRAM_ICONS_COMMIT'][:8]}", "-"),
    "natural-earth-TERMS.txt": ("nvkelso/natural-earth-vector", E["NATURAL_EARTH_TAG"]),
    "basemap-data-ODbL.txt": ("opendatacommons.org ODbL 1.0", "-"),
    "inter-OFL-1.1.txt": ("rsms/inter", E["INTER_TAG"]),
    "jetbrains-mono-OFL-1.1.txt": ("JetBrains/JetBrainsMono", E["JBMONO_TAG"]),
    "flagpack-MIT.txt": ("Yummygum/flagpack-core", E["FLAGPACK_TAG"]),
}
for name, (src, ver) in lic_src.items():
    p = static / "licenses" / name
    if p.exists(): add(p, "vendored", src, ver)

# --- legacy / re-vendored third-party files -------------------------------
# Before WP8 the baseline files are recorded as provenance_type "legacy"
# (source = repository baseline e798fcb, upstream_ref = unknown): a truthful
# tamper-evidence record, not an upstream provenance claim. WP8 replaces or
# removes every legacy entry; check_all.sh --release fails if one remains.
LEGACY_DONE = os.environ.get("VENDOR_LEGACY_DONE", "0") == "1"

def marker(p: Path) -> bool:
    return p.exists()

if LEGACY_DONE:
    p = static / "bootstrap.min.css"
    if p.exists(): add(p, "vendored", "npm:bootstrap/dist/css/bootstrap.min.css", E["BOOTSTRAP_VERSION"])
    p = static / "chart.umd.js"
    if p.exists(): add(p, "vendored", "npm:chart.js/dist/chart.umd.js", E["CHARTJS_VERSION"])
    add_glob(static, "fontawesome/**/*", "vendored", "npm:@fortawesome/fontawesome-free", E["FONTAWESOME_VERSION"])
    add_glob(static, "fonts/InterVariable*", "vendored", "rsms/inter (web woff2)", E["INTER_TAG"])
    add_glob(static, "fonts/JetBrainsMono*", "vendored", "JetBrains/JetBrainsMono (webfonts)", E["JBMONO_TAG"])
    p = static / "fonts" / "fonts.css"
    if p.exists(): add(p, "generated", "tools/vendor_frontend.sh --fonts", "-")
    add_glob(static, "flags/*.svg", "vendored", f"Yummygum/flagpack-core@{E['FLAGPACK_TAG']} (svg/l)", E["FLAGPACK_TAG"][1:])
else:
    baseline = "repository baseline e798fcb (upstream_ref = unknown)"
    for name in ("jquery-3.7.1.min.js", "luxon.min.js", "bootstrap.min.js",
                 "bootstrap.min.css", "bootstrap.min.css.map", "chart.umd.js"):
        p = static / name
        if p.exists(): add(p, "legacy", baseline, "-")
    add_glob(static, "fontawesome/**/*", "legacy", baseline, "-")
    add_glob(static, "fonts/*", "legacy", baseline, "-")
    add_glob(static, "flags/*.svg", "legacy", baseline, "-")

records.sort(key=lambda r: r[0])
out = root / "static" / "vendor.lock"
with out.open("w") as fh:
    fh.write("# static/vendor.lock — authoritative integrity/provenance manifest (HANDOFF-v2 §14.4).\n")
    fh.write("# Generated by tools/vendor_frontend.sh --write-lock; verified by update_hashes.py --check-vendor.\n")
    fh.write("# path\tsha384\tprovenance_type\tsource\tversion\n")
    for r in records:
        fh.write("\t".join(r) + "\n")
print(f"  wrote {out} ({len(records)} entries)")
PY
}

[ $# -gt 0 ] || { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

ACTIONS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --update) UPDATE=1 ;;
    --engine|--basemap-assets|--licenses|--countries|--legacy|--fonts|--flags|--write-lock) ACTIONS="$ACTIONS $1" ;;
    --all) ACTIONS="$ACTIONS --engine --basemap-assets --licenses --countries --write-lock" ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

for a in $ACTIONS; do
  case "$a" in
    --engine) do_engine ;;
    --basemap-assets) do_basemap_assets ;;
    --licenses) do_licenses ;;
    --countries) do_countries ;;
    --legacy) do_legacy ;;
    --fonts) do_fonts ;;
    --flags) do_flags ;;
    --write-lock) do_write_lock ;;
  esac
done
echo "[*] Done. Verify offline with: python3 update_hashes.py --check-vendor"
