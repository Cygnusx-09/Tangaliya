// scene.ts — the editable project file format (SceneFile/Layer/undo snapshot
// types + serialization), unit conversion, and buildSVGString (the single
// source of truth for every export). Pure, no React.

import type { Dot, SnapMode } from "@/lib/dots";
import { GRID_SUBDIV } from "@/lib/snap";
import { barRect, type DotShape } from "@/lib/shapes";

export type Unit = "mm" | "cm" | "in";

// ── Editable project file (re-openable scene) ──
// We serialize the *document* (dots + canvas/grid settings + brush state), not
// the view (zoom/pan/rot) or UI prefs (theme/mute persist on their own). The
// same shape is written to localStorage for autosave and downloaded as JSON.
export const PROJECT_VERSION = 1;
export const AUTOSAVE_KEY = "tangaliya-autosave";
export const PROJECT_TAG = "tangaliya-project";

// A drawing layer: its own dot map, name, and visibility. Dots edit into the
// *active* layer; render/export composite all visible layers bottom→top.
export interface Layer { id: string; name: string; visible: boolean; dots: Map<string, Dot>; }
// An undo/redo stack entry tags its dot snapshot with the layer it belongs to
// — undo is a single cross-layer timeline (like Procreate), so a step can
// restore a *different* layer than the one currently active; the layerId is
// what makes that safe instead of overwriting whatever layer happens to be
// selected right now.
export interface UndoSnapshot { layerId: string; dots: Map<string, Dot>; }
export interface SerializedLayer { id: string; name: string; visible: boolean; dots: Dot[]; }

export function genLayerId(): string {
  return `L${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export interface SceneFile {
  app: typeof PROJECT_TAG;
  version: number;
  dots: Dot[]; // flattened, kept for back-compat with pre-layers files/readers
  layers?: SerializedLayer[];
  unit: Unit;
  cellPhysical: number;
  canvasPhysW: number;
  canvasPhysH: number;
  canvasBg: string;
  gridColor: string;
  gridOpacity: number;
  gridThickness: number;
  snapMode: SnapMode;
  color: string;
  radius: number;
  snapReach: number;
  eraseRadius: number;
  recentColors: string[];
  minSpacing?: number; // absolute min distance between dots, in subgrid units — optional for back-compat with pre-existing files
}

// Light structural validation — never trust a file/localStorage blob.
export function parseScene(raw: string): SceneFile | null {
  try {
    const o = JSON.parse(raw);
    if (!o || o.app !== PROJECT_TAG || !Array.isArray(o.dots)) return null;
    if (!(o.canvasPhysW > 0) || !(o.canvasPhysH > 0) || !(o.cellPhysical > 0)) return null;
    return o as SceneFile;
  } catch { return null; }
}

// A dot Map from a raw array, dropping any malformed entries.
export function dotsArrayToMap(arr: unknown): Map<string, Dot> {
  const m = new Map<string, Dot>();
  if (Array.isArray(arr)) {
    for (const d of arr) {
      if (d && typeof d.key === "string" && Number.isFinite(d.x) && Number.isFinite(d.y) &&
        typeof d.color === "string" && Number.isFinite(d.radius)) {
        m.set(d.key, { key: d.key, x: d.x, y: d.y, color: d.color, radius: d.radius });
      }
    }
  }
  return m;
}

export function sceneToMap(scene: SceneFile | null): Map<string, Dot> {
  return dotsArrayToMap(scene?.dots);
}

// The layer stack from a scene: use its `layers` if present, else migrate the
// flat `dots` into a single "Layer 1". Always returns at least one layer.
// Flatten visible layers to one dot array (bottom→top, so a top layer's dot
// wins on a shared snap point) — for image export and the back-compat `dots`.
export function flattenLayers(layers: Layer[]): Dot[] {
  const m = new Map<string, Dot>();
  for (const l of layers) if (l.visible) for (const d of l.dots.values()) m.set(d.key, d);
  return Array.from(m.values());
}

export function sceneToLayers(scene: SceneFile | null): Layer[] {
  if (scene && Array.isArray(scene.layers) && scene.layers.length) {
    const ls = scene.layers.map((sl) => ({
      id: typeof sl?.id === "string" ? sl.id : genLayerId(),
      name: typeof sl?.name === "string" ? sl.name : "Layer",
      visible: sl?.visible !== false,
      dots: dotsArrayToMap(sl?.dots),
    }));
    if (ls.length) return ls;
  }
  return [{ id: genLayerId(), name: "Layer 1", visible: true, dots: sceneToMap(scene) }];
}

// Unit conversion (everything goes through mm internally for conversion)
const TO_MM: Record<Unit, number> = { mm: 1, cm: 10, in: 25.4 };

export function convertUnit(value: number, from: Unit, to: Unit): number {
  return (value * TO_MM[from]) / TO_MM[to];
}
export function roundForUnit(value: number, unit: Unit): number {
  const decimals = unit === "in" ? 3 : unit === "cm" ? 2 : 1;
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

export function fmt(value: number, unit: Unit): string {
  if (unit === "in") return `${value.toFixed(2)}"`;
  return `${value % 1 === 0 ? value : value.toFixed(1)}${unit}`;
}

export function buildSVGString(
  dots: Dot[],
  canvasPxW: number,
  canvasPxH: number,
  pxPerUnit: number,
  unit: Unit,
  canvasBg: string,
  gridColor: string,
  gridOpacity: number,
  gridThickness: number,
  cellSize: number,
  dotShape: DotShape,
): string {
  const wPhys = (canvasPxW / pxPerUnit).toFixed(2);
  const hPhys = (canvasPxH / pxPerUnit).toFixed(2);
  const cols = Math.round(canvasPxW / cellSize);
  const rows = Math.round(canvasPxH / cellSize);
  const visible = dots.filter((d) => d.x >= -d.radius && d.x <= canvasPxW + d.radius && d.y >= -d.radius && d.y <= canvasPxH + d.radius);

  // Build minor grid lines (graph-paper style): GRID_SUBDIV subdivisions per
  // cell, skipping positions that land on a bold main line.
  const sub = cellSize / GRID_SUBDIV;
  const mid = GRID_SUBDIV / 2; // half-cell line — carries the center/edge snap points
  const subGridLines: string[] = [];
  for (let i = 1; i < cols * GRID_SUBDIV; i++) {
    if (i % GRID_SUBDIV === 0) continue;
    const isMid = i % GRID_SUBDIV === mid;
    const x = i * sub;
    subGridLines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${canvasPxH}" stroke="${gridColor}" stroke-opacity="${gridOpacity * (isMid ? 0.72 : 0.4)}" stroke-width="${gridThickness * (isMid ? 0.8 : 0.5)}"/>`);
  }
  for (let i = 1; i < rows * GRID_SUBDIV; i++) {
    if (i % GRID_SUBDIV === 0) continue;
    const isMid = i % GRID_SUBDIV === mid;
    const y = i * sub;
    subGridLines.push(`<line x1="0" y1="${y}" x2="${canvasPxW}" y2="${y}" stroke="${gridColor}" stroke-opacity="${gridOpacity * (isMid ? 0.72 : 0.4)}" stroke-width="${gridThickness * (isMid ? 0.8 : 0.5)}"/>`);
  }

  // Build main grid lines
  const mainGridLines: string[] = [];
  for (let i = 0; i <= cols; i++)
    mainGridLines.push(`<line x1="${i * cellSize}" y1="0" x2="${i * cellSize}" y2="${canvasPxH}" stroke="${gridColor}" stroke-opacity="${gridOpacity}" stroke-width="${gridThickness}"/>`);
  for (let i = 0; i <= rows; i++)
    mainGridLines.push(`<line x1="0" y1="${i * cellSize}" x2="${canvasPxW}" y2="${i * cellSize}" stroke="${gridColor}" stroke-opacity="${gridOpacity}" stroke-width="${gridThickness}"/>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${wPhys}${unit}" height="${hPhys}${unit}" viewBox="0 0 ${canvasPxW} ${canvasPxH}">
  <rect width="${canvasPxW}" height="${canvasPxH}" fill="${canvasBg}"/>
  ${subGridLines.join("\n  ")}
  ${mainGridLines.join("\n  ")}
  ${visible.map((d) => {
    if (dotShape === "bar") { const b = barRect(d.x, d.y, d.radius); return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${b.rx}" fill="${d.color}"/>`; }
    return `<circle cx="${d.x}" cy="${d.y}" r="${d.radius}" fill="${d.color}"/>`;
  }).join("\n  ")}
</svg>`;
}
