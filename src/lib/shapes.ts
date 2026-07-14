// shapes.ts — dot-rendering shape (bar/circle) + the Shape tool's primitives
// (ellipse/rect/diamond/triangle/polygon outline+fill). Pure, no React.

import { HALF_CELL, getKey, type SnapMode } from "@/lib/dots";
import { FINE_CELL, getFineKey } from "@/lib/snap";

// How a placed dot is drawn (position/snapping is identical either way).
// "bar" is a 1.5:1 rounded rectangle — width 1.5× its height.
export type DotShape = "circle" | "bar";
export function barRect(x: number, y: number, r: number) {
  const h = r * 1.5, w = h * 1.5;
  return { x: x - w / 2, y: y - h / 2, w, h, rx: h * 0.4 };
}

// ── Shape tool: dotted ellipse (the Tangaliya lens/spindle motif) ────────────
// An outline is just a closed path, so it reuses `computePathDots` (same
// gap-space spacing engine as Line/Pen — Ramp/Taper/Pulse distribute the beads
// around the perimeter). Fill enumerates every grid snap point inside.

// Closed polyline approximating an ellipse (last point == first, so the
// arc-length walk in computePathDots treats it as a loop).
export function ellipsePolyline(cx: number, cy: number, rx: number, ry: number, segments = 180): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return pts;
}

// Every grid snap point whose center lies inside the ellipse — a solid,
// grid-aligned fill (cleaner than concentric rings: no moiré gaps). Bounded to
// the ellipse bbox for speed, and uses the same center-anchored parity as
// `generateGridPoints` so the keys line up with the rest of the tool.
export function gridPointsInEllipse(
  cx: number, cy: number, rx: number, ry: number,
  snapMode: SnapMode, canvasW: number, canvasH: number
): { key: string; x: number; y: number }[] {
  if (rx <= 0 || ry <= 0) return [];
  const out: { key: string; x: number; y: number }[] = [];
  const fine = snapMode === "fine";
  const step = fine ? FINE_CELL : HALF_CELL;
  const maxHC = Math.round(canvasW / HALF_CELL), maxHR = Math.round(canvasH / HALF_CELL);
  const oc = Math.round(maxHC / 2), or = Math.round(maxHR / 2);
  const i0 = Math.max(0, Math.floor((cx - rx) / step)), i1 = Math.ceil((cx + rx) / step);
  const j0 = Math.max(0, Math.floor((cy - ry) / step)), j1 = Math.ceil((cy + ry) / step);
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const x = i * step, y = j * step;
      if (x < 0 || x > canvasW || y < 0 || y > canvasH) continue;
      const nx = (x - cx) / rx, ny = (y - cy) / ry;
      if (nx * nx + ny * ny > 1) continue;
      if (fine) { out.push({ key: getFineKey(i, j), x, y }); continue; }
      const cEven = (i - oc) % 2 === 0, rEven = (j - or) % 2 === 0;
      if (snapMode === "corner" && !(cEven && rEven)) continue;
      if (snapMode === "center" && !(!cEven && !rEven)) continue;
      out.push({ key: getKey(i, j), x, y });
    }
  }
  return out;
}

export type ShapeKind = "ellipse" | "rect" | "diamond" | "triangle" | "polygon";

// Closed vertex list (last == first) for a shape inscribed in the bbox centered
// at (cx,cy) with half-extents rx,ry. Every shape reduces to a closed polyline,
// so outline reuses `computePathDots` and fill reuses `gridPointsInPolygon`.
export function shapeVertices(kind: ShapeKind, cx: number, cy: number, rx: number, ry: number, sides: number): { x: number; y: number }[] {
  switch (kind) {
    case "rect":
      return [{ x: cx - rx, y: cy - ry }, { x: cx + rx, y: cy - ry }, { x: cx + rx, y: cy + ry }, { x: cx - rx, y: cy + ry }, { x: cx - rx, y: cy - ry }];
    case "diamond":
      return [{ x: cx, y: cy - ry }, { x: cx + rx, y: cy }, { x: cx, y: cy + ry }, { x: cx - rx, y: cy }, { x: cx, y: cy - ry }];
    case "triangle":
      return [{ x: cx, y: cy - ry }, { x: cx + rx, y: cy + ry }, { x: cx - rx, y: cy + ry }, { x: cx, y: cy - ry }];
    case "polygon": {
      const n = Math.max(3, Math.round(sides));
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i <= n; i++) {
        const a = -Math.PI / 2 + (i / n) * Math.PI * 2; // pointing up
        pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
      }
      return pts;
    }
    default:
      return ellipsePolyline(cx, cy, rx, ry);
  }
}

// Even-odd point-in-polygon (ray cast). `verts` may be closed (last == first);
// the wrapping edge is harmless.
export function pointInPolygon(px: number, py: number, verts: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const xi = verts[i].x, yi = verts[i].y, xj = verts[j].x, yj = verts[j].y;
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// Solid grid-aligned fill for an arbitrary polygon — same bbox scan + snap-mode
// parity as `gridPointsInEllipse`, but with a polygon inside-test.
export function gridPointsInPolygon(
  verts: { x: number; y: number }[], snapMode: SnapMode, canvasW: number, canvasH: number
): { key: string; x: number; y: number }[] {
  if (verts.length < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of verts) { minX = Math.min(minX, v.x); minY = Math.min(minY, v.y); maxX = Math.max(maxX, v.x); maxY = Math.max(maxY, v.y); }
  const out: { key: string; x: number; y: number }[] = [];
  const fine = snapMode === "fine";
  const step = fine ? FINE_CELL : HALF_CELL;
  const maxHC = Math.round(canvasW / HALF_CELL), maxHR = Math.round(canvasH / HALF_CELL);
  const oc = Math.round(maxHC / 2), or = Math.round(maxHR / 2);
  const i0 = Math.max(0, Math.floor(minX / step)), i1 = Math.ceil(maxX / step);
  const j0 = Math.max(0, Math.floor(minY / step)), j1 = Math.ceil(maxY / step);
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const x = i * step, y = j * step;
      if (x < 0 || x > canvasW || y < 0 || y > canvasH) continue;
      if (!pointInPolygon(x, y, verts)) continue;
      if (fine) { out.push({ key: getFineKey(i, j), x, y }); continue; }
      const cEven = (i - oc) % 2 === 0, rEven = (j - or) % 2 === 0;
      if (snapMode === "corner" && !(cEven && rEven)) continue;
      if (snapMode === "center" && !(!cEven && !rEven)) continue;
      out.push({ key: getKey(i, j), x, y });
    }
  }
  return out;
}

export function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
