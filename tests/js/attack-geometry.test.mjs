// node --test — exact geometry assertions of HANDOFF-v2 §9.3.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  unwrapLongitude,
  chooseWorldCopy,
  easeCircleIn,
} from '../../static/attack-geometry.mjs';

test('unwrapLongitude(139.7, -121.9) yields a span <= 180', () => {
  const u = unwrapLongitude(139.7, -121.9);
  assert.ok(Math.abs(u - 139.7) <= 180, `span ${Math.abs(u - 139.7)}`);
  assert.equal(u, 238.1);
});

test('unwrapLongitude at exactly ±180 is deterministic (positive direction)', () => {
  const a = unwrapLongitude(0, 180);
  const b = unwrapLongitude(0, -180);
  assert.equal(a, b);
  assert.equal(a, 180);
});

test('unwrapLongitude identity for nearby longitudes', () => {
  assert.equal(unwrapLongitude(10, 20), 20);
  assert.equal(unwrapLongitude(-170, 170), -190);
});

test('chooseWorldCopy keeps the shifted route mean within 180° of the centre', () => {
  for (const [srcLng, dstLng] of [[139.7, 238.1], [-10, 10], [170, 190]]) {
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
