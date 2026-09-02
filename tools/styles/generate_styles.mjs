#!/usr/bin/env node
// tools/styles/generate_styles.mjs — generates the committed map styles
// (HANDOFF-v2 §8.4, D5, D12). Development-time only; the output is committed.
//
//   node generate_styles.mjs            regenerate static/styles/{dark,light}.json
//   node generate_styles.mjs --verify   regenerate to memory and diff against the
//                                       committed files (offline; exits non-zero on drift)
//
// The style filter is an ALLOWLIST (allowlist.json). The generator prints all /
// retained / dropped upstream ids and FAILS on any id that is in neither
// allowlist.json nor known_dropped.json — an @protomaps/basemaps upgrade must
// force an explicit human decision instead of silently changing the map.
//
// The committed styles deliberately contain NO source url and NO maxzoom: both
// are injected at runtime (url from document.baseURI, maxzoom from the PMTiles
// header — the archive is authoritative, §7.4). glyphs/sprite are placeholders
// overwritten at runtime (§7.3).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { layers, namedFlavor } from "@protomaps/basemaps";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT_DIR = join(ROOT, "static", "styles");

const THEMES = { dark: "dark", light: "light" }; // style file -> namedFlavor()

const allow = new Set(JSON.parse(readFileSync(join(HERE, "allowlist.json"), "utf8")).retain);
const knownDropped = new Set(JSON.parse(readFileSync(join(HERE, "known_dropped.json"), "utf8")).dropped);

function buildStyle(theme) {
  const flavor = namedFlavor(THEMES[theme]);
  const upstream = layers("protomaps", flavor, { lang: "en" });

  const allIds = upstream.map((l) => l.id);
  const retained = upstream.filter((l) => allow.has(l.id));
  const droppedIds = allIds.filter((id) => !allow.has(id));
  const unknown = allIds.filter((id) => !allow.has(id) && !knownDropped.has(id));

  console.log(`[${theme}] upstream ids (${allIds.length}): ${allIds.join(", ")}`);
  console.log(`[${theme}] retained (${retained.length}): ${retained.map((l) => l.id).join(", ")}`);
  console.log(`[${theme}] dropped (${droppedIds.length}): ${droppedIds.join(", ")}`);
  if (unknown.length) {
    console.error(
      `ERROR: upstream layer ids in neither allowlist.json nor known_dropped.json: ${unknown.join(", ")}\n` +
      `A @protomaps/basemaps upgrade added layers — decide explicitly (retain or drop) and update the lists.`
    );
    process.exit(1);
  }

  return {
    version: 8,
    name: `T-Pot Attack Map (${theme})`,
    // placeholders — overwritten at runtime against document.baseURI (§7.3)
    glyphs: "static/basemaps/fonts/{fontstack}/{range}.pbf",
    sprite: `static/basemaps/sprites/v4/${theme}`,
    sources: {
      protomaps: {
        type: "vector",
        attribution:
          '<a href="https://github.com/protomaps/basemaps">Protomaps</a> © <a href="https://osm.org/copyright">OpenStreetMap</a>',
      },
    },
    layers: retained,
  };
}

const verify = process.argv.includes("--verify");
let drift = false;

for (const theme of Object.keys(THEMES)) {
  const style = buildStyle(theme);
  const json = JSON.stringify(style, null, 2) + "\n";
  const outPath = join(OUT_DIR, `${theme}.json`);
  if (verify) {
    let committed = null;
    try { committed = readFileSync(outPath, "utf8"); } catch { /* missing */ }
    if (committed !== json) {
      console.error(`DRIFT: ${outPath} does not match the generator output.`);
      drift = true;
    } else {
      console.log(`OK: ${outPath} matches the generator output.`);
    }
  } else {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(outPath, json);
    console.log(`wrote ${outPath} (${json.length} bytes)`);
  }
}

if (verify && drift) process.exit(1);
