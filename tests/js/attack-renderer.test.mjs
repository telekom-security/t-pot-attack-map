// node --test — renderer assertions of HANDOFF-v2 §9.3/§9.4 and §11 WP5.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AttackRenderer,
  bendPixels,
  quadraticPoint,
  FACTOR, MIN_BEND_PX, MAX_BEND_PX, MAX_EVENTS, TRAVEL_MS, LIFETIME_MS,
} from '../../static/attack-renderer.mjs';

// ---- pure presentation maths -----------------------------------------------

test('bendPixels is monotone and respects both bounds', () => {
  assert.equal(bendPixels(0), MIN_BEND_PX);
  assert.equal(bendPixels(1e9), MAX_BEND_PX);
  let prev = -1;
  for (let d = 0; d <= 2000; d += 50) {
    const b = bendPixels(d);
    assert.ok(b >= prev, 'monotone');
    assert.ok(b >= MIN_BEND_PX && b <= MAX_BEND_PX, 'bounded');
    prev = b;
  }
  const mid = (MIN_BEND_PX + MAX_BEND_PX) / 2 / FACTOR;
  assert.ok(Math.abs(bendPixels(mid) - mid * FACTOR) < 1e-9, 'linear inside the bounds');
});

test('quadraticPoint returns the endpoints exactly', () => {
  const p0 = { x: 3, y: 4 }, c = { x: 100, y: -50 }, p1 = { x: -7, y: 9 };
  assert.deepEqual(quadraticPoint(p0, c, p1, 0), { x: 3, y: 4 });
  assert.deepEqual(quadraticPoint(p0, c, p1, 1), { x: -7, y: 9 });
});

// ---- test doubles -----------------------------------------------------------

function spyCtx() {
  const calls = [];
  const ctx = new Proxy({}, {
    get(_, prop) {
      if (prop === '__calls') return calls;
      return (...args) => { calls.push([prop, ...args]); };
    },
    set(_, prop, value) { calls.push(['set:' + prop, value]); return true; },
  });
  return ctx;
}

function fakeCanvas(ctx) {
  return { width: 800, height: 600, style: {}, getContext: () => ctx };
}

// Linear "projection": x depends on lng relative to a movable centre.
function stubMap(centerLng = 0) {
  const m = {
    _centerLng: centerLng,
    getCenter: () => ({ lng: m._centerLng, lat: 0 }),
    getContainer: () => ({ clientWidth: 800, clientHeight: 600 }),
    project: ([lng, lat]) => ({ x: (lng - m._centerLng) * 4 + 400, y: 300 - lat * 4 }),
    on: () => {},
  };
  return m;
}

function makeRenderer(map, t0 = 0) {
  let now = t0;
  const r = new AttackRenderer({ clock: () => now });
  r.attach(map, { canvas: fakeCanvas(spyCtx()) });
  return { r, setNow: (t) => { now = t; } };
}

const EVENT = (over = {}) => ({
  id: 1,
  src: { lng: 10, lat: 50 },
  dst: { lng: 30, lat: 40 },
  color: '#FF9800',
  protocol: 'SSH',
  spawnedAt: 0,
  seed: 1,
  ...over,
});

const ops = (r) => r.ctx.__calls.map((c) => c[0]);

// ---- phase behaviour ---------------------------------------------------------

test('travel phase draws source ring, trail and head dot', () => {
  const { r } = makeRenderer(stubMap());
  r.spawn(EVENT());
  r.ctx.__calls.length = 0;
  r.renderFrame(300); // mid-travel
  const o = ops(r);
  assert.ok(o.includes('clearRect'));
  assert.ok(o.includes('stroke'), 'ring + trail strokes');
  assert.ok(o.includes('moveTo') && o.includes('lineTo'), 'trail path');
  assert.ok(o.includes('fill'), 'head dot');
});

test('impact phase draws only the destination ring', () => {
  const { r } = makeRenderer(stubMap());
  r.spawn(EVENT());
  r.ctx.__calls.length = 0;
  r.renderFrame(1000); // impact phase (700-1400)
  const o = ops(r);
  assert.ok(o.includes('stroke'), 'impact ring');
  assert.ok(!o.includes('lineTo'), 'no trail after travel');
  assert.ok(!o.includes('fill'), 'no head dot after travel');
});

test('events self-expire after the 1.4 s lifetime', () => {
  const { r } = makeRenderer(stubMap());
  r.spawn(EVENT());
  r.renderFrame(LIFETIME_MS + 1);
  assert.equal(r.queue.length, 0);
});

test('identical endpoints: rings only, no trail, no NaN', () => {
  const { r } = makeRenderer(stubMap());
  r.spawn(EVENT({ dst: { lng: 10, lat: 50 } }));
  r.ctx.__calls.length = 0;
  r.renderFrame(300);
  const calls = r.ctx.__calls;
  assert.ok(!calls.some((c) => c[0] === 'lineTo'), 'no trail');
  for (const c of calls) for (const a of c.slice(1)) {
    if (typeof a === 'number') assert.ok(Number.isFinite(a), `NaN in ${c[0]}`);
  }
});

test('non-finite projection results are skipped', () => {
  const map = stubMap();
  map.project = () => ({ x: NaN, y: NaN });
  const { r } = makeRenderer(map);
  r.spawn(EVENT());
  r.ctx.__calls.length = 0;
  r.renderFrame(300);
  assert.ok(!ops(r).includes('stroke'), 'nothing drawn for a non-finite projection');
});

test(`the ${MAX_EVENTS}-event cap drops the oldest event`, () => {
  const { r } = makeRenderer(stubMap());
  for (let i = 0; i < MAX_EVENTS + 5; i++) r.spawn(EVENT({ id: i }));
  assert.equal(r.queue.length, MAX_EVENTS);
  assert.equal(r.queue[0].event.id, 5, 'oldest dropped');
  assert.equal(r.queue.at(-1).event.id, MAX_EVENTS + 4);
});

// ---- world-copy continuity (§9.3): centres 170 -> 179 -> 181 -> 190 ----------

test('worldCopyOffsetLng is frozen at spawn; projected midpoint moves continuously', () => {
  const map = stubMap(170);
  const { r } = makeRenderer(map);
  // route mean 0 (src -10, dst 10) — the classic half-world-threshold case
  r.spawn(EVENT({ src: { lng: -10, lat: 0 }, dst: { lng: 10, lat: 0 } }));
  const frozen = r.queue[0].worldCopyOffsetLng;

  const midAt = (centerLng) => {
    map._centerLng = centerLng;
    const re = r.queue[0];
    const S = map.project([re.event.src.lng + re.worldCopyOffsetLng, 0]);
    const D = map.project([re.dstLngUnwrapped + re.worldCopyOffsetLng, 0]);
    return (S.x + D.x) / 2;
  };

  let prevMid = midAt(170);
  for (const c of [179, 181, 190]) {
    const mid = midAt(c);
    assert.equal(r.queue[0].worldCopyOffsetLng, frozen, 'offset never recomputed');
    // continuous: a 360° copy jump would move the midpoint by 360*4 = 1440 px
    assert.ok(Math.abs(mid - prevMid) < 100,
      `midpoint jumped ${Math.abs(mid - prevMid)} px between centres`);
    prevMid = mid;
  }
});

test('a newly spawned event picks the copy nearest the CURRENT centre', () => {
  const map = stubMap(365); // one world to the east
  const { r } = makeRenderer(map);
  r.spawn(EVENT({ src: { lng: -10, lat: 0 }, dst: { lng: 10, lat: 0 } }));
  assert.equal(r.queue[0].worldCopyOffsetLng, 360);
});

test('clear() empties the queue and wipes the canvas', () => {
  const { r } = makeRenderer(stubMap());
  r.spawn(EVENT());
  r.clear();
  assert.equal(r.queue.length, 0);
  assert.ok(ops(r).includes('clearRect'));
});
