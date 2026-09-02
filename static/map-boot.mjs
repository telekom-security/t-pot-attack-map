// static/map-boot.mjs — map engine bootstrap (HANDOFF-v2 §7.1, D13).
// Imported dynamically by map.js: await import('./map-boot.mjs').
// Registers the pmtiles protocol WITHOUT the metadata option (D13: with
// metadata enabled the protocol's json branch performs an extra ranged
// request for the archive's JSON metadata section on the startup critical
// path; with it disabled the TileJSON is built from the header we already
// read in openBasemap()).

import * as maplibregl from './maplibre-gl.mjs';
import { PMTiles, Protocol, TileType } from './pmtiles.mjs';

// Same-origin module worker, set explicitly so the guarantee does not depend
// on module-URL resolution (§13.2). MapLibre 6.6.0 calls
// new Worker(url, {type:'module'}) directly for same-origin URLs — no blob:.
maplibregl.setWorkerUrl(new URL('./maplibre-gl-worker.mjs', import.meta.url).href);

const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

export { maplibregl };

// PMTiles preflight (§13.5): open the archive and validate its header BEFORE
// MapLibre is constructed. Any rejection here reaches the failure UI without
// a half-initialised map. protocol.add() registers the instance under its URL
// key, so the header read (one ~16 KB range request) is reused by the tile
// protocol — the preflight adds no repeated request.
export async function openBasemap(absoluteUrl) {
  const archive = new PMTiles(absoluteUrl);
  const header = await archive.getHeader();
  if (header.tileType !== TileType.Mvt) {
    throw new Error(`unexpected tile type ${header.tileType} (expected MVT)`);
  }
  if (header.maxZoom < header.minZoom) {
    throw new Error('invalid zoom range in PMTiles header');
  }
  protocol.add(archive);
  return header;
}
