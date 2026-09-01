// static/attack-geometry.mjs — pure geographic helpers (HANDOFF-v2 §9.2).
// Imported by the renderer AND by node --test; no DOM, no MapLibre, no state.
// Nothing in here is ever persisted: shape/pixel/projection values stay
// renderer-local (§9.2 rules).

/**
 * Nearest ±360° representation of lng relative to refLng, so a route takes
 * the short way across the antimeridian. Exactly ±180° apart resolves
 * deterministically (both +180 and -180 inputs yield the same value).
 */
export function unwrapLongitude(refLng, lng) {
  return lng + 360 * Math.round((refLng - lng) / 360);
}

/**
 * World-copy offset (k*360) that places the route nearest the map centre.
 * Called ONCE per spawn (§9.3); the result is frozen for the event's
 * lifetime — recomputing per frame teleports a live arc by ±360° when the
 * centre crosses the half-world threshold.
 */
export function chooseWorldCopy(srcLng, dstLngUnwrapped, centerLng) {
  const routeMeanLng = (srcLng + dstLngUnwrapped) / 2;
  return 360 * Math.round((centerLng - routeMeanLng) / 360);
}

/** d3.easeCircleIn equivalent (the only easing the old renderer used). */
export function easeCircleIn(t) {
  return 1 - Math.sqrt(1 - t * t);
}
