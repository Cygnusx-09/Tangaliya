// snap.ts — the half-cell/sub-grid snap lattice math, extracted verbatim from
// DotArtTool.tsx (module scope, no React/ref coupling — see ARCHITECTURE.md).

import { CELL_SIZE, HALF_CELL, getKey, type SnapMode } from "@/lib/dots";

// Graph-paper minor lines: how many subdivisions per cell. 5 = classic
// geography/engineering paper (5 small squares between bold cell lines).
// 10 = millimeter-paper density. Also doubles as the resolution of "Sub-grid"
// snap mode below — the two are deliberately the same number so dots in that
// mode land exactly on the visible minor lines.
export const GRID_SUBDIV = 10;
// One subdivision cell — the lattice step for "Sub-grid" snap mode.
export const FINE_CELL = CELL_SIZE / GRID_SUBDIV;
// Sub-grid points live on a finer lattice than the half-cell one every other
// snap mode uses, so they get their own key namespace ("f:col,row") — this
// guarantees they can never collide with an existing half-cell key even
// though both are just small integer pairs.
export function getFineKey(fc: number, fr: number) {
  return `f:${fc},${fr}`;
}
// The lattice step size a given snap mode places/moves dots on.
export function snapSpacing(mode: SnapMode): number {
  return mode === "fine" ? FINE_CELL : mode === "both" ? HALF_CELL : CELL_SIZE;
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
