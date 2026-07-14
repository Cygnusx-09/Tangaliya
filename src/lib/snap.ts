// snap.ts — the half-cell/sub-grid snap lattice math. Pure, no React.

import { CELL_SIZE, HALF_CELL, getKey, GRID_SUBDIV, FINE_CELL, getFineKey, type SnapMode } from "@/lib/dots";

// GRID_SUBDIV/FINE_CELL/getFineKey now live in dots.ts (the base module with
// no lib-internal dependencies) — buildDotsFromImage/buildDotsFromText need
// them too, and snap.ts already depends on dots.ts, so this avoids a cycle.
// Re-exported here so existing imports of these three from "@/lib/snap"
// don't need to change.
export { GRID_SUBDIV, FINE_CELL, getFineKey };

// The lattice step size a given snap mode places/moves dots on.
export function snapSpacing(mode: SnapMode): number {
  return mode === "fine" ? FINE_CELL : mode === "both" ? HALF_CELL : CELL_SIZE;
}

// Absolute minimum-distance gate: true if (x,y) is at least minDistPx away
// from every dot already in `dots`. Used to enforce the global "Min. Spacing"
// setting across every placement path (draw, brush walk, line/pen/shape,
// hand-draw) regardless of which snap mode or spacing model produced the
// candidate point.
export function farEnough(x: number, y: number, dots: Map<string, { x: number; y: number }>, minDistPx: number): boolean {
  if (minDistPx <= 0) return true;
  for (const d of dots.values()) {
    if (Math.hypot(d.x - x, d.y - y) < minDistPx) return false;
  }
  return true;
}

// Same greedy "first dot wins" rule as farEnough (raster scan order, since
// Map iteration = insertion order = the grid's own scan order), but bucketed
// into a spatial hash instead of a brute O(n²) scan — a bulk image import at
// fine detail can produce 10^5-10^6 candidate dots, where farEnough's linear
// scan per candidate would be far too slow for a live-scrubbed preview.
export function filterMinSpacing<T extends { x: number; y: number }>(dots: Map<string, T>, minDistPx: number): Map<string, T> {
  if (minDistPx <= 0) return dots;
  const cell = minDistPx;
  const buckets = new Map<string, { x: number; y: number }[]>();
  const out = new Map<string, T>();
  for (const [key, dot] of dots) {
    const bx = Math.floor(dot.x / cell), by = Math.floor(dot.y / cell);
    let clear = true;
    for (let dx = -1; dx <= 1 && clear; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = buckets.get(`${bx + dx},${by + dy}`);
        if (!bucket) continue;
        if (bucket.some((p) => Math.hypot(p.x - dot.x, p.y - dot.y) < minDistPx)) { clear = false; break; }
      }
    }
    if (!clear) continue;
    out.set(key, dot);
    const bk = `${bx},${by}`;
    const bucket = buckets.get(bk);
    if (bucket) bucket.push(dot); else buckets.set(bk, [dot]);
  }
  return out;
}

// Canvas-bounds gate (edges inclusive — x = 0 and x = canvasW are real snap
// points). getNearestSnap and computePathDots enforce this internally; the
// paths that place via the unbounded keyFromPosition (array, paste) gate
// through this instead.
export function inBounds(x: number, y: number, canvasW: number, canvasH: number): boolean {
  return x >= 0 && x <= canvasW && y >= 0 && y <= canvasH;
}

// Clamp a lattice-aligned move offset (drag / arrow-nudge) so the selection's
// bounding box stays inside the canvas — the selection stops flush at the
// wall as a unit instead of dots leaking past the edge. Clamps in whole
// `spacing` steps so the result stays lattice-aligned, and never forces a
// move: if the selection already pokes outside (legacy data), staying put is
// always allowed.
export function clampOffsetToCanvas(
  dx: number, dy: number,
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  canvasW: number, canvasH: number, spacing: number
): { dx: number; dy: number } {
  const dxMin = Math.min(0, -Math.floor(bbox.minX / spacing) * spacing);
  const dxMax = Math.max(0, Math.floor((canvasW - bbox.maxX) / spacing) * spacing);
  const dyMin = Math.min(0, -Math.floor(bbox.minY / spacing) * spacing);
  const dyMax = Math.max(0, Math.floor((canvasH - bbox.maxY) / spacing) * spacing);
  return { dx: Math.min(dxMax, Math.max(dxMin, dx)), dy: Math.min(dyMax, Math.max(dyMin, dy)) };
}

export function getNearestSnap(
  mx: number, my: number, cellSize: number, snapMode: SnapMode, canvasW: number, canvasH: number
): { key: string; x: number; y: number } | null {
  if (snapMode === "fine") {
    const col = Math.round(mx / FINE_CELL);
    const row = Math.round(my / FINE_CELL);
    const x = col * FINE_CELL, y = row * FINE_CELL;
    if (x < 0 || x > canvasW || y < 0 || y > canvasH) return null;
    return { key: getFineKey(col, row), x, y };
  }
  const half = cellSize / 2;
  const col = Math.floor(mx / cellSize);
  const row = Math.floor(my / cellSize);
  const candidates: { key: string; x: number; y: number }[] = [];

  // Corners (4 per cell — grid intersections)
  if (snapMode !== "center") {
    for (let dc = 0; dc <= 1; dc++)
      for (let dr = 0; dr <= 1; dr++)
        candidates.push({ key: getKey((col + dc) * 2, (row + dr) * 2), x: (col + dc) * cellSize, y: (row + dr) * cellSize });
  }

  // Center (1 per cell)
  if (snapMode !== "corner")
    candidates.push({ key: getKey(col * 2 + 1, row * 2 + 1), x: col * cellSize + half, y: row * cellSize + half });

  // Edge midpoints (4 per cell — only in "both" mode)
  if (snapMode === "both") {
    // Top edge
    candidates.push({ key: getKey(col * 2 + 1, row * 2), x: col * cellSize + half, y: row * cellSize });
    // Bottom edge
    candidates.push({ key: getKey(col * 2 + 1, (row + 1) * 2), x: col * cellSize + half, y: (row + 1) * cellSize });
    // Left edge
    candidates.push({ key: getKey(col * 2, row * 2 + 1), x: col * cellSize, y: row * cellSize + half });
    // Right edge
    candidates.push({ key: getKey((col + 1) * 2, row * 2 + 1), x: (col + 1) * cellSize, y: row * cellSize + half });
  }

  // Filter to canvas bounds
  const inBounds = candidates.filter(c => c.x >= 0 && c.x <= canvasW && c.y >= 0 && c.y <= canvasH);
  if (inBounds.length === 0) return null;
  return inBounds.reduce((n, c) => Math.hypot(c.x - mx, c.y - my) < Math.hypot(n.x - mx, n.y - my) ? c : n);
}

// Reflects an already-snapped point across the canvas center and re-snaps
// each reflection (rather than mirroring the coordinate arithmetically) so
// mirrored dots always land on a real grid point in the current snap mode,
// even when the canvas isn't an exact multiple of the cell size.
export function mirrorSnaps(
  x: number, y: number, canvasW: number, canvasH: number, snapMode: SnapMode, mirrorX: boolean, mirrorY: boolean
): { key: string; x: number; y: number }[] {
  const out: { key: string; x: number; y: number }[] = [];
  if (mirrorX) {
    const s = getNearestSnap(canvasW - x, y, CELL_SIZE, snapMode, canvasW, canvasH);
    if (s) out.push(s);
  }
  if (mirrorY) {
    const s = getNearestSnap(x, canvasH - y, CELL_SIZE, snapMode, canvasW, canvasH);
    if (s) out.push(s);
  }
  if (mirrorX && mirrorY) {
    const s = getNearestSnap(canvasW - x, canvasH - y, CELL_SIZE, snapMode, canvasW, canvasH);
    if (s) out.push(s);
  }
  return out;
}

export function keyFromPosition(x: number, y: number, spacing: number = HALF_CELL): { key: string; x: number; y: number } {
  const col = Math.round(x / spacing);
  const row = Math.round(y / spacing);
  const snappedX = col * spacing, snappedY = row * spacing;
  const key = spacing === FINE_CELL ? getFineKey(col, row) : getKey(Math.round(snappedX / HALF_CELL), Math.round(snappedY / HALF_CELL));
  return { key, x: snappedX, y: snappedY };
}
