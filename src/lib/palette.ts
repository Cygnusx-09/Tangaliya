// Median-cut color quantization + palette-based image → dots conversion.
// Sibling to dots.ts (reuses its image-sampling core). Pure, no React.

import { type Dot, type SnapMode, rgbToHex, sampleImageGrid } from "./dots";

export interface PaletteDots {
  dots: Map<string, Dot>;      // dot colors already = quantized palette entries
  palette: string[];           // hex, population-ordered (most-used first), deduped — may be < requested count
  index: Map<string, number>;  // dot key -> slot in `palette`
  counts: number[];            // dots per slot
}

// Above this many samples, quantization runs on a deterministic uniform-stride
// subsample instead of the full sample cloud — keeps median-cut fast on large
// images without changing the result on repeated runs of the same image.
const MAX_QUANT_SAMPLES = 4096;

type RGB = [number, number, number];

function boxRange(box: RGB[]): { channel: 0 | 1 | 2; range: number } {
  let mins: [number, number, number] = [255, 255, 255];
  let maxs: [number, number, number] = [0, 0, 0];
  for (const [r, g, b] of box) {
    if (r < mins[0]) mins[0] = r; if (r > maxs[0]) maxs[0] = r;
    if (g < mins[1]) mins[1] = g; if (g > maxs[1]) maxs[1] = g;
    if (b < mins[2]) mins[2] = b; if (b > maxs[2]) maxs[2] = b;
  }
  const ranges: [number, number, number] = [maxs[0] - mins[0], maxs[1] - mins[1], maxs[2] - mins[2]];
  let channel: 0 | 1 | 2 = 0;
  if (ranges[1] >= ranges[channel]) channel = 1;
  if (ranges[2] >= ranges[channel]) channel = 2;
  return { channel, range: ranges[channel] };
}

function boxMean(box: RGB[]): RGB {
  let r = 0, g = 0, b = 0;
  for (const [pr, pg, pb] of box) { r += pr; g += pg; b += pb; }
  const n = box.length || 1;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

// Median-cut over an RGB sample cloud. Deterministic. Repeatedly splits the box
// with the largest single-channel range (tie-break: more samples) at its
// median along that channel, until `count` boxes exist or no box can usefully
// split (range 0 everywhere). Each final box's entry = its mean, rounded.
export function medianCutPalette(samples: RGB[], count: number): RGB[] {
  if (samples.length === 0 || count <= 0) return [];
  const boxes: RGB[][] = [samples.slice()];

  while (boxes.length < count) {
    let bestIdx = -1, bestRange = -1, bestChannel: 0 | 1 | 2 = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.length < 2) continue;
      const { channel, range } = boxRange(box);
      if (range > bestRange || (range === bestRange && bestIdx !== -1 && box.length > boxes[bestIdx].length)) {
        bestIdx = i; bestRange = range; bestChannel = channel;
      }
    }
    if (bestIdx === -1 || bestRange <= 0) break; // nothing left worth splitting

    const box = boxes[bestIdx];
    const sorted = box.slice().sort((a, b) => a[bestChannel] - b[bestChannel]);
    const mid = Math.floor(sorted.length / 2);
    boxes.splice(bestIdx, 1, sorted.slice(0, mid), sorted.slice(mid));
  }

  return boxes.map(boxMean);
}

// Nearest palette entry by squared RGB distance. First wins ties.
export function nearestPaletteIndex(r: number, g: number, b: number, palette: RGB[]): number {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const [pr, pg, pb] = palette[i];
    const dr = r - pr, dg = g - pg, db = b - pb;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) { bestDist = dist; best = i; }
  }
  return best;
}

// Quantize an image to `colorCount` colors and emit one dot per surviving grid
// point, colored by its nearest palette entry. `threshold` skips light/
// background pixels first (same "keep when lum <= threshold" rule the
// color/mono styles in buildDotsFromImage already use), so the palette is
// built only from pixels that will actually become dots.
export function buildPaletteDots(
  bitmap: ImageBitmap, w: number, h: number,
  opts: { colorCount: number; threshold: number; dotRadius: number; snapMode: SnapMode; glitch?: number }
): PaletteDots {
  const empty: PaletteDots = { dots: new Map(), palette: [], index: new Map(), counts: [] };

  const samples = sampleImageGrid(bitmap, w, h, opts.snapMode, opts.glitch ?? 0);
  const survivors = samples.filter((s) => s.lum <= opts.threshold);
  if (survivors.length === 0) return empty;

  // Quantize on a deterministic uniform-stride subsample above the cap, but
  // always assign the FULL survivor set to the resulting palette below.
  let quantSource = survivors;
  if (survivors.length > MAX_QUANT_SAMPLES) {
    const stride = Math.ceil(survivors.length / MAX_QUANT_SAMPLES);
    quantSource = survivors.filter((_, i) => i % stride === 0);
  }
  const rawPalette = medianCutPalette(quantSource.map((s): RGB => [s.r, s.g, s.b]), opts.colorCount);

  // Population-order (most-used first) + dedupe identical hexes. Population is
  // measured against the FULL survivor set (not just quantSource) so ordering
  // reflects the real image, even though quantization itself ran on a subsample.
  const rawCounts = new Array(rawPalette.length).fill(0);
  for (const s of survivors) rawCounts[nearestPaletteIndex(s.r, s.g, s.b, rawPalette)]++;

  const order = rawPalette
    .map((_, i) => i)
    .filter((i) => rawCounts[i] > 0)
    .sort((a, b) => rawCounts[b] - rawCounts[a]);

  const palette: string[] = [];
  const paletteRGB: RGB[] = [];
  const seenHex = new Set<string>();
  for (const i of order) {
    const hex = rgbToHex(...rawPalette[i]);
    if (seenHex.has(hex)) continue;
    seenHex.add(hex);
    palette.push(hex);
    paletteRGB.push(rawPalette[i]);
  }

  // Final assignment: every surviving grid point (full resolution), each
  // becoming one dot colored by its nearest deduped palette entry.
  const dots = new Map<string, Dot>();
  const index = new Map<string, number>();
  const counts = new Array(palette.length).fill(0);
  for (const s of survivors) {
    const slot = nearestPaletteIndex(s.r, s.g, s.b, paletteRGB);
    counts[slot]++;
    index.set(s.key, slot);
    dots.set(s.key, { key: s.key, x: s.x, y: s.y, color: palette[slot], radius: opts.dotRadius });
  }

  return { dots, palette, index, counts };
}
