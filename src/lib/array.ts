// array.ts — the Array tool's pure geometry: motif-repetition transforms
// (linear/grid/curve) and the shared placement pipeline that turns a motif +
// transform list into real, lattice-snapped, min-spacing-gated dots. No
// React/ref coupling — see ARCHITECTURE.md.

import type { Dot } from "@/lib/dots";
import { HALF_CELL } from "@/lib/dots";
import { keyFromPosition, inBounds, SpatialHash, farEnoughFast } from "@/lib/snap";
import { pathPolyline, pathLength, pointAtArcLength } from "@/lib/path";

export type ArrayMode = "linear" | "grid" | "curve";

// A transform is relative to the motif's pivot: rotate the motif by `rot`
// around the pivot, then translate by (dx,dy). See applyMotifTransform.
export interface Transform { dx: number; dy: number; rot: number; }

export interface LinearArrayOptions { angleDeg: number; count: number; spacing: number; centered: boolean; }
export interface GridArrayOptions { rows: number; cols: number; spacingX: number; spacingY: number; rowOffsetPct: number; centered: boolean; }
export interface CurveArrayOptions {
  anchors: { x: number; y: number }[];
  curved: boolean;
  count: number;
  spacing: number;
  alignToCurve: boolean;
}

// Bounding-box center of a set of points — the pivot every mode rotates
// around and (for Curve mode) measures placement from.
export function motifPivot(pts: { x: number; y: number }[]): { x: number; y: number } {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

// Corner (default): index 0 is always {dx:0,dy:0,rot:0} — the pivot stays
// put, instance 0 IS the motif's current position, and the array fans out
// along a ray at angleDeg from there (only "forward" along that ray — with
// angleDeg=0 that reads as "grows right", which is the whole reason Center
// exists below). Center: the motif's position becomes the MIDDLE of the
// array — offsets run from -(count-1)/2 to +(count-1)/2 steps, so it spreads
// both ways along the ray (e.g. angleDeg=0 grows left AND right).
export function computeLinearInstances(o: LinearArrayOptions): Transform[] {
  const rad = (o.angleDeg * Math.PI) / 180;
  const offset = o.centered ? (o.count - 1) / 2 : 0;
  const out: Transform[] = [];
  for (let i = 0; i < o.count; i++) {
    const d = (i - offset) * o.spacing;
    out.push({ dx: Math.cos(rad) * d, dy: Math.sin(rad) * d, rot: 0 });
  }
  return out;
}

// Corner (default): row-major, index 0 (row0,col0) is always
// {dx:0,dy:0,rot:0} — the grid only grows right+down from the motif. Center:
// the motif's cell becomes the middle of the grid, so it spreads on all 4
// sides. Odd rows (by their ORIGINAL, not centered, row index — keeps the
// brick coursing pattern identical either way) shift by rowOffsetPct% of
// spacingX — 0% = plain grid, 50% = classic brick coursing.
export function computeGridInstances(o: GridArrayOptions): Transform[] {
  const colOffset = o.centered ? (o.cols - 1) / 2 : 0;
  const rowOffset = o.centered ? (o.rows - 1) / 2 : 0;
  const out: Transform[] = [];
  for (let r = 0; r < o.rows; r++) {
    const rowShift = (r % 2) * (o.rowOffsetPct / 100) * o.spacingX;
    for (let c = 0; c < o.cols; c++) {
      out.push({ dx: (c - colOffset) * o.spacingX + rowShift, dy: (r - rowOffset) * o.spacingY, rot: 0 });
    }
  }
  return out;
}

// Walks the drawn curve at a constant arc-length step (spacing), starting
// from the curve's first anchor. dist is clamped to the curve's ends by
// pointAtArcLength, so instances that overrun the curve length pile up (and
// later dedupe) at the endpoint. Index 0 here is the curve's START POINT, not
// the motif's original on-canvas position — the original motif is left in
// place untouched by the caller (nothing in this app implicitly deletes
// dots); this mode adds N new stamped copies alongside it.
export function computeCurveInstances(pivot: { x: number; y: number }, o: CurveArrayOptions): Transform[] {
  if (o.anchors.length < 2) return [];
  const poly = pathPolyline(o.anchors, o.curved);
  const { segs, total } = pathLength(poly);
  const eps = Math.max(1, o.spacing * 0.05);
  const out: Transform[] = [];
  for (let i = 0; i < o.count; i++) {
    const dist = i * o.spacing;
    const p = pointAtArcLength(poly, segs, total, dist);
    let rot = 0;
    if (o.alignToCurve) {
      const p0 = pointAtArcLength(poly, segs, total, Math.max(0, dist - eps));
      const p1 = pointAtArcLength(poly, segs, total, Math.min(total, dist + eps));
      rot = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    }
    out.push({ dx: p.x - pivot.x, dy: p.y - pivot.y, rot });
  }
  return out;
}

// Rotate each motif dot around `pivot` by t.rot, then translate by (t.dx,
// t.dy). Returns new Dot positions — key/color/radius carried through
// unchanged, NOT yet re-keyed/re-snapped (the caller's job, via
// keyFromPosition — see computeArrayPlacements).
export function applyMotifTransform(motif: Dot[], pivot: { x: number; y: number }, t: Transform): Dot[] {
  const cos = Math.cos(t.rot), sin = Math.sin(t.rot);
  return motif.map((d) => {
    const rx = d.x - pivot.x, ry = d.y - pivot.y;
    return {
      ...d,
      x: pivot.x + rx * cos - ry * sin + t.dx,
      y: pivot.y + rx * sin + ry * cos + t.dy,
    };
  });
}

// The shared placement pipeline for BOTH the live preview and the real
// commit, so what the user sees is exactly what gets written: for every
// transform, rotate+translate a copy of the motif, snap each dot to the
// active lattice, and gate it through the app-wide min-spacing floor exactly
// like every other placement path (commitLineDots, draw, brush).
// `existing` is read AND incrementally extended as the batch builds, so
// already-placed instances within this same array batch also count against
// the floor, not just pre-existing canvas dots. Dedupes by key. Returns only
// the newly-touched entries (not merged with `existing`).
//
// This is the LIVE PREVIEW's pipeline too — it reruns on every slider tweak,
// not just on Apply — so it can't afford to clone `existing` (a full Map
// copy) or brute-scan it per candidate the way farEnough does; both are O(n)
// per call/candidate and `existing` can be a canvas's entire dot count.
// Spatially indexed instead: one O(n) hash build per call (same order as the
// clone it replaces, but only once, not per candidate), then each candidate's
// spacing check is a narrow hash query. New placements are inserted into the
// same hash as they're accepted, so within-batch spacing keeps working
// exactly like the old `working` map did.
export function computeArrayPlacements(
  motif: Dot[],
  transforms: Transform[],
  existing: Map<string, { x: number; y: number }>,
  spacing: number,
  minDistPx: number,
  canvasW: number,
  canvasH: number
): Map<string, Dot> {
  if (motif.length === 0 || transforms.length === 0) return new Map();
  const pivot = motifPivot(motif);
  const placed = new Map<string, Dot>();
  const hash = new SpatialHash<{ x: number; y: number }>(Math.max(minDistPx, HALF_CELL));
  hash.build(existing.values());
  for (const t of transforms) {
    for (const d of applyMotifTransform(motif, pivot, t)) {
      const pos = keyFromPosition(d.x, d.y, spacing);
      if (!inBounds(pos.x, pos.y, canvasW, canvasH)) continue;
      const alreadyPlaced = existing.has(pos.key) || placed.has(pos.key);
      if (!alreadyPlaced && !farEnoughFast(hash, pos.x, pos.y, minDistPx)) continue;
      const dot: Dot = { ...d, key: pos.key, x: pos.x, y: pos.y };
      if (!alreadyPlaced) hash.insert({ x: pos.x, y: pos.y });
      placed.set(pos.key, dot);
    }
  }
  return placed;
}
