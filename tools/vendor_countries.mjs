#!/usr/bin/env node
// tools/vendor_countries.mjs — country geometry for the choropleth
// (HANDOFF-v2 §8.5, D18). Node stdlib only.
//
//   --rebuild  NETWORK-ENABLED maintainer operation: download the pinned
//              Natural Earth source, verify its recorded SHA-256 BEFORE
//              processing, regenerate static/data/countries.geojson(.gz),
//              print the full report and diff against the committed output.
//   --verify   FULLY OFFLINE (used by every check_all.sh mode): validate the
//              committed output only — GeoJSON structure, hashes against
//              static/vendor.lock, unique feature ids, ISO coverage against
//              tools/iso_universe.txt / tools/iso_unsupported.txt, and the
//              recorded provenance metadata.
//
// Transformation (one Feature per ISO code): keep ISO_A2_EH and NAME, drop
// -99/empty ids, merge all map units of a code into one (Multi)Polygon, round
// coordinates to 3 decimals and drop consecutive duplicate points. The fill is
// rendered without its own outline (§8.5): exact alignment with the Protomaps
// boundary lines is not guaranteed and not claimed.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---- pinned source (the single place this pin lives) ----------------------
const NE_REPO = "nvkelso/natural-earth-vector";
const NE_TAG = "v5.1.2";
const NE_COMMIT = "f1890d9f152c896d250a77557a5751a93d494776"; // the tag's commit (tags can move)
const NE_FILE = "geojson/ne_50m_admin_0_map_units.geojson";
const NE_URL = `https://raw.githubusercontent.com/${NE_REPO}/${NE_TAG}/${NE_FILE}`;
const NE_SHA256 = "b8d421aca6e9e08e8cdf09cc26af111cc3e0deba4fe915611d58ade71e8a4db0";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "static", "data", "countries.geojson");
const OUT_GZ = OUT + ".gz";
const UNIVERSE = join(HERE, "iso_universe.txt");
const UNSUPPORTED = join(HERE, "iso_unsupported.txt");
const VENDOR_LOCK = join(ROOT, "static", "vendor.lock");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const sri384 = (buf) => "sha384-" + createHash("sha384").update(buf).digest("base64");

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function readList(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

// ---- geometry helpers ------------------------------------------------------

function roundRing(ring) {
  const out = [];
  for (const [x, y] of ring) {
    const p = [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  // re-close the ring after rounding/dedupe
  if (out.length >= 3) {
    const [f, l] = [out[0], out[out.length - 1]];
    if (f[0] !== l[0] || f[1] !== l[1]) out.push([f[0], f[1]]);
  }
  return out.length >= 4 ? out : null; // a valid linear ring needs 4+ positions
}

function roundPolygon(polygon) {
  const rings = [];
  for (let i = 0; i < polygon.length; i++) {
    const r = roundRing(polygon[i]);
    if (r) rings.push(r);
    else if (i === 0) return null; // outer ring collapsed -> drop the polygon
  }
  return rings.length ? rings : null;
}

function asPolygonList(geometry) {
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  fail(`unexpected geometry type ${geometry.type}`);
}

// ---- rebuild ---------------------------------------------------------------

async function rebuild() {
  console.log(`[*] Downloading ${NE_REPO}@${NE_TAG} ${NE_FILE} ...`);
  const res = await fetch(NE_URL);
  if (!res.ok) fail(`download failed: HTTP ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer());
  const gotSha = sha256(raw);
  if (gotSha !== NE_SHA256) {
    fail(
      `source SHA-256 mismatch — upstream moved!\n  expected: ${NE_SHA256}\n  got:      ${gotSha}\n` +
      `Refusing to process an unverified source (HANDOFF-v2 §8.5).`
    );
  }
  console.log(`[*] Source verified: sha256 ${gotSha}`);

  const src = JSON.parse(raw.toString("utf8"));
  const sourceCount = src.features.length;

  const groups = new Map(); // iso2 -> {name, polygons: [...]}
  const dropped = [];
  for (const f of src.features) {
    const iso = f.properties.ISO_A2_EH;
    const name = f.properties.NAME;
    if (!iso || iso === "-99") {
      dropped.push(`${name ?? "?"} (ISO_A2_EH=${JSON.stringify(iso)})`);
      continue;
    }
    if (!groups.has(iso)) groups.set(iso, { name, polygons: [] });
    groups.get(iso).polygons.push(...asPolygonList(f.geometry));
  }

  const features = [];
  for (const [iso, g] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const polys = g.polygons.map(roundPolygon).filter(Boolean);
    if (!polys.length) {
      dropped.push(`${g.name} (${iso}): all rings collapsed at 3 decimals`);
      continue;
    }
    features.push({
      type: "Feature",
      properties: { ISO_A2_EH: iso, NAME: g.name },
      geometry:
        polys.length === 1
          ? { type: "Polygon", coordinates: polys[0] }
          : { type: "MultiPolygon", coordinates: polys },
    });
  }

  // hard assertion: exactly one feature per ISO code (§0.4 item 51)
  const ids = features.map((f) => f.properties.ISO_A2_EH);
  if (new Set(ids).size !== ids.length) fail("duplicate feature ids after merge — must never happen");

  const fc = {
    type: "FeatureCollection",
    tpot_provenance: {
      source: NE_REPO,
      ref: NE_TAG,
      commit: NE_COMMIT,
      file: NE_FILE,
      source_sha256: NE_SHA256,
      generator: "tools/vendor_countries.mjs --rebuild",
    },
    features,
  };
  const json = Buffer.from(JSON.stringify(fc));
  const gz = gzipSync(json, { level: 9 });

  const existed = existsSync(OUT) ? readFileSync(OUT) : null;
  const changed = !existed || !existed.equals(json);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  writeFileSync(OUT_GZ, gz);

  console.log(`[*] Report:`);
  console.log(`    source tag/commit:   ${NE_TAG} / ${NE_COMMIT}`);
  console.log(`    source features:     ${sourceCount}`);
  console.log(`    merged ISO groups:   ${groups.size}`);
  console.log(`    final features:     ${features.length} (unique ids asserted)`);
  console.log(`    dropped:             ${dropped.length}`);
  for (const d of dropped) console.log(`      - ${d}`);
  console.log(`    countries.geojson:   ${json.length} bytes, sha256 ${sha256(json)}`);
  console.log(`    countries.geojson.gz ${gz.length} bytes`);
  console.log(`    vs committed output: ${changed ? "CHANGED" : "identical"}`);
  coverage(features, true);
  console.log("[*] Remember to update static/vendor.lock: tools/vendor_frontend.sh --write-lock");
}

// ---- coverage --------------------------------------------------------------

function coverage(features, print) {
  const universe = new Set(readList(UNIVERSE));
  const unsupported = new Set(readList(UNSUPPORTED));
  const have = new Set(features.map((f) => f.properties.ISO_A2_EH));

  const unmatched = [...universe].filter((c) => !have.has(c) && !unsupported.has(c)).sort();
  const staleUnsupported = [...unsupported].filter((c) => have.has(c)).sort();
  const extra = [...have].filter((c) => !universe.has(c)).sort();

  if (print) {
    console.log(`    ISO universe:        ${universe.size} codes (${UNIVERSE})`);
    console.log(`    covered by geometry: ${[...universe].filter((c) => have.has(c)).length}`);
    console.log(`    declared unsupported:${unsupported.size} (${[...unsupported].sort().join(", ")})`);
    if (extra.length) console.log(`    geometry outside universe: ${extra.join(", ")}`);
  }
  if (unmatched.length)
    fail(`codes missing from both the geometry and ${UNSUPPORTED}: ${unmatched.join(", ")}`);
  if (staleUnsupported.length)
    fail(`codes listed unsupported but present in the geometry (stale list): ${staleUnsupported.join(", ")}`);
}

// ---- verify (fully offline) -------------------------------------------------

function verify() {
  for (const p of [OUT, OUT_GZ, UNIVERSE, UNSUPPORTED, VENDOR_LOCK])
    if (!existsSync(p)) fail(`missing file: ${p}`);

  const json = readFileSync(OUT);
  const gz = readFileSync(OUT_GZ);

  // 1. hashes against vendor.lock
  const lock = new Map(
    readFileSync(VENDOR_LOCK, "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split("\t"))
      .map((c) => [c[0], c[1]])
  );
  for (const [rel, buf] of [
    ["static/data/countries.geojson", json],
    ["static/data/countries.geojson.gz", gz],
  ]) {
    const want = lock.get(rel);
    if (!want) fail(`${rel} not present in static/vendor.lock`);
    if (want !== sri384(buf)) fail(`${rel} does not match its vendor.lock hash`);
  }

  // 2. structure + provenance metadata
  const fc = JSON.parse(json.toString("utf8"));
  if (fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) fail("not a FeatureCollection");
  const prov = fc.tpot_provenance;
  if (!prov) fail("missing tpot_provenance metadata");
  for (const [k, v] of [
    ["source", NE_REPO], ["ref", NE_TAG], ["commit", NE_COMMIT],
    ["file", NE_FILE], ["source_sha256", NE_SHA256],
  ]) {
    if (prov[k] !== v) fail(`provenance ${k} = ${JSON.stringify(prov[k])}, expected ${JSON.stringify(v)}`);
  }

  // 3. unique ids, valid geometry types
  const ids = [];
  for (const f of fc.features) {
    const iso = f?.properties?.ISO_A2_EH;
    if (!iso || typeof iso !== "string") fail("feature without ISO_A2_EH");
    if (!["Polygon", "MultiPolygon"].includes(f.geometry?.type)) fail(`bad geometry for ${iso}`);
    ids.push(iso);
  }
  if (new Set(ids).size !== ids.length) {
    const dupes = ids.filter((c, i) => ids.indexOf(c) !== i);
    fail(`duplicate feature ids: ${[...new Set(dupes)].join(", ")}`);
  }

  // 4. ISO coverage
  coverage(fc.features, false);

  console.log(`OK: countries.geojson verified offline — ${fc.features.length} features, unique ids, `
    + `hashes match vendor.lock, provenance ${prov.ref}@${prov.commit.slice(0, 8)}, ISO coverage complete.`);
}

const mode = process.argv[2];
if (mode === "--rebuild") await rebuild();
else if (mode === "--verify") verify();
else {
  console.error("usage: node tools/vendor_countries.mjs --rebuild | --verify");
  process.exit(2);
}
