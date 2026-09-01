// static/attack-renderer.mjs — the replaceable Mercator Canvas 2D renderer for
// transient attack animations (HANDOFF-v2 §9.1-§9.4, D14/D15).
//
// Renderer contract (§9.1): spawn(event), renderFrame(tMs), clear(), resize(),
// attach(map), detach(). Nothing in the WebSocket path, the cache path or the
// event model knows a canvas exists. The canonical AttackEvent carries only
// geographic endpoints + metadata; the world-copy offset and the screen-space
// bend are renderer-local and never persisted.
//
// Importable by node --test: no DOM access at module level; attach() accepts
// an injected canvas, the clock is injectable, and renderFrame(tMs) is
// explicit so tests need no requestAnimationFrame.

import { unwrapLongitude, chooseWorldCopy, easeCircleIn } from './attack-geometry.mjs';

// Visual calibration (WP6, against the WP1 baseline screenshots S09):
// bendPx = clamp(screenDist * factor, MIN_BEND_PX, MAX_BEND_PX) — the bend is
// screen-space-normalised, not latitude-scaled (§9.3). The per-event factor
// varies deterministically with the event seed in [BEND_FACTOR_MIN,
// BEND_FACTOR_MAX] around the FACTOR baseline — restoring 3.0.1's organic
// per-event arc variation ("bend direction and small variation" from the
// seed, §9.2) while keeping the D15 pixel bounds.
export const FACTOR = 0.22;
export const BEND_FACTOR_MIN = 0.12;
export const BEND_FACTOR_MAX = 0.32;
export const MIN_BEND_PX = 12;
export const MAX_BEND_PX = 140;

// Phase timings, as in 3.0.1 (§9.4): travel 0-700 ms, impact 700-1400 ms,
// source ring 0-700 ms; events self-expire after <= 1.4 s.
export const TRAVEL_MS = 700;
export const LIFETIME_MS = 1400;
export const MAX_EVENTS = 300;   // flood fuse: hard cap, oldest dropped
export const TRAIL_SAMPLES = 24;

export function bendPixels(screenDistance, factor = FACTOR) {
  return Math.min(Math.max(screenDistance * factor, MIN_BEND_PX), MAX_BEND_PX);
}

/** Deterministic per-event bend factor in [BEND_FACTOR_MIN, BEND_FACTOR_MAX]
 *  derived from the event seed (integer hash -> uniform). Same seed, same arc. */
export function bendFactorFromSeed(seed) {
  let h = (seed | 0) + 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  h ^= h >>> 15;
  const u = (h >>> 0) / 4294967295;   // [0, 1]
  return BEND_FACTOR_MIN + u * (BEND_FACTOR_MAX - BEND_FACTOR_MIN);
}

/** d3's default transition easing (used by 3.0.1 for the line fade-out). */
export function easeCubicInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Quadratic Bézier point: u=0 -> p0 exactly, u=1 -> p1 exactly. */
export function quadraticPoint(p0, c, p1, u) {
  const v = 1 - u;
  return {
    x: v * v * p0.x + 2 * v * u * c.x + u * u * p1.x,
    y: v * v * p0.y + 2 * v * u * c.y + u * u * p1.y,
  };
}

export class AttackRenderer {
  constructor({ clock } = {}) {
    this.clock = clock ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.map = null;
    this.canvas = null;
    this.ctx = null;
    this.queue = [];          // RendererEvent list (§9.2), oldest first
    this._raf = 0;
    this._tick = this._tick.bind(this);
  }

  /** Attach to a MapLibre map. opts.canvas is for tests (no DOM in Node). */
  attach(map, opts = {}) {
    this.map = map;
    this.canvas = opts.canvas ?? document.createElement('canvas');
    if (!opts.canvas) {
      this.canvas.className = 'attack-canvas';
      map.getContainer().appendChild(this.canvas);
    }
    this.ctx = this.canvas.getContext('2d');
    this.resize();
    if (map.on) map.on('resize', () => this.resize());
  }

  detach() {
    this._stopLoop();
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.map = null;
    this.canvas = null;
    this.ctx = null;
    this.queue.length = 0;
  }

  resize() {
    if (!this.canvas || !this.map || !this.map.getContainer) return;
    const el = this.map.getContainer();
    const dpr = (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1);
    const w = el.clientWidth, h = el.clientHeight;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
  }

  /**
   * Accept a canonical AttackEvent (§9.2):
   * {id, src:{lng,lat}, dst:{lng,lat}, color, protocol, spawnedAt, seed}.
   * The geographic choices (unwrap + world copy) happen ONCE here and are
   * frozen for the event's lifetime (D15).
   */
  spawn(event) {
    if (!this.map) return;
    const dstLngUnwrapped = unwrapLongitude(event.src.lng, event.dst.lng);
    const centerLng = this.map.getCenter ? this.map.getCenter().lng : 0;
    const worldCopyOffsetLng = chooseWorldCopy(event.src.lng, dstLngUnwrapped, centerLng);
    if (this.queue.length >= MAX_EVENTS) this.queue.shift();   // drop the OLDEST
    this.queue.push({
      event,
      dstLngUnwrapped,
      worldCopyOffsetLng,
      // bend shape frozen at spawn (like the world copy) so the arc is stable
      // across frames: direction and magnitude both come from the seed (§9.2)
      bendDir: (event.seed % 2) ? 1 : -1,
      bendFactor: bendFactorFromSeed(event.seed),
      spawnedAt: this.clock(),
    });
    this._startLoop();
  }

  clear() {
    this.queue.length = 0;
    if (this.ctx && this.canvas) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._stopLoop();
  }

  _startLoop() {
    if (this._raf || typeof requestAnimationFrame === 'undefined') return;
    if (typeof document !== 'undefined' && document.hidden) return;
    this._raf = requestAnimationFrame(this._tick);
  }

  _stopLoop() {
    if (this._raf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  _tick() {
    this._raf = 0;
    this.renderFrame(this.clock());
    if (this.queue.length && !(typeof document !== 'undefined' && document.hidden)) {
      this._raf = requestAnimationFrame(this._tick);
    }
  }

  /**
   * Draw one frame at absolute time tMs. Explicit for tests (§17.5).
   * Per event: 2 map.project() calls with the FROZEN worldCopyOffsetLng, a
   * bounded screen-space bend, a 24-sample trail, head dot and rings (§9.3/§9.4).
   */
  renderFrame(tMs) {
    if (!this.ctx || !this.map) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // expire (<= 1.4 s lifetime)
    this.queue = this.queue.filter((re) => tMs - re.spawnedAt < LIFETIME_MS);

    for (const re of this.queue) {
      const { event, dstLngUnwrapped, worldCopyOffsetLng, bendDir, bendFactor } = re;
      const t = tMs - re.spawnedAt;

      const S = this.map.project([event.src.lng + worldCopyOffsetLng, event.src.lat]);
      const D = this.map.project([dstLngUnwrapped + worldCopyOffsetLng, event.dst.lat]);
      if (!Number.isFinite(S.x) || !Number.isFinite(S.y) ||
          !Number.isFinite(D.x) || !Number.isFinite(D.y)) continue;   // §9.3 degenerate case

      const color = event.color || '#FF9800';

      // source ring: r 0 -> 50, alpha 1 -> 0, over 0-700 ms
      if (t < TRAVEL_MS) {
        const p = easeCircleIn(t / TRAVEL_MS);
        this._ring(ctx, S, 50 * p, 1 - p, color);
      }

      const dx = D.x - S.x, dy = D.y - S.y;
      const dist = Math.hypot(dx, dy);

      if (dist >= 1) {
        // screen-space quadratic bend (§9.3): direction AND magnitude frozen
        // at spawn from the event seed, amplitude pixel-bounded (D15).
        const bendPx = bendDir * bendPixels(dist, bendFactor);
        const nx = -dy / dist, ny = dx / dist;                 // unit normal
        const C = { x: (S.x + D.x) / 2 + nx * bendPx, y: (S.y + D.y) / 2 + ny * bendPx };

        // Sample the full curve once and accumulate segment lengths: the trail
        // is revealed by ARC LENGTH, exactly like 3.0.1's stroke-dasharray /
        // getPointAtLength animation — not by the Bézier parameter, whose
        // speed is uneven on bent curves.
        const pts = new Array(TRAIL_SAMPLES + 1);
        const cum = new Array(TRAIL_SAMPLES + 1);
        let total = 0;
        for (let i = 0; i <= TRAIL_SAMPLES; i++) {
          pts[i] = quadraticPoint(S, C, D, i / TRAIL_SAMPLES);
          if (i > 0) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
          cum[i] = total;
        }

        if (t < TRAVEL_MS) {
          // travel phase: reveal up to easedProgress * length, head dot at the tip
          const progress = easeCircleIn(Math.min(1, t / TRAVEL_MS));
          const target = progress * total;
          let head = pts[0];
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i <= TRAIL_SAMPLES; i++) {
            if (cum[i] <= target) {
              ctx.lineTo(pts[i].x, pts[i].y);
              head = pts[i];
            } else {
              const seg = cum[i] - cum[i - 1];
              const f = seg > 0 ? (target - cum[i - 1]) / seg : 0;
              head = {
                x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f,
                y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f,
              };
              ctx.lineTo(head.x, head.y);
              break;
            }
          }
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.globalAlpha = 0.8;
          ctx.stroke();
          ctx.globalAlpha = 1;

          // head dot r = 6 at the tip
          ctx.beginPath();
          ctx.arc(head.x, head.y, 6, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
        } else {
          // fade phase (700-1400 ms, 3.0.1 parity): the COMPLETED line stays
          // on screen and fades out (opacity 0.8 -> 0 with d3's default
          // cubicInOut easing); no head dot. This guarantees the arc visibly
          // reaches the destination regardless of frame quantisation.
          const fadeP = Math.min(1, (t - TRAVEL_MS) / (LIFETIME_MS - TRAVEL_MS));
          const alpha = 0.8 * (1 - easeCubicInOut(fadeP));
          if (alpha > 0.01) {
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i <= TRAIL_SAMPLES; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.globalAlpha = alpha;
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
      }

      // impact ring at the destination: 700-1400 ms, r 6 -> 50 (the head dot
      // becomes the ring, as in 3.0.1), alpha 1 -> 0
      if (t >= TRAVEL_MS) {
        const p = (t - TRAVEL_MS) / (LIFETIME_MS - TRAVEL_MS);
        this._ring(ctx, D, 6 + 44 * p, 1 - p, color);
      }
    }
  }

  _ring(ctx, at, r, alpha, color) {
    if (r <= 0 || alpha <= 0) return;
    ctx.beginPath();
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.globalAlpha = alpha;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}
