// Shared dot-grid model + image/text → dots conversion. Used by the main editor
// (DotArtTool) and the standalone full-screen image tool. Pure, no React.

export type SnapMode = "both" | "corner" | "center";

export interface Dot {
  key: string;
  x: number;
  y: number;
  color: string;
  radius: number;
}

export const CELL_SIZE = 20;
export const HALF_CELL = CELL_SIZE / 2;

export function getKey(halfCol: number, halfRow: number) {
  return `${halfCol},${halfRow}`;
}

// Enumerate EVERY snap point across the canvas. corner = even/even half-cells,
// center = odd/odd, "both" = the full half-cell lattice.
export function generateGridPoints(
  snapMode: SnapMode, canvasW: number, canvasH: number
): { key: string; x: number; y: number }[] {
  const pts: { key: string; x: number; y: number }[] = [];
  const maxHC = Math.round(canvasW / HALF_CELL);
  const maxHR = Math.round(canvasH / HALF_CELL);
  for (let hc = 0; hc <= maxHC; hc++) {
    for (let hr = 0; hr <= maxHR; hr++) {
      const cEven = hc % 2 === 0, rEven = hr % 2 === 0;
      if (snapMode === "corner" && !(cEven && rEven)) continue;
      if (snapMode === "center" && !(!cEven && !rEven)) continue;
      pts.push({ key: getKey(hc, hr), x: hc * HALF_CELL, y: hr * HALF_CELL });
    }
  }
  return pts;
}

export function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

// Canvas dimensions that match an image's aspect ratio. The grid resolution is
// set by the cell size: longCells = long-edge physical length / cell size, so a
// smaller cell → more cells → finer grid (the artwork's real size stays put).
export function computeImportDims(iw: number, ih: number, longPhys: number, cellPhysical: number) {
  const longCells = Math.max(1, Math.round(longPhys / cellPhysical));
  const a = iw / ih;
  const cols = a >= 1 ? longCells : Math.max(1, Math.round(longCells * a));
  const rows = a >= 1 ? Math.max(1, Math.round(longCells / a)) : longCells;
  return {
    cols, rows,
    pxW: cols * CELL_SIZE, pxH: rows * CELL_SIZE,
    physW: +(cols * cellPhysical).toFixed(2), physH: +(rows * cellPhysical).toFixed(2),
  };
}

// Sample an image on the grid into editable dots. style: "color" (image RGB) |
// "mono" (one color) | "tonal" (grayscale halftone, dot SIZE follows brightness).
export function buildDotsFromImage(
  bitmap: ImageBitmap, w: number, h: number,
  opts: { style: "color" | "mono" | "tonal"; threshold: number; dotRadius: number; snapMode: SnapMode; monoColor: string; tonalColor?: boolean }
): Map<string, Dot> {
  const SIZE_GAMMA = 1.6, MIN_DOT = 0.12;
  const W = Math.round(w), H = Math.round(h);
  const out = new Map<string, Dot>();
  if (W <= 0 || H <= 0) return out;

  const off = document.createElement("canvas");
  off.width = W; off.height = H;
  const ctx = off.getContext("2d", { willReadFrequently: true });
  if (!ctx) return out;

  // Cover-fit (center-crop) so the image fills the canvas without stretching.
  const iw = bitmap.width, ih = bitmap.height;
  const scale = Math.max(W / iw, H / ih);
  ctx.drawImage(bitmap, (W - iw * scale) / 2, (H - ih * scale) / 2, iw * scale, ih * scale);
  const data = ctx.getImageData(0, 0, W, H).data;

  for (const p of generateGridPoints(opts.snapMode, W, H)) {
    const sx = Math.min(W - 1, Math.max(0, Math.round(p.x)));
    const sy = Math.min(H - 1, Math.max(0, Math.round(p.y)));
    const i = (sy * W + sx) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (opts.style === "tonal") {
      const ink = 1 - lum;
      if (ink < opts.threshold) continue;        // skip highlights
      const gray = Math.round(lum * 255);
      const color = opts.tonalColor ? rgbToHex(r, g, b) : rgbToHex(gray, gray, gray);
      out.set(p.key, { key: p.key, x: p.x, y: p.y, color,
        radius: opts.dotRadius * (MIN_DOT + (1 - MIN_DOT) * Math.pow(ink, SIZE_GAMMA)) });
    } else {
      if (lum > opts.threshold) continue;         // skip light/background
      const color = opts.style === "color" ? rgbToHex(r, g, b) : opts.monoColor;
      out.set(p.key, { key: p.key, x: p.x, y: p.y, color, radius: opts.dotRadius });
    }
  }
  return out;
}

// Deterministic 0..1 hash for a lattice cell — stable scatter across re-renders.
export function hash01(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// Rasterized text → dots with a halftone DISSOLVE: dots are solid inside the
// letters and shrink + scatter outward at the edges. The scatter is a coverage
// field (text alpha, box-averaged on the half-cell lattice) blurred outward;
// each grid point is placed by probability and sized by that field. Dots stay
// on the lattice (deterministic hash) so they remain snapped/editable. Pure.
export function buildDotsFromText(
  src: CanvasImageSource & { width: number; height: number }, w: number, h: number,
  opts: { style: "color" | "mono" | "tonal"; threshold: number; dotRadius: number; snapMode: SnapMode; textColor: string; monoColor: string; scatter: number }
): Map<string, Dot> {
  const W = Math.round(w), H = Math.round(h);
  const out = new Map<string, Dot>();
  if (W <= 0 || H <= 0) return out;

  const off = document.createElement("canvas");
  off.width = W; off.height = H;
  const ctx = off.getContext("2d", { willReadFrequently: true });
  if (!ctx) return out;

  // Contain-fit (aspect already matches the canvas, so this fills without crop).
  const iw = src.width, ih = src.height;
  const s = Math.min(W / iw, H / ih);
  ctx.drawImage(src, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s);
  const data = ctx.getImageData(0, 0, W, H).data;

  // Coverage field on the full half-cell lattice: average text alpha over a
  // cell-sized box around each lattice point.
  const cols = Math.round(W / HALF_CELL) + 1;
  const rows = Math.round(H / HALF_CELL) + 1;
  const field = new Float32Array(cols * rows);
  const rad = Math.max(1, Math.round(HALF_CELL / 2));
  for (let c = 0; c < cols; c++) {
    for (let rW = 0; rW < rows; rW++) {
      const px = c * HALF_CELL, py = rW * HALF_CELL;
      let sum = 0, n = 0;
      for (let dx = -rad; dx <= rad; dx += 2) {
        for (let dy = -rad; dy <= rad; dy += 2) {
          const sx = px + dx, sy = py + dy;
          if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
          sum += data[(sy * W + sx) * 4 + 3]; n++;       // alpha
        }
      }
      field[c * rows + rW] = n ? sum / (n * 255) : 0;
    }
  }

  // Blur outward `scatter` passes (neighbour average) → the dissolve halo.
  let buf = field;
  const passes = Math.round(scatterToPasses(opts.scatter));
  for (let p = 0; p < passes; p++) {
    const nb = new Float32Array(cols * rows);
    for (let c = 0; c < cols; c++) for (let rW = 0; rW < rows; rW++) {
      let sum = 0, n = 0;
      for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) {
        const cc = c + dc, rr = rW + dr;
        if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
        sum += buf[cc * rows + rr]; n++;
      }
      nb[c * rows + rW] = sum / n;
    }
    buf = nb;
  }

  const SIZE_GAMMA = 1.6, MIN_DOT = 0.12;
  const CORE = 0.6, low = 0.04 + opts.threshold * 0.5;   // density slider lifts the floor
  for (const pt of generateGridPoints(opts.snapMode, W, H)) {
    const c = Math.round(pt.x / HALF_CELL), rW = Math.round(pt.y / HALF_CELL);
    const f = buf[c * rows + rW] || 0;
    if (f <= low) continue;
    let radius: number;
    if (f >= CORE) {
      radius = opts.dotRadius;                            // solid letter core
    } else {
      const t = (f - low) / (CORE - low);                // 0..1 across the fringe
      if (hash01(c, rW) > t) continue;                   // probabilistic scatter
      radius = opts.dotRadius * (MIN_DOT + (1 - MIN_DOT) * t);
    }
    const color = opts.style === "tonal"
      ? (() => { const g = Math.round((1 - Math.min(1, f)) * 255); return rgbToHex(g, g, g); })()
      : opts.style === "mono" ? opts.monoColor : opts.textColor;
    out.set(pt.key, { key: pt.key, x: pt.x, y: pt.y, color, radius });
  }
  return out;
}

// Scatter slider (0..1) → blur passes (0..10). Wider = softer dissolve.
export function scatterToPasses(scatter: number): number {
  return Math.max(0, Math.min(10, scatter * 10));
}

// Rasterize multi-line text (white on transparent) onto a tight canvas, in the
// given loaded font family (or a system fallback). High raster size — the final
// scale comes from the grid, not here. Returns null for empty text.
export function renderTextCanvas(text: string, fontFamily: string | null): HTMLCanvasElement | null {
  const lines = text.split("\n");
  if (lines.every((l) => l.trim() === "")) return null;
  const FS = 256, lineH = FS * 1.12, pad = FS * 0.18;
  const font = `${FS}px ${fontFamily ? `"${fontFamily}", ` : ""}sans-serif`;
  const meas = document.createElement("canvas").getContext("2d")!;
  meas.font = font;
  const widths = lines.map((l) => meas.measureText(l).width);
  const blockW = Math.ceil(Math.max(1, ...widths) + pad * 2);
  const blockH = Math.ceil(lines.length * lineH + pad * 2);
  const cv = document.createElement("canvas");
  cv.width = blockW; cv.height = blockH;
  const ctx = cv.getContext("2d")!;
  ctx.font = font;
  ctx.textBaseline = "top";
  ctx.fillStyle = "#fff";
  lines.forEach((l, i) => ctx.fillText(l, pad, pad + i * lineH));
  return cv;
}
