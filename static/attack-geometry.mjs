// static/attack-geometry.mjs — pure geographic helpers (HANDOFF-v2 §9.2).
// Imported by the renderer AND by node --test; no DOM, no MapLibre, no state.
// Nothing in here is ever persisted: shape/pixel/projection values stay
// renderer-local (§9.2 rules).

/**
 * World-copy offset (k*360) that places the route nearest the map centre.
 * Called ONCE per spawn (§9.3); the result is frozen for the event's
 * lifetime — recomputing per frame teleports a live arc by ±360° when the
 * centre crosses the half-world threshold.
 *
 * dstLng is the RAW destination longitude in [-180, 180]: since the 3.0.1
 * parity decision of 2026-09-01 routes are never unwrapped across the
 * antimeridian — an arc always connects the two points within ONE world
 * copy (the "long way" across the visible map), exactly like the Leaflet
 * noWrap renderer of 3.0.1. This replaces the shortest-path unwrap of
 * HANDOFF-v2 §9.2.
 */
export function chooseWorldCopy(srcLng, dstLng, centerLng) {
  const routeMeanLng = (srcLng + dstLng) / 2;
  return 360 * Math.round((centerLng - routeMeanLng) / 360);
}

/** d3.easeCircleIn equivalent (the only easing the old renderer used). */
export function easeCircleIn(t) {
  return 1 - Math.sqrt(1 - t * t);
}
