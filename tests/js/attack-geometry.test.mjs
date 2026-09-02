// node --test — exact geometry assertions of HANDOFF-v2 §9.3.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseWorldCopy,
  easeCircleIn,
} from '../../static/attack-geometry.mjs';

// unwrapLongitude was removed with the 3.0.1 parity decision of 2026-09-01:
// routes are never unwrapped across the antimeridian; chooseWorldCopy now
// takes the raw destination longitude.

test('chooseWorldCopy keeps the shifted route mean within 180° of the centre', () => {
  for (const [srcLng, dstLng] of [[139.7, -121.9], [-10, 10], [170, -170]]) {
    for (const centerLng of [0, 350, -350, 710]) {
      const off = chooseWorldCopy(srcLng, dstLng, centerLng);
      const mean = (srcLng + dstLng) / 2 + off;
      assert.ok(Math.abs(centerLng - mean) <= 180,
        `src=${srcLng} dst=${dstLng} centre=${centerLng} off=${off} mean=${mean}`);
      assert.equal(Math.abs(off % 360), 0);
    }
  }
});

test('easeCircleIn endpoints are exact', () => {
  assert.equal(easeCircleIn(0), 0);
  assert.equal(easeCircleIn(1), 1);
  assert.ok(easeCircleIn(0.5) > 0 && easeCircleIn(0.5) < 1);
});
