// Shared dot-grid model + image/text → dots conversion. Used by the main editor
// (DotArtTool) and the standalone full-screen image tool. Pure, no React.

export type SnapMode = "both" | "corner" | "center" | "fine";

export interface Dot {
  key: string;
  x: number;
  y: number;
  color: string;
  radius: number;
}

export const CELL_SIZE = 20;
export const HALF_CELL = CELL_SIZE / 2;

// Graph-paper minor lines: how many subdivisions per cell (also the
// resolution of "Sub-grid"/"fine" snap mode — see FINE_CELL below).
export const GRID_SUBDIV = 10;
// One subdivision cell — the lattice step for "fine" snap mode.
export const FINE_CELL = CELL_SIZE / GRID_SUBDIV;

export function getKey(halfCol: number, halfRow: number) {
  return `${halfCol},${halfRow}`;
}
// Sub-grid points live on a finer lattice than the half-cell one every other
// snap mode uses, so they get their own key namespace ("f:col,row") — this
// guarantees they can never collide with an existing half-cell key even
// though both are just small integer pairs.
export function getFineKey(fc: number, fr: number) {
  return `f:${fc},${fr}`;
}

// Enumerate EVERY snap point across the canvas. corner = even/even half-cells,
// center = odd/odd, "both" = the full half-cell lattice, "fine" = the whole
// sub-grid lattice (its own key namespace, no parity filtering — every fine
// point is a valid snap point, same as getNearestSnap's fine branch).
// Parity is judged from the CENTER of the canvas outward (the lattice point
// nearest the center always counts as a corner): imported art is contain/cover-
// fit around the center, so this keeps the dot pattern anchored there when the
// grid resolution changes — otherwise a coarse lattice on an odd cell count has
// no point at the center and the whole design wobbles, pinned to the top-left.
// (Keys stay absolute half-cell indices, so editor import is unaffected. This
// deliberately diverges from P5js sketch/grid.js, which is corner-anchored.)
export function generateGridPoints(
  snapMode: SnapMode, canvasW: number, canvasH: number
): { key: string; x: number; y: number }[] {
  const pts: { key: string; x: number; y: number }[] = [];
  if (snapMode === "fine") {
    const maxFC = Math.round(canvasW / FINE_CELL);
    const maxFR = Math.round(canvasH / FINE_CELL);
    for (let fc = 0; fc <= maxFC; fc++)
      for (let fr = 0; fr <= maxFR; fr++)
        pts.push({ key: getFineKey(fc, fr), x: fc * FINE_CELL, y: fr * FINE_CELL });
    return pts;
  }
  const maxHC = Math.round(canvasW / HALF_CELL);
  const maxHR = Math.round(canvasH / HALF_CELL);
  const oc = Math.round(maxHC / 2), or = Math.round(maxHR / 2);
  for (let hc = 0; hc <= maxHC; hc++) {
    for (let hr = 0; hr <= maxHR; hr++) {
      const cEven = (hc - oc) % 2 === 0, rEven = (hr - or) % 2 === 0;
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

  // Sample on an AREA average, not a single pixel: downscale the cover-fit image
  // once to the snap-mode's grid resolution (one texel per snap point) so the
  // browser box-filters each cell. Kills aliasing/noise on downsampled photos —
  // and the getImageData is tiny (grid-sized, not full raster) so it's faster too.
  // "fine" mode samples at FINE_CELL resolution (5x finer than half-cell) so the
  // extra dot density actually captures more image detail, not just the same
  // half-cell texel repeated at higher dot count.
  const step = opts.snapMode === "fine" ? FINE_CELL : HALF_CELL;
  const sw = Math.round(W / step) + 1;   // sample-grid columns (matches generateGridPoints bounds)
  const sh = Math.round(H / step) + 1;   // sample-grid rows
  const off = document.createElement("canvas");
  off.width = sw; off.height = sh;
  const ctx = off.getContext("2d", { willReadFrequently: true });
  if (!ctx) return out;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Cover-fit (center-crop) so the image fills the grid without stretching.
  const iw = bitmap.width, ih = bitmap.height;
  const scale = Math.max(sw / iw, sh / ih);
  ctx.drawImage(bitmap, (sw - iw * scale) / 2, (sh - ih * scale) / 2, iw * scale, ih * scale);
  const data = ctx.getImageData(0, 0, sw, sh).data;

  for (const p of generateGridPoints(opts.snapMode, W, H)) {
    const sx = Math.min(sw - 1, Math.max(0, Math.round(p.x / step)));
    const sy = Math.min(sh - 1, Math.max(0, Math.round(p.y / step)));
    const i = (sy * sw + sx) * 4;
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

// Rasterized text → dots with a halftone DISSOLVE: a coverage field (text
// alpha, box-averaged on the half-cell lattice) is blurred outward (optionally
// direction-biased — `drift`) and every grid point gets a dot SIZED by the
// field: full in the letter core (with subtle texture), shrinking smoothly to
// sub-pixel through the fringe. Dots stay on the lattice so they remain
// snapped/editable. Pure.
export function buildDotsFromText(
  src: CanvasImageSource & { width: number; height: number }, w: number, h: number,
  opts: { style: "color" | "mono" | "tonal"; threshold: number; dotRadius: number; snapMode: SnapMode; textColor: string; monoColor: string; scatter: number; drift?: number; driftAngle?: number }
): Map<string, Dot> {
  const W = Math.round(w), H = Math.round(h);
  const out = new Map<string, Dot>();
  if (W <= 0 || H <= 0) return out;

  // Coverage field on the snap-mode's lattice. The text is downsampled straight
  // to lattice resolution (one texel per snap point; the browser box-filters
  // the drawImage) instead of reading the full raster — a full-res getImageData
  // dominated rebuild cost and stalled live slider scrubs/recording. The -0.5
  // texel shift centers each texel on its lattice point. "fine" mode samples at
  // FINE_CELL resolution so the extra dot density captures real extra detail.
  const step = opts.snapMode === "fine" ? FINE_CELL : HALF_CELL;
  const cols = Math.round(W / step) + 1;
  const rows = Math.round(H / step) + 1;
  const off = document.createElement("canvas");
  off.width = cols; off.height = rows;
  const ctx = off.getContext("2d", { willReadFrequently: true });
  if (!ctx) return out;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Contain-fit (aspect already matches the canvas, so this fills without crop).
  const iw = src.width, ih = src.height;
  const s = Math.min(W / iw, H / ih);
  ctx.drawImage(src,
    ((W - iw * s) / 2) / step - 0.5, ((H - ih * s) / 2) / step - 0.5,
    (iw * s) / step, (ih * s) / step);
  const data = ctx.getImageData(0, 0, cols, rows).data;
  const field = new Float32Array(cols * rows);
  for (let c = 0; c < cols; c++)
    for (let rW = 0; rW < rows; rW++)
      field[c * rows + rW] = data[(rW * cols + c) * 4 + 3] / 255;   // alpha

  // Blur outward `scatter` passes → the dissolve halo. `drift` (0..1) biases
  // the kernel toward the upstream neighbour so coverage pours downstream and
  // the halo smears in one direction (`driftAngle` in degrees, 0 = right,
  // screen y-down, so 135 = down-left).
  let buf = field;
  const passes = Math.round(scatterToPasses(opts.scatter));
  const drift = Math.min(1, Math.max(0, opts.drift ?? 0));
  const ang = ((opts.driftAngle ?? 135) * Math.PI) / 180;
  const ux = Math.cos(ang), uy = Math.sin(ang);
  const w9: number[] = [];
  for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) {
    const len = Math.hypot(dc, dr);
    w9.push(len ? Math.max(0, 1 - drift * ((dc * ux + dr * uy) / len)) : 1);
  }
  for (let p = 0; p < passes; p++) {
    const nb = new Float32Array(cols * rows);
    for (let c = 0; c < cols; c++) for (let rW = 0; rW < rows; rW++) {
      let sum = 0, wsum = 0, k = 0;
      for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++, k++) {
        const cc = c + dc, rr = rW + dr;
        if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
        sum += buf[cc * rows + rr] * w9[k];
        wsum += w9[k];
      }
      nb[c * rows + rW] = wsum ? sum / wsum : 0;
    }
    buf = nb;
  }

  const CORE = 0.6, low = 0.04 + opts.threshold * 0.5;   // density slider lifts the floor
  const MIN_PX = 0.3;                                     // cull sub-pixel dots
  for (const pt of generateGridPoints(opts.snapMode, W, H)) {
    const c = Math.round(pt.x / step), rW = Math.round(pt.y / step);
    const f = buf[c * rows + rW] || 0;
    if (f <= low) continue;
    let radius: number;
    if (f >= CORE) {
      // subtle halftone texture inside the letters (thin strokes → smaller dots)
      radius = opts.dotRadius * (0.85 + 0.15 * (f - CORE) / (1 - CORE));
    } else {
      // Size-graded fringe: dots stay DENSE and shrink smoothly outward (no
      // probabilistic dropout — that read as noise, not halftone). A mild
      // per-dot size jitter keeps it organic; the sub-pixel cull lets the
      // outermost tail go naturally grainy.
      const t = (f - low) / (CORE - low);                // 0..1 across the fringe
      radius = opts.dotRadius * Math.pow(t, 0.9) * (0.75 + 0.5 * hash01(c, rW));
      if (radius < MIN_PX) continue;
    }
    const color = opts.style === "tonal"
      ? (() => { const g = Math.round((1 - Math.min(1, f)) * 255); return rgbToHex(g, g, g); })()
      : opts.style === "mono" ? opts.monoColor : opts.textColor;
    out.set(pt.key, { key: pt.key, x: pt.x, y: pt.y, color, radius });
  }
  return out;
}

// Scatter slider (0..1) → blur passes (0..22). Wider = softer + longer dissolve
// tails (each pass spreads the coverage field one half-cell outward).
export function scatterToPasses(scatter: number): number {
  return Math.max(0, Math.min(22, scatter * 22));
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
