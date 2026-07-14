// path.ts — the shared Line/Pen spacing engine. Pure, no React.

import type { SnapMode } from "@/lib/dots";
import { getNearestSnap, snapSpacing } from "@/lib/snap";

// Shift-constrain: rounds the drag angle to the nearest 15° so a hand-drawn
// ladder-tail row can land dead straight without fighting hand wobble.
export function constrainAngle15(sx: number, sy: number, ex: number, ey: number): { x: number; y: number } {
  const dist = Math.hypot(ex - sx, ey - sy);
  if (dist < 1e-6) return { x: ex, y: ey };
  const step = Math.PI / 12; // 15°
  const angle = Math.round(Math.atan2(ey - sy, ex - sx) / step) * step;
  return { x: sx + Math.cos(angle) * dist, y: sy + Math.sin(angle) * dist };
}

// Smooth curve through every anchor, via the uniform Catmull-Rom → cubic
// Bézier conversion (each anchor's tangent handle is neighbour-difference/6 —
// the same construction Paper.js's `path.smooth('catmull-rom')` and Figma's
// smoothing use). Critically this never divides by the distance between
// points, so anchors that are close or coincident (adjacent snap points, or
// the cursor hovering over the last anchor during the live rubber-band) can't
// blow the interpolation up into spikes — the bug the earlier centripetal
// version had. Endpoints duplicate the terminal anchor, giving a natural
// non-overshooting end tangent. Tessellating to a dense polyline lets the
// arc-length dot engine (`computePathDots`) walk it as if it were straight.
export const CURVE_SEG = 24; // tessellation segments per anchor span
export function pathPolyline(anchors: { x: number; y: number }[], curved: boolean): { x: number; y: number }[] {
  if (!curved || anchors.length < 3) return anchors;
  const n = anchors.length;
  const out: { x: number; y: number }[] = [anchors[0]];
  for (let i = 0; i < n - 1; i++) {
    const p0 = anchors[i - 1] ?? anchors[i];
    const p1 = anchors[i];
    const p2 = anchors[i + 1];
    const p3 = anchors[i + 2] ?? anchors[i + 1];
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
    for (let s = 1; s <= CURVE_SEG; s++) {
      const t = s / CURVE_SEG, u = 1 - t;
      const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
      out.push({
        x: w0 * p1.x + w1 * c1x + w2 * c2x + w3 * p2.x,
        y: w0 * p1.y + w1 * c1y + w2 * c2y + w3 * p2.y,
      });
    }
  }
  return out;
}

// Cumulative segment lengths along a polyline, plus the total — the shared
// arc-length backbone for both the Line tool's 2-anchor path and the Pen
// tool's N-anchor path (a straight line is just a 2-anchor path).
export function pathLength(anchors: { x: number; y: number }[]): { segs: number[]; total: number } {
  const segs: number[] = [];
  let total = 0;
  for (let i = 0; i < anchors.length - 1; i++) {
    const d = Math.hypot(anchors[i + 1].x - anchors[i].x, anchors[i + 1].y - anchors[i].y);
    segs.push(d); total += d;
  }
  return { segs, total };
}

// Walks a polyline to the point at cumulative arc-length `dist` (clamped to
// the path's ends).
export function pointAtArcLength(
  anchors: { x: number; y: number }[], segs: number[], total: number, dist: number
): { x: number; y: number } {
  if (dist <= 0) return anchors[0];
  if (dist >= total) return anchors[anchors.length - 1];
  let remaining = dist;
  for (let i = 0; i < segs.length; i++) {
    if (remaining <= segs[i]) {
      const t = segs[i] === 0 ? 0 : remaining / segs[i];
      const a = anchors[i], b = anchors[i + 1];
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= segs[i];
  }
  return anchors[anchors.length - 1];
}

// The whole variable-spacing design space is one idea: a DENSITY curve ρ(t)
// over the path (t 0→1) that says how tightly dots pack at each point. Dots
// are then placed at equal steps of the cumulative density (inverse-CDF /
// equal-area sampling) — high density → dots close, low → far apart. Every
// pattern is just a different ρ, so the UI reduces to "pick a shape + how
// much", instead of raw start/step/repeat numbers.
export type SpacingShape = "even" | "ramp" | "taper" | "pulse";
export interface SpacingOpts { shape: SpacingShape; spacing: number; amount: number; count: number; }

// ρ(t) ≥ ε for each shape. `a` ∈ [-1,1] is the intensity (sign flips
// direction for ramp/taper); `count` is the cluster count for pulse.
export function densityAt(shape: SpacingShape, t: number, a: number, count: number): number {
  switch (shape) {
    case "ramp":  return Math.max(0.05, 1 + a * 1.9 * (0.5 - t));            // a>0 dense start
    case "taper": return Math.max(0.1, 1 - a * 0.9 * Math.cos(2 * Math.PI * t)); // a>0 dense centre
    case "pulse": return Math.max(0.1, 1 + Math.abs(a) * 0.9 * Math.cos(2 * Math.PI * Math.max(1, count) * t)); // clusters
    default:      return 1; // even
  }
}

// Places dots along an N-anchor polyline (a straight drag is just a 2-anchor
// path). Dot count comes from the average `spacing`; their positions from the
// shape's density curve. Distances are measured continuously along the whole
// path (not reset per segment), and every sampled point is snapped back onto
// the active snap mode's lattice — deduped by key, so a very short path
// collapses to just its start.
//
// GAP-SPACE: the density curve is realized as whole-lattice-step GAPS, never
// as continuous positions snapped afterward — that variant looks even and
// must not come back. A density curve computed in
// px-space produces fractional gaps (e.g. 14px on a 20px lattice); snapping
// each position to the coarse lattice independently then quantizes the
// variation away (worst case `corner` mode + small spacing → average gap is
// already one lattice step, the tightest possible, so ramp/taper collapse to
// perfectly even). Instead we integrate the density to a CDF, invert it in
// STEP space (path length measured in whole `base` steps), and round to a
// monotonic integer step sequence (each gap ≥ 1 step). Dots therefore always
// land on the active-mode lattice AND the variation always survives — the only
// cost is a mild ±1-step jitter on very gentle ramps, which is inherent to
// representing a slowly-varying fractional gap on a whole-step grid.
export function computePathDots(
  anchors: { x: number; y: number }[],
  cellSize: number, snapMode: SnapMode, canvasW: number, canvasH: number,
  o: SpacingOpts
): { key: string; x: number; y: number }[] {
  if (anchors.length === 0) return [];
  if (anchors.length === 1) {
    const snap = getNearestSnap(anchors[0].x, anchors[0].y, cellSize, snapMode, canvasW, canvasH);
    return snap ? [snap] : [];
  }
  const { segs, total } = pathLength(anchors);
  const base = snapSpacing(snapMode);
  const N = Math.max(1, Math.round((total / base) / Math.max(1, o.spacing)));

  // Arc-length distances (px) for each of the N+1 dots.
  const targets: number[] = [];
  if (o.shape === "even" || total <= 0) {
    for (let i = 0; i <= N; i++) targets.push((i / N) * total);
  } else {
    // Total path budget in whole lattice steps.
    const L = Math.max(1, Math.round(total / base));
    // Sample the density, integrate to a CDF, invert it to get each dot's
    // position in [0,L] step-space, then round to a monotonic integer step
    // index with every gap forced ≥ 1 step (so no two dots collapse and the
    // sequence never goes backwards).
    const S = 256;
    const cdf = new Float64Array(S + 1);
    let acc = 0;
    for (let s = 0; s < S; s++) { acc += densityAt(o.shape, (s + 0.5) / S, o.amount, o.count); cdf[s + 1] = acc; }
    const totalDen = cdf[S] || 1;
    let lo = 0, prevIdx = -1;
    for (let i = 0; i <= N; i++) {
      const tc = (i / N) * totalDen;
      while (lo < S && cdf[lo + 1] < tc) lo++;
      const c0 = cdf[lo], c1 = cdf[lo + 1];
      const frac = c1 > c0 ? (tc - c0) / (c1 - c0) : 0;
      let idx = Math.round(((lo + frac) / S) * L);
      if (idx <= prevIdx) idx = prevIdx + 1; // keep gaps ≥ 1 step, monotonic
      prevIdx = idx;
      targets.push(Math.min(idx * base, total));
    }
  }

  const seen = new Set<string>();
  const out: { key: string; x: number; y: number }[] = [];
  for (const dist of targets) {
    const p = pointAtArcLength(anchors, segs, total, dist);
    const snap = getNearestSnap(p.x, p.y, cellSize, snapMode, canvasW, canvasH);
    if (snap && !seen.has(snap.key)) { seen.add(snap.key); out.push(snap); }
  }
  return out;
}
