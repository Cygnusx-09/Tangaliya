import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo, memo } from "react";
import { flushSync } from "react-dom";
import { HexColorPicker } from "react-colorful";
import { Eraser, Pen, Trash2, ZoomIn, ZoomOut, Maximize2, Undo2, Redo2, MousePointer2, FileImage, FileCode2, Printer, Grid3x3, Magnet, Ruler, Plus, Minus, Droplet, PaintBucket, Moon, Sun, Volume2, VolumeX, Menu, SlidersHorizontal, Dices, Save, FolderOpen, ImagePlus, Type, FlipHorizontal2, FlipVertical2, Slash, PenTool, Circle, Layers as LayersIcon, Eye, EyeOff, Copy, ChevronUp, ChevronDown, Repeat, Home as HomeIcon, Combine, Check, TriangleAlert } from "lucide-react";
import { sfx, setSfxMuted } from "../sounds";
import { Progress } from "./ui/progress";
import {
  CELL_SIZE, HALF_CELL, getKey, generateGridPoints, rgbToHex, computeImportDims, computeCanvasDims,
  buildDotsFromImage, buildDotsFromText, renderTextCanvas, type SnapMode, type Dot,
} from "@/lib/dots";
import { buildPaletteDots } from "@/lib/palette";
import { GRID_SUBDIV, FINE_CELL, getFineKey, snapSpacing, getNearestSnap, mirrorSnaps, keyFromPosition, nativeSpacing, filterMinSpacing, inBounds, clampOffsetToCanvas, SpatialHash, farEnoughFast } from "@/lib/snap";
import { downloadBlob } from "@/lib/download";
import {
  constrainAngle15, pathPolyline, computePathDots,
  type SpacingShape, type SpacingOpts,
} from "@/lib/path";
import {
  barRect, ellipsePolyline, gridPointsInEllipse, shapeVertices, gridPointsInPolygon, distToSegment,
  type DotShape, type ShapeKind,
} from "@/lib/shapes";
import {
  motifPivot, computeLinearInstances, computeGridInstances, computeCurveInstances, computeArrayPlacements,
  type ArrayMode, type Transform,
} from "@/lib/array";
import {
  PROJECT_VERSION, AUTOSAVE_KEY, PROJECT_TAG, parseScene, sceneToLayers, flattenLayers, genLayerId, defaultScene,
  convertUnit, roundForUnit, fmt, buildSVGString,
  type Unit, type Layer, type SceneFile,
} from "@/lib/scene";
import { useLayers } from "../hooks/useLayers";
import {
  genProjectId, getProject, putProject, getActiveProjectId, setActiveProjectId, listProjects, randomProjectName,
} from "@/lib/projectLibrary";
import { captureThumbnail } from "@/lib/thumbnail";
import { HomeScreen } from "./HomeScreen";

type Tool = "draw" | "erase" | "select" | "line" | "pen" | "shape" | "array";
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 20;
// Screen-space px a mousedown-on-an-unselected-dot can move before it's
// treated as the start of a marquee drag rather than a plain click-select.
const SELECT_CLICK_SLOP = 4;
// Above this many selected dots, SelectionOverlay swaps per-dot rings for one
// bounding-box rect — inserting thousands of ring <circle>s in one commit is
// what freezes Ctrl+A on a large layer (see ARCHITECTURE.md). Starting guess,
// tuned against tests/perf-selection.mjs.
const LARGE_SELECTION_RING_THRESHOLD = 1000;

// Selection + hover rings for the active layer. Dots themselves render to a
// <canvas> now (drawScene, below) — this stays a standalone SVG overlay,
// since selection/hover UI is interactive chrome, not artwork. Originally
// split out of a per-layer DotLayer SVG component specifically so that
// flipping a huge selection (Ctrl+A on tens of thousands of dots) wouldn't
// force a full per-dot re-render just because selectedKeys changed
// reference — DotLayer is gone now that dots aren't DOM nodes at all, but
// this overlay's own large-selection bbox-fallback (below) is still real
// and still needed, so it stayed. Rendered once (not per-layer) since only
// the active layer's dots are ever selectable/hoverable.
const SelectionOverlay = memo(function SelectionOverlay(props: {
  dots: Map<string, Dot>;
  selectedKeys: Set<string>;
  hoveredDotKey: string | null;
  isDragging: boolean; moveDx: number; moveDy: number;
  zoom: number; selectionRingColor: string;
}) {
  const { dots, selectedKeys, hoveredDotKey, isDragging, moveDx, moveDy, zoom, selectionRingColor } = props;

  // Radius-aware bbox over the selection only — kept separate from
  // selectionBBox (used elsewhere for edge-clamping) because that helper
  // deliberately ignores per-dot radius, which matters here since tonal
  // image import produces varying radii and a tight box would clip rings.
  // Memoized on [selectedKeys, dots] — moveDx/moveDy are applied as a plain
  // offset below, not inside the memo, so dragging a huge selection doesn't
  // recompute this every pointermove.
  const bigSelectionBox = useMemo(() => {
    if (selectedKeys.size <= LARGE_SELECTION_RING_THRESHOLD) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxRadius = 0;
    for (const key of selectedKeys) {
      const dot = dots.get(key);
      if (!dot) continue;
      if (dot.x < minX) minX = dot.x;
      if (dot.y < minY) minY = dot.y;
      if (dot.x > maxX) maxX = dot.x;
      if (dot.y > maxY) maxY = dot.y;
      if (dot.radius > maxRadius) maxRadius = dot.radius;
    }
    if (minX > maxX) return null;
    return { minX, minY, maxX, maxY, maxRadius };
  }, [selectedKeys, dots]);

  const hoverRing = hoveredDotKey && !selectedKeys.has(hoveredDotKey) && (() => {
    const dot = dots.get(hoveredDotKey);
    if (!dot) return null;
    return (
      <circle cx={dot.x} cy={dot.y} r={dot.radius + 4 / zoom}
        fill="none" stroke={selectionRingColor} strokeWidth={1 / zoom} opacity={0.5}
        style={{ pointerEvents: "none" }} />
    );
  })();

  if (bigSelectionBox) {
    const pad = bigSelectionBox.maxRadius + 4 / zoom;
    const ox = isDragging ? moveDx : 0;
    const oy = isDragging ? moveDy : 0;
    return (
      <g data-selection-overlay="">
        <rect
          x={bigSelectionBox.minX - pad + ox} y={bigSelectionBox.minY - pad + oy}
          width={bigSelectionBox.maxX - bigSelectionBox.minX + pad * 2}
          height={bigSelectionBox.maxY - bigSelectionBox.minY + pad * 2}
          fill={selectionRingColor} fillOpacity={0.06}
          stroke={selectionRingColor} strokeWidth={1 / zoom}
          strokeDasharray={isDragging ? `${4 / zoom},${3 / zoom}` : "none"}
          style={{ pointerEvents: "none" }}
        />
        {hoverRing}
      </g>
    );
  }

  return (
    <g data-selection-overlay="">
      {Array.from(selectedKeys).map((key) => {
        const dot = dots.get(key);
        if (!dot) return null;
        const cx = isDragging ? dot.x + moveDx : dot.x;
        const cy = isDragging ? dot.y + moveDy : dot.y;
        return (
          <circle key={key} cx={cx} cy={cy} r={dot.radius + 4 / zoom}
            fill="none" stroke={selectionRingColor} strokeWidth={1.5 / zoom}
            strokeDasharray={isDragging ? `${3 / zoom},${2 / zoom}` : "none"}
            style={{ pointerEvents: "none" }} />
        );
      })}
      {hoverRing}
    </g>
  );
});

const PALETTE = [
  "#FF2A2A", "#FF6B35", "#FFCC00", "#29CC74",
  "#00B4D8", "#4361EE", "#9B5DE5", "#F72585",
  "#000000", "#444444", "#999999", "#FFFFFF",
];

function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// Exact hit test, unchanged — `dots` is now any iterable (a full Map's
// .values(), or a small pre-filtered candidate array from a spatial hash
// query) rather than requiring the whole Map, so callers can hand it either
// the brute set or a hash-narrowed one with no change to the math itself.
function findDotAt(dots: Iterable<Dot>, wx: number, wy: number): Dot | null {
  let closest: Dot | null = null;
  let closestDist = Infinity;
  for (const dot of dots) {
    const d = Math.hypot(dot.x - wx, dot.y - wy);
    if (d <= dot.radius + 4 && d < closestDist) { closest = dot; closestDist = d; }
  }
  return closest;
}

// Bounding box of the selected dots' centers — null when nothing resolves.
function selectionBBox(dots: Map<string, Dot>, keys: Set<string>): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const k of keys) {
    const d = dots.get(k);
    if (!d) continue;
    if (d.x < minX) minX = d.x; if (d.x > maxX) maxX = d.x;
    if (d.y < minY) minY = d.y; if (d.y > maxY) maxY = d.y;
  }
  return maxX === -Infinity ? null : { minX, minY, maxX, maxY };
}


// Exact bbox test, unchanged — same widened-to-Iterable treatment as findDotAt.
function dotsInRect(dots: Iterable<Dot>, wx1: number, wy1: number, wx2: number, wy2: number): Set<string> {
  const minX = Math.min(wx1, wx2); const maxX = Math.max(wx1, wx2);
  const minY = Math.min(wy1, wy2); const maxY = Math.max(wy1, wy2);
  const result = new Set<string>();
  for (const dot of dots)
    if (dot.x >= minX && dot.x <= maxX && dot.y >= minY && dot.y <= maxY) result.add(dot.key);
  return result;
}

// Pill slider: label sits on a filled track, tick dots mark the range,
// a vertical bar is the thumb, and the current value shows large on the right.
// The whole pill is a pointer scrub surface (iOS range inputs only drag from
// the thumb itself, which is hopeless with a finger or Pencil): pressing the
// track jumps to that value and drags absolutely; pressing the label / value
// end-zones drags relatively from the current value, so a tap there can't
// slam the value to min/max. A hidden native range input stays for keyboard.
function ValueSlider({
  label, value, min, max, step = 1, onChange, display,
}: {
  label: string; value: number; min: number; max: number;
  step?: number; onChange: (v: number) => void; display?: string;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startValue: number; relative: boolean } | null>(null);
  const frac = Math.min(1, Math.max(0, (value - min) / (max - min)));
  const track = "(100% - var(--tl) - var(--tr))"; // travel region for the thumb
  const TL = 84, TR = 44;

  const quantize = (raw: number) => {
    const stepped = min + Math.round((raw - min) / step) * step;
    const decimals = (String(step).split(".")[1] ?? "").length;
    return Math.min(max, Math.max(min, Number(stepped.toFixed(decimals))));
  };
  const emit = (v: number) => {
    if (v === value) return;
    onChange(v);
    sfx.slider((v - min) / (max - min));
  };
  const handleScrub = (e: React.PointerEvent, phase: "down" | "move") => {
    const row = rowRef.current;
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const trackW = rect.width - TL - TR;
    if (phase === "down") {
      const x = e.clientX - rect.left;
      const relative = x < TL || x > rect.width - TR;
      dragRef.current = { startX: e.clientX, startValue: value, relative };
      try { row.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (!relative) emit(quantize(min + ((x - TL) / trackW) * (max - min)));
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.relative) emit(quantize(drag.startValue + ((e.clientX - drag.startX) / trackW) * (max - min)));
    else emit(quantize(min + ((e.clientX - rect.left - TL) / trackW) * (max - min)));
  };
  return (
    <div
      ref={rowRef}
      onPointerDown={(e) => { if (e.pointerType === "mouse" && e.button !== 0) return; e.preventDefault(); handleScrub(e, "down"); }}
      onPointerMove={(e) => handleScrub(e, "move")}
      onPointerUp={() => { dragRef.current = null; }}
      onPointerCancel={() => { dragRef.current = null; }}
      className="relative flex items-center h-11 rounded-[12px] bg-[var(--track)] select-none touch-none cursor-pointer"
      style={{ "--tl": "84px", "--tr": "44px" } as React.CSSProperties}
    >
      {/* filled pill from the left edge up to the thumb */}
      <div
        className="absolute inset-y-0 left-0 rounded-[12px] bg-[var(--track-fill)] pointer-events-none"
        style={{ width: `calc(var(--tl) + ${frac} * ${track})` }}
      />
      <span className="relative z-10 pl-[10px] text-[12px] text-[var(--txt-1)] tracking-[-0.25px] pointer-events-none whitespace-nowrap">
        {label}
      </span>
      {/* evenly spaced tick dots across the track */}
      <div
        className="absolute inset-y-0 flex items-center justify-between pointer-events-none"
        style={{ left: "var(--tl)", right: "var(--tr)" }}
      >
        {Array.from({ length: 11 }).map((_, i) => (
          <span key={i} className="w-[2px] h-[2px] rounded-full bg-[var(--tick)]" />
        ))}
      </div>
      {/* vertical bar thumb */}
      <div
        className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-[2px] h-[17px] rounded-[12px] bg-[var(--txt-1)] pointer-events-none"
        style={{ left: `calc(var(--tl) + ${frac} * ${track})` }}
      />
      <span className="absolute right-3 z-10 text-[20px] leading-none text-[var(--txt-1)] tracking-[-0.5px] tabular-nums pointer-events-none">
        {display ?? value}
      </span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        aria-label={label}
        onChange={(e) => { const v = Number(e.target.value); onChange(v); sfx.slider((v - min) / (max - min)); }}
        className="absolute top-0 bottom-0 m-0 opacity-0 pointer-events-none"
        style={{ left: "var(--tl)", right: "var(--tr)" }}
      />
    </div>
  );
}

interface DotArtToolProps {
  showHome: boolean;
  onShowHome: () => void;
  onHideHome: () => void;
}

export function DotArtTool({ showHome, onShowHome, onHideHome }: DotArtToolProps) {
  // Restore the autosaved session once, before first paint, so the initial
  // fit-to-view uses the right canvas size (no flash, no double-fit).
  const bootRef = useRef<SceneFile | null | undefined>(undefined);
  // Which library entry (if any) this session is mirroring — read alongside
  // AUTOSAVE_KEY at the same lazy-init point. Ref only: nothing in the UI
  // renders "which project is open" in v1, so there's no render-driven
  // consumer that would need a state twin (see the mirroring pattern note
  // elsewhere in this file — a ref twin exists for values a handler needs
  // that ALSO drive rendering; this drives neither).
  const activeProjectIdRef = useRef<string | null>(null);
  if (bootRef.current === undefined) {
    try { bootRef.current = parseScene(localStorage.getItem(AUTOSAVE_KEY) ?? ""); }
    catch { bootRef.current = null; }
    activeProjectIdRef.current = getActiveProjectId();
  }
  const boot = bootRef.current;

  // ── Selection state + Layers ──
  // Selection is declared before the layers hook because layer switches
  // (select/add/delete, undo/redo landing on another layer) must clear it —
  // the keys belong to the previous layer's dots.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const selectedKeysRef = useRef<Set<string>>(new Set());
  const clearSelection = useCallback(() => {
    setSelectedKeys(new Set());
    selectedKeysRef.current = new Set();
  }, []);
  const {
    layers, setLayers, layersRef,
    activeLayerId, setActiveLayerId, activeLayerIdRef,
    activeLayer, dots, setDots, dotsRef,
    undoCount, redoCount, pushUndo, undo, redo,
    selectLayer, addLayer, duplicateLayer, deleteLayer,
    moveLayer, toggleLayerVisible, renameLayer, mergeLayers,
  } = useLayers(boot, clearSelection);
  const [showLayers, setShowLayers] = useState(false);
  // True while the debounced localStorage autosave is failing (quota
  // exceeded — see the autosave effect below). Surfaced as a small warning
  // pill so a silently-broken crash-recovery net isn't invisible.
  const [autosaveFailed, setAutosaveFailed] = useState(false);
  // Merge-candidate picks in the Layers panel — separate from `activeLayerId`
  // (which layer you're drawing on). Ctrl/Cmd/Shift-click toggles membership;
  // a plain click still activates as before and leaves this untouched.
  const [mergeSelectIds, setMergeSelectIds] = useState<Set<string>>(new Set());
  // Filtered against live `layers` so a stale id (its layer got deleted, or a
  // merge just consumed it) never inflates the panel's "N selected" count.
  const mergeSelectCount = layers.filter((l) => mergeSelectIds.has(l.id)).length;
  // Canvas layer-nav arrows (up = layer above, down = layer below). pulseKey
  // bumps on every arrow switch — was consumed by the now-removed SVG
  // DotLayer to replay a one-shot "you're now looking at this layer" pulse;
  // rewiring it to drive an equivalent canvas alpha tween is a follow-up
  // pass, not yet done. layerToast shows the landed-on layer's name briefly.
  const [layerPulseKey, setLayerPulseKey] = useState(0);
  const [layerToast, setLayerToast] = useState<{ name: string; dir: 1 | -1; id: number } | null>(null);
  const layerToastTimerRef = useRef<number>();

  const [color, setColor] = useState(boot?.color ?? "#FF2A2A");
  const [recentColors, setRecentColors] = useState<string[]>(boot?.recentColors ?? []);
  const [paletteOpen, setPaletteOpen] = useState(false); // Recent/Palette collapsible dropdown
  const [canvasSetupOpen, setCanvasSetupOpen] = useState(true); // Units/Canvas Size/Cell Size collapsible
  // Bumped by the boot-flush effect below to tell HomeScreen to re-list projects
  // after it refreshes the active tile's thumbnail/timestamp on a cold boot.
  const [homeRefresh, setHomeRefresh] = useState(0);
  const [radius, setRadius] = useState(boot?.radius ?? 1);
  // Dot render shape — global (all dots), snapping unaffected. Persisted.
  const [dotShape, setDotShape] = useState<DotShape>(() => {
    try { return localStorage.getItem("tangaliya-dot-shape") === "bar" ? "bar" : "circle"; } catch { return "circle"; }
  });
  useEffect(() => {
    try { localStorage.setItem("tangaliya-dot-shape", dotShape); } catch { /* ignore */ }
  }, [dotShape]);
  // Absolute minimum distance between any two dots, in subgrid units — a hard
  // floor applied to every placement path (draw click, brush walk, line/pen/
  // shape commit), independent of snap mode and of the Line/Pen
  // Spacing model's own density curve. 1 = no-op (already the finest lattice
  // step); only thins placement once it exceeds the active mode's own spacing.
  const [minSpacing, setMinSpacing] = useState(boot?.minSpacing ?? 3);
  // Stroke snap reach, % of a lattice step: how far away a point "catches"
  // the pen during a stroke. High = eager/loose, low = deliberate placement.
  const [snapReach, setSnapReach] = useState(boot?.snapReach ?? 35);
  // Eraser size in world px — its own state, deliberately NOT shared with the
  // draw dot radius (resizing the eraser must not change the brush).
  const [eraseRadius, setEraseRadius] = useState(boot?.eraseRadius ?? 8);
  const [tool, setTool] = useState<Tool>("draw");
  const [snapMode, setSnapMode] = useState<SnapMode>(boot?.snapMode ?? "fine");
  // Image import: a modal tunes the conversion; "Add to canvas" commits the dots.
  // These aren't part of the saved scene — they only configure the conversion.
  const [importOpen, setImportOpen] = useState(false);
  // Mirror of importOpen for the global keydown handler (Ctrl+V dot-paste
  // needs to yield to the modal's own image-paste listener while it's open).
  const importOpenRef = useRef(false);
  useEffect(() => { importOpenRef.current = importOpen; }, [importOpen]);
  const [importImg, setImportImg] = useState<ImageBitmap | null>(null);
  const [traceStyle, setTraceStyle] = useState<"color" | "mono" | "tonal">("color");
  const [traceThreshold, setTraceThreshold] = useState(1);
  const [traceDotSize, setTraceDotSize] = useState(1.5);          // world-px dot radius
  const [traceDetail, setTraceDetail] = useState<SnapMode>("fine"); // sub-cell fill
  const [importCell, setImportCell] = useState(10);             // cell size for the import (current unit)
  const [traceTonalColor, setTraceTonalColor] = useState(false); // Light & Shadow: keep image colors
  // Image-modal-only style (Colors palette vs Light & Shadow tonal halftone) —
  // separate from traceStyle, which the Text modal still uses (color/mono/tonal).
  const [imgStyle, setImgStyle] = useState<"palette" | "tonal">("palette");
  const [traceColorCount, setTraceColorCount] = useState(8);     // Colors slider, 1..32
  // Glitch: RGB channel offset (chromatic-aberration tear) applied during
  // sampling, Colors-mode only. Amount is in sample-grid cells — see
  // sampleImageGrid's `glitch` param for the actual R/G/B shift.
  const [traceGlitch, setTraceGlitch] = useState(false);
  const [traceGlitchAmount, setTraceGlitchAmount] = useState(4);
  // "Add to canvas" adds one new layer per palette color, appended above the
  // existing stack, instead of replacing the active layer's content. Off by
  // default — layer add/delete isn't undoable (only dot edits within a layer
  // are), so this stays opt-in.
  const [splitLayersByColor, setSplitLayersByColor] = useState(false);
  // Manual swatch recolors, keyed by the ORIGINAL quantized hex (not slot
  // index) so an edit survives a slider/threshold recompute as long as that
  // hex reappears in the new quantization. Cleared only on modal open / new image.
  const [paletteEdits, setPaletteEdits] = useState<Record<string, string>>({});
  // Modal-local target canvas size (current unit) — seeded from the live
  // canvas when the modal opens, only applied to the real canvas on commit.
  const [importW, setImportW] = useState(20);
  const [importH, setImportH] = useState(20);
  const [importWInput, setImportWInput] = useState("20");
  const [importHInput, setImportHInput] = useState("20");
  // Text → Dots mode (separate modal): typed text in an uploaded font, dissolved.
  const [textOpen, setTextOpen] = useState(false);
  const [textValue, setTextValue] = useState("Prompt them.\nStack them.\nShare them.");
  const [textFontFamily, setTextFontFamily] = useState<string | null>(null);
  const [textFontName, setTextFontName] = useState("");
  const [textColor, setTextColor] = useState("#d4ff3f");
  const [traceScatter, setTraceScatter] = useState(0.35);
  const [preview, setPreview] = useState<{ x: number; y: number } | null>(null);
  // Position of the most recently placed draw-tool dot (persists across mouse
  // up, unlike lastPaintRef which resets per stroke). Drives the spacing
  // readout so variable gaps can be judged by eye while hand-drawing.
  const [lastPlaced, setLastPlaced] = useState<{ x: number; y: number } | null>(null);
  const lastPlacedRef = useRef<{ x: number; y: number } | null>(null);
  // Rolling history of the last few gaps between consecutive draw placements,
  // each as x / y offset in subgrid steps — the sequence HUD, for keeping a
  // manual spacing ramp consistent (e.g. 5,0 · 6,0 · 8,0 …).
  const [gapSeq, setGapSeq] = useState<{ x: number; y: number }[]>([]);
  const [viewportSize, setViewportSize] = useState({ width: 800, height: 600 });
  const [canvasBg, setCanvasBg] = useState<string>(boot?.canvasBg ?? "#ffffff");
  const [gridColor, setGridColor] = useState(boot?.gridColor ?? "#000000");
  const [gridOpacity, setGridOpacity] = useState(boot?.gridOpacity ?? 0.07);
  const [gridThickness, setGridThickness] = useState(boot?.gridThickness ?? 0.5);

  // ── Universal unit (project-wide) ──
  const [unit, setUnit] = useState<Unit>(boot?.unit ?? "cm");
  const [cellPhysical, setCellPhysical] = useState(boot?.cellPhysical ?? 1);   // value expressed in current `unit`
  const [canvasPhysW, setCanvasPhysW] = useState(boot?.canvasPhysW ?? 20);
  const [canvasPhysH, setCanvasPhysH] = useState(boot?.canvasPhysH ?? 20);
  const [cellInput, setCellInput] = useState(String(boot?.cellPhysical ?? 1));
  const [wInput, setWInput] = useState(String(boot?.canvasPhysW ?? 20));
  const [hInput, setHInput] = useState(String(boot?.canvasPhysH ?? 20));

  const [dark, setDark] = useState<boolean>(() => {
    try { return localStorage.getItem("tangaliya-theme") === "dark"; } catch { return false; }
  });
  const [theming, setTheming] = useState(false);
  const themeTimerRef = useRef<number>();
  useEffect(() => {
    try { localStorage.setItem("tangaliya-theme", dark ? "dark" : "light"); } catch { /* ignore */ }
  }, [dark]);
  // Plain crossfade fallback (reduced-motion or a browser without View
  // Transitions) — the `.theming` class drives theme.css's blanket
  // background/color/border transition.
  const crossfadeTheme = useCallback(() => {
    setTheming(true);
    window.clearTimeout(themeTimerRef.current);
    themeTimerRef.current = window.setTimeout(() => setTheming(false), 350);
    setDark((d) => !d);
  }, []);
  // Diagonal wipe reveal via the native View Transitions API — the new theme
  // sweeps down over the old one on a slant (leading from the top-left,
  // trailing at the top-right), instead of the whole UI dissolving
  // uniformly. `flushSync` forces the setDark commit to apply synchronously
  // inside the transition callback, since startViewTransition snapshots the
  // DOM right after that callback returns and React's setState is normally
  // batched/async. theme.css disables the API's own default crossfade on the
  // root pseudo-elements so only this manual clip-path wipe animates.
  // The polygon's top edge stays pinned at (0%,0%)-(100%,0%) in both
  // keyframes; only the bottom (leading) edge travels, from a degenerate
  // sliver above the viewport to well past its bottom, so the two vertex
  // pairs interpolate smoothly with no shape "pop". A `filter: blur()` hump
  // (0 -> 6px -> 0, peaking at the sweep's midpoint, same easing) rides
  // alongside the clip-path so the wipe line softens while it's moving fast
  // and sharpens as it decelerates into place, instead of reading as a rigid
  // geometric cut the whole way.
  const toggleTheme = useCallback(() => {
    sfx.toggle();
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion || !document.startViewTransition) { crossfadeTheme(); return; }

    const transition = document.startViewTransition(() => {
      flushSync(() => setDark((d) => !d));
    });
    transition.ready.then(() => {
      document.documentElement.animate(
        {
          // Middle clip-path keyframe is the exact linear midpoint of the
          // start/end polygon (both vertices travel at a constant rate), so
          // it's a geometric no-op — it exists only to anchor the blur hump
          // at the sweep's midpoint below.
          clipPath: [
            "polygon(0% 0%, 100% 0%, 100% -65%, 0% -15%)",
            "polygon(0% 0%, 100% 0%, 100% 25%, 0% 75%)",
            "polygon(0% 0%, 100% 0%, 100% 115%, 0% 165%)",
          ],
          filter: ["blur(0px)", "blur(6px)", "blur(0px)"],
        },
        { duration: 1400, easing: "cubic-bezier(0.65, 0, 0.35, 1)", pseudoElement: "::view-transition-new(root)" },
      );
    });
  }, [crossfadeTheme]);

  const [muted, setMuted] = useState<boolean>(() => {
    try { return localStorage.getItem("tangaliya-muted") === "1"; } catch { return false; }
  });
  useEffect(() => {
    setSfxMuted(muted);
    try { localStorage.setItem("tangaliya-muted", muted ? "1" : "0"); } catch { /* ignore */ }
  }, [muted]);

  // Export format for the single Export button + dropdown. Persisted.
  const [exportFormat, setExportFormat] = useState<"svg" | "png" | "pdf">(() => {
    try { const f = localStorage.getItem("tangaliya-export-format"); return (f === "png" || f === "pdf") ? f : "svg"; } catch { return "svg"; }
  });
  useEffect(() => {
    try { localStorage.setItem("tangaliya-export-format", exportFormat); } catch { /* ignore */ }
  }, [exportFormat]);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  // ── Responsive: below ~1100px (iPad portrait, split landscape, phones) the
  // two side panels collapse into slide-in overlays toggled by floating buttons. ──
  const [compact, setCompact] = useState(false);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1100px)");
    const on = () => setCompact(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => { if (!compact) { setLeftOpen(false); setRightOpen(false); } }, [compact]);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Canvas view rotation in radians (two-finger twist, like Procreate).
  // View-only — world coordinates, snapping, and exports are unaffected.
  const [rot, setRot] = useState(0);
  const [isGrabbing, setIsGrabbing] = useState(false);
  // Hold-to-clear: press and hold the Clear button for HOLD_CLEAR_MS to wipe the canvas.
  const [clearProgress, setClearProgress] = useState(0); // 0–100, drives the fill bar
  const clearRafRef = useRef<number>();
  const clearStartRef = useRef(0);
  // Which "element" the right-hand context panel is inspecting/editing.
  const [inspect, setInspect] = useState<"dot" | "grid" | "background">("dot");

  const [marqueeBox, setMarqueeBox] = useState<{ wx1: number; wy1: number; wx2: number; wy2: number } | null>(null);
  const [dragOffset, setDragOffset] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const [hoveredDotKey, setHoveredDotKey] = useState<string | null>(null);

  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const rotRef = useRef(0);
  const clipboardRef = useRef<Dot[]>([]);
  const pasteCountRef = useRef(0);
  const marqueeBaseRef = useRef<Set<string>>(new Set());
  const isPaintingRef = useRef(false);
  const isPanningRef = useRef(false);
  const isMarqueeingRef = useRef(false);
  const isDraggingDotsRef = useRef(false);
  const panStartRef = useRef<{ mx: number; my: number; px: number; py: number } | null>(null);
  const marqueeStartRef = useRef<{ wx: number; wy: number } | null>(null);
  const dragStartWorldRef = useRef<{ x: number; y: number } | null>(null);
  const preDragDotsRef = useRef<Map<string, Dot>>(new Map());
  // Selection bbox captured at drag start — the move handler clamps the drag
  // offset against it so the selection stops flush at the canvas edge.
  const dragBBoxRef = useRef<{ minX: number; minY: number; maxX: number; maxY: number } | null>(null);
  const snappedOffsetRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  // A mousedown that hit an *unselected* dot is ambiguous — it could be a
  // plain click-to-select, or the start of a marquee drag that happens to
  // begin on top of a dot (near-unavoidable at high dot density). Held here
  // until the pointer moves past SELECT_CLICK_SLOP: resolves to a single-dot
  // select on release, or a marquee if actually dragged.
  const pendingClickRef = useRef<{ hit: Dot; sx: number; sy: number; world: { wx: number; wy: number } } | null>(null);
  const spaceDownRef = useRef(false);
  const toolRef = useRef<Tool>("draw");
  const colorRef = useRef("#FF2A2A");
  const radiusRef = useRef(3);
  const snapReachRef = useRef(35);
  const eraseRadiusRef = useRef(8);
  const minSpacingRef = useRef(1);
  const snapModeRef = useRef<SnapMode>("both");
  const canvasBoundsRef = useRef({ w: 0, h: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastPickRef = useRef("#000000");

  useEffect(() => { selectedKeysRef.current = selectedKeys; }, [selectedKeys]);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { radiusRef.current = radius; }, [radius]);
  useEffect(() => { snapReachRef.current = snapReach; }, [snapReach]);
  useEffect(() => { eraseRadiusRef.current = eraseRadius; }, [eraseRadius]);
  useEffect(() => { minSpacingRef.current = minSpacing; }, [minSpacing]);
  useEffect(() => { snapModeRef.current = snapMode; }, [snapMode]);

  const pxPerUnit = CELL_SIZE / cellPhysical;
  const canvasPxW = canvasPhysW * pxPerUnit;
  const canvasPxH = canvasPhysH * pxPerUnit;
  canvasBoundsRef.current = { w: canvasPxW, h: canvasPxH };

  // Universal unit change → convert ALL physical values so the design size stays constant
  const changeUnit = useCallback((next: Unit) => {
    if (next === unit) return;
    sfx.ui();
    const newCell = roundForUnit(convertUnit(cellPhysical, unit, next), next);
    const newW = roundForUnit(convertUnit(canvasPhysW, unit, next), next);
    const newH = roundForUnit(convertUnit(canvasPhysH, unit, next), next);
    setCellPhysical(newCell);
    setCanvasPhysW(newW);
    setCanvasPhysH(newH);
    setCellInput(String(newCell));
    setWInput(String(newW));
    setHInput(String(newH));
    setUnit(next);
  }, [unit, cellPhysical, canvasPhysW, canvasPhysH]);

  const applyViewport = useCallback((z: number, p: { x: number; y: number }) => {
    const clamped = Math.min(Math.max(z, MIN_ZOOM), MAX_ZOOM);
    zoomRef.current = clamped; panRef.current = p;
    setZoom(clamped); setPan({ ...p });
  }, []);

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) setViewportSize({ width: Math.floor(e.contentRect.width), height: Math.floor(e.contentRect.height) });
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const fitToViewport = useCallback(() => {
    const pad = 60;
    const w = viewportSize.width - pad * 2;
    const h = viewportSize.height - pad * 2;
    if (w <= 0 || h <= 0 || canvasPxW <= 0 || canvasPxH <= 0) return;
    const z = Math.min(w / canvasPxW, h / canvasPxH, 4);
    const newZoom = Math.min(Math.max(z, MIN_ZOOM), MAX_ZOOM);
    const px = (viewportSize.width - canvasPxW * newZoom) / 2;
    const py = (viewportSize.height - canvasPxH * newZoom) / 2;
    rotRef.current = 0; setRot(0); // fit also straightens a rotated view
    applyViewport(newZoom, { x: px, y: py });
  }, [viewportSize, canvasPxW, canvasPxH, applyViewport]);

  const didInitialFitRef = useRef(false);
  useEffect(() => {
    if (!didInitialFitRef.current && viewportSize.width > 100) {
      fitToViewport();
      didInitialFitRef.current = true;
    }
  }, [viewportSize, fitToViewport]);

  const pushRecentColor = useCallback((c: string) => {
    setRecentColors((prev) => [c, ...prev.filter((p) => p.toLowerCase() !== c.toLowerCase())].slice(0, 8));
  }, []);

  // Set the brush color (draw mode) or recolor the current selection, tracking recents.
  const chooseColor = useCallback((c: string) => {
    if (toolRef.current === "select" && selectedKeysRef.current.size > 0) {
      pushUndo();
      setDots((prev) => {
        const next = new Map(prev);
        for (const key of selectedKeysRef.current) {
          const dot = next.get(key);
          if (dot) next.set(key, { ...dot, color: c });
        }
        return next;
      });
    } else {
      setColor(c);
    }
    pushRecentColor(c);
  }, [pushUndo, pushRecentColor]);

  // Random-but-harmonious starter combo: one hue anchors ground + grid (the
  // grid stays a low-contrast whisper of the ground), the brush takes a
  // rotated hue with guaranteed lightness contrast. Dark grounds get equal
  // weight — traditional Tangaliya is bright dots on dark wool. Deliberately
  // NOT chooseColor: shuffling should never recolor a live selection.
  const shuffleColors = useCallback(() => {
    const h = Math.floor(Math.random() * 360);
    const dark = Math.random() < 0.5;
    const bg = dark
      ? hslToHex(h, 25 + Math.random() * 35, 8 + Math.random() * 10)
      : hslToHex(h, 8 + Math.random() * 25, 90 + Math.random() * 7);
    const grid = dark
      ? hslToHex(h, 15 + Math.random() * 15, 34 + Math.random() * 12)
      : hslToHex(h, 10 + Math.random() * 15, 68 + Math.random() * 10);
    const bh = (h + 90 + Math.random() * 180) % 360;
    const brush = dark
      ? hslToHex(bh, 65 + Math.random() * 30, 55 + Math.random() * 12)
      : hslToHex(bh, 60 + Math.random() * 35, 38 + Math.random() * 14);
    setCanvasBg(bg);
    setGridColor(grid);
    // The grid's visibility = color contrast × opacity, and an opacity tuned
    // for a light ground vanishes on a near-black one — shuffle owns both.
    setGridOpacity(dark ? 0.6 : 0.4);
    setColor(brush);
    pushRecentColor(brush);
    sfx.ui();
  }, [pushRecentColor]);

  const updateSelectedDots = useCallback((patch: Partial<Pick<Dot, "color" | "radius">>) => {
    if (selectedKeysRef.current.size === 0) return;
    pushUndo();
    setDots((prev) => {
      const next = new Map(prev);
      for (const key of selectedKeysRef.current) {
        const dot = next.get(key);
        if (dot) next.set(key, { ...dot, ...patch });
      }
      return next;
    });
  }, [pushUndo]);

  // ── Selection operations (keyboard-driven) ──
  const deleteSelected = useCallback(() => {
    if (selectedKeysRef.current.size === 0) return;
    pushUndo();
    // Snapshot the selection NOW: the functional updater below runs later (at
    // render time), after this handler has already reset selectedKeysRef —
    // reading the ref inside the updater would iterate an empty Set.
    const keys = selectedKeysRef.current;
    setDots((prev) => {
      const next = new Map(prev);
      for (const key of keys) next.delete(key);
      return next;
    });
    setSelectedKeys(new Set());
    selectedKeysRef.current = new Set();
  }, [pushUndo]);

  const selectAll = useCallback(() => {
    setTool("select");
    const all = new Set(dotsRef.current.keys());
    setSelectedKeys(all);
    selectedKeysRef.current = all;
  }, []);

  // Place a batch of dots offset by (dx,dy), assign fresh grid keys, and select them.
  const placeDots = useCallback((source: Dot[], dx: number, dy: number) => {
    if (source.length === 0) return;
    pushUndo();
    const next = new Map(dotsRef.current);
    const newSelected = new Set<string>();
    const { w, h } = canvasBoundsRef.current;
    for (const dot of source) {
      // Each dot re-keys at ITS OWN lattice resolution, not the tool's
      // current snapMode — see nativeSpacing's doc comment.
      const pos = keyFromPosition(dot.x + dx, dot.y + dy, nativeSpacing(dot.key));
      if (!inBounds(pos.x, pos.y, w, h)) continue; // pasting near the edge drops what won't fit
      next.set(pos.key, { ...dot, key: pos.key, x: pos.x, y: pos.y });
      newSelected.add(pos.key);
    }
    dotsRef.current = next;
    setDots(next);
    setTool("select");
    setSelectedKeys(newSelected);
    selectedKeysRef.current = newSelected;
  }, [pushUndo]);

  // Array tool's commit — a sibling of placeDots, not a generalization of it
  // (placeDots has two simple existing callers, duplicate/paste, with no
  // rotation or min-spacing-gating need; changing its contract risks
  // regressing those). `transforms` come from src/lib/array.ts's
  // compute*Instances; computeArrayPlacements is the same pipeline the live
  // preview already ran, so what was on screen is exactly what gets written.
  const commitArrayDots = useCallback((motif: Dot[], transforms: Transform[]) => {
    const spacing = snapSpacing(snapModeRef.current);
    const minDist = minSpacingRef.current * FINE_CELL;
    const placed = computeArrayPlacements(motif, transforms, dotsRef.current, spacing, minDist, canvasBoundsRef.current.w, canvasBoundsRef.current.h);
    if (placed.size === 0) return; // everything gated out — no-op, don't burn an undo step
    pushUndo();
    const next = new Map(dotsRef.current);
    for (const [k, d] of placed) next.set(k, d);
    dotsRef.current = next;
    setDots(next);
    setTool("select");
    const newSelected = new Set(placed.keys());
    setSelectedKeys(newSelected);
    selectedKeysRef.current = newSelected;
  }, [pushUndo]);

  const copySelected = useCallback(() => {
    const picked = Array.from(selectedKeysRef.current)
      .map((k) => dotsRef.current.get(k))
      .filter(Boolean) as Dot[];
    if (picked.length === 0) return;
    clipboardRef.current = picked.map((d) => ({ ...d }));
    pasteCountRef.current = 0;
  }, []);

  const pasteClipboard = useCallback(() => {
    if (clipboardRef.current.length === 0) return;
    pasteCountRef.current += 1;
    const off = CELL_SIZE * pasteCountRef.current;
    placeDots(clipboardRef.current, off, off);
  }, [placeDots]);

  const duplicateSelected = useCallback(() => {
    const picked = Array.from(selectedKeysRef.current)
      .map((k) => dotsRef.current.get(k))
      .filter(Boolean) as Dot[];
    placeDots(picked, CELL_SIZE, CELL_SIZE);
  }, [placeDots]);

  const nudgeSelected = useCallback((dx: number, dy: number) => {
    if (selectedKeysRef.current.size === 0) return;
    const spacing = snapSpacing(snapModeRef.current);
    // Stop flush at the canvas edge — the selection moves as a unit, no dot leaks out.
    const bbox = selectionBBox(dotsRef.current, selectedKeysRef.current);
    if (bbox) ({ dx, dy } = clampOffsetToCanvas(dx, dy, bbox, canvasBoundsRef.current.w, canvasBoundsRef.current.h, spacing));
    if (dx === 0 && dy === 0) return;
    pushUndo();
    const base = new Map(dotsRef.current);
    const newSelected = new Set<string>();
    for (const key of selectedKeysRef.current) {
      const dot = base.get(key);
      if (!dot) continue;
      base.delete(key);
    }
    for (const key of selectedKeysRef.current) {
      const dot = dotsRef.current.get(key);
      if (!dot) continue;
      // Each dot re-keys at ITS OWN lattice resolution, not the tool's
      // current snapMode — see nativeSpacing's doc comment.
      const pos = keyFromPosition(dot.x + dx, dot.y + dy, nativeSpacing(dot.key));
      base.set(pos.key, { ...dot, key: pos.key, x: pos.x, y: pos.y });
      newSelected.add(pos.key);
    }
    dotsRef.current = base;
    setDots(base);
    setSelectedKeys(newSelected);
    selectedKeysRef.current = newSelected;
  }, [pushUndo]);

  // Double-click a dot → select every dot sharing its color.
  const selectSameColor = useCallback((targetColor: string) => {
    setTool("select");
    const matches = new Set<string>();
    for (const dot of dotsRef.current.values())
      if (dot.color === targetColor) matches.add(dot.key);
    setSelectedKeys(matches);
    selectedKeysRef.current = matches;
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (showHome) return;
      if (e.code === "Space" && !e.repeat) { e.preventDefault(); spaceDownRef.current = true; }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") { spaceDownRef.current = false; isPanningRef.current = false; panStartRef.current = null; setIsGrabbing(false); }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [showHome]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (showHome) return; // Home is covering the canvas — its own Escape/typing handlers own input now
      const target = e.target as HTMLElement;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;

      // While building a pen path (nothing committed yet), Ctrl+Z walks back
      // the last anchor rather than undoing the last committed dot — it's the
      // path you're actively editing.
      if (mod && !e.shiftKey && (e.key === "z" || e.key === "Z") &&
        toolRef.current === "pen" && penAnchorsRef.current.length > 0) {
        e.preventDefault(); popPenAnchor(); return;
      }

      // Undo / redo are canvas-level — keep them working even when a field has focus.
      if (mod && (e.key === "z" || e.key === "Z")) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); return; }

      // Everything below would clash with editing a text field, so bail while typing.
      if (typing) return;

      if (mod && (e.key === "a" || e.key === "A")) { e.preventDefault(); selectAll(); return; }
      if (mod && (e.key === "c" || e.key === "C")) { e.preventDefault(); copySelected(); return; }
      if (mod && (e.key === "v" || e.key === "V")) {
        // Yield to the Import Image modal's own paste listener while it's
        // open — critically, skip preventDefault too, or the browser's
        // native paste event (which that listener depends on) never fires.
        if (importOpenRef.current) return;
        e.preventDefault(); pasteClipboard(); return;
      }
      if (mod && (e.key === "d" || e.key === "D")) { e.preventDefault(); duplicateSelected(); return; }

      // Pen tool: while a path is being built, these keys own the path
      // instead of their usual meaning (selection deletion / clear-selection).
      if (toolRef.current === "pen" && penAnchorsRef.current.length > 0) {
        if (e.key === "Enter") { e.preventDefault(); finishPenPathRef.current(penAnchorsRef.current); return; }
        if (e.key === "Escape") { e.preventDefault(); cancelPenPathRef.current(); return; }
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); popPenAnchor(); return; }
      }

      // Array tool, Curve mode: while a path is being drawn, these keys own
      // it. Enter is a convenience alias for Apply (there's no separate
      // "finish path, then apply" step — sliders can be tuned regardless of
      // anchor count, Apply is the only commit action).
      if (toolRef.current === "array" && arrayCurveAnchorsRef.current.length > 0) {
        if (e.key === "Enter") { e.preventDefault(); applyArrayRef.current(); return; }
        if (e.key === "Escape") { e.preventDefault(); cancelArrayCurveRef.current(); return; }
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); popArrayCurveAnchor(); return; }
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedKeysRef.current.size > 0) { e.preventDefault(); deleteSelected(); }
        return;
      }
      if (e.key.startsWith("Arrow") && selectedKeysRef.current.size > 0) {
        e.preventDefault();
        const fine = snapModeRef.current === "fine";
        const step = e.shiftKey ? (fine ? HALF_CELL : CELL_SIZE) : (fine ? FINE_CELL : HALF_CELL);
        if (e.key === "ArrowLeft") nudgeSelected(-step, 0);
        else if (e.key === "ArrowRight") nudgeSelected(step, 0);
        else if (e.key === "ArrowUp") nudgeSelected(0, -step);
        else if (e.key === "ArrowDown") nudgeSelected(0, step);
        return;
      }

      if (e.key === "Escape") { setSelectedKeys(new Set()); selectedKeysRef.current = new Set(); }
      if (e.key === "v" || e.key === "V") { setTool("select"); sfx.toolSelect(); }
      if (e.key === "b" || e.key === "B") { setTool("draw"); sfx.toolDraw(); }
      if (e.key === "e" || e.key === "E") { setTool("erase"); sfx.toolErase(); }
      if (e.key === "l" || e.key === "L") { setTool("line"); sfx.toolDraw(); }
      if (e.key === "p" || e.key === "P") { setTool("pen"); sfx.toolDraw(); }
      if (!mod && (e.key === "s" || e.key === "S")) { setTool("shape"); sfx.toolDraw(); }
      if (!mod && (e.key === "a" || e.key === "A")) { setTool("array"); sfx.toolDraw(); }
    };
    // Capture phase so our shortcuts run before any host/bubble handler that
    // might swallow Ctrl+Z (e.g. an embedding preview's own undo).
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [undo, redo, selectAll, copySelected, pasteClipboard, duplicateSelected, deleteSelected, nudgeSelected, showHome]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();

      // Mid-drag on the Line tool, the wheel scrubs the interval instead of
      // zooming (exclusive — never both for the same event), so spacing can
      // be dialed in live without letting go of the drag.
      if (isPaintingRef.current && toolRef.current === "line" && lineStartRef.current && lineEndRef.current) {
        const dir = e.deltaY < 0 ? 1 : -1;
        const next = Math.min(10, Math.max(1, lineIntervalRef.current + dir));
        if (next !== lineIntervalRef.current) {
          lineIntervalRef.current = next;
          setLineInterval(next);
          const start = lineStartRef.current, end = lineEndRef.current;
          const { w, h } = canvasBoundsRef.current;
          setLinePreview(computePathDots([start, end], CELL_SIZE, snapModeRef.current, w, h, spacingOpts()));
          sfx.slider((next - 1) / 9);
        }
        return;
      }

      // Shape is a momentary drag like Line, so plain wheel mid-drag scrubs the
      // outline spacing (Filled has no path, so it stays zoom there).
      if (isPaintingRef.current && toolRef.current === "shape" && !shapeFilledRef.current &&
        shapeStartRef.current && shapeEndRef.current) {
        const dir = e.deltaY < 0 ? 1 : -1;
        const next = Math.min(10, Math.max(1, lineIntervalRef.current + dir));
        if (next !== lineIntervalRef.current) {
          lineIntervalRef.current = next;
          setLineInterval(next);
          const { dots, cx, cy, rx, ry } = shapeDotsForRef.current(shapeStartRef.current, shapeEndRef.current);
          setShapeGuide({ cx, cy, rx, ry });
          setShapePreview(dots);
          sfx.slider((next - 1) / 9);
        }
        return;
      }

      // Building a Pen path is a persistent mode (unlike the Line drag, which
      // is a momentary button-held gesture), so plain wheel must stay ZOOM —
      // otherwise you can't zoom out while placing anchors. Interval scrub is
      // still here behind Shift for those who want it; the panel slider works
      // anytime too.
      if (e.shiftKey && toolRef.current === "pen" && penAnchorsRef.current.length > 0 && penCursorRef.current) {
        const dir = e.deltaY < 0 ? 1 : -1;
        const next = Math.min(10, Math.max(1, lineIntervalRef.current + dir));
        if (next !== lineIntervalRef.current) {
          lineIntervalRef.current = next;
          setLineInterval(next);
          setPenPreview(penDots([...penAnchorsRef.current, penCursorRef.current]));
          sfx.slider((next - 1) / 9);
        }
        return;
      }

      const rect = svg.getBoundingClientRect();
      const cx = e.clientX - rect.left; const cy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const oldZoom = zoomRef.current;
      const newZoom = Math.min(Math.max(oldZoom * factor, MIN_ZOOM), MAX_ZOOM);
      const newPan = { x: cx - (cx - panRef.current.x) * (newZoom / oldZoom), y: cy - (cy - panRef.current.y) * (newZoom / oldZoom) };
      zoomRef.current = newZoom; panRef.current = newPan;
      setZoom(newZoom); setPan({ ...newPan });
    };
    svg.addEventListener("wheel", handler, { passive: false });
    return () => svg.removeEventListener("wheel", handler);
  }, []);

  // Inverse of the view transform translate(pan) · scale(zoom) · rotate(rot):
  // world = R(−rot) · (screen − pan) / zoom.
  const screenToWorld = (sx: number, sy: number) => {
    const dx = (sx - panRef.current.x) / zoomRef.current;
    const dy = (sy - panRef.current.y) / zoomRef.current;
    const c = Math.cos(rotRef.current), s = Math.sin(rotRef.current);
    return { x: dx * c + dy * s, y: -dx * s + dy * c };
  };

  const getSVGPoint = useCallback((e: React.MouseEvent) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    return screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  }, []);

  // Persistent min-spacing hash for the Draw brush (applyDrawTool/
  // paintStrokeTo below) — keyed on Map reference identity, same idea as
  // hitHashRef further down but tracked separately since it's rebuilt/reused
  // on a different rhythm. Both functions below run entirely inside one
  // synchronous setDots updater each call (never interleaved with another
  // setDots call mid-stroke), so `prev` at the start of one call is always
  // exactly the `next` the previous call returned — meaning "rebuild only
  // when the Map reference changed" is safe across an ENTIRE stroke, not
  // just within one call: every new dot gets inserted into this same hash
  // object as it's added to `next`, and the cache's `dots` pointer is
  // advanced to `next` at the end of the updater, so the following call
  // recognizes continuity and skips rebuilding. Any other kind of edit
  // (undo/redo, a Line/Pen/Shape commit, opening a project) always produces
  // a genuinely different Map reference, which correctly forces a fresh
  // rebuild instead of trusting stale buckets. Bucket size tracks
  // min-spacing directly (SpatialHash.nearby widens its search ring if a
  // later query radius exceeds it, so a stale bucket size from before a
  // mid-session Min. Spacing change stays correct, just less optimal).
  const placeHashRef = useRef<{ dots: Map<string, Dot> | null; hash: SpatialHash<Dot> }>({
    dots: null, hash: new SpatialHash<Dot>(HALF_CELL),
  });
  const ensurePlaceHash = useCallback((dots: Map<string, Dot>, minDist: number) => {
    const cache = placeHashRef.current;
    if (cache.dots !== dots) {
      const hash = new SpatialHash<Dot>(Math.max(minDist, HALF_CELL));
      hash.build(dots.values());
      cache.hash = hash;
      cache.dots = dots;
    }
    return cache;
  }, []);

  const applyDrawTool = useCallback((key: string, x: number, y: number) => {
    setDots((prev) => {
      const next = new Map(prev);
      if (toolRef.current === "erase") next.delete(key);
      else {
        const minDist = minSpacingRef.current * FINE_CELL;
        const { hash } = ensurePlaceHash(prev, minDist);
        // Same-key overwrites (recoloring/redrawing an already-placed dot)
        // always go through — the gate only blocks placing a genuinely new
        // dot too close to a different one.
        if (!next.has(key) && !farEnoughFast(hash, x, y, minDist)) return next;
        const dot: Dot = { key, x, y, color: colorRef.current, radius: radiusRef.current };
        next.set(key, dot);
        hash.insert(dot);
        if (mirrorXRef.current || mirrorYRef.current) {
          const { w, h } = canvasBoundsRef.current;
          for (const m of mirrorSnaps(x, y, w, h, snapModeRef.current, mirrorXRef.current, mirrorYRef.current)) {
            if (m.key !== key && (next.has(m.key) || farEnoughFast(hash, m.x, m.y, minDist))) {
              const mdot: Dot = { key: m.key, x: m.x, y: m.y, color: colorRef.current, radius: radiusRef.current };
              next.set(m.key, mdot);
              hash.insert(mdot);
            }
          }
        }
        placeHashRef.current.dots = next;
      }
      return next;
    });
  }, [ensurePlaceHash]);

  // ── Area eraser ──────────────────────────────────────────────────────────
  // The eraser is a swept circle, not a snap-point deleter: every dot whose
  // body overlaps the segment from the previous pen sample to this one goes,
  // so fast drags can't skip dots and the slider radius is the real hit area.
  const eraseStrokeRef = useRef<{ x: number; y: number } | null>(null);

  // Persistent spatial hash for the eraser, same continuity trick as
  // placeHashRef above: an erase stroke is many synchronous setDots calls in
  // a row, and each call's `prev` is provably the previous call's `next` (no
  // other setDots call can interleave mid-stroke), so the hash is rebuilt
  // once per stroke (or whenever some other edit changes the Map reference)
  // and then kept in sync incrementally — insert never needed here since
  // erasing only removes, so `remove()` on every deleted dot is enough to
  // keep it consistent with `next` across the whole stroke.
  const eraseHashRef = useRef<{ dots: Map<string, Dot> | null; hash: SpatialHash<Dot>; maxRadius: number }>({
    dots: null, hash: new SpatialHash<Dot>(HALF_CELL), maxRadius: 0,
  });
  const ensureEraseHash = useCallback((dots: Map<string, Dot>, reach: number) => {
    const cache = eraseHashRef.current;
    if (cache.dots !== dots) {
      let maxRadius = 0;
      for (const d of dots.values()) if (d.radius > maxRadius) maxRadius = d.radius;
      const hash = new SpatialHash<Dot>(Math.max(reach + maxRadius, HALF_CELL));
      hash.build(dots.values());
      cache.dots = dots; cache.hash = hash; cache.maxRadius = maxRadius;
    }
    return cache;
  }, []);

  const eraseAlong = useCallback((x1: number, y1: number, x2: number, y2: number) => {
    const reach = eraseRadiusRef.current;
    setDots((prev) => {
      let changed = false;
      const next = new Map(prev);
      const { w, h } = canvasBoundsRef.current;
      const mx = mirrorXRef.current, my = mirrorYRef.current;
      const { hash, maxRadius } = ensureEraseHash(prev, reach);
      // Segment bbox padded by reach + the widest dot radius present narrows
      // the scan to dots that could possibly overlap the swept capsule,
      // instead of testing every dot in the layer per sample.
      const pad = reach + maxRadius;
      const candidates = hash.inRect(
        Math.min(x1, x2) - pad, Math.min(y1, y2) - pad,
        Math.max(x1, x2) + pad, Math.max(y1, y2) + pad
      );
      for (const d of candidates) {
        if (!next.has(d.key)) continue; // already removed earlier in this same call
        if (distToSegment(d.x, d.y, x1, y1, x2, y2) <= reach + d.radius) {
          next.delete(d.key); hash.remove(d); changed = true;
          if (mx || my) {
            for (const m of mirrorSnaps(d.x, d.y, w, h, snapModeRef.current, mx, my)) {
              const md = next.get(m.key);
              if (md) { next.delete(m.key); hash.remove(md); changed = true; }
            }
          }
        }
      }
      if (changed) eraseHashRef.current.dots = next;
      return changed ? next : prev;
    });
  }, [ensureEraseHash]);

  // ── Brush-style stroke walk ──────────────────────────────────────────────
  // Pointer moves arrive once per frame (Safari coalesces the Pencil's 240Hz
  // stream), so snapping each event independently leaves gaps on fast strokes
  // and double-places edge midpoints on diagonals (at 45° two edge points are
  // exactly equidistant from the stroke, so jitter picks both). Instead we
  // step the last painted bead toward the pen in 8-direction lattice moves:
  // continuous lines at any speed, and a diagonal lands as one clean
  // corner→center→corner chain. The direction is bucketed into 45° sectors
  // and a step only fires once the pen is decisively into the next cell
  // (hysteresis), so hand wobble can't stutter sideways.
  const lastPaintRef = useRef<{ x: number; y: number } | null>(null);

  // ── Magnetic ruler (Freeform-style straightening) ────────────────────────
  // The walk above already buckets each step into one of 8 lattice directions;
  // the ruler watches that history. Hold one direction for RULER_LOCK_STEPS
  // consecutive steps and the stroke locks onto that ray: the pen position is
  // projected onto it, so hand wobble can't kink a long straight run. A
  // deliberate swerve — perpendicular drift past RULER_ESCAPE — breaks the
  // lock and the walk follows the hand again (and can re-lock on a new
  // heading). The lock origin is always a painted bead, so the ray passes
  // exactly through lattice points. `rulerGuide` renders the dashed rail.
  const RULER_LOCK_STEPS = 3;
  const RULER_ESCAPE = CELL_SIZE * 1.25;
  const rulerRef = useRef<{ sx: number; sy: number; run: number; ox: number; oy: number; locked: boolean } | null>(null);
  const [rulerGuide, setRulerGuide] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  // User toggle: straightening helps long straight runs but fights deliberate
  // curves, so it's switchable from the floating cluster (persisted).
  const [rulerOn, setRulerOn] = useState<boolean>(() => {
    try { return localStorage.getItem("tangaliya-ruler") !== "0"; } catch { return true; }
  });
  const rulerOnRef = useRef(rulerOn);
  useEffect(() => {
    rulerOnRef.current = rulerOn;
    try { localStorage.setItem("tangaliya-ruler", rulerOn ? "1" : "0"); } catch { /* ignore */ }
  }, [rulerOn]);
  const toggleRuler = useCallback(() => {
    setRulerOn((v) => !v);
    rulerRef.current = null; // drop any live lock either way
    setRulerGuide(null);
    sfx.toggle();
  }, []);

  // ── Mirror drawing ────────────────────────────────────────────────────────
  // Reflects every placed/erased dot across the canvas center so symmetric
  // motifs (the lens/spindle shapes in Tangaliya work) only need one quadrant
  // hand-placed. Independently toggleable left-right / top-bottom; both on
  // gives full 4-way symmetry. Persisted like the ruler toggle.
  const [mirrorX, setMirrorX] = useState<boolean>(() => {
    try { return localStorage.getItem("tangaliya-mirror-x") === "1"; } catch { return false; }
  });
  const [mirrorY, setMirrorY] = useState<boolean>(() => {
    try { return localStorage.getItem("tangaliya-mirror-y") === "1"; } catch { return false; }
  });
  const mirrorXRef = useRef(mirrorX);
  const mirrorYRef = useRef(mirrorY);
  useEffect(() => {
    mirrorXRef.current = mirrorX;
    try { localStorage.setItem("tangaliya-mirror-x", mirrorX ? "1" : "0"); } catch { /* ignore */ }
  }, [mirrorX]);
  useEffect(() => {
    mirrorYRef.current = mirrorY;
    try { localStorage.setItem("tangaliya-mirror-y", mirrorY ? "1" : "0"); } catch { /* ignore */ }
  }, [mirrorY]);
  const toggleMirrorX = useCallback(() => { setMirrorX((v) => !v); sfx.toggle(); }, []);
  const toggleMirrorY = useCallback(() => { setMirrorY((v) => !v); sfx.toggle(); }, []);

  // ── Line tool (sparse straight rows) ─────────────────────────────────────
  // A single drag places dots every `lineInterval` lattice steps between a
  // snapped start and end point — for hand-building ladder-tail rows without
  // clicking every point. Nothing is mutated during the drag: `lineGuide` /
  // `linePreview` are render-only previews, and the whole line commits as one
  // undo step on pointer up (mirrors the mirror-drawing dedupe-by-key idiom).
  const [lineInterval, setLineInterval] = useState<number>(() => {
    try { return Number(localStorage.getItem("tangaliya-line-interval")) || 2; } catch { return 2; }
  });
  const lineIntervalRef = useRef(lineInterval);
  useEffect(() => {
    lineIntervalRef.current = lineInterval;
    try { localStorage.setItem("tangaliya-line-interval", String(lineInterval)); } catch { /* ignore */ }
  }, [lineInterval]);
  // Spacing shape (the density curve) + intensity. `lineInterval` above is the
  // base "Spacing" (average gap). `lineAmount` is -100..100 (sign flips
  // direction for ramp/taper); `lineCount` is the cluster count for pulse.
  const [lineShape, setLineShape] = useState<SpacingShape>(() => {
    try { const m = localStorage.getItem("tangaliya-line-shape"); return m === "ramp" || m === "taper" || m === "pulse" ? m : "even"; } catch { return "even"; }
  });
  const [lineAmount, setLineAmount] = useState<number>(() => {
    // localStorage.getItem returns null when unset, and Number(null) === 0
    // (not NaN) — so a plain Number.isFinite check can never fall through to
    // the default for a fresh browser. Check for "unset" explicitly first.
    try {
      const raw = localStorage.getItem("tangaliya-line-amount");
      if (raw === null) return 100;
      const v = Number(raw);
      return Number.isFinite(v) ? v : 100;
    } catch { return 100; }
  });
  const [lineCount, setLineCount] = useState<number>(() => {
    try { return Number(localStorage.getItem("tangaliya-line-count")) || 3; } catch { return 3; }
  });
  const lineShapeRef = useRef(lineShape);
  const lineAmountRef = useRef(lineAmount);
  const lineCountRef = useRef(lineCount);
  useEffect(() => {
    lineShapeRef.current = lineShape;
    try { localStorage.setItem("tangaliya-line-shape", lineShape); } catch { /* ignore */ }
  }, [lineShape]);
  useEffect(() => {
    lineAmountRef.current = lineAmount;
    try { localStorage.setItem("tangaliya-line-amount", String(lineAmount)); } catch { /* ignore */ }
  }, [lineAmount]);
  useEffect(() => {
    lineCountRef.current = lineCount;
    try { localStorage.setItem("tangaliya-line-count", String(lineCount)); } catch { /* ignore */ }
  }, [lineCount]);
  // Assembles the current spacing options from the live refs — the single
  // source every Line/Pen dot computation reads.
  const spacingOpts = useCallback((): SpacingOpts => ({
    shape: lineShapeRef.current, spacing: lineIntervalRef.current,
    amount: lineAmountRef.current / 100, count: lineCountRef.current,
  }), []);
  const lineStartRef = useRef<{ x: number; y: number } | null>(null);
  // Live end point of the in-progress drag — a ref (not just the `lineGuide`
  // state) so the wheel handler below, whose effect only runs once, can read
  // the current value instead of a stale closure.
  const lineEndRef = useRef<{ x: number; y: number } | null>(null);
  const [lineGuide, setLineGuide] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [linePreview, setLinePreview] = useState<{ key: string; x: number; y: number }[] | null>(null);

  const commitLineDots = useCallback((pts: { key: string; x: number; y: number }[]) => {
    setDots((prev) => {
      const next = new Map(prev);
      const { w, h } = canvasBoundsRef.current;
      const minDist = minSpacingRef.current * FINE_CELL;
      // A local, throwaway hash — one commit is a single synchronous batch
      // (not spread across multiple calls like the Draw brush), so there's
      // no reference-identity bookkeeping to do: build once from `prev`,
      // insert as `pts` land, done. Real win when `pts.length` is large
      // (Ramp/Taper/Pulse spacing, Array apply, filled Shape) — O(n) build +
      // O(pts.length) queries instead of O(n × pts.length).
      const hash = new SpatialHash<Dot>(Math.max(minDist, HALF_CELL));
      hash.build(prev.values());
      for (const p of pts) {
        // Applies on top of whatever the Spacing model already produced —
        // an absolute floor, even over a deliberately tight Pulse cluster.
        if (!next.has(p.key) && !farEnoughFast(hash, p.x, p.y, minDist)) continue;
        const dot: Dot = { key: p.key, x: p.x, y: p.y, color: colorRef.current, radius: radiusRef.current };
        next.set(p.key, dot);
        hash.insert(dot);
        if (mirrorXRef.current || mirrorYRef.current) {
          for (const m of mirrorSnaps(p.x, p.y, w, h, snapModeRef.current, mirrorXRef.current, mirrorYRef.current)) {
            if (m.key !== p.key && (next.has(m.key) || farEnoughFast(hash, m.x, m.y, minDist))) {
              const mdot: Dot = { key: m.key, x: m.x, y: m.y, color: colorRef.current, radius: radiusRef.current };
              next.set(m.key, mdot);
              hash.insert(mdot);
            }
          }
        }
      }
      return next;
    });
  }, []);

  // ── Shape tool (dotted ellipse: outline or solid fill) ───────────────────
  // Drag a bounding box → an ellipse. Outline reuses the Line/Pen spacing
  // engine around the perimeter; fill places every grid point inside. Commits
  // through `commitLineDots` (one undo step, mirror- and dot-shape-aware).
  const [shapeFilled, setShapeFilled] = useState<boolean>(() => {
    try { return localStorage.getItem("tangaliya-shape-filled") === "1"; } catch { return false; }
  });
  const shapeFilledRef = useRef(shapeFilled);
  useEffect(() => {
    shapeFilledRef.current = shapeFilled;
    try { localStorage.setItem("tangaliya-shape-filled", shapeFilled ? "1" : "0"); } catch { /* ignore */ }
  }, [shapeFilled]);
  // Anchor model: where the first press lands. "center" = press is the ellipse
  // center, drag is the radius (compass); "corner" = press is one bbox corner,
  // drag is the opposite corner (fit-to-region). Persisted.
  const [shapeAnchor, setShapeAnchor] = useState<"center" | "corner">(() => {
    try { return localStorage.getItem("tangaliya-shape-anchor") === "corner" ? "corner" : "center"; } catch { return "center"; }
  });
  const shapeAnchorRef = useRef(shapeAnchor);
  useEffect(() => {
    shapeAnchorRef.current = shapeAnchor;
    try { localStorage.setItem("tangaliya-shape-anchor", shapeAnchor); } catch { /* ignore */ }
  }, [shapeAnchor]);
  // Which primitive. Persisted.
  const [shapeType, setShapeType] = useState<ShapeKind>(() => {
    try { const t = localStorage.getItem("tangaliya-shape-type"); return (t === "rect" || t === "diamond" || t === "triangle" || t === "polygon") ? t : "ellipse"; } catch { return "ellipse"; }
  });
  const shapeTypeRef = useRef(shapeType);
  useEffect(() => {
    shapeTypeRef.current = shapeType;
    try { localStorage.setItem("tangaliya-shape-type", shapeType); } catch { /* ignore */ }
  }, [shapeType]);
  const [shapeSides, setShapeSides] = useState<number>(() => {
    try { return Number(localStorage.getItem("tangaliya-shape-sides")) || 6; } catch { return 6; }
  });
  const shapeSidesRef = useRef(shapeSides);
  useEffect(() => {
    shapeSidesRef.current = shapeSides;
    try { localStorage.setItem("tangaliya-shape-sides", String(shapeSides)); } catch { /* ignore */ }
  }, [shapeSides]);
  const shapeStartRef = useRef<{ x: number; y: number } | null>(null);
  const shapeEndRef = useRef<{ x: number; y: number } | null>(null);
  const [shapeGuide, setShapeGuide] = useState<{ cx: number; cy: number; rx: number; ry: number } | null>(null);
  const [shapePreview, setShapePreview] = useState<{ key: string; x: number; y: number }[] | null>(null);

  // A pressed point (`start`) + the current cursor (`end`) → shape dots +
  // geometry (for the dashed guide + readouts). The two points mean different
  // things per anchor mode: center → start is the center and the delta is the
  // radius; corner → they're opposite bbox corners.
  const shapeDotsFor = useCallback((start: { x: number; y: number }, end: { x: number; y: number }) => {
    const { w, h } = canvasBoundsRef.current;
    let cx: number, cy: number, rx: number, ry: number;
    if (shapeAnchorRef.current === "center") {
      cx = start.x; cy = start.y;
      rx = Math.abs(end.x - start.x); ry = Math.abs(end.y - start.y);
    } else {
      cx = (start.x + end.x) / 2; cy = (start.y + end.y) / 2;
      rx = Math.abs(end.x - start.x) / 2; ry = Math.abs(end.y - start.y) / 2;
    }
    if (rx < 1 || ry < 1) return { dots: [] as { key: string; x: number; y: number }[], cx, cy, rx, ry };
    const kind = shapeTypeRef.current;
    const verts = shapeVertices(kind, cx, cy, rx, ry, shapeSidesRef.current);
    const dots = shapeFilledRef.current
      ? (kind === "ellipse" ? gridPointsInEllipse(cx, cy, rx, ry, snapModeRef.current, w, h) : gridPointsInPolygon(verts, snapModeRef.current, w, h))
      : computePathDots(verts, CELL_SIZE, snapModeRef.current, w, h, spacingOpts());
    return { dots, cx, cy, rx, ry };
  }, [spacingOpts]);
  // Ref so the once-mounted wheel handler can recompute the preview without a
  // stale closure (same idiom as finishPenPathRef).
  const shapeDotsForRef = useRef(shapeDotsFor);
  useEffect(() => { shapeDotsForRef.current = shapeDotsFor; }, [shapeDotsFor]);

  // ── Pen tool (multi-anchor paths) ────────────────────────────────────────
  // Click places an anchor; each click after the first extends the path
  // (straight segments only), with a live rubber-band preview from the last
  // anchor to the cursor. Nothing commits until Enter (finish), a click back
  // near the first anchor (close the loop), Backspace (drop the last anchor),
  // or Escape (cancel the whole path). Shares the Line tool's spacing engine
  // (`computePathDots`, the Constant/Arithmetic mode + Interval/Step controls)
  // and its `commitLineDots` — a finished path is just an N-anchor line.
  const [penAnchors, setPenAnchors] = useState<{ x: number; y: number }[]>([]);
  const [penCursor, setPenCursor] = useState<{ x: number; y: number } | null>(null);
  const [penPreview, setPenPreview] = useState<{ key: string; x: number; y: number }[] | null>(null);
  const penAnchorsRef = useRef<{ x: number; y: number }[]>([]);
  const penCursorRef = useRef<{ x: number; y: number } | null>(null);
  // Straight vs. curved (Catmull-Rom through the anchors). Persisted.
  const [pathCurve, setPathCurve] = useState<boolean>(() => {
    try { return localStorage.getItem("tangaliya-pen-curve") === "1"; } catch { return false; }
  });
  const pathCurveRef = useRef(pathCurve);
  useEffect(() => {
    pathCurveRef.current = pathCurve;
    try { localStorage.setItem("tangaliya-pen-curve", pathCurve ? "1" : "0"); } catch { /* ignore */ }
  }, [pathCurve]);

  // Single place the Pen tool turns anchors into dots: tessellate to a curve
  // when enabled (a no-op for straight mode), then run the shared spacing
  // engine. Every pen call site goes through here so curve/straight, mode,
  // interval and step stay consistent.
  const penDots = useCallback((anchors: { x: number; y: number }[]) => {
    const { w, h } = canvasBoundsRef.current;
    const poly = pathPolyline(anchors, pathCurveRef.current);
    return computePathDots(poly, CELL_SIZE, snapModeRef.current, w, h, spacingOpts());
  }, [spacingOpts]);

  const cancelPenPath = useCallback(() => {
    penAnchorsRef.current = []; setPenAnchors([]);
    penCursorRef.current = null; setPenCursor(null);
    setPenPreview(null);
  }, []);

  // Drop the most recently placed anchor (Backspace, and Ctrl+Z while a path
  // is being built — before any dots are committed, undo should walk back the
  // path, not the last dot on the canvas).
  const popPenAnchor = useCallback(() => {
    const next = penAnchorsRef.current.slice(0, -1);
    penAnchorsRef.current = next; setPenAnchors(next);
    if (next.length === 0) { penCursorRef.current = null; setPenCursor(null); setPenPreview(null); }
    else if (penCursorRef.current) setPenPreview(penDots([...next, penCursorRef.current]));
  }, [penDots]);

  const finishPenPath = useCallback((anchors: { x: number; y: number }[]) => {
    const pts = penDots(anchors);
    if (pts.length) { pushUndo(); commitLineDots(pts); }
    cancelPenPath();
  }, [penDots, pushUndo, commitLineDots, cancelPenPath]);

  // The global keydown effect below is registered near the top of the
  // component (before these callbacks exist in source order) — a dependency
  // array is evaluated eagerly at render time, so listing finishPenPath /
  // cancelPenPath there directly hits a temporal-dead-zone ReferenceError.
  // Refs sidestep it (read inside the handler body, only at actual keydown
  // time, well after this render has finished initializing everything).
  const finishPenPathRef = useRef(finishPenPath);
  const cancelPenPathRef = useRef(cancelPenPath);
  useEffect(() => { finishPenPathRef.current = finishPenPath; }, [finishPenPath]);
  useEffect(() => { cancelPenPathRef.current = cancelPenPath; }, [cancelPenPath]);

  // ── Array tool (motif repetition: linear/grid/curve) ─────────────────────
  // Repeats the current selection ("the motif") into new dots via
  // src/lib/array.ts's pure transform math. Destructive/commit-based: sliders
  // drive a live ghost preview (see arrayPreview below, near the other
  // render-time derivations), nothing writes to `dots` until Apply.
  const [arrayMode, setArrayMode] = useState<ArrayMode>(() => {
    try { const m = localStorage.getItem("tangaliya-array-mode"); return (m === "grid" || m === "curve") ? m : "linear"; } catch { return "linear"; }
  });
  const arrayModeRef = useRef(arrayMode);
  useEffect(() => {
    arrayModeRef.current = arrayMode;
    try { localStorage.setItem("tangaliya-array-mode", arrayMode); } catch { /* ignore */ }
  }, [arrayMode]);

  const [arrayLinearAngle, setArrayLinearAngle] = useState<number>(() => {
    try { return Number(localStorage.getItem("tangaliya-array-linear-angle")) || 0; } catch { return 0; }
  });
  const arrayLinearAngleRef = useRef(arrayLinearAngle);
  useEffect(() => { arrayLinearAngleRef.current = arrayLinearAngle; try { localStorage.setItem("tangaliya-array-linear-angle", String(arrayLinearAngle)); } catch { /* ignore */ } }, [arrayLinearAngle]);

  const [arrayLinearCount, setArrayLinearCount] = useState<number>(() => {
    try { return Number(localStorage.getItem("tangaliya-array-linear-count")) || 4; } catch { return 4; }
  });
  const arrayLinearCountRef = useRef(arrayLinearCount);
  useEffect(() => { arrayLinearCountRef.current = arrayLinearCount; try { localStorage.setItem("tangaliya-array-linear-count", String(arrayLinearCount)); } catch { /* ignore */ } }, [arrayLinearCount]);

  const [arrayLinearSpacing, setArrayLinearSpacing] = useState<number>(() => {
    try { return Number(localStorage.getItem("tangaliya-array-linear-spacing")) || 60; } catch { return 60; }
  });
  const arrayLinearSpacingRef = useRef(arrayLinearSpacing);
  useEffect(() => { arrayLinearSpacingRef.current = arrayLinearSpacing; try { localStorage.setItem("tangaliya-array-linear-spacing", String(arrayLinearSpacing)); } catch { /* ignore */ } }, [arrayLinearSpacing]);

  // Corner (default, false) = the motif is one end of the ray, array only
  // grows "forward" along angleDeg. Center (true) = the motif is the
  // midpoint, array spreads both ways along the ray.
  const [arrayLinearCentered, setArrayLinearCentered] = useState<boolean>(() => {
    try { return localStorage.getItem("tangaliya-array-linear-centered") === "1"; } catch { return false; }
  });
  const arrayLinearCenteredRef = useRef(arrayLinearCentered);
  useEffect(() => { arrayLinearCenteredRef.current = arrayLinearCentered; try { localStorage.setItem("tangaliya-array-linear-centered", arrayLinearCentered ? "1" : "0"); } catch { /* ignore */ } }, [arrayLinearCentered]);

  const [arrayGridRows, setArrayGridRows] = useState<number>(() => {
    try { return Number(localStorage.getItem("tangaliya-array-grid-rows")) || 3; } catch { return 3; }
  });
  const arrayGridRowsRef = useRef(arrayGridRows);
  useEffect(() => { arrayGridRowsRef.current = arrayGridRows; try { localStorage.setItem("tangaliya-array-grid-rows", String(arrayGridRows)); } catch { /* ignore */ } }, [arrayGridRows]);

  const [arrayGridCols, setArrayGridCols] = useState<number>(() => {
    try { return Number(localStorage.getItem("tangaliya-array-grid-cols")) || 3; } catch { return 3; }
  });
  const arrayGridColsRef = useRef(arrayGridCols);
  useEffect(() => { arrayGridColsRef.current = arrayGridCols; try { localStorage.setItem("tangaliya-array-grid-cols", String(arrayGridCols)); } catch { /* ignore */ } }, [arrayGridCols]);

  const [arrayGridSpacingX, setArrayGridSpacingX] = useState<number>(() => {
    try { return Number(localStorage.getItem("tangaliya-array-grid-spacing-x")) || 60; } catch { return 60; }
  });
  const arrayGridSpacingXRef = useRef(arrayGridSpacingX);
  useEffect(() => { arrayGridSpacingXRef.current = arrayGridSpacingX; try { localStorage.setItem("tangaliya-array-grid-spacing-x", String(arrayGridSpacingX)); } catch { /* ignore */ } }, [arrayGridSpacingX]);

  const [arrayGridSpacingY, setArrayGridSpacingY] = useState<number>(() => {
    try { return Number(localStorage.getItem("tangaliya-array-grid-spacing-y")) || 60; } catch { return 60; }
  });
  const arrayGridSpacingYRef = useRef(arrayGridSpacingY);
  useEffect(() => { arrayGridSpacingYRef.current = arrayGridSpacingY; try { localStorage.setItem("tangaliya-array-grid-spacing-y", String(arrayGridSpacingY)); } catch { /* ignore */ } }, [arrayGridSpacingY]);

  // 0% = plain grid, 50% = classic brick coursing — one slider covers both.
  const [arrayGridRowOffsetPct, setArrayGridRowOffsetPct] = useState<number>(() => {
    try { return Number(localStorage.getItem("tangaliya-array-grid-row-offset")) || 0; } catch { return 0; }
  });
  const arrayGridRowOffsetPctRef = useRef(arrayGridRowOffsetPct);
  useEffect(() => { arrayGridRowOffsetPctRef.current = arrayGridRowOffsetPct; try { localStorage.setItem("tangaliya-array-grid-row-offset", String(arrayGridRowOffsetPct)); } catch { /* ignore */ } }, [arrayGridRowOffsetPct]);

  // Corner (default, false) = motif is cell (row0,col0), grid only grows
  // right+down. Center (true) = motif's cell is the grid's middle, so it
  // spreads on all 4 sides — this is the fix for "array only goes right/down".
  const [arrayGridCentered, setArrayGridCentered] = useState<boolean>(() => {
    try { return localStorage.getItem("tangaliya-array-grid-centered") === "1"; } catch { return false; }
  });
  const arrayGridCenteredRef = useRef(arrayGridCentered);
  useEffect(() => { arrayGridCenteredRef.current = arrayGridCentered; try { localStorage.setItem("tangaliya-array-grid-centered", arrayGridCentered ? "1" : "0"); } catch { /* ignore */ } }, [arrayGridCentered]);

  const [arrayCurveCount, setArrayCurveCount] = useState<number>(() => {
    try { return Number(localStorage.getItem("tangaliya-array-curve-count")) || 8; } catch { return 8; }
  });
  const arrayCurveCountRef = useRef(arrayCurveCount);
  useEffect(() => { arrayCurveCountRef.current = arrayCurveCount; try { localStorage.setItem("tangaliya-array-curve-count", String(arrayCurveCount)); } catch { /* ignore */ } }, [arrayCurveCount]);

  const [arrayCurveSpacing, setArrayCurveSpacing] = useState<number>(() => {
    try { return Number(localStorage.getItem("tangaliya-array-curve-spacing")) || 40; } catch { return 40; }
  });
  const arrayCurveSpacingRef = useRef(arrayCurveSpacing);
  useEffect(() => { arrayCurveSpacingRef.current = arrayCurveSpacing; try { localStorage.setItem("tangaliya-array-curve-spacing", String(arrayCurveSpacing)); } catch { /* ignore */ } }, [arrayCurveSpacing]);

  const [arrayCurveAlign, setArrayCurveAlign] = useState<boolean>(() => {
    try { return localStorage.getItem("tangaliya-array-curve-align") !== "0"; } catch { return true; }
  });
  const arrayCurveAlignRef = useRef(arrayCurveAlign);
  useEffect(() => { arrayCurveAlignRef.current = arrayCurveAlign; try { localStorage.setItem("tangaliya-array-curve-align", arrayCurveAlign ? "1" : "0"); } catch { /* ignore */ } }, [arrayCurveAlign]);

  const [arrayPathCurved, setArrayPathCurved] = useState<boolean>(() => {
    try { return localStorage.getItem("tangaliya-array-path-curved") === "1"; } catch { return false; }
  });
  const arrayPathCurvedRef = useRef(arrayPathCurved);
  useEffect(() => { arrayPathCurvedRef.current = arrayPathCurved; try { localStorage.setItem("tangaliya-array-path-curved", arrayPathCurved ? "1" : "0"); } catch { /* ignore */ } }, [arrayPathCurved]);

  // Curve-mode anchor drawing — ephemeral, not persisted (a mid-draw curve
  // shouldn't survive a reload, same as the Pen tool's anchors don't).
  const [arrayCurveAnchors, setArrayCurveAnchors] = useState<{ x: number; y: number }[]>([]);
  const arrayCurveAnchorsRef = useRef<{ x: number; y: number }[]>([]);
  const [arrayCurveCursor, setArrayCurveCursor] = useState<{ x: number; y: number } | null>(null);
  const arrayCurveCursorRef = useRef<{ x: number; y: number } | null>(null);

  const cancelArrayCurve = useCallback(() => {
    arrayCurveAnchorsRef.current = []; setArrayCurveAnchors([]);
    arrayCurveCursorRef.current = null; setArrayCurveCursor(null);
  }, []);
  const popArrayCurveAnchor = useCallback(() => {
    const next = arrayCurveAnchorsRef.current.slice(0, -1);
    arrayCurveAnchorsRef.current = next; setArrayCurveAnchors(next);
  }, []);

  // Gathers the motif from the current selection, computes this mode's
  // transform list, and commits. Curve mode clears its drawn anchors after a
  // successful apply (matches Pen: a committed path doesn't linger).
  const applyArray = useCallback(() => {
    const motif = Array.from(selectedKeysRef.current)
      .map((k) => dotsRef.current.get(k))
      .filter((d): d is Dot => !!d);
    if (motif.length === 0) return;
    const mode = arrayModeRef.current;
    const transforms =
      mode === "linear" ? computeLinearInstances({ angleDeg: arrayLinearAngleRef.current, count: arrayLinearCountRef.current, spacing: arrayLinearSpacingRef.current, centered: arrayLinearCenteredRef.current }) :
      mode === "grid" ? computeGridInstances({ rows: arrayGridRowsRef.current, cols: arrayGridColsRef.current, spacingX: arrayGridSpacingXRef.current, spacingY: arrayGridSpacingYRef.current, rowOffsetPct: arrayGridRowOffsetPctRef.current, centered: arrayGridCenteredRef.current }) :
      computeCurveInstances(motifPivot(motif), { anchors: arrayCurveAnchorsRef.current, curved: arrayPathCurvedRef.current, count: arrayCurveCountRef.current, spacing: arrayCurveSpacingRef.current, alignToCurve: arrayCurveAlignRef.current });
    commitArrayDots(motif, transforms);
    if (mode === "curve") cancelArrayCurve();
  }, [commitArrayDots, cancelArrayCurve]);
  // Same TDZ-avoidance idiom as finishPenPathRef — the keydown effect sits
  // above this callback in source order.
  const applyArrayRef = useRef(applyArray);
  const cancelArrayCurveRef = useRef(cancelArrayCurve);
  useEffect(() => { applyArrayRef.current = applyArray; }, [applyArray]);
  useEffect(() => { cancelArrayCurveRef.current = cancelArrayCurve; }, [cancelArrayCurve]);

  const paintStrokeTo = useCallback((wx: number, wy: number) => {
    const spacing = snapSpacing(snapModeRef.current);
    const { w, h } = canvasBoundsRef.current;

    // Ruler: while locked, walk toward the pen's projection on the ray, not
    // the pen itself.
    let tx = wx, ty = wy;
    const R = rulerRef.current;
    if (R?.locked) {
      const len = Math.hypot(R.sx, R.sy);
      const ux = R.sx / len, uy = R.sy / len;
      const perp = Math.abs((wx - R.ox) * uy - (wy - R.oy) * ux);
      if (perp > RULER_ESCAPE) {
        R.locked = false; R.run = 0;
        setRulerGuide(null);
      } else {
        const t = Math.max(0, (wx - R.ox) * ux + (wy - R.oy) * uy);
        tx = R.ox + ux * t; ty = R.oy + uy * t;
        setRulerGuide({ x1: R.ox, y1: R.oy, x2: R.ox + ux * (t + 2 * CELL_SIZE), y2: R.oy + uy * (t + 2 * CELL_SIZE) });
      }
    }

    const steps: { key: string; x: number; y: number }[] = [];
    let last = lastPaintRef.current;
    for (let guard = 0; last && guard < 256; guard++) {
      const dx = tx - last.x, dy = ty - last.y;
      const dist = Math.hypot(dx, dy);
      // 45° sector bucketing: a component counts only past cos(67.5°) ≈ 0.3827
      const sx = Math.abs(dx) > dist * 0.3827 ? Math.sign(dx) : 0;
      const sy = Math.abs(dy) > dist * 0.3827 ? Math.sign(dy) : 0;
      if (!sx && !sy) break;
      const stepLen = spacing * Math.hypot(sx, sy);
      // Hysteresis: hold this bead until the pen is within "snap reach" of the
      // next point — the user-facing slider sets how eagerly points catch.
      if (dist < stepLen * (1 - snapReachRef.current / 100)) break;
      const nx = last.x + sx * spacing, ny = last.y + sy * spacing;
      if (nx < 0 || nx > w || ny < 0 || ny > h) { last = null; rulerRef.current = null; setRulerGuide(null); break; } // re-seed on re-entry
      // Ruler bookkeeping: extend the current same-direction run or start a
      // new one anchored at the bead this step departs from.
      if (rulerOnRef.current) {
        const r = rulerRef.current;
        if (r && r.sx === sx && r.sy === sy) {
          if (++r.run >= RULER_LOCK_STEPS) r.locked = true;
        } else {
          rulerRef.current = { sx, sy, run: 1, ox: last.x, oy: last.y, locked: false };
        }
      }
      const pos = keyFromPosition(nx, ny, spacing);
      steps.push(pos);
      last = { x: pos.x, y: pos.y };
    }
    lastPaintRef.current = last;
    if (steps.length === 0) return;
    // One Map copy for the whole walk (applyDrawTool per step would copy per bead).
    setDots((prev) => {
      const next = new Map(prev);
      const { w: cw, h: ch } = canvasBoundsRef.current;
      const mx = mirrorXRef.current, my = mirrorYRef.current;
      const minDist = minSpacingRef.current * FINE_CELL;
      const { hash } = ensurePlaceHash(prev, minDist);
      for (const s of steps) {
        if (toolRef.current === "erase") next.delete(s.key);
        else {
          if (!next.has(s.key) && !farEnoughFast(hash, s.x, s.y, minDist)) continue; // too close to an already-placed bead — skip, walk continues
          const dot: Dot = { key: s.key, x: s.x, y: s.y, color: colorRef.current, radius: radiusRef.current };
          next.set(s.key, dot);
          hash.insert(dot);
          if (mx || my) {
            for (const m of mirrorSnaps(s.x, s.y, cw, ch, snapModeRef.current, mx, my)) {
              if (m.key !== s.key && (next.has(m.key) || farEnoughFast(hash, m.x, m.y, minDist))) {
                const mdot: Dot = { key: m.key, x: m.x, y: m.y, color: colorRef.current, radius: radiusRef.current };
                next.set(m.key, mdot);
                hash.insert(mdot);
              }
            }
          }
        }
      }
      placeHashRef.current.dots = next;
      return next;
    });
  }, [ensurePlaceHash]);

  // ── Touch (finger) input: one finger pans, two fingers pan + pinch-zoom ──
  // together. While a pen is actively drawing, touch points are ignored —
  // palm rejection. Flip FINGER_DRAWS to let a single finger draw like the
  // pen instead (a 2nd finger landing mid-stroke then converts to navigation).
  const FINGER_DRAWS = false;
  const ROT_SNAP = (5 * Math.PI) / 180; // twist snaps to a quarter turn within 5°
  // Multi-finger taps (Procreate-style): two-finger tap = undo, three = redo.
  // A tap = every finger down and up within TAP_MS, none drifting past
  // TAP_SLOP px — so a real pan/pinch/twist can never misfire as one.
  const TAP_MS = 300;
  const TAP_SLOP = 12;
  const tapRef = useRef<{ start: number; maxCount: number; moved: boolean; downs: Map<number, { x: number; y: number }> } | null>(null);
  const touchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gestureRef = useRef<{ dist: number; cx: number; cy: number; angle: number } | null>(null);
  // Unsnapped twist accumulator. Snapping must be display-only: if the snapped
  // value were stored back, every per-frame delta inside the 5° zone would be
  // re-zeroed and a slow twist could never escape it (rotation felt "stuck").
  const rotRawRef = useRef(0);
  const penActiveRef = useRef(false);
  const fingerDrawRef = useRef<number | null>(null); // pointerId of a finger mid-stroke

  // Belt-and-braces for Safari: even with touch-action none, WebKit can hand
  // a Pencil drag to the scroller and pointercancel the stroke unless native
  // touchmove is actively prevented (must be a non-passive DOM listener —
  // React's synthetic handlers can't preventDefault touchmove).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Only block moves that started on the canvas SVG (touch events keep
    // targeting their start element). A blanket preventDefault also killed
    // click synthesis on the overlay buttons — a Pencil tap always wobbles a
    // pixel, fires touchmove, and Safari then swallows the button's click.
    const block = (ev: TouchEvent) => {
      if (svgRef.current?.contains(ev.target as Node)) ev.preventDefault();
    };
    el.addEventListener("touchmove", block, { passive: false });
    return () => el.removeEventListener("touchmove", block);
  }, []);

  const handleTouchNav = useCallback((e: React.PointerEvent, phase: "down" | "move") => {
    const svg = svgRef.current;
    if (!svg) return;
    if (phase === "down") {
      touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      gestureRef.current = null; // re-seed when a 2nd finger starts moving
      return;
    }
    const prev = touchesRef.current.get(e.pointerId);
    if (!prev) return;
    touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...touchesRef.current.values()];
    if (pts.length === 1) {
      // one-finger drag-pan (only when fingers don't draw)
      if (FINGER_DRAWS) return;
      const newPan = { x: panRef.current.x + (e.clientX - prev.x), y: panRef.current.y + (e.clientY - prev.y) };
      panRef.current = newPan; setPan({ ...newPan });
      return;
    }
    if (pts.length >= 2) {
      // two-finger pinch-zoom + twist-rotate + drag-pan, all one gesture
      // anchored at the centroid: the world point under the fingers' midpoint
      // stays glued to it through zoom, rotation, and translation together.
      const [a, b] = pts;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const g = gestureRef.current;
      if (g && g.dist > 0) {
        const rect = svg.getBoundingClientRect();
        const oldZoom = zoomRef.current;
        const newZoom = Math.min(Math.max(oldZoom * (dist / g.dist), MIN_ZOOM), MAX_ZOOM);
        // Twist delta, wrapped so the atan2 seam can't flip the canvas.
        let dRot = angle - g.angle;
        if (dRot > Math.PI) dRot -= 2 * Math.PI;
        else if (dRot < -Math.PI) dRot += 2 * Math.PI;
        let raw = rotRawRef.current + dRot;
        if (raw > Math.PI) raw -= 2 * Math.PI;
        else if (raw < -Math.PI) raw += 2 * Math.PI;
        rotRawRef.current = raw;
        // Soft snap to the nearest quarter turn so "straight" is easy to hit —
        // applied to the displayed angle only; `raw` keeps the true twist.
        const quarter = Math.PI / 2;
        const nearest = Math.round(raw / quarter) * quarter;
        const newRot = Math.abs(raw - nearest) < ROT_SNAP ? nearest : raw;
        const applied = newRot - rotRef.current;
        // pan' = c_new − (zoom'/zoom) · R(Δrot) · (c_old − pan)
        const k = newZoom / oldZoom;
        const rc = Math.cos(applied), rs = Math.sin(applied);
        const vx = (g.cx - rect.left) - panRef.current.x;
        const vy = (g.cy - rect.top) - panRef.current.y;
        const newPan = {
          x: (cx - rect.left) - k * (rc * vx - rs * vy),
          y: (cy - rect.top) - k * (rs * vx + rc * vy),
        };
        zoomRef.current = newZoom; panRef.current = newPan; rotRef.current = newRot;
        setZoom(newZoom); setPan({ ...newPan }); setRot(newRot);
      } else {
        // gesture (re)starts: seed the accumulator from the settled angle
        rotRawRef.current = rotRef.current;
      }
      gestureRef.current = { dist, cx, cy, angle };
    }
  }, []);

  // Hover/click/marquee hit-testing hash — rebuilt lazily only when the
  // active layer's dots Map reference has changed since the last call. Every
  // dot edit already produces a brand-new Map (see useLayers.ts), so
  // reference identity is a free, exact staleness check with no extra
  // bookkeeping. Bucket size tracks the largest dot radius present in the
  // layer so a query always covers findDotAt's hit tolerance (radius + 4),
  // even with the varying per-dot radii tonal image import produces.
  const hitHashRef = useRef<{ dots: Map<string, Dot> | null; hash: SpatialHash<Dot>; maxRadius: number }>({
    dots: null, hash: new SpatialHash<Dot>(HALF_CELL), maxRadius: 0,
  });
  const ensureHitHash = useCallback((dots: Map<string, Dot>) => {
    const cache = hitHashRef.current;
    if (cache.dots !== dots) {
      let maxRadius = 0;
      for (const d of dots.values()) if (d.radius > maxRadius) maxRadius = d.radius;
      const hash = new SpatialHash<Dot>(Math.max(maxRadius + 4, HALF_CELL));
      hash.build(dots.values());
      cache.dots = dots; cache.hash = hash; cache.maxRadius = maxRadius;
    }
    return cache;
  }, []);
  // Same exact math as findDotAt, just pre-filtered to the query point's
  // neighborhood instead of scanning every dot in the layer.
  const findDotAtFast = useCallback((dots: Map<string, Dot>, wx: number, wy: number): Dot | null => {
    const { hash, maxRadius } = ensureHitHash(dots);
    return findDotAt(hash.nearby(wx, wy, maxRadius + 4), wx, wy);
  }, [ensureHitHash]);
  // Same exact bbox math as dotsInRect, pre-filtered to the buckets the
  // marquee rectangle overlaps.
  const dotsInRectFast = useCallback((dots: Map<string, Dot>, wx1: number, wy1: number, wx2: number, wy2: number): Set<string> => {
    const { hash } = ensureHitHash(dots);
    const minX = Math.min(wx1, wx2), maxX = Math.max(wx1, wx2);
    const minY = Math.min(wy1, wy2), maxY = Math.max(wy1, wy2);
    return dotsInRect(hash.inRect(minX, minY, maxX, maxY), wx1, wy1, wx2, wy2);
  }, [ensureHitHash]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Only strokes that start on the canvas SVG count — the container div
    // also holds zoom buttons and panel FABs.
    if (!svgRef.current || !svgRef.current.contains(e.target as Node)) return;

    // Reclaim keyboard shortcuts from a lingering focused text field. The
    // e.preventDefault() below (needed to stop native touch-scroll/text
    // selection on the canvas) also suppresses the browser's implicit
    // focus-shift-on-click — so without this, typing into any field (cell
    // size, canvas W/H, a hex color, a layer name...) and then clicking the
    // canvas to marquee-select leaves that field focused. The global keydown
    // handler's `typing` guard then silently swallows Delete/Backspace/Arrow
    // shortcuts — the "select-all-then-delete does nothing" bug.
    const active = document.activeElement as HTMLElement | null;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) active.blur();
    if (e.pointerType === "touch") {
      if (penActiveRef.current) return; // palm rejection while a pen is drawing
      e.preventDefault();
      handleTouchNav(e, "down");
      // Arm/extend a multi-finger tap candidate (resolved on the last finger up).
      if (touchesRef.current.size === 1) {
        tapRef.current = { start: performance.now(), maxCount: 1, moved: false, downs: new Map([[e.pointerId, { x: e.clientX, y: e.clientY }]]) };
      } else if (tapRef.current) {
        tapRef.current.maxCount = Math.max(tapRef.current.maxCount, touchesRef.current.size);
        tapRef.current.downs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (touchesRef.current.size >= 2) {
        // 2nd finger lands: abandon any one-finger stroke, become a gesture
        if (fingerDrawRef.current !== null) {
          fingerDrawRef.current = null;
          isPaintingRef.current = false;
          lastPaintRef.current = null;
          rulerRef.current = null;
          setRulerGuide(null);
          eraseStrokeRef.current = null;
          isDraggingDotsRef.current = false;
          isMarqueeingRef.current = false;
          setMarqueeBox(null);
        }
        return;
      }
      if (!FINGER_DRAWS) return; // single finger navigates only (pan via handleTouchNav)
      // single finger: fall through and draw exactly like the pen
      fingerDrawRef.current = e.pointerId;
    }
    // ── pen / mouse / single finger: draw, erase, select ──
    if (e.button === 1 || (e.button === 0 && spaceDownRef.current)) {
      e.preventDefault();
      isPanningRef.current = true;
      panStartRef.current = { mx: e.clientX, my: e.clientY, px: panRef.current.x, py: panRef.current.y };
      setIsGrabbing(true);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    // Only a real pen/mouse arms palm rejection — a drawing finger must not
    // block the 2nd finger that converts the stroke into a pan/zoom gesture.
    if (e.pointerType !== "touch") penActiveRef.current = true;

    const world = getSVGPoint(e);
    if (!world) return;

    // Alt+click = eyedropper: pick a dot's color into the brush (works in any tool)
    if (e.altKey) {
      const hit = findDotAtFast(dotsRef.current, world.x, world.y);
      if (hit) { setColor(hit.color); pushRecentColor(hit.color); }
      return;
    }

    if (toolRef.current === "select") {
      const hit = findDotAtFast(dotsRef.current, world.x, world.y);

      // Shift = additive: toggle a dot in/out, or union-marquee from current selection
      if (e.shiftKey) {
        if (hit) {
          const next = new Set(selectedKeysRef.current);
          next.has(hit.key) ? next.delete(hit.key) : next.add(hit.key);
          setSelectedKeys(next);
          selectedKeysRef.current = next;
        } else {
          marqueeBaseRef.current = new Set(selectedKeysRef.current);
          isMarqueeingRef.current = true;
          marqueeStartRef.current = { wx: world.x, wy: world.y };
          setMarqueeBox(null);
        }
        return;
      }

      if (hit && selectedKeysRef.current.has(hit.key)) {
        // Pressing down on a dot that's already selected drags the whole
        // selection immediately.
        pushUndo();
        isDraggingDotsRef.current = true;
        dragStartWorldRef.current = { x: world.x, y: world.y };
        // No clone: nothing mutates dotsRef.current in place, and no setDots
        // call happens between here and the pointerup commit (which reads
        // preDragDotsRef, then only THEN reassigns dotsRef.current) — so
        // aliasing the current Map is safe and skips an O(n) copy on every
        // drag start.
        preDragDotsRef.current = dotsRef.current;
        dragBBoxRef.current = selectionBBox(dotsRef.current, selectedKeysRef.current);
        snappedOffsetRef.current = { dx: 0, dy: 0 };
      } else if (hit) {
        // Hit an unselected dot — ambiguous (see pendingClickRef above).
        // Deferred to pointermove/pointerup instead of deciding here.
        pendingClickRef.current = { hit, sx: e.clientX, sy: e.clientY, world: { wx: world.x, wy: world.y } };
      } else {
        setSelectedKeys(new Set());
        selectedKeysRef.current = new Set();
        marqueeBaseRef.current = new Set();
        isMarqueeingRef.current = true;
        marqueeStartRef.current = { wx: world.x, wy: world.y };
        setMarqueeBox(null);
      }
      return;
    }

    if (toolRef.current === "line") {
      // Nothing is mutated yet — just anchor the start point and arm the
      // drag. The whole line is a single undo step, pushed on commit.
      const snap = getNearestSnap(world.x, world.y, CELL_SIZE, snapModeRef.current, canvasBoundsRef.current.w, canvasBoundsRef.current.h);
      if (!snap) return;
      isPaintingRef.current = true;
      lineStartRef.current = { x: snap.x, y: snap.y };
      lineEndRef.current = { x: snap.x, y: snap.y };
      setLineGuide({ x1: snap.x, y1: snap.y, x2: snap.x, y2: snap.y });
      setLinePreview([snap]);
      return;
    }

    if (toolRef.current === "shape") {
      const snap = getNearestSnap(world.x, world.y, CELL_SIZE, snapModeRef.current, canvasBoundsRef.current.w, canvasBoundsRef.current.h);
      const s = snap ? { x: snap.x, y: snap.y } : world;
      isPaintingRef.current = true;
      shapeStartRef.current = s;
      shapeEndRef.current = s;
      setShapeGuide({ cx: s.x, cy: s.y, rx: 0, ry: 0 });
      setShapePreview(null);
      return;
    }

    if (toolRef.current === "pen") {
      const anchors = penAnchorsRef.current;
      // Match the live preview: while Shift is held, the placed anchor follows
      // the 15°-constrained ray from the last anchor (not the raw cursor), so
      // the click lands on the ghost dot the preview showed — not off at the
      // cursor.
      const last = anchors[anchors.length - 1];
      const target = (e.shiftKey && last) ? constrainAngle15(last.x, last.y, world.x, world.y) : world;
      const snap = getNearestSnap(target.x, target.y, CELL_SIZE, snapModeRef.current, canvasBoundsRef.current.w, canvasBoundsRef.current.h);
      if (!snap) return;

      // Clicking back near the first anchor closes the path (a diamond/lens
      // outline needs this) — appending the first anchor again makes the
      // closing segment fall out of the same arc-length walk for free.
      if (anchors.length >= 2) {
        const first = anchors[0];
        const closeReach = snapSpacing(snapModeRef.current) * 0.75;
        if (Math.hypot(snap.x - first.x, snap.y - first.y) <= closeReach) {
          finishPenPath([...anchors, { x: first.x, y: first.y }]);
          return;
        }
      }

      const next = [...anchors, { x: snap.x, y: snap.y }];
      penAnchorsRef.current = next;
      setPenAnchors(next);
      penCursorRef.current = { x: snap.x, y: snap.y };
      setPenCursor({ x: snap.x, y: snap.y });
      setPenPreview(penDots(next));
      return;
    }

    if (toolRef.current === "array" && arrayModeRef.current === "curve") {
      // Same click-to-anchor state machine as Pen, but nothing is computed or
      // committed here — this only accumulates path anchors. The live
      // preview (render-time) and Apply both read arrayCurveAnchorsRef
      // directly whenever they need it.
      const anchors = arrayCurveAnchorsRef.current;
      const last = anchors[anchors.length - 1];
      const target = (e.shiftKey && last) ? constrainAngle15(last.x, last.y, world.x, world.y) : world;
      const snap = getNearestSnap(target.x, target.y, CELL_SIZE, snapModeRef.current, canvasBoundsRef.current.w, canvasBoundsRef.current.h);
      if (!snap) return;

      // Closing the loop near the first anchor is free (same reach test as
      // Pen) — lets a curve array wrap into a closed ring of motifs.
      if (anchors.length >= 2) {
        const first = anchors[0];
        const closeReach = snapSpacing(snapModeRef.current) * 0.75;
        if (Math.hypot(snap.x - first.x, snap.y - first.y) <= closeReach) {
          const closed = [...anchors, { x: first.x, y: first.y }];
          arrayCurveAnchorsRef.current = closed; setArrayCurveAnchors(closed);
          return;
        }
      }

      const nextAnchors = [...anchors, { x: snap.x, y: snap.y }];
      arrayCurveAnchorsRef.current = nextAnchors; setArrayCurveAnchors(nextAnchors);
      arrayCurveCursorRef.current = { x: snap.x, y: snap.y }; setArrayCurveCursor({ x: snap.x, y: snap.y });
      return;
    }

    pushUndo();
    isPaintingRef.current = true;

    if (toolRef.current === "erase") {
      setPreview({ x: world.x, y: world.y });
      eraseStrokeRef.current = { x: world.x, y: world.y };
      eraseAlong(world.x, world.y, world.x, world.y);
      return;
    }

    const snap = getNearestSnap(world.x, world.y, CELL_SIZE, snapModeRef.current, canvasBoundsRef.current.w, canvasBoundsRef.current.h);
    if (snap) { setPreview({ x: snap.x, y: snap.y }); applyDrawTool(snap.key, snap.x, snap.y); }
    lastPaintRef.current = snap ? { x: snap.x, y: snap.y } : null;
    rulerRef.current = null;
    setRulerGuide(null);
  }, [getSVGPoint, applyDrawTool, eraseAlong, pushUndo, pushRecentColor, handleTouchNav, finishPenPath, penDots, findDotAtFast]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    // Select-same-color only makes sense in the select tool. Without this
    // gate, two quick pen taps while drawing register as a double-click and
    // surprise-select dots mid-stroke.
    if (toolRef.current !== "select") return;
    if (!svgRef.current || !svgRef.current.contains(e.target as Node)) return;
    if (e.button !== 0) return;
    const world = getSVGPoint(e);
    if (!world) return;
    const hit = findDotAtFast(dotsRef.current, world.x, world.y);
    if (hit) selectSameColor(hit.color);
  }, [getSVGPoint, selectSameColor, findDotAtFast]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "touch") {
      if (penActiveRef.current) return;
      const t = tapRef.current;
      if (t && !t.moved) {
        const d0 = t.downs.get(e.pointerId);
        if (d0 && Math.hypot(e.clientX - d0.x, e.clientY - d0.y) > TAP_SLOP) t.moved = true;
      }
      if (fingerDrawRef.current === e.pointerId && touchesRef.current.size === 1) {
        // keep the nav position fresh so a 2nd finger can take over cleanly
        touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        // fall through: the drawing finger paints like the pen
      } else {
        handleTouchNav(e, "move");
        return;
      }
    }
    if (isPanningRef.current && panStartRef.current) {
      const newPan = { x: panStartRef.current.px + (e.clientX - panStartRef.current.mx), y: panStartRef.current.py + (e.clientY - panStartRef.current.my) };
      panRef.current = newPan; setPan({ ...newPan });
      return;
    }

    const world = getSVGPoint(e);
    if (!world) return;

    if (toolRef.current === "select") {
      if (pendingClickRef.current) {
        const p = pendingClickRef.current;
        if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) <= SELECT_CLICK_SLOP) return;
        // Moved past click tolerance without the dot ever being selected —
        // this was always a marquee drag, not a single-dot grab.
        pendingClickRef.current = null;
        setSelectedKeys(new Set());
        selectedKeysRef.current = new Set();
        marqueeBaseRef.current = new Set();
        isMarqueeingRef.current = true;
        marqueeStartRef.current = p.world;
        setMarqueeBox(null);
      }
      if (isDraggingDotsRef.current && dragStartWorldRef.current) {
        const rawDx = world.x - dragStartWorldRef.current.x;
        const rawDy = world.y - dragStartWorldRef.current.y;
        const dragSpacing = snapSpacing(snapModeRef.current);
        let snappedDx = Math.round(rawDx / dragSpacing) * dragSpacing;
        let snappedDy = Math.round(rawDy / dragSpacing) * dragSpacing;
        const bb = dragBBoxRef.current;
        if (bb) ({ dx: snappedDx, dy: snappedDy } = clampOffsetToCanvas(snappedDx, snappedDy, bb, canvasBoundsRef.current.w, canvasBoundsRef.current.h, dragSpacing));
        snappedOffsetRef.current = { dx: snappedDx, dy: snappedDy };
        setDragOffset({ dx: snappedDx, dy: snappedDy });
      } else if (isMarqueeingRef.current && marqueeStartRef.current) {
        setMarqueeBox({ wx1: marqueeStartRef.current.wx, wy1: marqueeStartRef.current.wy, wx2: world.x, wy2: world.y });
        const keys = dotsInRectFast(dotsRef.current, marqueeStartRef.current.wx, marqueeStartRef.current.wy, world.x, world.y);
        const union = new Set(marqueeBaseRef.current);
        for (const k of keys) union.add(k);
        setSelectedKeys(union);
        selectedKeysRef.current = union;
      } else {
        const hit = findDotAtFast(dotsRef.current, world.x, world.y);
        setHoveredDotKey(hit ? hit.key : null);
      }
      return;
    }

    if (toolRef.current === "erase") {
      // The eraser cursor follows the pen freely (it's an area, not a snap),
      // sweeping a segment per sample so fast drags can't skip dots.
      setPreview({ x: world.x, y: world.y });
      if (isPaintingRef.current) {
        const native = e.nativeEvent as PointerEvent;
        const samples = native.getCoalescedEvents?.() ?? [];
        for (const ev of samples.length ? samples : [native]) {
          const pt = getSVGPoint(ev as unknown as React.MouseEvent);
          if (!pt) continue;
          const from = eraseStrokeRef.current ?? pt;
          eraseAlong(from.x, from.y, pt.x, pt.y);
          eraseStrokeRef.current = { x: pt.x, y: pt.y };
        }
      }
      return;
    }

    if (toolRef.current === "line") {
      if (isPaintingRef.current && lineStartRef.current) {
        const start = lineStartRef.current;
        const end = e.shiftKey ? constrainAngle15(start.x, start.y, world.x, world.y) : world;
        lineEndRef.current = end;
        setLineGuide({ x1: start.x, y1: start.y, x2: end.x, y2: end.y });
        const { w, h } = canvasBoundsRef.current;
        setLinePreview(computePathDots([start, end], CELL_SIZE, snapModeRef.current, w, h, spacingOpts()));
      }
      return;
    }

    if (toolRef.current === "shape") {
      if (isPaintingRef.current && shapeStartRef.current) {
        const start = shapeStartRef.current;
        let end = world;
        if (e.shiftKey) { // constrain to a circle
          const dx = world.x - start.x, dy = world.y - start.y;
          const sq = Math.min(Math.abs(dx), Math.abs(dy));
          end = { x: start.x + Math.sign(dx) * sq, y: start.y + Math.sign(dy) * sq };
        }
        const snapE = getNearestSnap(end.x, end.y, CELL_SIZE, snapModeRef.current, canvasBoundsRef.current.w, canvasBoundsRef.current.h);
        const e2 = snapE ? { x: snapE.x, y: snapE.y } : end;
        shapeEndRef.current = e2;
        const { dots, cx, cy, rx, ry } = shapeDotsFor(start, e2);
        setShapeGuide({ cx, cy, rx, ry });
        setShapePreview(dots);
      }
      return;
    }

    if (toolRef.current === "pen") {
      if (penAnchorsRef.current.length > 0) {
        const last = penAnchorsRef.current[penAnchorsRef.current.length - 1];
        const cursor = e.shiftKey ? constrainAngle15(last.x, last.y, world.x, world.y) : world;
        penCursorRef.current = cursor;
        setPenCursor(cursor);
        setPenPreview(penDots([...penAnchorsRef.current, cursor]));
      }
      return;
    }

    if (toolRef.current === "array" && arrayModeRef.current === "curve") {
      if (arrayCurveAnchorsRef.current.length > 0) {
        const snap = getNearestSnap(world.x, world.y, CELL_SIZE, snapModeRef.current, canvasBoundsRef.current.w, canvasBoundsRef.current.h);
        const cursor = snap ? { x: snap.x, y: snap.y } : world;
        arrayCurveCursorRef.current = cursor; setArrayCurveCursor(cursor);
      }
      return;
    }

    const snap = getNearestSnap(world.x, world.y, CELL_SIZE, snapModeRef.current, canvasBoundsRef.current.w, canvasBoundsRef.current.h);
    if (snap) setPreview({ x: snap.x, y: snap.y });

    if (isPaintingRef.current) {
      // Walk every coalesced sample (Pencil reports up to 240Hz; Safari folds
      // them into one event per frame) so curves keep their true shape.
      const native = e.nativeEvent as PointerEvent;
      const samples = native.getCoalescedEvents?.() ?? [];
      for (const ev of samples.length ? samples : [native]) {
        const pt = getSVGPoint(ev as unknown as React.MouseEvent);
        if (!pt) continue;
        if (lastPaintRef.current) {
          paintStrokeTo(pt.x, pt.y);
        } else {
          // (Re-)seed: stroke start, or pen re-entering the canvas bounds.
          const s = getNearestSnap(pt.x, pt.y, CELL_SIZE, snapModeRef.current, canvasBoundsRef.current.w, canvasBoundsRef.current.h);
          if (s) { applyDrawTool(s.key, s.x, s.y); lastPaintRef.current = { x: s.x, y: s.y }; }
        }
      }
    }
  }, [getSVGPoint, applyDrawTool, paintStrokeTo, handleTouchNav, penDots, spacingOpts, shapeDotsFor, dotsInRectFast, findDotAtFast]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "touch") {
      touchesRef.current.delete(e.pointerId);
      if (touchesRef.current.size < 2) gestureRef.current = null;
      // Last finger up resolves a pending multi-finger tap: undo / redo.
      if (touchesRef.current.size === 0) {
        const t = tapRef.current;
        tapRef.current = null;
        if (t && !t.moved && performance.now() - t.start <= TAP_MS) {
          if (t.maxCount === 2) undo();
          else if (t.maxCount === 3) redo();
        }
      }
      if (fingerDrawRef.current !== e.pointerId) return;
      fingerDrawRef.current = null;
      // fall through: finish the finger stroke exactly like the pen
    }
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    penActiveRef.current = false;

    if (e.button === 1 || isPanningRef.current) {
      isPanningRef.current = false; panStartRef.current = null; setIsGrabbing(false);
      return;
    }

    if (toolRef.current === "select") {
      if (pendingClickRef.current) {
        // Released without ever exceeding SELECT_CLICK_SLOP — a plain click,
        // resolved now as select-just-this-dot.
        const next = new Set([pendingClickRef.current.hit.key]);
        setSelectedKeys(next);
        selectedKeysRef.current = next;
        pendingClickRef.current = null;
        return;
      }
      if (isDraggingDotsRef.current) {
        const { dx, dy } = snappedOffsetRef.current;
        if (dx !== 0 || dy !== 0) {
          const next = new Map(preDragDotsRef.current);
          const newSelected = new Set<string>();
          for (const key of selectedKeysRef.current) {
            const dot = preDragDotsRef.current.get(key);
            if (!dot) continue;
            next.delete(key);
            // Each dot re-keys at ITS OWN lattice resolution, not the tool's
            // current snapMode — see nativeSpacing's doc comment.
            const newPos = keyFromPosition(dot.x + dx, dot.y + dy, nativeSpacing(dot.key));
            next.set(newPos.key, { ...dot, key: newPos.key, x: newPos.x, y: newPos.y });
            newSelected.add(newPos.key);
          }
          dotsRef.current = next;
          setDots(next);
          setSelectedKeys(newSelected);
          selectedKeysRef.current = newSelected;
        }
        isDraggingDotsRef.current = false;
        dragStartWorldRef.current = null;
        snappedOffsetRef.current = { dx: 0, dy: 0 };
        setDragOffset({ dx: 0, dy: 0 });
      } else if (isMarqueeingRef.current) {
        isMarqueeingRef.current = false;
        marqueeStartRef.current = null;
        setMarqueeBox(null);
      }
      return;
    }

    if (toolRef.current === "line") {
      if (isPaintingRef.current && lineStartRef.current) {
        const start = lineStartRef.current;
        const world = getSVGPoint(e);
        if (world) {
          const end = e.shiftKey ? constrainAngle15(start.x, start.y, world.x, world.y) : world;
          const { w, h } = canvasBoundsRef.current;
          const pts = computePathDots([start, end], CELL_SIZE, snapModeRef.current, w, h, spacingOpts());
          if (pts.length) { pushUndo(); commitLineDots(pts); }
        }
      }
      isPaintingRef.current = false;
      lineStartRef.current = null;
      lineEndRef.current = null;
      setLineGuide(null);
      setLinePreview(null);
      return;
    }

    if (toolRef.current === "shape") {
      if (isPaintingRef.current && shapeStartRef.current && shapeEndRef.current) {
        const { dots } = shapeDotsFor(shapeStartRef.current, shapeEndRef.current);
        if (dots.length) { pushUndo(); commitLineDots(dots); }
      }
      isPaintingRef.current = false;
      shapeStartRef.current = null;
      shapeEndRef.current = null;
      setShapeGuide(null);
      setShapePreview(null);
      return;
    }

    // Pen: a click's release commits nothing — the path stays open, waiting
    // for the next anchor (or Enter / close-click / Escape / Backspace).
    if (toolRef.current === "pen") return;
    // Array/Curve: same — clicks fully resolve on pointer-down, nothing to
    // do on release. Linear/Grid have no drag at all, so they never reach here.
    if (toolRef.current === "array") return;

    isPaintingRef.current = false;
    // Remember where this draw ended so the next placement can be measured
    // against it (capture before lastPaintRef is cleared below), and record
    // the gap from the previous placement into the sequence HUD.
    if (toolRef.current === "draw" && lastPaintRef.current) {
      const np = lastPaintRef.current;
      const prev = lastPlacedRef.current;
      if (prev) {
        const gx = Math.abs(Math.round((np.x - prev.x) / FINE_CELL));
        const gy = Math.abs(Math.round((np.y - prev.y) / FINE_CELL));
        if (gx !== 0 || gy !== 0) setGapSeq((s) => [...s, { x: gx, y: gy }].slice(-6));
      }
      lastPlacedRef.current = np;
      setLastPlaced(np);
    }
    lastPaintRef.current = null;
    rulerRef.current = null;
    setRulerGuide(null);
    eraseStrokeRef.current = null;
  }, [undo, redo, getSVGPoint, pushUndo, commitLineDots, spacingOpts, shapeDotsFor]);

  const handlePointerLeave = useCallback(() => {
    // iPad WebKit fires ghost pointerleave events mid-stroke, with the pen
    // still in contact and captured — resetting here disarmed painting after
    // the first dot, so trails never formed. While any press-driven
    // interaction is live, ignore leave; pointerup/cancel own the real cleanup.
    if (penActiveRef.current || fingerDrawRef.current !== null || isPaintingRef.current ||
      isPanningRef.current || isDraggingDotsRef.current || isMarqueeingRef.current || pendingClickRef.current) return;
    setPreview(null);
    isPaintingRef.current = false;
    fingerDrawRef.current = null;
    lastPaintRef.current = null;
    rulerRef.current = null;
    setRulerGuide(null);
    eraseStrokeRef.current = null;
    lineStartRef.current = null;
    lineEndRef.current = null;
    setLineGuide(null);
    setLinePreview(null);
    shapeStartRef.current = null;
    shapeEndRef.current = null;
    setShapeGuide(null);
    setShapePreview(null);
    isPanningRef.current = false;
    panStartRef.current = null;
    setIsGrabbing(false);
    setHoveredDotKey(null);
  }, []);

  const handlePointerCancel = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "touch") {
      touchesRef.current.delete(e.pointerId);
      if (touchesRef.current.size < 2) gestureRef.current = null;
      tapRef.current = null; // a cancelled touch can't be a tap
      if (fingerDrawRef.current !== e.pointerId) return;
      fingerDrawRef.current = null;
      // fall through: reset stroke state like a cancelled pen
    }
    penActiveRef.current = false;
    isPaintingRef.current = false;
    lastPaintRef.current = null;
    rulerRef.current = null;
    setRulerGuide(null);
    eraseStrokeRef.current = null;
    lineStartRef.current = null;
    lineEndRef.current = null;
    setLineGuide(null);
    setLinePreview(null);
    shapeStartRef.current = null;
    shapeEndRef.current = null;
    setShapeGuide(null);
    setShapePreview(null);
    isDraggingDotsRef.current = false;
    isMarqueeingRef.current = false;
    pendingClickRef.current = null;
    setMarqueeBox(null);
  }, []);

  const viewportRef = useRef(viewportSize);
  useEffect(() => { viewportRef.current = viewportSize; }, [viewportSize]);

  const zoomTo = useCallback((newZoom: number) => {
    const cx = viewportSize.width / 2; const cy = viewportSize.height / 2;
    const clamped = Math.min(Math.max(newZoom, MIN_ZOOM), MAX_ZOOM);
    applyViewport(clamped, { x: cx - (cx - panRef.current.x) * (clamped / zoomRef.current), y: cy - (cy - panRef.current.y) * (clamped / zoomRef.current) });
  }, [viewportSize, applyViewport]);

  const exportSVG = useCallback(() => {
    sfx.export();
    const allDots = flattenLayers(layers);
    const content = buildSVGString(allDots, canvasPxW, canvasPxH, pxPerUnit, unit, canvasBg, gridColor, gridOpacity, gridThickness, CELL_SIZE, dotShape);
    const blob = new Blob([content], { type: "image/svg+xml" });
    downloadBlob(blob, "dot-art.svg");
  }, [layers, canvasPxW, canvasPxH, pxPerUnit, unit, canvasBg, gridColor, gridOpacity, gridThickness, dotShape]);

  const exportPNG = useCallback(() => {
    // Browsers cap a single <canvas> dimension around ~16000px (Chrome; some
    // are lower) — a large physical canvas at a fine cell size can exceed
    // that at the usual 4x scale and silently produce a blank/truncated PNG.
    // Step the scale down to whatever still fits; if even 1x doesn't fit,
    // there's no usable raster size — bail out and point at SVG (vector,
    // no size ceiling at all).
    const MAX_RASTER_DIM = 16000;
    const rawScale = Math.floor(MAX_RASTER_DIM / Math.max(canvasPxW, canvasPxH));
    if (rawScale < 1) {
      alert("This canvas is too large to export as PNG at any usable resolution — export SVG instead (vector, no size limit).");
      return;
    }
    const scale = Math.min(4, rawScale);
    sfx.export();
    const allDots = flattenLayers(layers);
    const content = buildSVGString(allDots, canvasPxW, canvasPxH, pxPerUnit, unit, canvasBg, gridColor, gridOpacity, gridThickness, CELL_SIZE, dotShape);
    const outW = Math.max(1, Math.round(canvasPxW * scale));
    const outH = Math.max(1, Math.round(canvasPxH * scale));
    const captionH = Math.round(24 * scale); // reserved white strip below the artwork
    const svgBlob = new Blob([content], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = outW; canvas.height = outH + captionH;
      const ctx = canvas.getContext("2d");
      if (!ctx) { URL.revokeObjectURL(url); return; }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, outW, outH);
      URL.revokeObjectURL(url);
      // White caption strip — readable regardless of the artwork's own background color.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, outH, outW, captionH);
      ctx.fillStyle = "#888888";
      ctx.font = `${Math.round(13 * scale)}px sans-serif`;
      ctx.textBaseline = "middle";
      ctx.fillText(`${allDots.length} dots`, Math.round(8 * scale), outH + captionH / 2);
      canvas.toBlob((blob) => {
        if (!blob) return;
        downloadBlob(blob, "dot-art.png");
      }, "image/png");
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }, [layers, canvasPxW, canvasPxH, pxPerUnit, unit, canvasBg, gridColor, gridOpacity, gridThickness, dotShape]);

  const exportPDF = useCallback(() => {
    const widthMm = unit === "mm" ? canvasPhysW : convertUnit(canvasPhysW, unit, "mm");
    const heightMm = unit === "mm" ? canvasPhysH : convertUnit(canvasPhysH, unit, "mm");

    // Same raster-dimension ceiling as exportPNG — step dpi down from the
    // usual 300 (print quality) if the physical size would exceed it, and
    // bail below a "not worth it" floor (72dpi, screen resolution) rather
    // than silently rendering a blank/truncated page.
    const MAX_RASTER_DIM = 16000;
    const longestMm = Math.max(widthMm, heightMm);
    const rawDpi = Math.floor(MAX_RASTER_DIM / (longestMm / 25.4));
    if (rawDpi < 72) {
      alert("This canvas is too large to export as PDF at any usable resolution — export SVG instead (vector, no size limit).");
      return;
    }
    const dpi = Math.min(300, rawDpi); // print quality, capped by the raster ceiling

    sfx.export();
    const allDots = flattenLayers(layers);
    const svgContent = buildSVGString(allDots, canvasPxW, canvasPxH, pxPerUnit, unit, canvasBg, gridColor, gridOpacity, gridThickness, CELL_SIZE, dotShape);

    const renderW = Math.round(widthMm / 25.4 * dpi);
    const renderH = Math.round(heightMm / 25.4 * dpi);

    const svgBlob = new Blob([svgContent], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = renderW; canvas.height = renderH;
      const ctx = canvas.getContext("2d");
      if (!ctx) { URL.revokeObjectURL(url); return; }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, renderW, renderH);
      URL.revokeObjectURL(url);

      const { jsPDF } = await import("jspdf");
      const orientation = widthMm > heightMm ? "landscape" : "portrait";
      const captionMm = 6; // reserved strip below the artwork for the dot-count caption
      const pdf = new jsPDF({
        orientation: orientation as "landscape" | "portrait",
        unit: "mm",
        format: [widthMm, heightMm + captionMm],
      });
      const imgData = canvas.toDataURL("image/png");
      pdf.addImage(imgData, "PNG", 0, 0, widthMm, heightMm);
      pdf.setFontSize(9);
      pdf.setTextColor(120);
      pdf.text(`${allDots.length} dots`, 3, heightMm + captionMm - 2);
      downloadBlob(pdf.output("blob"), "dot-art.pdf");
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }, [layers, canvasPxW, canvasPxH, pxPerUnit, unit, canvasBg, gridColor, gridOpacity, gridThickness, canvasPhysW, canvasPhysH, dotShape]);

  // ── Editable project: serialize / save / open / restore ──
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const importPreviewRef = useRef<HTMLCanvasElement>(null); // the modal's preview canvas
  const importPreviewBoxRef = useRef<HTMLDivElement>(null);  // its container — measured for resize-fit
  const fontInputRef = useRef<HTMLInputElement>(null);
  const textPreviewRef = useRef<HTMLCanvasElement>(null);

  const buildScene = useCallback((): SceneFile => ({
    app: PROJECT_TAG,
    version: PROJECT_VERSION,
    dots: flattenLayers(layers), // flattened, for back-compat readers
    layers: layers.map((l) => ({ id: l.id, name: l.name, visible: l.visible, dots: Array.from(l.dots.values()) })),
    unit, cellPhysical, canvasPhysW, canvasPhysH,
    canvasBg, gridColor, gridOpacity, gridThickness,
    snapMode, color, radius, snapReach, eraseRadius, recentColors, minSpacing,
  }), [layers, unit, cellPhysical, canvasPhysW, canvasPhysH, canvasBg, gridColor,
    gridOpacity, gridThickness, snapMode, color, radius, snapReach, eraseRadius, recentColors, minSpacing]);

  // Replace the entire document with a loaded scene (undoable, re-fits the view).
  const applyScene = useCallback((scene: SceneFile) => {
    // Written synchronously (not left to the debounced autosave effect below)
    // so AUTOSAVE_KEY and activeProjectIdRef can never point at mismatched
    // documents — e.g. Create New mints a new id and this scene in the same
    // tick; without this, a crash inside the ~400ms autosave debounce window
    // would leave AUTOSAVE_KEY holding the PREVIOUS project's dots under the
    // NEW project's id, and the next library flush would silently overwrite
    // the new project's IndexedDB record with stale content.
    try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(scene)); } catch { /* quota / private mode */ }
    pushUndo();
    const nextLayers = sceneToLayers(scene);
    const activeId = nextLayers[nextLayers.length - 1].id;
    setLayers(nextLayers); layersRef.current = nextLayers;
    setActiveLayerId(activeId); activeLayerIdRef.current = activeId;
    dotsRef.current = nextLayers[nextLayers.length - 1].dots;
    setSelectedKeys(new Set()); selectedKeysRef.current = new Set();

    setUnit(scene.unit);
    setCellPhysical(scene.cellPhysical); setCellInput(String(scene.cellPhysical));
    setCanvasPhysW(scene.canvasPhysW); setWInput(String(scene.canvasPhysW));
    setCanvasPhysH(scene.canvasPhysH); setHInput(String(scene.canvasPhysH));
    setCanvasBg(scene.canvasBg);
    setGridColor(scene.gridColor);
    setGridOpacity(scene.gridOpacity);
    setGridThickness(scene.gridThickness);
    setSnapMode(scene.snapMode); snapModeRef.current = scene.snapMode;
    setColor(scene.color); colorRef.current = scene.color;
    setRadius(scene.radius); radiusRef.current = scene.radius;
    setSnapReach(scene.snapReach); snapReachRef.current = scene.snapReach;
    setEraseRadius(scene.eraseRadius); eraseRadiusRef.current = scene.eraseRadius;
    if (Array.isArray(scene.recentColors)) setRecentColors(scene.recentColors);
    const nextMinSpacing = scene.minSpacing ?? 1; // optional field, back-compat with older files
    setMinSpacing(nextMinSpacing); minSpacingRef.current = nextMinSpacing;

    // Fit the loaded canvas to the viewport. Computed from the scene's own
    // dimensions (pure numbers via viewportRef) so it's correct immediately,
    // without waiting for the new canvasPxW to flow through a render.
    const pxW = scene.canvasPhysW * (CELL_SIZE / scene.cellPhysical);
    const pxH = scene.canvasPhysH * (CELL_SIZE / scene.cellPhysical);
    const pad = 60; const vp = viewportRef.current;
    const availW = vp.width - pad * 2; const availH = vp.height - pad * 2;
    if (availW > 0 && availH > 0 && pxW > 0 && pxH > 0) {
      const z = Math.min(Math.max(Math.min(availW / pxW, availH / pxH, 4), MIN_ZOOM), MAX_ZOOM);
      rotRef.current = 0; setRot(0);
      applyViewport(z, { x: (vp.width - pxW * z) / 2, y: (vp.height - pxH * z) / 2 });
    }
  }, [pushUndo, applyViewport]);

  // Canvas nav arrows: dir=1 = layer above (next index up — index 0 is the
  // bottom of the stack, same convention as moveLayer's "Move up"), dir=-1 =
  // layer below. Reuses selectLayer (clears selection, syncs refs, plays its
  // own sfx.toggle() — no need to fire a second sound here) so the arrows
  // are just another entry point into the same op as the Layers panel.
  const switchLayer = useCallback((dir: 1 | -1) => {
    const ls = layersRef.current;
    const idx = ls.findIndex((l) => l.id === activeLayerIdRef.current);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= ls.length) return;
    const target = ls[j];
    selectLayer(target.id);
    setLayerPulseKey((k) => k + 1);
    window.clearTimeout(layerToastTimerRef.current);
    setLayerToast({ name: target.name, dir, id: Date.now() });
    layerToastTimerRef.current = window.setTimeout(() => setLayerToast(null), 900);
  }, [selectLayer]);

  const saveProject = useCallback(() => {
    sfx.export();
    const blob = new Blob([JSON.stringify(buildScene(), null, 2)], { type: "application/json" });
    downloadBlob(blob, "tangaliya-project.json");
    void flushActiveProjectToLibrary();
  }, [buildScene]);

  const openProjectFile = useCallback((file: File, afterApply?: (scene: SceneFile | null) => void) => {
    const reader = new FileReader();
    reader.onload = () => {
      const scene = parseScene(String(reader.result));
      if (!scene) { alert("That doesn't look like a Tangaliya project file."); afterApply?.(null); return; }
      sfx.ui();
      applyScene(scene);
      afterApply?.(scene);
    };
    reader.readAsText(file);
  }, [applyScene]);

  // ── Project library (Home screen) ──
  // Coarser, event-driven persistence layered on top of the always-current
  // AUTOSAVE_KEY mirror above: a project only gets an IndexedDB record (with
  // a rasterized thumbnail) when the user actually leaves the editor for
  // Home, saves explicitly, or mints a new/loaded document — never on every
  // debounced autosave tick, since thumbnail capture is an async SVG->canvas
  // rasterize that would be wasteful (and racy) to run on every keystroke.
  const commitToLibrary = useCallback(async (scene: SceneFile, id: string) => {
    const pxW = scene.canvasPhysW * (CELL_SIZE / scene.cellPhysical);
    const pxH = scene.canvasPhysH * (CELL_SIZE / scene.cellPhysical);
    const svg = buildSVGString(flattenLayers(sceneToLayers(scene)), pxW, pxH, CELL_SIZE / scene.cellPhysical,
      scene.unit, scene.canvasBg, scene.gridColor, scene.gridOpacity, scene.gridThickness, CELL_SIZE, dotShape);
    let thumbnail = "";
    try { thumbnail = await captureThumbnail(svg, pxW, pxH); } catch { /* non-fatal — tile just shows a blank swatch */ }
    const existing = await getProject(id);
    await putProject({ id, name: existing?.name ?? randomProjectName(), thumbnail, lastModified: Date.now(), scene });
  }, [dotShape]);

  const flushActiveProjectToLibrary = useCallback(async () => {
    const scene = buildScene();
    const isBlank = (scene.layers ?? []).every((l) => l.dots.length === 0);
    if (isBlank && activeProjectIdRef.current === null) return; // never-touched document — nothing worth a tile
    let id = activeProjectIdRef.current;
    if (id === null) {
      id = genProjectId();
      activeProjectIdRef.current = id;
      setActiveProjectId(id);
    }
    await commitToLibrary(scene, id);
  }, [buildScene, commitToLibrary]);

  const createNewProject = useCallback(async () => {
    const scene = defaultScene();
    applyScene(scene);
    const id = genProjectId();
    activeProjectIdRef.current = id;
    setActiveProjectId(id);
    // No thumbnail yet — it'd just rasterize an empty canvas; the next real
    // flush (leaving for Home, saving) captures the first meaningful preview.
    await putProject({ id, name: randomProjectName(), thumbnail: "", lastModified: Date.now(), scene });
  }, [applyScene]);

  const openLibraryProject = useCallback(async (id: string) => {
    // The live document IS this project already (Home can now show on boot,
    // before the flushing click that used to guarantee freshness) — the
    // library record may be staler than what's already on screen (nothing
    // flushed since the last coarse trigger). Re-applying it would clobber
    // fresher work, so treat opening your own active tile as "resume", not
    // "reload from disk".
    if (id === activeProjectIdRef.current) return true;
    const record = await getProject(id);
    if (!record) return false; // vanished (e.g. deleted from another tab) — Home's own list will drop it too
    applyScene(record.scene);
    activeProjectIdRef.current = id;
    setActiveProjectId(id);
    return true;
  }, [applyScene]);

  const openProjectFileAndRegister = useCallback((file: File) => {
    return new Promise<boolean>((resolve) => {
      openProjectFile(file, (scene) => {
        if (!scene) { resolve(false); return; }
        const id = genProjectId();
        activeProjectIdRef.current = id;
        setActiveProjectId(id);
        void commitToLibrary(scene, id).then(() => resolve(true));
      });
    });
  }, [openProjectFile, commitToLibrary]);

  // If the tile for the project currently mirrored by this session gets
  // deleted from Home, drop the pointer rather than let the next flush
  // resurrect it under the same id — a fresh id is minted next time instead.
  const notifyProjectDeleted = useCallback((id: string) => {
    if (activeProjectIdRef.current === id) { activeProjectIdRef.current = null; setActiveProjectId(null); }
  }, []);

  // One-time migration: an existing single-autosave user has no library yet.
  // Runs off the microtask queue (needs an async IndexedDB read) rather than
  // the synchronous bootRef block, guarded so it can never double-fire (incl.
  // React 18 StrictMode's dev-only double-invoke, since refs survive that).
  useEffect(() => {
    if (activeProjectIdRef.current !== null) return;
    if (!boot) return;
    (async () => {
      if ((await listProjects()).length > 0) return;
      if (activeProjectIdRef.current !== null) return; // re-check after the await
      const id = genProjectId();
      await commitToLibrary(boot, id);
      activeProjectIdRef.current = id;
      setActiveProjectId(id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Boot flush: if the app booted straight onto Home (cold open — see
  // App.tsx's sessionStorage gate) and there's already an active library
  // project, refresh that tile's thumbnail/timestamp once. Without this the
  // tile would show whatever the last coarse flush (a Home visit, Save, or
  // new/loaded doc) captured — possibly last session's work, not the most
  // recent — since Home no longer gates through a flushing click to get
  // here. Disjoint from the migration effect above (that one only runs when
  // there's NO active project yet). Purely cosmetic and fine to be async —
  // unlike openLibraryProject's active-tile guard above, nothing races this.
  const bootFlushedRef = useRef(false);
  useEffect(() => {
    if (bootFlushedRef.current) return;
    bootFlushedRef.current = true;
    if (!showHome) return; // same-session reload, not a cold boot — nothing to refresh yet
    if (!boot) return;
    const id = activeProjectIdRef.current;
    if (id === null) return;
    void commitToLibrary(boot, id).then(() => setHomeRefresh((k) => k + 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Image import (modal) ──
  // The "Import Image" modal tunes a conversion against a loaded image and shows
  // a live preview; "Add to canvas" commits the dots to the real editor.

  // Open the modal, seeding its local canvas-size override from the live
  // canvas (and cell size from the live cell) so it starts matching today's
  // document — editing it here never touches the real canvas until commit.
  const openImportModal = useCallback(() => {
    setImportCell(cellPhysical);
    setImportW(canvasPhysW); setImportWInput(String(canvasPhysW));
    setImportH(canvasPhysH); setImportHInput(String(canvasPhysH));
    setPaletteEdits({});
    setImportOpen(true);
  }, [cellPhysical, canvasPhysW, canvasPhysH]);

  const commitImportW = () => {
    const parsed = parseFloat(importWInput);
    if (!isNaN(parsed) && parsed > 0) {
      const v = roundForUnit(parsed, unit);
      setImportW(v); setImportWInput(String(v));
    } else setImportWInput(String(importW));
  };
  const commitImportH = () => {
    const parsed = parseFloat(importHInput);
    if (!isNaN(parsed) && parsed > 0) {
      const v = roundForUnit(parsed, unit);
      setImportH(v); setImportHInput(String(v));
    } else setImportHInput(String(importH));
  };
  // Escape hatch back to today's default (canvas size derived from the loaded
  // image's own aspect ratio), since auto-aspect no longer happens on load.
  const matchImageRatio = () => {
    if (!importImg) return;
    const v = roundForUnit((importW * importImg.height) / importImg.width, unit);
    setImportH(v); setImportHInput(String(v));
  };

  // Target canvas dims from the modal-local W×H override + cell size — a
  // direct grid computation, independent of any loaded image (so the modal
  // has a size before an image is even chosen).
  const importDims = useMemo(() => computeCanvasDims(importW, importH, importCell), [importW, importH, importCell]);

  // Quantized palette + palette-colored dots — only computed for the "palette"
  // style (Light & Shadow keeps continuous image RGB, no quantization).
  const basePalette = useMemo(() => {
    if (!importImg || imgStyle !== "palette") return null;
    return buildPaletteDots(importImg, importDims.pxW, importDims.pxH,
      { colorCount: traceColorCount, threshold: traceThreshold, dotRadius: traceDotSize, snapMode: traceDetail,
        glitch: traceGlitch ? traceGlitchAmount : 0 });
  }, [importImg, importDims, imgStyle, traceColorCount, traceThreshold, traceDotSize, traceDetail, traceGlitch, traceGlitchAmount]);

  // Palette with manual swatch edits applied — a pure lookup, never re-quantizes.
  const effectivePalette = useMemo(() =>
    basePalette ? basePalette.palette.map((c) => paletteEdits[c] ?? c) : null,
  [basePalette, paletteEdits]);

  // Live preview dots — recomputed whenever the image or any control changes.
  // The final Min. Spacing pass reuses the same app-wide floor as every other
  // placement path (draw, brush, line/pen/shape, array).
  const previewDots = useMemo(() => {
    if (!importImg) return null;
    const minDist = minSpacing * FINE_CELL;
    if (imgStyle === "tonal") {
      const raw = buildDotsFromImage(importImg, importDims.pxW, importDims.pxH, {
        style: "tonal", threshold: traceThreshold, dotRadius: traceDotSize, snapMode: traceDetail, monoColor: "#000000", tonalColor: traceTonalColor,
      });
      return filterMinSpacing(raw, minDist);
    }
    if (!basePalette) return null;
    if (!effectivePalette) return filterMinSpacing(basePalette.dots, minDist);
    // Recolor: reuse each Dot object unchanged unless its slot's color was
    // edited, so an untouched palette produces byte-identical Dot references.
    const out = new Map<string, Dot>();
    for (const [key, dot] of basePalette.dots) {
      const slot = basePalette.index.get(key);
      const nextColor = slot != null ? effectivePalette[slot] : dot.color;
      out.set(key, nextColor === dot.color ? dot : { ...dot, color: nextColor });
    }
    return filterMinSpacing(out, minDist);
  }, [importImg, importDims, imgStyle, traceThreshold, traceDotSize, traceDetail, traceTonalColor, basePalette, effectivePalette, minSpacing]);

  const openImportFile = useCallback(async (file: File) => {
    try {
      const bitmap = await createImageBitmap(file);
      setImportImg(bitmap);
      setPaletteEdits({}); // a new/different image starts with a clean palette
    } catch {
      alert("Couldn't read that image.");
    }
  }, []);

  // Paste an image straight into the modal (Ctrl+V) while it's open. The
  // global keydown handler yields (skips its own preventDefault) so this
  // native "paste" event actually fires.
  useEffect(() => {
    if (!importOpen) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) { e.preventDefault(); openImportFile(f); }
          return;
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [importOpen, openImportFile]);

  // Close the modal and drop the loaded image so each open starts fresh.
  const closeImport = useCallback(() => { setImportOpen(false); setImportImg(null); }, []);

  // Resize the canvas to the source aspect + cell size and fit the view — the
  // document-wide part of a commit, shared by the normal (replace) and
  // split-into-layers commit paths below.
  const resizeCanvasTo = useCallback((dims: { pxW: number; pxH: number; physW: number; physH: number }, cell: number) => {
    const { pxW, pxH, physW, physH } = dims;
    setCellPhysical(cell); setCellInput(String(cell));
    setCanvasPhysW(physW); setWInput(String(physW));
    setCanvasPhysH(physH); setHInput(String(physH));
    canvasBoundsRef.current = { w: pxW, h: pxH };

    const pad = 60; const vp = viewportRef.current;
    const availW = vp.width - pad * 2, availH = vp.height - pad * 2;
    if (availW > 0 && availH > 0) {
      const z = Math.min(Math.max(Math.min(availW / pxW, availH / pxH, 4), MIN_ZOOM), MAX_ZOOM);
      rotRef.current = 0; setRot(0);
      applyViewport(z, { x: (vp.width - pxW * z) / 2, y: (vp.height - pxH * z) / 2 });
    }
  }, [applyViewport]);

  // Shared commit: resize the canvas, then replace the active layer's dots
  // (undoable). Used by the image and text modals.
  const commitDots = useCallback((map: Map<string, Dot>, dims: { pxW: number; pxH: number; physW: number; physH: number }, cell: number) => {
    resizeCanvasTo(dims, cell);
    pushUndo();
    const next = new Map(map);
    setDots(next); dotsRef.current = next;
    setSelectedKeys(new Set()); selectedKeysRef.current = new Set();
    sfx.ui();
  }, [pushUndo, resizeCanvasTo]);

  // Alternative commit for the image modal's "Split into layers by color":
  // groups previewDots by their final (post-edit) color and appends one new
  // layer per color to the TOP of the stack. Existing layers' content is
  // never touched — this is a structural add, not a replace, so (matching
  // every other add/delete/duplicate-layer op) it's immediate and NOT on the
  // undo stack. Canvas still resizes to the import dims, same as a normal
  // import, since that's a document-wide setting rather than a layer one.
  const addImportAsColorLayers = useCallback(() => {
    if (!importDims || !previewDots || !effectivePalette) return;
    resizeCanvasTo(importDims, importCell);

    const byColor = new Map<string, Map<string, Dot>>();
    for (const [key, dot] of previewDots) {
      let m = byColor.get(dot.color);
      if (!m) { m = new Map(); byColor.set(dot.color, m); }
      m.set(key, dot);
    }
    // Layer order/naming follows the palette's own population order
    // (most-used first), deduped — matches the swatch strip above it.
    const seen = new Set<string>();
    const orderedColors: string[] = [];
    for (const c of effectivePalette) {
      if (!seen.has(c) && byColor.has(c)) { seen.add(c); orderedColors.push(c); }
    }
    const newLayers: Layer[] = orderedColors.map((color) => ({
      id: genLayerId(), name: color, visible: true, dots: byColor.get(color)!,
    }));
    if (newLayers.length === 0) return;

    const next = [...layersRef.current, ...newLayers];
    setLayers(next); layersRef.current = next;
    const topId = newLayers[newLayers.length - 1].id;
    setActiveLayerId(topId); activeLayerIdRef.current = topId;
    clearSelection();
    sfx.toggle();
  }, [importDims, previewDots, effectivePalette, importCell, resizeCanvasTo, layersRef, setLayers, activeLayerIdRef, setActiveLayerId, clearSelection]);

  const addImportToCanvas = useCallback(() => {
    if (!importDims || !previewDots) return;
    if (splitLayersByColor && imgStyle === "palette") addImportAsColorLayers();
    else commitDots(previewDots, importDims, importCell);
    setImportOpen(false); setImportImg(null);
  }, [importDims, previewDots, importCell, commitDots, splitLayersByColor, imgStyle, addImportAsColorLayers]);

  // Render the preview dots into the modal's canvas — sized to fill whatever
  // room the preview box actually has (ResizeObserver-driven, dpr-scaled for
  // crispness) rather than a fixed box, since the modal itself can now be
  // resized (80vw/80vh) and the box grows/shrinks with the viewport.
  useEffect(() => {
    const cv = importPreviewRef.current, box = importPreviewBoxRef.current;
    if (!cv || !box || !importDims) return;
    const paint = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const availW = Math.max(1, box.clientWidth - 16), availH = Math.max(1, box.clientHeight - 16);
      const s = Math.max(0.001, Math.min(availW / importDims.pxW, availH / importDims.pxH));
      const cssW = importDims.pxW * s, cssH = importDims.pxH * s;
      cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
      cv.style.width = `${cssW}px`; cv.style.height = `${cssH}px`;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = canvasBg;
      ctx.fillRect(0, 0, cssW, cssH);
      if (!previewDots) return;
      ctx.scale(s, s);
      for (const d of previewDots.values()) {
        ctx.fillStyle = d.color;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.radius, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(box);
    return () => ro.disconnect();
  }, [previewDots, importDims, canvasBg, importOpen]);

  // ── Text → Dots ──
  // Load an uploaded font locally (no network) and register it for canvas use.
  const loadFontFile = useCallback(async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      const family = `DotFont-${Date.now()}`;
      const face = new FontFace(family, buf);
      await face.load();
      (document as Document & { fonts: FontFaceSet }).fonts.add(face);
      setTextFontFamily(family);
      setTextFontName(file.name.replace(/\.[^.]+$/, ""));
    } catch {
      alert("Couldn't load that font file.");
    }
  }, []);

  // Render the typed text onto a tight offscreen canvas (white on transparent).
  // High raster size — final scale comes from the cell size, not here.
  const textCanvas = useMemo(
    () => (textOpen ? renderTextCanvas(textValue, textFontFamily) : null),
    [textValue, textFontFamily, textOpen]
  );

  const textDims = useMemo(() => {
    if (!textCanvas) return null;
    const longPhys = Math.max(canvasPhysW, canvasPhysH) || 1;
    return computeImportDims(textCanvas.width, textCanvas.height, longPhys, importCell);
  }, [textCanvas, canvasPhysW, canvasPhysH, importCell]);

  const textDots = useMemo(() => {
    if (!textCanvas || !textDims) return null;
    return buildDotsFromText(textCanvas, textDims.pxW, textDims.pxH, {
      style: traceStyle, threshold: traceThreshold, dotRadius: traceDotSize,
      snapMode: traceDetail, textColor, monoColor: color, scatter: traceScatter,
    });
  }, [textCanvas, textDims, traceStyle, traceThreshold, traceDotSize, traceDetail, textColor, color, traceScatter]);

  const closeText = useCallback(() => setTextOpen(false), []);

  const addTextToCanvas = useCallback(() => {
    if (!textDims || !textDots) return;
    commitDots(textDots, textDims, importCell);
    setTextOpen(false);
  }, [textDims, textDots, importCell, commitDots]);

  // Paint the text preview dots into the modal's canvas.
  useEffect(() => {
    const cv = textPreviewRef.current;
    if (!cv || !textDims) return;
    const BOX = 420;
    const s = Math.min(BOX / textDims.pxW, BOX / textDims.pxH);
    cv.width = Math.round(textDims.pxW * s);
    cv.height = Math.round(textDims.pxH * s);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = canvasBg;
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (!textDots) return;
    ctx.scale(s, s);
    for (const d of textDots.values()) {
      ctx.fillStyle = d.color;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [textDots, textDims, canvasBg, textOpen]);

  // Autosave the document to localStorage (debounced) on any change. At very
  // high dot counts the serialized scene can exceed localStorage's ~5-10MB
  // quota — the write then throws and silently no-ops, which used to mean
  // the crash-recovery safety net quietly stopped working with no
  // indication. autosaveFailed surfaces that instead of swallowing it, and
  // clears itself the moment a save succeeds again (e.g. after deleting
  // enough dots to fit).
  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(buildScene()));
        setAutosaveFailed(false);
      } catch { setAutosaveFailed(true); }
    }, 400);
    return () => window.clearTimeout(id);
  }, [buildScene]);

  const HOLD_CLEAR_MS = 1000;
  const cancelClearHold = useCallback(() => {
    if (clearRafRef.current !== undefined) cancelAnimationFrame(clearRafRef.current);
    clearRafRef.current = undefined;
    setClearProgress(0);
  }, []);
  const startClearHold = useCallback(() => {
    if (dotsRef.current.size === 0 || clearRafRef.current !== undefined) return;
    clearStartRef.current = performance.now();
    const tick = () => {
      const p = Math.min(100, ((performance.now() - clearStartRef.current) / HOLD_CLEAR_MS) * 100);
      setClearProgress(p);
      if (p >= 100) {
        sfx.clear();
        pushUndo();
        setDots(new Map());
        setSelectedKeys(new Set());
        selectedKeysRef.current = new Set();
        setGapSeq([]); setLastPlaced(null); lastPlacedRef.current = null;
        cancelClearHold();
        return;
      }
      clearRafRef.current = requestAnimationFrame(tick);
    };
    clearRafRef.current = requestAnimationFrame(tick);
  }, [pushUndo, cancelClearHold]);

  const applyCellSize = (next: number) => {
    // Lock the canvas frame on screen while the grid rescales inside it.
    // Internal raster width is (physical W / cell) × CELL_SIZE, so a cell
    // change scales every world coordinate by old/next — counter-scaling
    // the zoom by next/old keeps every zoom × world product identical and
    // the canvas rectangle doesn't move a pixel (pan needs no correction).
    const z = Math.min(Math.max(zoomRef.current * (next / cellPhysical), MIN_ZOOM), MAX_ZOOM);
    zoomRef.current = z;
    setZoom(z);
    setCellPhysical(next);
  };
  const commitCell = () => {
    const parsed = parseFloat(cellInput);
    if (!isNaN(parsed) && parsed > 0) applyCellSize(parsed);
    else setCellInput(String(cellPhysical));
  };
  const commitW = () => {
    const parsed = parseFloat(wInput);
    if (!isNaN(parsed) && parsed > 0) setCanvasPhysW(parsed);
    else setWInput(String(canvasPhysW));
  };
  const commitH = () => {
    const parsed = parseFloat(hInput);
    if (!isNaN(parsed) && parsed > 0) setCanvasPhysH(parsed);
    else setHInput(String(canvasPhysH));
  };
  const stepCell = (dir: 1 | -1) => {
    const stepBy = unit === "in" ? 0.1 : unit === "cm" ? 0.5 : 1;
    const next = roundForUnit(Math.max(stepBy, cellPhysical + dir * stepBy), unit);
    applyCellSize(next);
    setCellInput(String(next));
  };

  const cols = Math.round(canvasPxW / CELL_SIZE);
  const rows = Math.round(canvasPxH / CELL_SIZE);
  const zoomPct = Math.round(zoom * 100);
  const isDragging = isDraggingDotsRef.current;
  const { dx: moveDx, dy: moveDy } = dragOffset;

  // ── Canvas scene ─────────────────────────────────────────────────────
  // Everything that used to be plain SVG shapes — viewport bg, drop shadow,
  // canvas bg, the 3-tier grid, border, mirror axes, AND the dots
  // themselves — now draws to a <canvas> sized/transformed to match the
  // SVG's own pan/zoom/rot exactly. Grid math is the same loops
  // `buildSVGString` (src/lib/scene.ts) uses to build the export string,
  // with the same zoom-compensated line widths the old live SVG grid used
  // (export has no "zoom", always 1x). Selection/hover rings, previews, the
  // marquee, and the cursor-hit rect stay SVG on top — see the JSX below.
  //
  // The resolved `--viewport` CSS color is cached in a ref, refreshed only
  // when `dark` changes, instead of a getComputedStyle() call inside this
  // function — which reruns on every pan/zoom/rotate tick, a much hotter
  // path than a theme toggle.
  // useLayoutEffect (not useEffect) and defined BEFORE drawScene's own
  // paint effect below — same-phase effects run in source order, so this is
  // guaranteed to refresh the ref before the repaint effect reads it on the
  // same theme-toggle commit. A plain useEffect here raced the paint: it
  // runs after the browser has already painted, so the repaint below could
  // fire first with the stale color and never get a second nudge to redraw.
  const viewportBgRef = useRef("#ffffff");
  useLayoutEffect(() => {
    if (containerRef.current) {
      viewportBgRef.current = getComputedStyle(containerRef.current).getPropertyValue("--viewport").trim() || "#ffffff";
    }
  }, [dark]);

  // Layer-switch pulse alpha, driven by a rAF tween (see the effect below,
  // keyed on layerPulseKey) — read here as a ref so ticking it doesn't need
  // to be one of drawScene's dependencies; the tween calls drawScene()
  // directly on every frame instead of going through the dep-triggered
  // paint effect.
  const activeAlphaRef = useRef(1);

  const sceneCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawScene = useCallback(() => {
    const canvas = sceneCanvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = viewportSize.width, h = viewportSize.height;
    const pxW = Math.round(w * dpr), pxH = Math.round(h * dpr);
    if (canvas.width !== pxW) canvas.width = pxW;
    if (canvas.height !== pxH) canvas.height = pxH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = viewportBgRef.current;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.rotate(rot);
    ctx.scale(zoom, zoom);

    // Drop shadow, then the canvas's own background.
    ctx.fillStyle = "rgba(0,0,0,0.12)";
    ctx.fillRect(6 / zoom, 8 / zoom, canvasPxW, canvasPxH);
    ctx.fillStyle = canvasBg;
    ctx.fillRect(0, 0, canvasPxW, canvasPxH);

    // 3-tier grid: minor subdivisions, then bold main lines. Batched into 3
    // stroke() calls (one per alpha/width group) instead of one beginPath/
    // stroke per line — on a canvas large enough for a few hundred thousand
    // dots that was several thousand individual stroke() calls (plus a
    // globalAlpha/lineWidth reassignment on nearly every one) every single
    // redraw, i.e. every pan tick and zoom step. Same geometry, same alpha,
    // same widths — just fewer draw calls, so the grid renders identically.
    const sub = CELL_SIZE / GRID_SUBDIV;
    const mid = GRID_SUBDIV / 2;
    ctx.strokeStyle = gridColor;

    ctx.globalAlpha = gridOpacity * 0.4;
    ctx.lineWidth = (gridThickness * 0.5) / zoom;
    ctx.beginPath();
    for (let i = 1; i < cols * GRID_SUBDIV; i++) {
      if (i % GRID_SUBDIV === 0 || i % GRID_SUBDIV === mid) continue;
      const x = i * sub;
      ctx.moveTo(x, 0); ctx.lineTo(x, canvasPxH);
    }
    for (let i = 1; i < rows * GRID_SUBDIV; i++) {
      if (i % GRID_SUBDIV === 0 || i % GRID_SUBDIV === mid) continue;
      const y = i * sub;
      ctx.moveTo(0, y); ctx.lineTo(canvasPxW, y);
    }
    ctx.stroke();

    ctx.globalAlpha = gridOpacity * 0.72;
    ctx.lineWidth = (gridThickness * 0.8) / zoom;
    ctx.beginPath();
    for (let i = mid; i < cols * GRID_SUBDIV; i += GRID_SUBDIV) {
      const x = i * sub;
      ctx.moveTo(x, 0); ctx.lineTo(x, canvasPxH);
    }
    for (let i = mid; i < rows * GRID_SUBDIV; i += GRID_SUBDIV) {
      const y = i * sub;
      ctx.moveTo(0, y); ctx.lineTo(canvasPxW, y);
    }
    ctx.stroke();

    ctx.globalAlpha = gridOpacity;
    ctx.lineWidth = gridThickness / zoom;
    ctx.beginPath();
    for (let i = 0; i <= cols; i++) {
      const x = i * CELL_SIZE;
      ctx.moveTo(x, 0); ctx.lineTo(x, canvasPxH);
    }
    for (let i = 0; i <= rows; i++) {
      const y = i * CELL_SIZE;
      ctx.moveTo(0, y); ctx.lineTo(canvasPxW, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Border.
    ctx.strokeStyle = "#999";
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(0, 0, canvasPxW, canvasPxH);

    // Mirror axes — same bg-lightness-picked color as `selectionRingColor`
    // below (inlined here rather than depended-on, since that `const` is
    // computed further down in source order and a dependency array can't
    // reference it before it's initialized — see the state-vs-ref mirroring
    // gotcha in this file's module comment / CLAUDE.md).
    if (mirrorX || mirrorY) {
      const bgHex = canvasBg.replace("#", "");
      const bgIsLightHere = bgHex.length < 6 ? true : (() => {
        const r = parseInt(bgHex.slice(0, 2), 16), g = parseInt(bgHex.slice(2, 4), 16), b = parseInt(bgHex.slice(4, 6), 16);
        return 0.299 * r + 0.587 * g + 0.114 * b > 140;
      })();
      ctx.strokeStyle = bgIsLightHere ? "#4361EE" : "#FFD700";
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1 / zoom;
      ctx.setLineDash([7 / zoom, 5 / zoom]);
      if (mirrorX) { ctx.beginPath(); ctx.moveTo(canvasPxW / 2, 0); ctx.lineTo(canvasPxW / 2, canvasPxH); ctx.stroke(); }
      if (mirrorY) { ctx.beginPath(); ctx.moveTo(0, canvasPxH / 2); ctx.lineTo(canvasPxW, canvasPxH / 2); ctx.stroke(); }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // Dots — every visible layer, bottom→top (array order = stack order).
    // Viewport culling: map the 4 viewport corners into world space via the
    // same screenToWorld used for pointer input, take their axis-aligned
    // bounding box (a rotated viewport's true footprint isn't
    // axis-aligned, but the AABB of its corners is guaranteed to contain it
    // — just not maximally tight, which is fine), and skip any dot outside
    // it. Cheap, correctness-neutral, and the difference between redrawing
    // everything vs. only what's on-screen once zoomed into a large canvas.
    const corners = [
      screenToWorld(0, 0), screenToWorld(viewportSize.width, 0),
      screenToWorld(0, viewportSize.height), screenToWorld(viewportSize.width, viewportSize.height),
    ];
    const cullPad = 50; // generous margin for dot radius + antialiasing
    const cullMinX = Math.min(...corners.map((c) => c.x)) - cullPad;
    const cullMaxX = Math.max(...corners.map((c) => c.x)) + cullPad;
    const cullMinY = Math.min(...corners.map((c) => c.y)) - cullPad;
    const cullMaxY = Math.max(...corners.map((c) => c.y)) + cullPad;

    // Tried color-batching here (group by color/alpha into fewer fill()
    // calls) and measured it — reverted. It regressed the common case: for
    // photographic imports (near-continuous per-pixel colors, little to
    // consolidate), the grouping bookkeeping itself (a Map lookup + object
    // allocation per dot, paid on EVERY redraw including pan/zoom which
    // touch no new data) cost more than the fill()-call savings ever
    // recovered — measured single-dot-placement redraw at 40k dots going
    // from ~45ms to ~200-400ms. Only a flat-color/few-palette-colors layer
    // would've actually benefited, and that case was already fast. Left as
    // the simple per-dot loop.
    for (const layer of layers) {
      if (!layer.visible) continue;
      const isActiveLayer = layer.id === activeLayerId;
      // Layer-switch pulse: only the active layer's dots fade with the tween
      // (activeAlphaRef is 1 outside of one, so this is a no-op then).
      const layerAlpha = isActiveLayer ? activeAlphaRef.current : 1;
      for (const d of layer.dots.values()) {
        // Drag ghost: a selected dot on the active layer, mid-drag, draws
        // OFFSET by the live drag delta at reduced alpha — same rule
        // DotLayerImpl used to apply per-dot before dots moved to canvas.
        const isDraggingThis = isActiveLayer && isDragging && selectedKeysRef.current.has(d.key);
        const x = isDraggingThis ? d.x + moveDx : d.x;
        const y = isDraggingThis ? d.y + moveDy : d.y;
        if (x < cullMinX || x > cullMaxX || y < cullMinY || y > cullMaxY) continue;
        ctx.globalAlpha = (isDraggingThis ? 0.7 : 1) * layerAlpha;
        ctx.fillStyle = d.color;
        if (dotShape === "bar") {
          const b = barRect(x, y, d.radius);
          if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(b.x, b.y, b.w, b.h, b.rx); ctx.fill(); }
          else ctx.fillRect(b.x, b.y, b.w, b.h); // fallback for older engines: square corners
        } else {
          ctx.beginPath();
          ctx.arc(x, y, d.radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;

    ctx.restore();
    // `dark` isn't read directly in this function (viewportBgRef.current is,
    // which the sibling effect above refreshes on the same dependency) — it's
    // listed here purely so this callback's identity changes on a theme
    // toggle too, which is what actually re-triggers the paint effect below.
    // Without it, the ref value updates but nothing repaints until some
    // unrelated dep (pan/zoom/etc.) happens to change next.
    //
    // selectedKeys is deliberately NOT a dep: selection has no visual effect
    // on this canvas except the drag-ghost offset above, which reads
    // selectedKeysRef instead (kept in perfect sync — every setSelectedKeys
    // call site updates the ref in the same breath). Selection changes fire
    // on every marquee-drag pointermove; without this, each of those forced
    // a full repaint of a byte-identical canvas.
  }, [viewportSize, pan, zoom, rot, canvasPxW, canvasPxH, canvasBg, gridColor, gridOpacity, gridThickness, cols, rows, mirrorX, mirrorY, dark, layers, dotShape, activeLayerId, isDragging, moveDx, moveDy]);

  useLayoutEffect(() => { drawScene(); }, [drawScene]);

  // Layer-switch pulse — replaces the old `.dotart-layer-pulse` CSS
  // animation (theme.css), which animated a per-layer SVG <g> that no
  // longer exists now that dots are canvas pixels. Same shape (0% -> 1,
  // 50% -> 0.55, 100% -> 1, 250ms, ease-in-out) and reduced-motion guard as
  // the original keyframes, just driven by a rAF tween writing
  // activeAlphaRef and imperatively repainting each frame, since a ref
  // change alone doesn't retrigger drawScene's dependency-driven effect.
  // Skips on mount (layerPulseKey starts at 0 and this only bumps on an
  // explicit layer-nav switch).
  useEffect(() => {
    if (layerPulseKey === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const DURATION = 250;
    const start = performance.now();
    let raf = 0;
    const easeInOutQuad = (t: number) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION);
      const half = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
      const eased = easeInOutQuad(half);
      activeAlphaRef.current = t < 0.5 ? 1 - 0.45 * eased : 0.55 + 0.45 * eased;
      drawScene();
      if (t < 1) raf = requestAnimationFrame(tick);
      else activeAlphaRef.current = 1;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [layerPulseKey, drawScene]);

  // Layer-nav arrows: index 0 = bottom of stack (matches moveLayer/render
  // order), so "layer above" = next index up.
  const activeLayerIdx = layers.findIndex((l) => l.id === activeLayerId);
  const canLayerUp = activeLayerIdx >= 0 && activeLayerIdx < layers.length - 1;
  const canLayerDown = activeLayerIdx > 0;

  let cursor = "crosshair";
  if (isGrabbing) cursor = "grabbing";
  else if (tool === "select") {
    if (isDragging) cursor = "grabbing";
    else if (hoveredDotKey && selectedKeys.has(hoveredDotKey)) cursor = "grab";
    else if (hoveredDotKey) cursor = "pointer";
    else cursor = "default";
  }

  // Pick a selection-ring color that stays visible against the current background.
  const bgIsLight = (() => {
    const h = canvasBg.replace("#", "");
    if (h.length < 6) return true;
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return 0.299 * r + 0.587 * g + 0.114 * b > 140;
  })();
  const selectionRingColor = bgIsLight ? "#4361EE" : "#FFD700";

  // Memoized: this used to recompute on every render (hover, pan, zoom, drag
  // — none of which change the selection) — O(selection size) on each, real
  // cost with a large selection (e.g. after Ctrl+A) sitting on screen.
  const { selColors, selRadii } = useMemo(() => {
    const selectedDots = Array.from(selectedKeys).map((k) => dots.get(k)).filter(Boolean) as Dot[];
    return {
      selColors: [...new Set(selectedDots.map((d) => d.color))],
      selRadii: [...new Set(selectedDots.map((d) => d.radius))],
    };
  }, [selectedKeys, dots]);
  const selColor = selColors.length === 1 ? selColors[0] : color;
  const selRadius = selRadii.length === 1 ? selRadii[0] : radius;
  const selMixed = selColors.length > 1 || selRadii.length > 1;

  // ── Right-panel context: what the inspector currently edits ──
  const editingSelection = tool === "select" && selectedKeys.size > 0;
  const rightCtx: "erase" | "selection" | "dot" | "grid" | "background" | "array" =
    tool === "erase" ? "erase" : tool === "array" ? "array" : editingSelection ? "selection" : inspect;
  const ctxTitle = rightCtx === "dot" && tool === "line" ? "Sparse Line"
    : rightCtx === "dot" && tool === "pen" ? "Pen Path"
      : rightCtx === "dot" && tool === "shape" ? ({ ellipse: "Ellipse", rect: "Rectangle", diamond: "Diamond", triangle: "Triangle", polygon: "Polygon" }[shapeType])
        : { erase: "Eraser", selection: "Selection", dot: "Dot Color", grid: "Grid", background: "Background", array: "Array" }[rightCtx];
  const isColorCtx = rightCtx === "dot" || rightCtx === "selection";
  const activeColor = editingSelection ? selColor : color;
  const activeRadius = editingSelection ? selRadius : radius;
  const colorMixed = editingSelection && selMixed;
  const setActiveColor = (c: string) => { editingSelection ? updateSelectedDots({ color: c }) : setColor(c); pushRecentColor(c); };
  const setActiveRadius = (v: number) => { editingSelection ? updateSelectedDots({ radius: v }) : setRadius(v); };

  // ── Array tool: live preview (post-snap, post-min-spacing-gate — what you
  // see is exactly what Apply writes) ──
  const arrayMotif = useMemo(
    () => (tool === "array" ? (Array.from(selectedKeys).map((k) => dots.get(k)).filter((d): d is Dot => !!d)) : []),
    [tool, selectedKeys, dots]
  );
  const arrayTransforms = useMemo((): Transform[] => {
    if (arrayMotif.length === 0) return [];
    if (arrayMode === "linear") return computeLinearInstances({ angleDeg: arrayLinearAngle, count: arrayLinearCount, spacing: arrayLinearSpacing, centered: arrayLinearCentered });
    if (arrayMode === "grid") return computeGridInstances({ rows: arrayGridRows, cols: arrayGridCols, spacingX: arrayGridSpacingX, spacingY: arrayGridSpacingY, rowOffsetPct: arrayGridRowOffsetPct, centered: arrayGridCentered });
    return computeCurveInstances(motifPivot(arrayMotif), { anchors: arrayCurveAnchors, curved: arrayPathCurved, count: arrayCurveCount, spacing: arrayCurveSpacing, alignToCurve: arrayCurveAlign });
  }, [arrayMotif, arrayMode, arrayLinearAngle, arrayLinearCount, arrayLinearSpacing, arrayLinearCentered,
      arrayGridRows, arrayGridCols, arrayGridSpacingX, arrayGridSpacingY, arrayGridRowOffsetPct, arrayGridCentered,
      arrayCurveAnchors, arrayPathCurved, arrayCurveCount, arrayCurveSpacing, arrayCurveAlign]);
  const arrayPreviewMap = useMemo(
    () => computeArrayPlacements(arrayMotif, arrayTransforms, dots, snapSpacing(snapMode), minSpacing * FINE_CELL, canvasPxW, canvasPxH),
    [arrayMotif, arrayTransforms, dots, snapMode, minSpacing, canvasPxW, canvasPxH]
  );
  const arrayPreview = useMemo(() => Array.from(arrayPreviewMap.values()), [arrayPreviewMap]);
  // Recolor the selection live during a picker drag, without pushing an undo snapshot every tick.
  const recolorSelectionLive = (c: string) => {
    setDots((prev) => {
      const next = new Map(prev);
      for (const k of selectedKeysRef.current) { const d = next.get(k); if (d) next.set(k, { ...d, color: c }); }
      return next;
    });
  };
  const onPickerChange = (c: string) => { lastPickRef.current = c; editingSelection ? recolorSelectionLive(c) : setColor(c); };

  // Dev-only test-observability hook (never present in a production build —
  // `import.meta.env.DEV` is statically false there, so this whole block is
  // dead-code-eliminated). Exists so tests can read dot state directly
  // instead of counting SVG <circle> DOM nodes — a dependency the planned
  // Canvas2D render-layer rewrite would otherwise break, since dots stop
  // being DOM nodes at all. Set up once; every function reads live refs
  // (never closed-over state) so it can't go stale as the app runs.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as any).__tangaliyaTest = {
      dots: () => flattenLayers(layersRef.current).map((d) => ({ key: d.key, x: d.x, y: d.y, color: d.color, radius: d.radius })),
      count: () => flattenLayers(layersRef.current).length,
      // Client (viewport) x/y for the i-th visible dot — the forward
      // transform world -> screen, i.e. the algebraic inverse of
      // screenToWorld above: screen = pan + zoom * R(rot) * world.
      dotScreenPos: (i: number) => {
        const d = flattenLayers(layersRef.current)[i];
        if (!d || !svgRef.current) return null;
        const rect = svgRef.current.getBoundingClientRect();
        const c = Math.cos(rotRef.current), s = Math.sin(rotRef.current);
        const dx = d.x * c - d.y * s, dy = d.x * s + d.y * c;
        return {
          x: rect.left + panRef.current.x + dx * zoomRef.current,
          y: rect.top + panRef.current.y + dy * zoomRef.current,
        };
      },
      // World-space canvas size (w/h in px) — lets tests check dot bounds
      // without depending on the background rect's DOM structure, which the
      // planned Canvas2D substrate rewrite will move off the SVG entirely.
      canvasBounds: () => ({ w: canvasBoundsRef.current.w, h: canvasBoundsRef.current.h }),
    };
    return () => { delete (window as any).__tangaliyaTest; };
  }, []);

  // A preview/ghost dot in the current dot shape, so hovering and stroke
  // previews match what will actually be placed.
  const shapeDot = (x: number, y: number, r: number, fill: string, opacity: number, key?: string) => {
    if (dotShape === "bar") {
      const b = barRect(x, y, r);
      return <rect key={key} x={b.x} y={b.y} width={b.w} height={b.h} rx={b.rx} fill={fill} opacity={opacity} />;
    }
    return <circle key={key} cx={x} cy={y} r={r} fill={fill} opacity={opacity} />;
  };

  return (
    <div className={`dotart${dark ? " dark" : ""}${theming ? " theming" : ""} flex h-dvh w-screen overflow-hidden bg-[var(--app-bg)] text-[var(--app-fg)]`}>

      {/* ── Left panel — tools & controls ── */}
      <aside className={`${compact ? `fixed left-0 top-0 z-50 bg-[var(--app-bg)] shadow-2xl transition-transform duration-300 ${leftOpen ? "translate-x-0" : "-translate-x-full"}` : "relative"} w-[300px] max-w-[88vw] shrink-0 h-dvh p-4 flex flex-col gap-4 overflow-hidden`}>

        {/* Header controls — the brand mark now lives on the Home screen only
            (the front door), freeing this row up in the working editor. */}
        <div className="bg-[var(--card)] rounded-3xl px-5 py-3.5 shrink-0">
          <div className="flex items-center gap-1.5 shrink-0">
            <button onClick={async () => { await flushActiveProjectToLibrary(); onShowHome(); }} title="Home"
              aria-label="Go to Home"
              className="flex-1 h-9 rounded-xl flex items-center justify-center bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)] transition-all">
              <HomeIcon size={17} />
            </button>
            <button onClick={() => fileInputRef.current?.click()} title="Open a saved project file"
              aria-label="Open a saved project file"
              className="flex-1 h-9 rounded-xl flex items-center justify-center bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)] transition-all">
              <FolderOpen size={17} />
            </button>
            <button onClick={() => setMuted((m) => !m)} title={muted ? "Unmute sounds" : "Mute sounds"}
              aria-label="Toggle interface sounds"
              className="flex-1 h-9 rounded-xl flex items-center justify-center bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)] transition-all">
              {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
            </button>
            <button onClick={toggleTheme} title={dark ? "Switch to light mode" : "Switch to dark mode"}
              aria-label="Toggle dark mode"
              className="flex-1 h-9 rounded-xl flex items-center justify-center bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)] transition-all">
              {dark ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </div>
        </div>

        {/* Controls card */}
        <div className="bg-[var(--card)] rounded-3xl p-4 flex-1 overflow-y-auto flex flex-col gap-5 [&>*]:shrink-0" style={{ scrollbarWidth: "none" }}>

          {/* Import: Image / Text → dots, each opens a modal to tune, preview, then commit */}
          <div>
            <div className="text-[14px] text-[var(--txt-2)] tracking-[-0.3px] mb-2">Import</div>
            <div className="flex gap-2">
              <button onClick={openImportModal} title="Convert an image into editable dots"
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] transition-colors">
                <ImagePlus size={13} /> Image
              </button>
              <button onClick={() => { setImportCell(cellPhysical); setTextOpen(true); }} title="Convert typed text in any font into dissolving dots"
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] transition-colors">
                <Type size={13} /> Text
              </button>
            </div>
          </div>

          {/* Canvas Setup: Units / Canvas Size / Cell Size, collapsible to save space */}
          <div className="bg-[var(--ctl)] rounded-xl overflow-hidden">
            <button onClick={() => setCanvasSetupOpen((o) => !o)}
              className="w-full flex items-center justify-between p-3 text-[14px] text-[var(--txt-2)] tracking-[-0.3px]">
              Canvas Setup
              {canvasSetupOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            {canvasSetupOpen && (
              <div className="p-3 pt-0 flex flex-col gap-4">
                {/* Units */}
                <div>
                  <div className="text-[13px] text-[var(--txt-3)] mb-2">Units</div>
                  <div className="flex gap-2">
                    {(["mm", "cm", "in"] as Unit[]).map((u) => (
                      <button key={u} onClick={() => changeUnit(u)}
                        className={`flex-1 py-2 rounded-xl text-[16px] transition-all ${unit === u ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--card)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
                          }`}>
                        {u}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Canvas Size */}
                <div>
                  <div className="text-[13px] text-[var(--txt-3)] mb-2">Canvas Size</div>
                  <div className="flex gap-2">
                    {([
                      { label: "W", value: wInput, onChange: setWInput, onCommit: commitW },
                      { label: "H", value: hInput, onChange: setHInput, onCommit: commitH },
                    ]).map(({ label, value, onChange, onCommit }) => (
                      <div key={label} className="flex-1 flex items-center gap-1.5 bg-[var(--card)] rounded-xl px-3 py-2">
                        <span className="text-[16px] text-[var(--txt-2)] shrink-0">{label}</span>
                        <input type="number" min="1" step="any" value={value}
                          onChange={(e) => onChange(e.target.value)} onBlur={onCommit}
                          onFocus={(e) => e.target.select()}
                          onKeyDown={(e) => { if (e.key === "Enter") { onCommit(); (e.target as HTMLInputElement).blur(); } }}
                          className="w-full min-w-0 bg-transparent text-[16px] text-[var(--txt-1)] text-right focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
                      </div>
                    ))}
                  </div>
                </div>

                {/* Cell Size */}
                <div>
                  <div className="text-[13px] text-[var(--txt-3)] mb-2">Cell Size</div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => stepCell(-1)} title="Smaller cell"
                      className="w-10 h-10 rounded-lg bg-[var(--card)] text-[var(--txt-1)] flex items-center justify-center hover:bg-[var(--ctl-hover)] transition-all shrink-0">
                      <Minus size={18} />
                    </button>
                    <div className="flex-1 flex items-center justify-center gap-1.5 bg-[var(--card)] rounded-xl py-2">
                      <input type="number" min="0.01" step="any" value={cellInput}
                        onChange={(e) => setCellInput(e.target.value)} onBlur={commitCell}
                        onFocus={(e) => e.target.select()}
                        onKeyDown={(e) => { if (e.key === "Enter") { commitCell(); (e.target as HTMLInputElement).blur(); } }}
                        className="w-12 bg-transparent text-[16px] text-[var(--txt-1)] text-center focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
                      <span className="text-[13px] text-[var(--txt-2)]">{unit}</span>
                    </div>
                    <button onClick={() => stepCell(1)} title="Larger cell"
                      className="w-10 h-10 rounded-lg bg-[var(--card)] text-[var(--txt-1)] flex items-center justify-center hover:bg-[var(--ctl-hover)] transition-all shrink-0">
                      <Plus size={18} />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Snap To */}
          <div>
            <div className="flex items-center gap-1.5 text-[14px] text-[var(--txt-2)] tracking-[-0.3px] mb-2">
              <Magnet size={13} /> Snap To
            </div>
            <div className="grid grid-cols-2 gap-2">
              {([
                { value: "both" as SnapMode, label: "Both" },
                { value: "corner" as SnapMode, label: "Corner" },
                { value: "center" as SnapMode, label: "Center" },
                { value: "fine" as SnapMode, label: "Sub-grid" },
              ]).map(({ value, label }) => (
                <button key={value} onClick={() => { setSnapMode(value); sfx.ui(); }}
                  className={`py-2 rounded-xl text-[13px] transition-all ${snapMode === value ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
                    }`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Dot Shape — global render shape (snapping unaffected) */}
          <div>
            <div className="text-[14px] text-[var(--txt-2)] tracking-[-0.3px] mb-2">Dot Shape</div>
            <div className="flex gap-2">
              {([
                { s: "circle" as DotShape, label: "Circle", glyph: <circle cx={11} cy={9} r={6} /> },
                { s: "bar" as DotShape, label: "Bar", glyph: <rect x={2} y={5.5} width={18} height={7} rx={3} /> },
              ]).map(({ s, label, glyph }) => (
                <button key={s} onClick={() => { setDotShape(s); sfx.toggle(); }}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-xl text-[13px] transition-all ${dotShape === s ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
                    }`}>
                  <svg width="22" height="18" viewBox="0 0 22 18" fill="currentColor">{glyph}</svg>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Dot Size — moved here from the color context panel (2026-07-09) */}
          <ValueSlider label="Dot Size" min={1} max={14}
            value={colorMixed ? 7 : activeRadius}
            display={colorMixed ? "—" : `${activeRadius}`}
            onChange={setActiveRadius} />

          {/* Min. Spacing — absolute floor, in subgrid units, applied across
              every placement tool (draw, brush, line, pen, shape) */}
          <ValueSlider label="Min. Spacing" min={1} max={20}
            value={minSpacing}
            display={`${minSpacing} step${minSpacing === 1 ? "" : "s"}`}
            onChange={setMinSpacing} />

          {/* Elements — pick what the right panel edits */}
          <div>
            <div className="text-[14px] text-[var(--txt-2)] tracking-[-0.3px] mb-2">Elements</div>
            <div className="flex flex-col gap-2">
              {([
                { key: "dot" as const, icon: <Droplet size={16} />, label: "Dot Color", swatch: color, sub: color.toUpperCase() },
                { key: "grid" as const, icon: <Grid3x3 size={16} />, label: "Grid Color", swatch: gridColor, sub: gridColor.toUpperCase() },
                { key: "background" as const, icon: <PaintBucket size={16} />, label: "Background", swatch: canvasBg, sub: canvasBg.toUpperCase() },
              ]).map(({ key, icon, label, swatch, sub }) => {
                const active = inspect === key && !(tool === "erase") && !(tool === "select" && selectedKeys.size > 0);
                return (
                  <button key={key} onClick={() => setInspect(key)}
                    className={`flex items-center gap-3 rounded-xl px-3 py-2.5 transition-all ${active ? "bg-[var(--card-active)] ring-2 ring-[var(--solid)]/80" : "bg-[var(--ctl)] hover:bg-[var(--ctl-hover)]"
                      }`}>
                    <span className="text-[var(--txt-2)]">{icon}</span>
                    <span className="w-6 h-6 rounded-md shrink-0" style={{ backgroundColor: swatch, border: "1px solid rgba(0,0,0,0.1)" }} />
                    <span className="flex flex-col items-start leading-tight min-w-0">
                      <span className="text-[14px] text-[var(--txt-1)]">{label}</span>
                      <span className="text-[11px] text-[var(--txt-3)] font-mono uppercase truncate max-w-[150px]">{sub}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

        </div>

      </aside>

      {/* ── Canvas ── */}
      {/* Pointer handlers live on this HTML div, NOT the <svg>: WebKit's
          setPointerCapture is broken on SVG elements, and without capture
          Safari pointercancels a Pencil drag as a system gesture — strokes
          died after the first dot on iPad. handlePointerDown gates on the
          event target so the overlay buttons inside this div never paint. */}
      <div ref={containerRef} className="flex-1 relative overflow-hidden"
        style={{ touchAction: "none" }}
        onPointerDown={handlePointerDown} onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp} onPointerLeave={handlePointerLeave}
        onPointerCancel={handlePointerCancel}
        onDoubleClick={handleDoubleClick}>
        {/* Canvas substrate — viewport bg, shadow, canvas bg, grid, border,
            mirror axes, and the dots. See `drawScene` above. Sits BEHIND the svg via
            DOM order (both position:absolute inset-0, no z-index). */}
        <canvas ref={sceneCanvasRef} className="absolute inset-0" style={{ width: viewportSize.width, height: viewportSize.height }} />
        <svg ref={svgRef} width={viewportSize.width} height={viewportSize.height}
          className="absolute inset-0 select-none" style={{ touchAction: "none" }}>

          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom}) rotate(${(rot * 180) / Math.PI})`}>
            {/* Dots themselves render to the <canvas> underneath now (see
                drawScene above) — composited bottom→top across every visible
                layer there. Selection/hover rings stay SVG, here. */}
            {(selectedKeys.size > 0 || hoveredDotKey) && (
              <SelectionOverlay
                dots={dots}
                selectedKeys={selectedKeys}
                hoveredDotKey={hoveredDotKey}
                isDragging={isDragging}
                moveDx={moveDx}
                moveDy={moveDy}
                zoom={zoom}
                selectionRingColor={selectionRingColor}
              />
            )}

            {rulerGuide && tool === "draw" && (
              /* Magnetic-ruler rail: visible only while the stroke is locked
                 onto a lattice direction; swerving off it breaks the lock. */
              <line x1={rulerGuide.x1} y1={rulerGuide.y1} x2={rulerGuide.x2} y2={rulerGuide.y2}
                stroke={color} strokeOpacity={0.35} strokeWidth={1.5 / zoom}
                strokeDasharray={`${6 / zoom},${4 / zoom}`} style={{ pointerEvents: "none" }} />
            )}
            {preview && tool === "draw" && (
              <g style={{ pointerEvents: "none" }}>
                {shapeDot(preview.x, preview.y, radius, color, 0.4)}
                {/* Snap-reach halo: the true catch distance — the next point
                    grabs the pen when it crosses this ring. Scales live with
                    the Snap reach slider (and with snap mode's lattice step). */}
                <circle cx={preview.x} cy={preview.y}
                  r={snapSpacing(snapMode) * snapReach / 100}
                  fill="none" stroke={color} strokeOpacity={0.45}
                  strokeWidth={1 / zoom} strokeDasharray={`${3 / zoom},${2 / zoom}`} />
              </g>
            )}
            {/* Spacing readout: an L-shaped dimension tape from the last
                placed dot to the cursor, labelled with the x / y offset in
                subgrid steps — so non-uniform gaps can be judged by eye while
                hand-drawing. Hidden mid-stroke (it's for aiming the next dot). */}
            {tool === "draw" && lastPlaced && preview && !isPaintingRef.current && (() => {
              const dxSub = Math.round((preview.x - lastPlaced.x) / FINE_CELL);
              const dySub = Math.round((preview.y - lastPlaced.y) / FINE_CELL);
              const ring = (
                <circle cx={lastPlaced.x} cy={lastPlaced.y} r={radius + 3 / zoom} fill="none"
                  stroke={selectionRingColor} strokeOpacity={0.7} strokeWidth={1 / zoom} />
              );
              if (dxSub === 0 && dySub === 0) return <g style={{ pointerEvents: "none" }}>{ring}</g>;
              const ex = preview.x, ey = lastPlaced.y; // right-angle elbow
              const label = (x: number, y: number, txt: string) => (
                <g transform={`rotate(${-(rot * 180) / Math.PI} ${x} ${y})`}>
                  <text x={x} y={y} fontSize={19 / zoom} fill={selectionRingColor}
                    stroke={canvasBg} strokeWidth={3 / zoom} textAnchor="middle"
                    style={{ paintOrder: "stroke", fontWeight: 600 }}>{txt}</text>
                </g>
              );
              return (
                <g style={{ pointerEvents: "none" }}>
                  {ring}
                  {dxSub !== 0 && (
                    <line x1={lastPlaced.x} y1={lastPlaced.y} x2={ex} y2={ey}
                      stroke={selectionRingColor} strokeOpacity={0.55} strokeWidth={1 / zoom}
                      strokeDasharray={`${4 / zoom},${3 / zoom}`} />
                  )}
                  {dySub !== 0 && (
                    <line x1={ex} y1={ey} x2={preview.x} y2={preview.y}
                      stroke={selectionRingColor} strokeOpacity={0.55} strokeWidth={1 / zoom}
                      strokeDasharray={`${4 / zoom},${3 / zoom}`} />
                  )}
                  {dxSub !== 0 && label((lastPlaced.x + ex) / 2, lastPlaced.y - 10 / zoom, `${Math.abs(dxSub)}`)}
                  {dySub !== 0 && label(ex + 15 / zoom, (ey + preview.y) / 2, `${Math.abs(dySub)}`)}
                </g>
              );
            })()}
            {preview && tool === "erase" && (
              <circle cx={preview.x} cy={preview.y} r={eraseRadius} fill="none"
                stroke="#ef4444" strokeWidth={1.5 / zoom} strokeDasharray={`${3 / zoom},${2 / zoom}`}
                style={{ pointerEvents: "none" }} />
            )}

            {lineGuide && tool === "line" && (
              <g style={{ pointerEvents: "none" }}>
                <line x1={lineGuide.x1} y1={lineGuide.y1} x2={lineGuide.x2} y2={lineGuide.y2}
                  stroke={color} strokeOpacity={0.4} strokeWidth={1.5 / zoom}
                  strokeDasharray={`${6 / zoom},${4 / zoom}`} />
                {linePreview?.map((p) => shapeDot(p.x, p.y, radius, color, 0.4, p.key))}
                {(() => {
                  const dx = lineGuide.x2 - lineGuide.x1, dy = lineGuide.y2 - lineGuide.y1;
                  if (Math.hypot(dx, dy) < 1) return null;
                  // World-space angle (matches the dots' actual placement, not the
                  // on-screen twist), normalized to 0–359.
                  const angleDeg = Math.round((((Math.atan2(dy, dx) * 180) / Math.PI) % 360 + 360) % 360);
                  const lx = lineGuide.x2 + 10 / zoom, ly = lineGuide.y2 - 10 / zoom;
                  return (
                    // Counter-rotate so the readout stays upright even while the
                    // canvas itself is twisted (two-finger rotate on touch).
                    <g transform={`rotate(${-(rot * 180) / Math.PI} ${lx} ${ly})`}>
                      <text x={lx} y={ly} fontSize={13 / zoom} fill={color}
                        stroke={canvasBg} strokeWidth={3 / zoom}
                        style={{ paintOrder: "stroke", fontWeight: 600 }}>
                        {angleDeg}°
                      </text>
                    </g>
                  );
                })()}
              </g>
            )}

            {tool === "pen" && penAnchors.length > 0 && (
              <g style={{ pointerEvents: "none" }}>
                {pathCurve ? (
                  /* Curved mode: one polyline through the tessellated curve
                     (including the cursor as a provisional final anchor) so
                     you see the real curve as you aim the next point. */
                  <polyline fill="none" stroke={color} strokeOpacity={0.5} strokeWidth={1.5 / zoom}
                    points={pathPolyline(penCursor ? [...penAnchors, penCursor] : penAnchors, true)
                      .map((p) => `${p.x},${p.y}`).join(" ")} />
                ) : (
                  <>
                    {/* Committed segments, solid — distinct from the dashed rubber-band. */}
                    {penAnchors.slice(1).map((p, i) => (
                      <line key={i} x1={penAnchors[i].x} y1={penAnchors[i].y} x2={p.x} y2={p.y}
                        stroke={color} strokeOpacity={0.55} strokeWidth={1.5 / zoom} />
                    ))}
                    {penCursor && (
                      <line x1={penAnchors[penAnchors.length - 1].x} y1={penAnchors[penAnchors.length - 1].y}
                        x2={penCursor.x} y2={penCursor.y}
                        stroke={color} strokeOpacity={0.4} strokeWidth={1.5 / zoom}
                        strokeDasharray={`${6 / zoom},${4 / zoom}`} />
                    )}
                  </>
                )}
                {penAnchors.map((p, i) => (
                  <circle key={i} cx={p.x} cy={p.y} r={(i === 0 && penAnchors.length >= 2 ? 5 : 3) / zoom}
                    fill={i === 0 && penAnchors.length >= 2 ? "none" : color}
                    stroke={color} strokeWidth={1.5 / zoom} />
                ))}
                {penPreview?.map((p) => shapeDot(p.x, p.y, radius, color, 0.4, p.key))}
                {penCursor && (() => {
                  const last = penAnchors[penAnchors.length - 1];
                  const dx = penCursor.x - last.x, dy = penCursor.y - last.y;
                  if (Math.hypot(dx, dy) < 1) return null;
                  const angleDeg = Math.round((((Math.atan2(dy, dx) * 180) / Math.PI) % 360 + 360) % 360);
                  const lx = penCursor.x + 10 / zoom, ly = penCursor.y - 10 / zoom;
                  return (
                    <g transform={`rotate(${-(rot * 180) / Math.PI} ${lx} ${ly})`}>
                      <text x={lx} y={ly} fontSize={13 / zoom} fill={color}
                        stroke={canvasBg} strokeWidth={3 / zoom}
                        style={{ paintOrder: "stroke", fontWeight: 600 }}>
                        {angleDeg}°
                      </text>
                    </g>
                  );
                })()}
                {penCursor && (() => {
                  // Absolute cursor position on the canvas, origin at the
                  // canvas CENTER, in sub-grid steps (FINE_CELL = 1 unit) —
                  // distinct from the angle label above, which is relative
                  // to the last anchor.
                  const gx = Math.round((penCursor.x - canvasPxW / 2) / FINE_CELL);
                  const gy = Math.round((penCursor.y - canvasPxH / 2) / FINE_CELL);
                  const lx = penCursor.x + 10 / zoom, ly = penCursor.y + 20 / zoom;
                  return (
                    <g transform={`rotate(${-(rot * 180) / Math.PI} ${lx} ${ly})`}>
                      <text x={lx} y={ly} fontSize={13 / zoom} fill={color}
                        stroke={canvasBg} strokeWidth={3 / zoom}
                        style={{ paintOrder: "stroke", fontWeight: 600 }}>
                        {gx}, {gy}
                      </text>
                    </g>
                  );
                })()}
              </g>
            )}

            {shapeGuide && tool === "shape" && (
              <g style={{ pointerEvents: "none" }}>
                {shapeGuide.rx >= 1 && shapeGuide.ry >= 1 && (
                  shapeType === "ellipse" ? (
                    <ellipse cx={shapeGuide.cx} cy={shapeGuide.cy} rx={shapeGuide.rx} ry={shapeGuide.ry}
                      fill="none" stroke={color} strokeOpacity={0.4} strokeWidth={1.5 / zoom}
                      strokeDasharray={`${6 / zoom},${4 / zoom}`} />
                  ) : (
                    <polyline fill="none" stroke={color} strokeOpacity={0.4} strokeWidth={1.5 / zoom}
                      strokeDasharray={`${6 / zoom},${4 / zoom}`}
                      points={shapeVertices(shapeType, shapeGuide.cx, shapeGuide.cy, shapeGuide.rx, shapeGuide.ry, shapeSides).map((p) => `${p.x},${p.y}`).join(" ")} />
                  )
                )}
                {/* Center crosshair (center-anchor mode) so the anchor is unambiguous. */}
                {shapeAnchor === "center" && (
                  <g stroke={color} strokeOpacity={0.65} strokeWidth={1 / zoom}>
                    <line x1={shapeGuide.cx - 5 / zoom} y1={shapeGuide.cy} x2={shapeGuide.cx + 5 / zoom} y2={shapeGuide.cy} />
                    <line x1={shapeGuide.cx} y1={shapeGuide.cy - 5 / zoom} x2={shapeGuide.cx} y2={shapeGuide.cy + 5 / zoom} />
                  </g>
                )}
                {shapePreview?.map((p) => shapeDot(p.x, p.y, radius, color, 0.4, p.key))}
                {(() => {
                  // Before a drag has size: show the anchor's x,y (in cells, ½-cell
                  // precision). During the drag: radius (center mode) or w×h (corner),
                  // placed past the top-right of the box. Upright under canvas rotation.
                  const started = shapeGuide.rx >= 1 && shapeGuide.ry >= 1;
                  const half = (v: number) => Math.round((v / CELL_SIZE) * 2) / 2;
                  let txt: string, lx: number, ly: number;
                  if (!started) {
                    txt = `${half(shapeGuide.cx)}, ${half(shapeGuide.cy)}`;
                    lx = shapeGuide.cx + 10 / zoom; ly = shapeGuide.cy - 10 / zoom;
                  } else if (shapeAnchor === "center") {
                    const rxC = half(shapeGuide.rx), ryC = half(shapeGuide.ry);
                    txt = rxC === ryC ? `r ${rxC}` : `r ${rxC}×${ryC}`;
                    lx = shapeGuide.cx + shapeGuide.rx + 10 / zoom; ly = shapeGuide.cy - shapeGuide.ry - 10 / zoom;
                  } else {
                    txt = `${Math.max(1, Math.round((shapeGuide.rx * 2) / CELL_SIZE))}×${Math.max(1, Math.round((shapeGuide.ry * 2) / CELL_SIZE))}`;
                    lx = shapeGuide.cx + shapeGuide.rx + 10 / zoom; ly = shapeGuide.cy - shapeGuide.ry - 10 / zoom;
                  }
                  return (
                    <g transform={`rotate(${-(rot * 180) / Math.PI} ${lx} ${ly})`}>
                      <text x={lx} y={ly} fontSize={13 / zoom} fill={color}
                        stroke={canvasBg} strokeWidth={3 / zoom}
                        style={{ paintOrder: "stroke", fontWeight: 600 }}>
                        {txt}
                      </text>
                    </g>
                  );
                })()}
              </g>
            )}

            {tool === "array" && (
              <g style={{ pointerEvents: "none" }}>
                {arrayMode === "curve" && arrayCurveAnchors.length > 0 && (
                  <>
                    <polyline fill="none" stroke={color} strokeOpacity={0.4} strokeWidth={1.5 / zoom}
                      strokeDasharray={`${6 / zoom},${4 / zoom}`}
                      points={pathPolyline(arrayCurveCursor ? [...arrayCurveAnchors, arrayCurveCursor] : arrayCurveAnchors, arrayPathCurved)
                        .map((p) => `${p.x},${p.y}`).join(" ")} />
                    {arrayCurveAnchors.map((p, i) => (
                      <circle key={i} cx={p.x} cy={p.y} r={(i === 0 && arrayCurveAnchors.length >= 2 ? 5 : 3) / zoom}
                        fill={i === 0 && arrayCurveAnchors.length >= 2 ? "none" : color}
                        stroke={color} strokeWidth={1.5 / zoom} />
                    ))}
                  </>
                )}
                {/* Each ghost uses its OWN color/radius, not the current brush —
                    the motif can be multi-colored and the preview must show that
                    faithfully (same distinction placeDots draws vs commitLineDots). */}
                {arrayPreview.map((d) => shapeDot(d.x, d.y, d.radius, d.color, 0.4, d.key))}
              </g>
            )}

            {marqueeBox && (
              <rect
                x={Math.min(marqueeBox.wx1, marqueeBox.wx2)}
                y={Math.min(marqueeBox.wy1, marqueeBox.wy2)}
                width={Math.abs(marqueeBox.wx2 - marqueeBox.wx1)}
                height={Math.abs(marqueeBox.wy2 - marqueeBox.wy1)}
                fill={selectionRingColor} fillOpacity={0.06}
                stroke={selectionRingColor} strokeWidth={1 / zoom}
                strokeDasharray={`${4 / zoom},${3 / zoom}`}
                style={{ pointerEvents: "none" }}
              />
            )}
          </g>

          {/* Must stay the LAST child of <svg> — it's the sole native
              hit-target for cursor purposes; anything added after this point
              will intercept pointer events meant for the canvas. Carries the
              reactive `cursor` value instead of the <svg> root so changing it
              doesn't force the browser to resolve inherited style across the
              (tens-of-thousands-large) dot subtree above — see CLAUDE.md's
              Layers section for the measured cost this avoids.
              pointer-events:"all" makes it hit-testable despite fill="none". */}
          <rect data-cursor-surface="" x={0} y={0} width={viewportSize.width} height={viewportSize.height}
            fill="none" style={{ cursor, pointerEvents: "all" }} />
        </svg>

        {/* Stats + Layers panel (floating, top-right) — same pill height as
            the Tools cluster and the Undo/Redo cluster for visual consistency. */}
        <div className="absolute top-4 right-4 z-20 flex items-start gap-2">
          {/* Autosave-quota warning — the debounced localStorage backup
              (separate from Save Project) silently stops working past
              ~5-10MB of serialized dots; this makes that visible instead of
              a quietly-broken crash-recovery net. Clears itself once a save
              succeeds again. */}
          {autosaveFailed && (
            <div title="The document is too large for the browser's autosave backup. Your crash-recovery safety net is off — use Save Project to keep your work."
              className="h-[43px] px-[14px] flex items-center gap-[7px] rounded-xl text-[12px] backdrop-blur-sm border border-amber-500/40 shadow-sm bg-amber-500/15 text-amber-600 dark:text-amber-400">
              <TriangleAlert size={14} />
              <span>Autosave off — save manually</span>
            </div>
          )}
          {/* Dot count + physical canvas size — replaces both the left
              panel's old status footer and the bottom-left status pill
              (removed). Size is shown once (WxH unit), not as both grid
              cell count and physical size. Zoom isn't repeated here either —
              it's already shown in the bottom-right zoom cluster. */}
          <div className="h-[43px] px-[14px] flex items-center gap-[7px] rounded-xl text-[12px] backdrop-blur-sm border border-[var(--overlay-border)]/60 shadow-sm bg-[var(--overlay)]/85 text-[var(--overlay-fg)]">
            <span>{dots.size} dot{dots.size !== 1 ? "s" : ""}</span>
            <span className="text-[var(--overlay-fg-muted)]">·</span>
            <span className="font-mono text-[var(--overlay-fg-muted)]">
              {roundForUnit(canvasPhysW, unit)}×{roundForUnit(canvasPhysH, unit)}{unit === "in" ? "\"" : ` ${unit}`}
            </span>
          </div>
          <div className="flex flex-col items-end gap-2">
          <button onClick={() => setShowLayers((v) => !v)} title="Layers"
            className={`h-[43px] px-[14px] flex items-center gap-[5px] rounded-xl text-[12px] backdrop-blur-sm border border-[var(--overlay-border)]/60 shadow-sm transition-colors ${showLayers ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--overlay)]/85 text-[var(--overlay-fg)] hover:bg-[var(--ctl-hover)]"}`}>
            <LayersIcon size={14} /> Layers
          </button>
          {showLayers && (
            <div className="w-[230px] bg-[var(--card)] rounded-2xl p-[7px] shadow-xl border border-[var(--overlay-border)]/60 flex flex-col gap-[7px]">
              <div className="flex items-center justify-between px-1">
                <span className="text-[12px] text-[var(--txt-2)]">
                  {mergeSelectCount >= 2 ? `${mergeSelectCount} selected` : "Layers"}
                </span>
                <div className="flex items-center gap-1">
                  {mergeSelectCount >= 2 && (
                    <button
                      onClick={() => { mergeLayers(Array.from(mergeSelectIds)); setMergeSelectIds(new Set()); }}
                      title="Merge selected layers"
                      className="h-[25px] px-[7px] flex items-center gap-1 rounded-lg bg-[var(--solid)] text-[var(--solid-fg)] hover:opacity-90 transition-colors text-[11px]">
                      <Combine size={13} /> Merge
                    </button>
                  )}
                  <button onClick={addLayer} title="New layer"
                    className="w-[25px] h-[25px] flex items-center justify-center rounded-lg bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)] transition-colors">
                    <Plus size={14} />
                  </button>
                </div>
              </div>
              <div className="flex flex-col gap-1 max-h-[52vh] overflow-y-auto" style={{ scrollbarWidth: "none" }}>
                {layers.map((l, i) => ({ l, i })).reverse().map(({ l, i }) => {
                  const active = l.id === activeLayerId;
                  const picked = mergeSelectIds.has(l.id);
                  return (
                    <div key={l.id} onClick={() => selectLayer(l.id)}
                      className={`flex items-center gap-1 rounded-xl px-[5px] py-[5px] cursor-pointer transition-colors ${picked ? "ring-1 ring-sky-400/70 bg-sky-400/10" : active ? "bg-[var(--solid)]/15 ring-1 ring-[var(--solid)]/40" : "bg-[var(--ctl)] hover:bg-[var(--ctl-hover)]"}`}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setMergeSelectIds((prev) => {
                            const next = new Set(prev);
                            next.has(l.id) ? next.delete(l.id) : next.add(l.id);
                            return next;
                          });
                        }}
                        title={picked ? "Remove from merge selection" : "Pick for merge"}
                        disabled={layers.length <= 1}
                        className={`w-[14px] h-[14px] rounded border shrink-0 flex items-center justify-center transition-colors ${picked ? "bg-sky-400 border-sky-400" : "border-[var(--txt-3)] disabled:opacity-25"}`}>
                        {picked && <Check size={10} className="text-white" />}
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); toggleLayerVisible(l.id); }} title={l.visible ? "Hide" : "Show"}
                        className="w-[22px] h-[22px] flex items-center justify-center rounded text-[var(--txt-2)] hover:text-[var(--txt-1)] shrink-0">
                        {l.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                      </button>
                      <input value={l.name} onChange={(e) => renameLayer(l.id, e.target.value)}
                        className="flex-1 min-w-0 bg-transparent text-[12px] text-[var(--txt-1)] outline-none" />
                      <span className="text-[9px] text-[var(--txt-3)] tabular-nums shrink-0 mr-0.5">{l.dots.size}</span>
                      <button onClick={(e) => { e.stopPropagation(); moveLayer(l.id, 1); }} disabled={i === layers.length - 1} title="Move up"
                        className="w-[22px] h-[22px] flex items-center justify-center rounded text-[var(--txt-2)] hover:text-[var(--txt-1)] disabled:opacity-25 shrink-0"><ChevronUp size={13} /></button>
                      <button onClick={(e) => { e.stopPropagation(); moveLayer(l.id, -1); }} disabled={i === 0} title="Move down"
                        className="w-[22px] h-[22px] flex items-center justify-center rounded text-[var(--txt-2)] hover:text-[var(--txt-1)] disabled:opacity-25 shrink-0"><ChevronDown size={13} /></button>
                      <button onClick={(e) => { e.stopPropagation(); duplicateLayer(l.id); }} title="Duplicate"
                        className="w-[22px] h-[22px] flex items-center justify-center rounded text-[var(--txt-2)] hover:text-[var(--txt-1)] shrink-0"><Copy size={12} /></button>
                      <button onClick={(e) => { e.stopPropagation(); deleteLayer(l.id); }} disabled={layers.length <= 1} title="Delete"
                        className="w-[22px] h-[22px] flex items-center justify-center rounded text-[var(--txt-2)] hover:text-[#ef4444] disabled:opacity-25 shrink-0"><Trash2 size={12} /></button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          </div>
        </div>

        {/* Tools cluster (top-left) — floats on the canvas instead of
            crowding the left panel; same visual language as the bottom
            undo/redo pill. In compact mode it drops below the Menu FAB
            (which also lives at top-4 left-4) so the two don't collide. */}
        <div className={`absolute left-4 flex items-center gap-1 bg-[var(--overlay)] border border-[var(--overlay-border)] rounded-2xl shadow-sm px-1 py-1 ${compact ? "top-20" : "top-4"}`}>
          {([
            { t: "select" as Tool, icon: <MousePointer2 size={17} />, label: "Select (V)" },
            { t: "draw" as Tool, icon: <Pen size={17} />, label: "Draw (B)" },
            { t: "erase" as Tool, icon: <Eraser size={17} />, label: "Erase (E)" },
            { t: "line" as Tool, icon: <Slash size={17} />, label: "Line (L)" },
            { t: "pen" as Tool, icon: <PenTool size={17} />, label: "Pen (P)" },
            { t: "shape" as Tool, icon: <Circle size={17} />, label: "Shape (S)" },
            { t: "array" as Tool, icon: <Repeat size={17} />, label: "Array (A)" },
          ]).map(({ t, icon, label }) => (
            <div key={t} className="relative group">
              <button aria-label={label}
                onClick={() => {
                  // Switching away from Pen mid-path discards the pending
                  // anchors — you can't leave a dangling path around.
                  if (tool === "pen" && t !== "pen" && penAnchorsRef.current.length > 0) cancelPenPath();
                  // Same for Array's Curve mode.
                  if (tool === "array" && t !== "array" && arrayCurveAnchorsRef.current.length > 0) cancelArrayCurve();
                  setTool(t);
                  if (t === "select") sfx.toolSelect(); else if (t === "draw" || t === "line" || t === "pen" || t === "shape" || t === "array") sfx.toolDraw(); else sfx.toolErase();
                  if (t === "draw" || t === "line" || t === "pen" || t === "shape") setInspect("dot");
                  // Array reuses the current selection as its motif, so it
                  // joins Select as the tools that don't clear it on switch.
                  if (t !== "select" && t !== "array") { setSelectedKeys(new Set()); selectedKeysRef.current = new Set(); }
                }}
                className={`w-[43px] h-[43px] rounded-xl flex items-center justify-center transition-all ${tool === t ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "text-[var(--overlay-fg)] hover:bg-[var(--ctl-hover)]"
                  }`}>
                {icon}
              </button>
              <div className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-2 whitespace-nowrap text-[11px] text-[var(--overlay-fg)] bg-[var(--overlay)] border border-[var(--overlay-border)] rounded-md px-2 py-1 shadow-sm opacity-0 group-hover:opacity-100 transition-opacity delay-150 z-10">
                {label}
              </div>
            </div>
          ))}
        </div>

        {/* Undo / redo cluster (bottom-center) — floats on the canvas so it's
            one tap on iPad without opening the tools panel; targets are kept
            big (48px tall, wide pads) so a finger can't miss mid-flow. */}
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-0.5 bg-[var(--overlay)] border border-[var(--overlay-border)] rounded-2xl shadow-sm px-1 py-1">
          <button onClick={undo} disabled={undoCount === 0} title="Undo (Ctrl+Z)" aria-label="Undo"
            className="h-[43px] px-[18px] flex items-center justify-center gap-[7px] rounded-xl hover:bg-[var(--ctl-hover)] text-[var(--overlay-fg)] text-[12px] disabled:opacity-30 disabled:cursor-not-allowed transition-colors select-none touch-none">
            <Undo2 size={17} /> Undo
          </button>
          <div className="w-px h-[18px] bg-[var(--overlay-border)] mx-0.5" />
          <button onClick={redo} disabled={redoCount === 0} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"
            className="h-[43px] px-[18px] flex items-center justify-center gap-[7px] rounded-xl hover:bg-[var(--ctl-hover)] text-[var(--overlay-fg)] text-[12px] disabled:opacity-30 disabled:cursor-not-allowed transition-colors select-none touch-none">
            Redo <Redo2 size={17} />
          </button>
          <div className="w-px h-[18px] bg-[var(--overlay-border)] mx-0.5" />
          <button onClick={toggleRuler} aria-pressed={rulerOn} aria-label="Toggle magnetic ruler"
            title={rulerOn ? "Magnetic ruler on — strokes straighten onto a line (tap to turn off for curves)" : "Magnetic ruler off — strokes follow the hand freely"}
            className={`h-[43px] px-[14px] flex items-center justify-center rounded-xl text-[12px] transition-colors select-none touch-none ${rulerOn ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "text-[var(--overlay-fg)] hover:bg-[var(--ctl-hover)]"}`}>
            <Ruler size={17} />
          </button>
          <div className="w-px h-[18px] bg-[var(--overlay-border)] mx-0.5" />
          <button onClick={toggleMirrorX} aria-pressed={mirrorX} aria-label="Toggle left-right mirror"
            title={mirrorX ? "Left-right mirror on — every dot reflects across the vertical center" : "Left-right mirror off"}
            className={`h-[43px] px-[14px] flex items-center justify-center rounded-xl text-[12px] transition-colors select-none touch-none ${mirrorX ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "text-[var(--overlay-fg)] hover:bg-[var(--ctl-hover)]"}`}>
            <FlipHorizontal2 size={17} />
          </button>
          <button onClick={toggleMirrorY} aria-pressed={mirrorY} aria-label="Toggle top-bottom mirror"
            title={mirrorY ? "Top-bottom mirror on — every dot reflects across the horizontal center" : "Top-bottom mirror off"}
            className={`h-[43px] px-[14px] flex items-center justify-center rounded-xl text-[12px] transition-colors select-none touch-none ${mirrorY ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "text-[var(--overlay-fg)] hover:bg-[var(--ctl-hover)]"}`}>
            <FlipVertical2 size={17} />
          </button>
        </div>

        {/* Layer-nav arrows — pinned to the CANVAS's top-right corner (not
            the viewport): the corner's world point (canvasPxW, 0) is projected
            through the view transform screen = pan + zoom·R(rot)·world, so the
            cluster tracks pan/zoom/rotation with the artwork. ▲ = layer above,
            ▼ = layer below; the landed-on layer's name toasts beneath.
            Hidden entirely in a single-layer doc (nothing to switch to). */}
        {layers.length > 1 && (() => {
          const c = Math.cos(rot), s = Math.sin(rot);
          const sx = pan.x + zoom * (canvasPxW * c);
          const sy = pan.y + zoom * (canvasPxW * s);
          return (
            <div className="absolute z-20 flex flex-col items-center gap-1.5"
              style={{ left: sx + 14, top: sy }}>
              <button onClick={() => switchLayer(1)} disabled={!canLayerUp}
                aria-label="Switch to layer above"
                title={canLayerUp ? `Layer above: ${layers[activeLayerIdx + 1]?.name ?? ""}` : "Already on the top layer"}
                className={`w-10 h-10 flex items-center justify-center rounded-full backdrop-blur-sm border border-[var(--overlay-border)]/60 shadow-sm text-[var(--overlay-fg)] transition-colors touch-none ${canLayerUp ? "bg-[var(--overlay)]/85 hover:bg-[var(--ctl-hover)]" : "bg-[var(--overlay)]/40 opacity-30 cursor-not-allowed"}`}>
                <ChevronUp size={20} />
              </button>
              <button onClick={() => switchLayer(-1)} disabled={!canLayerDown}
                aria-label="Switch to layer below"
                title={canLayerDown ? `Layer below: ${layers[activeLayerIdx - 1]?.name ?? ""}` : "Already on the bottom layer"}
                className={`w-10 h-10 flex items-center justify-center rounded-full backdrop-blur-sm border border-[var(--overlay-border)]/60 shadow-sm text-[var(--overlay-fg)] transition-colors touch-none ${canLayerDown ? "bg-[var(--overlay)]/85 hover:bg-[var(--ctl-hover)]" : "bg-[var(--overlay)]/40 opacity-30 cursor-not-allowed"}`}>
                <ChevronDown size={20} />
              </button>
              {layerToast && (
                <div key={layerToast.id}
                  style={{ "--ty": layerToast.dir === 1 ? "8px" : "-8px" } as React.CSSProperties}
                  className="dotart-layer-toast px-2.5 py-1 rounded-lg bg-[var(--overlay)]/90 backdrop-blur-sm border border-[var(--overlay-border)]/60 shadow-sm text-[11px] text-[var(--overlay-fg)] whitespace-nowrap pointer-events-none">
                  {layerToast.name}
                </div>
              )}
            </div>
          );
        })()}

        {/* Zoom cluster (bottom-right) */}
        <div className="absolute bottom-4 right-4 flex items-center gap-0.5 bg-[var(--overlay)] border border-[var(--overlay-border)] rounded-lg shadow-sm px-1 py-1">
          <button onClick={() => zoomTo(zoom / 1.3)} className="w-7 h-7 flex items-center justify-center rounded hover:bg-[var(--ctl-hover)] text-[var(--overlay-fg-muted)] transition-colors"><ZoomOut size={13} /></button>
          <button onClick={fitToViewport} className="px-2 h-7 flex items-center justify-center rounded hover:bg-[var(--ctl-hover)] text-[var(--overlay-fg)] transition-colors font-mono" style={{ fontSize: "11px", minWidth: "44px" }}>{zoomPct}%</button>
          <button onClick={() => zoomTo(zoom * 1.3)} className="w-7 h-7 flex items-center justify-center rounded hover:bg-[var(--ctl-hover)] text-[var(--overlay-fg-muted)] transition-colors"><ZoomIn size={13} /></button>
          <div className="w-px h-4 bg-[var(--overlay-border)] mx-0.5" />
          <button onClick={fitToViewport} title="Fit to view" className="w-7 h-7 flex items-center justify-center rounded hover:bg-[var(--ctl-hover)] text-[var(--overlay-fg-muted)] transition-colors"><Maximize2 size={12} /></button>
        </div>

        {/* Spacing-sequence HUD: the last few gaps between placed dots, in
            subgrid steps — so a manual ramp (5, 6, 8, …) can be kept
            consistent. Newest is emphasized; click to reset the count. */}
        {tool === "draw" && gapSeq.length > 0 && (
          <button
            onClick={() => { setGapSeq([]); setLastPlaced(null); lastPlacedRef.current = null; }}
            title="Gap x,y between placed dots, in subgrid steps · click to reset"
            className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-[var(--overlay)] border border-[var(--overlay-border)] rounded-lg shadow-sm px-3 py-1.5 text-[11px] hover:bg-[var(--ctl-hover)] transition-colors">
            <span className="text-[var(--overlay-fg-muted)]">Gaps x,y</span>
            <span className="flex items-center gap-2 font-mono tabular-nums">
              {gapSeq.map((g, i) => (
                <span key={i} className={i === gapSeq.length - 1 ? "text-[var(--txt-1)] font-semibold" : "text-[var(--overlay-fg-muted)]"}>{g.x},{g.y}</span>
              ))}
            </span>
          </button>
        )}

        {/* Compact: floating buttons to reveal the tool / properties panels.
            Pen draws · one finger pans · two fingers pinch-zoom + rotate. */}
        {compact && (
          <>
            <button onClick={() => { setLeftOpen((v) => !v); setRightOpen(false); }} aria-label="Tools panel"
              className="absolute top-4 left-4 z-30 w-12 h-12 rounded-2xl bg-[var(--card)] text-[var(--txt-1)] shadow-lg flex items-center justify-center active:scale-95 transition-transform">
              <Menu size={20} />
            </button>
            <button onClick={() => { setRightOpen((v) => !v); setLeftOpen(false); }} aria-label="Properties panel"
              className="absolute top-4 right-4 z-30 w-12 h-12 rounded-2xl bg-[var(--card)] text-[var(--txt-1)] shadow-lg flex items-center justify-center active:scale-95 transition-transform">
              <SlidersHorizontal size={19} />
            </button>
          </>
        )}

      </div>

      {/* ── Right panel — context inspector for the selected element ── */}
      <aside className={`${compact ? `fixed right-0 top-0 z-50 bg-[var(--app-bg)] shadow-2xl transition-transform duration-300 ${rightOpen ? "translate-x-0" : "translate-x-full"}` : "relative"} w-[300px] max-w-[88vw] shrink-0 h-dvh p-4 flex flex-col gap-4 overflow-hidden`}>
        <div className="bg-[var(--card)] rounded-3xl p-4 flex-1 overflow-y-auto flex flex-col gap-4 [&>*]:shrink-0" style={{ scrollbarWidth: "none" }}>

          <div className="flex items-center justify-between">
            <span className="text-[19px] font-medium text-[var(--txt-title)] tracking-[-0.4px]">{ctxTitle}</span>
            {editingSelection && <span className="text-[12px] text-[var(--txt-3)]">{selectedKeys.size} selected</span>}
          </div>

          {/* ── Dot / Selection color editor ── */}
          {isColorCtx && (
            <>
              <div className="dot-picker rounded-2xl overflow-hidden"
                onPointerDown={() => { if (editingSelection) pushUndo(); }}
                onPointerUp={() => pushRecentColor(lastPickRef.current)}>
                <HexColorPicker color={activeColor} onChange={onPickerChange} />
              </div>
              <div className="flex gap-2">
                <div className="flex-1 bg-[var(--ctl)] rounded-xl px-4 flex items-center text-[16px] text-[var(--txt-1)] font-mono uppercase">
                  {colorMixed ? "mixed" : activeColor}
                </div>
                <label className="w-[84px] h-12 rounded-xl cursor-pointer shrink-0 flex items-center justify-center"
                  style={{ backgroundColor: colorMixed ? "#f23a3a" : activeColor, border: "1px solid rgba(0,0,0,0.1)" }}
                  title="System color picker">
                  <input type="color" className="sr-only" value={colorMixed ? "#ffffff" : activeColor}
                    onChange={(e) => setActiveColor(e.target.value)} />
                </label>
              </div>

              <div className="bg-[var(--ctl)] rounded-xl overflow-hidden">
                <button onClick={() => setPaletteOpen((o) => !o)}
                  className="w-full flex items-center justify-between p-3 text-[15px] text-[var(--txt-1)]">
                  Recent &amp; Palette
                  {paletteOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
                {paletteOpen && (
                  <div className="p-3 pt-0 flex flex-col gap-3">
                    {recentColors.length > 0 && (
                      <div>
                        <div className="text-[13px] text-[var(--txt-3)] mb-2">Recent</div>
                        <div className="flex flex-wrap gap-2">
                          {recentColors.map((c) => (
                            <button key={c} onClick={() => chooseColor(c)} title={c.toUpperCase()}
                              className="w-9 h-9 rounded-lg transition-all hover:scale-105 active:scale-95"
                              style={{ backgroundColor: c, border: "1px solid rgba(0,0,0,0.1)" }} />
                          ))}
                        </div>
                      </div>
                    )}
                    <div>
                      <div className="text-[13px] text-[var(--txt-3)] mb-2">Palette</div>
                      <div className="grid grid-cols-5 gap-2">
                        {PALETTE.map((c) => {
                          const isActive = !colorMixed && activeColor.toLowerCase() === c.toLowerCase();
                          return (
                            <button key={c} onClick={() => chooseColor(c)} title={c.toUpperCase()}
                              className="aspect-square rounded-lg transition-all hover:scale-105 active:scale-95"
                              style={{ backgroundColor: c, outline: isActive ? "2.5px solid var(--solid)" : "1px solid rgba(0,0,0,0.1)", outlineOffset: "1px" }} />
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <button onClick={shuffleColors} title="Random background + grid + brush combination"
                className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] transition-all">
                <Dices className="w-4 h-4" />
                Shuffle colors
              </button>

              {tool === "draw" && (
                <ValueSlider label="Snap reach" min={10} max={70} step={5}
                  value={snapReach} display={`${snapReach}%`}
                  onChange={setSnapReach} />
              )}
              {(tool === "line" || tool === "pen" || tool === "shape") && (
                <>
                  {tool === "shape" && (
                    <>
                      <div className="grid grid-cols-5 gap-2">
                        {([
                          { k: "ellipse" as ShapeKind, label: "Ellipse", glyph: <ellipse cx={12} cy={8} rx={9} ry={6} /> },
                          { k: "rect" as ShapeKind, label: "Rectangle", glyph: <rect x={3} y={2.5} width={18} height={11} rx={1} /> },
                          { k: "diamond" as ShapeKind, label: "Diamond", glyph: <polygon points="12,1.5 21,8 12,14.5 3,8" /> },
                          { k: "triangle" as ShapeKind, label: "Triangle", glyph: <polygon points="12,1.5 21,14 3,14" /> },
                          { k: "polygon" as ShapeKind, label: "Polygon", glyph: <polygon points="12,1.5 20,6.2 17,14 7,14 4,6.2" /> },
                        ]).map(({ k, label, glyph }) => (
                          <button key={k} title={label}
                            onClick={() => { setShapeType(k); sfx.toggle(); }}
                            className={`aspect-square rounded-xl flex items-center justify-center transition-all ${shapeType === k ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
                              }`}>
                            <svg width="24" height="16" viewBox="0 0 24 16" fill="none" stroke="currentColor" strokeWidth={1.4}>
                              {glyph}
                            </svg>
                          </button>
                        ))}
                      </div>
                      {shapeType === "polygon" && (
                        <ValueSlider label="Sides" min={3} max={12}
                          value={shapeSides} display={`${shapeSides}`}
                          onChange={setShapeSides} />
                      )}
                      <div className="text-[13px] text-[var(--txt-2)] tracking-[-0.3px]">Start from</div>
                      <div className="flex gap-2">
                        {([
                          { a: "center" as const, label: "Center" },
                          { a: "corner" as const, label: "Corner" },
                        ]).map(({ a, label }) => (
                          <button key={a} onClick={() => { setShapeAnchor(a); sfx.toggle(); }}
                            className={`flex-1 py-2 rounded-xl text-[14px] transition-all ${shapeAnchor === a ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
                              }`}>
                            {label}
                          </button>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        {([
                          { f: false, label: "Outline" },
                          { f: true, label: "Filled" },
                        ]).map(({ f, label }) => (
                          <button key={label} onClick={() => { setShapeFilled(f); sfx.toggle(); }}
                            className={`flex-1 py-2 rounded-xl text-[14px] transition-all ${shapeFilled === f ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
                              }`}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                  {(tool !== "shape" || !shapeFilled) && (
                  <>
                  <div className="grid grid-cols-4 gap-2">
                    {([
                      { s: "even" as const, label: "Even", xs: [4, 12, 20, 28, 36] },
                      { s: "ramp" as const, label: "Ramp", xs: [3, 7, 13, 22, 37] },
                      { s: "taper" as const, label: "Taper", xs: [2, 9, 18, 22, 31, 38] },
                      { s: "pulse" as const, label: "Pulse", xs: [3, 7, 18, 22, 33, 37] },
                    ]).map(({ s, label, xs }) => (
                      <button key={s}
                        onClick={() => { setLineShape(s); if (s === "pulse" && lineAmount < 0) setLineAmount(Math.abs(lineAmount)); sfx.toggle(); }}
                        title={label}
                        className={`flex flex-col items-center gap-1 py-2 rounded-xl transition-all ${lineShape === s ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
                          }`}>
                        <svg width="40" height="10" viewBox="0 0 40 10" className="w-full">
                          {xs.map((x, i) => <circle key={i} cx={x} cy={5} r={1.6} fill="currentColor" />)}
                        </svg>
                        <span className="text-[11px]">{label}</span>
                      </button>
                    ))}
                  </div>
                  <ValueSlider label="Spacing" min={1} max={10}
                    value={lineInterval} display={`${lineInterval}`}
                    onChange={setLineInterval} />
                  {lineShape !== "even" && (
                    <ValueSlider label="Amount" min={lineShape === "pulse" ? 0 : -100} max={100} step={5}
                      value={lineAmount} display={`${lineAmount}`}
                      onChange={setLineAmount} />
                  )}
                  {lineShape === "pulse" && (
                    <ValueSlider label="Clusters" min={2} max={8}
                      value={lineCount} display={`${lineCount}`}
                      onChange={setLineCount} />
                  )}
                  </>
                  )}
                  {tool === "pen" && (
                    <div className="flex gap-2">
                      {([
                        { c: false, label: "Straight" },
                        { c: true, label: "Curved" },
                      ]).map(({ c, label }) => (
                        <button key={label} onClick={() => { setPathCurve(c); sfx.toggle(); }}
                          className={`flex-1 py-2 rounded-xl text-[14px] transition-all ${pathCurve === c ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
                            }`}>
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* ── Array tool: repeat the selected motif ── */}
          {rightCtx === "array" && (
            <>
              {selectedKeys.size === 0 ? (
                <p className="text-[14px] text-[var(--txt-2)] leading-relaxed px-1">
                  Select some dots first, then switch to Array.
                </p>
              ) : (
                <>
                  <div className="text-[13px] text-[var(--txt-3)] px-1">{selectedKeys.size} dots in motif</div>

                  <div className="flex gap-2">
                    {([
                      { m: "linear" as ArrayMode, label: "Linear" },
                      { m: "grid" as ArrayMode, label: "Grid" },
                      { m: "curve" as ArrayMode, label: "Curve" },
                    ]).map(({ m, label }) => (
                      <button key={m} onClick={() => { setArrayMode(m); sfx.toggle(); }}
                        className={`flex-1 py-2 rounded-xl text-[14px] transition-all ${arrayMode === m ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
                          }`}>
                        {label}
                      </button>
                    ))}
                  </div>

                  {arrayMode === "linear" && (
                    <>
                      <div className="flex gap-2">
                        {[0, 45, 90].map((a) => (
                          <button key={a} onClick={() => setArrayLinearAngle(a)}
                            className={`flex-1 py-2 rounded-xl text-[14px] transition-all ${arrayLinearAngle === a ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
                              }`}>
                            {a}°
                          </button>
                        ))}
                      </div>
                      {/* Corner = motif is one end of the ray (grows one way).
                          Center = motif is the midpoint (grows both ways). */}
                      <div className="flex gap-2">
                        {([{ v: false, label: "Corner" }, { v: true, label: "Center" }]).map(({ v, label }) => (
                          <button key={label} onClick={() => { setArrayLinearCentered(v); sfx.toggle(); }}
                            className={`flex-1 py-2 rounded-xl text-[14px] transition-all ${arrayLinearCentered === v ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
                              }`}>
                            {label}
                          </button>
                        ))}
                      </div>
                      <ValueSlider label="Angle" min={0} max={360} step={5}
                        value={arrayLinearAngle} display={`${arrayLinearAngle}°`}
                        onChange={setArrayLinearAngle} />
                      <ValueSlider label="Count" min={2} max={50}
                        value={arrayLinearCount} display={`${arrayLinearCount}`}
                        onChange={setArrayLinearCount} />
                      <ValueSlider label="Spacing" min={10} max={300} step={5}
                        value={arrayLinearSpacing} display={`${arrayLinearSpacing}px`}
                        onChange={setArrayLinearSpacing} />
                    </>
                  )}

                  {arrayMode === "grid" && (
                    <>
                      {/* Corner = motif is cell (row0,col0), grid grows right+down
                          only. Center = motif's cell is the middle, grid spreads
                          on all 4 sides. */}
                      <div className="flex gap-2">
                        {([{ v: false, label: "Corner" }, { v: true, label: "Center" }]).map(({ v, label }) => (
                          <button key={label} onClick={() => { setArrayGridCentered(v); sfx.toggle(); }}
                            className={`flex-1 py-2 rounded-xl text-[14px] transition-all ${arrayGridCentered === v ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
                              }`}>
                            {label}
                          </button>
                        ))}
                      </div>
                      <ValueSlider label="Rows" min={1} max={20}
                        value={arrayGridRows} display={`${arrayGridRows}`}
                        onChange={setArrayGridRows} />
                      <ValueSlider label="Columns" min={1} max={20}
                        value={arrayGridCols} display={`${arrayGridCols}`}
                        onChange={setArrayGridCols} />
                      <ValueSlider label="Spacing X" min={10} max={300} step={5}
                        value={arrayGridSpacingX} display={`${arrayGridSpacingX}px`}
                        onChange={setArrayGridSpacingX} />
                      <ValueSlider label="Spacing Y" min={10} max={300} step={5}
                        value={arrayGridSpacingY} display={`${arrayGridSpacingY}px`}
                        onChange={setArrayGridSpacingY} />
                      <div className="flex gap-2">
                        {([{ v: 0, label: "Grid" }, { v: 50, label: "Brick" }]).map(({ v, label }) => (
                          <button key={label} onClick={() => setArrayGridRowOffsetPct(v)}
                            className={`flex-1 py-2 rounded-xl text-[14px] transition-all ${arrayGridRowOffsetPct === v ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
                              }`}>
                            {label}
                          </button>
                        ))}
                      </div>
                      <ValueSlider label="Row offset" min={0} max={100} step={5}
                        value={arrayGridRowOffsetPct} display={`${arrayGridRowOffsetPct}%`}
                        onChange={setArrayGridRowOffsetPct} />
                    </>
                  )}

                  {arrayMode === "curve" && (
                    <>
                      <p className="text-[13px] text-[var(--txt-2)] leading-relaxed px-1">
                        Click on the canvas to draw a path. Backspace undoes a point, Escape clears it.
                      </p>
                      <div className="text-[13px] text-[var(--txt-3)] px-1">{arrayCurveAnchors.length} points</div>
                      <ValueSlider label="Count" min={2} max={100}
                        value={arrayCurveCount} display={`${arrayCurveCount}`}
                        onChange={setArrayCurveCount} />
                      <ValueSlider label="Spacing" min={10} max={300} step={5}
                        value={arrayCurveSpacing} display={`${arrayCurveSpacing}px`}
                        onChange={setArrayCurveSpacing} />
                      <div className="flex gap-2">
                        {([{ c: false, label: "Straight" }, { c: true, label: "Curved" }]).map(({ c, label }) => (
                          <button key={label} onClick={() => { setArrayPathCurved(c); sfx.toggle(); }}
                            className={`flex-1 py-2 rounded-xl text-[14px] transition-all ${arrayPathCurved === c ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
                              }`}>
                            {label}
                          </button>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        {([{ v: false, label: "Free" }, { v: true, label: "Follow curve" }]).map(({ v, label }) => (
                          <button key={label} onClick={() => { setArrayCurveAlign(v); sfx.toggle(); }}
                            className={`flex-1 py-2 rounded-xl text-[14px] transition-all ${arrayCurveAlign === v ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
                              }`}>
                            {label}
                          </button>
                        ))}
                      </div>
                      {arrayCurveAnchors.length > 0 && (
                        <button onClick={() => { cancelArrayCurve(); sfx.toggle(); }}
                          className="w-full py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] transition-all">
                          Clear points
                        </button>
                      )}
                    </>
                  )}

                  <button onClick={applyArray} disabled={arrayPreview.length === 0}
                    className="w-full py-3 rounded-xl bg-[var(--solid)] text-[var(--solid-fg)] text-[15px] font-medium disabled:opacity-40 transition-all">
                    Apply{arrayPreview.length > 0 ? ` (${arrayPreview.length} dots)` : ""}
                  </button>
                </>
              )}
            </>
          )}

          {/* ── Grid editor ── */}
          {rightCtx === "grid" && (
            <>
              <div className="dot-picker rounded-2xl overflow-hidden">
                <HexColorPicker color={gridColor} onChange={setGridColor} />
              </div>
              <div className="flex gap-2">
                <div className="flex-1 bg-[var(--ctl)] rounded-xl px-4 flex items-center text-[16px] text-[var(--txt-1)] font-mono uppercase">{gridColor}</div>
                <label className="w-[84px] h-12 rounded-xl cursor-pointer shrink-0 flex items-center justify-center" style={{ backgroundColor: gridColor, border: "1px solid rgba(0,0,0,0.1)" }} title="System color picker">
                  <input type="color" className="sr-only" value={gridColor} onChange={(e) => setGridColor(e.target.value)} />
                </label>
              </div>
              <ValueSlider label="Grid opacity" min={0} max={1} step={0.01}
                value={gridOpacity} display={`${Math.round(gridOpacity * 100)}`}
                onChange={setGridOpacity} />
              <ValueSlider label="Grid Width" min={0.25} max={4} step={0.25}
                value={gridThickness} display={`${gridThickness}`}
                onChange={setGridThickness} />
            </>
          )}

          {/* ── Background editor ── */}
          {rightCtx === "background" && (
            <>
              <div className="dot-picker rounded-2xl overflow-hidden">
                <HexColorPicker color={canvasBg} onChange={setCanvasBg} />
              </div>
              <div className="flex gap-2">
                <div className="flex-1 bg-[var(--ctl)] rounded-xl px-4 flex items-center text-[16px] text-[var(--txt-1)] font-mono uppercase">{canvasBg}</div>
                <label className="w-[84px] h-12 rounded-xl cursor-pointer shrink-0 flex items-center justify-center" style={{ backgroundColor: canvasBg, border: "1px solid rgba(0,0,0,0.1)" }} title="System color picker">
                  <input type="color" className="sr-only" value={canvasBg} onChange={(e) => setCanvasBg(e.target.value)} />
                </label>
              </div>
              <div className="bg-[var(--ctl)] rounded-xl p-3">
                <div className="text-[15px] text-[var(--txt-1)] mb-2">Presets</div>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { hex: "#ffffff", grid: "#000000", label: "White" },
                    { hex: "#000000", grid: "#ffffff", label: "Black" },
                  ]).map(({ hex, grid, label }) => (
                    <button key={hex}
                      onClick={() => { setCanvasBg(hex); setGridColor(grid); }}
                      className={`rounded-xl h-16 flex items-end justify-start p-2 transition-all ${canvasBg.toLowerCase() === hex ? "ring-2 ring-[var(--solid)]/80" : ""
                        }`}
                      style={{ backgroundColor: hex, border: "1px solid rgba(0,0,0,0.1)" }}>
                      <span className={`text-[13px] ${hex === "#000000" ? "text-white" : "text-[var(--txt-1)]"}`}>{label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-[13px] text-[var(--txt-3)] leading-relaxed px-1">
                Presets also set a contrasting grid color. Fine-tune the grid under the Grid Color element.
              </p>
            </>
          )}

          {/* ── Eraser editor ── */}
          {rightCtx === "erase" && (
            <>
              <div className="rounded-2xl h-40 bg-[var(--ctl)] flex items-center justify-center">
                <span className="rounded-full border-2 border-dashed border-[#f23a3a]"
                  style={{ width: Math.max(eraseRadius * 2, 16), height: Math.max(eraseRadius * 2, 16) }} />
              </div>
              <ValueSlider label="Radius" min={2} max={40}
                value={eraseRadius} display={`${eraseRadius}`}
                onChange={setEraseRadius} />
              <p className="text-[13px] text-[var(--txt-3)] leading-relaxed px-1">
                Click or drag across the canvas to remove dots within the radius.
              </p>
            </>
          )}

        </div>

        {/* Export / footer card */}
        <div className="bg-[var(--card)] rounded-3xl p-3 shrink-0 flex flex-col gap-2">
          {/* Editable project: save / reopen */}
          <div className="flex gap-2">
            <button onClick={saveProject} title="Download an editable project file"
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-black text-[#a3bfc8] text-[13px] hover:bg-[#1a1a1a] transition-colors">
              <Save size={13} /> Save Project
            </button>
            <input ref={fileInputRef} type="file" accept="application/json,.json" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) openProjectFile(f); e.target.value = ""; }} />
          </div>

          <div className="h-px bg-[var(--ctl)] mx-1" />

          {/* Export: one button in the last-used format + a dropdown to change it */}
          <div className="relative">
            <div className="flex gap-2">
              <button
                onClick={() => { if (exportFormat === "svg") exportSVG(); else if (exportFormat === "png") exportPNG(); else exportPDF(); }}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] transition-colors">
                {exportFormat === "svg" ? <FileCode2 size={13} /> : exportFormat === "png" ? <FileImage size={13} /> : <Printer size={13} />}
                Export {exportFormat.toUpperCase()}
              </button>
              <button onClick={() => setExportMenuOpen((o) => !o)} title="Choose export format" aria-label="Choose export format"
                className="w-10 shrink-0 flex items-center justify-center rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)] transition-colors">
                {exportMenuOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            </div>
            {exportMenuOpen && (
              <div className="absolute bottom-full mb-2 left-0 right-0 bg-[var(--card)] border border-[var(--ctl)] rounded-xl shadow-lg overflow-hidden z-10">
                {([
                  { f: "svg" as const, label: "SVG", icon: <FileCode2 size={13} /> },
                  { f: "png" as const, label: "PNG", icon: <FileImage size={13} /> },
                  { f: "pdf" as const, label: "PDF", icon: <Printer size={13} /> },
                ]).map(({ f, label, icon }) => (
                  <button key={f} onClick={() => { setExportFormat(f); setExportMenuOpen(false); }}
                    className={`w-full flex items-center gap-2 px-3 py-2.5 text-[13px] transition-colors ${exportFormat === f ? "bg-[var(--ctl)] text-[var(--txt-1)]" : "text-[var(--txt-2)] hover:bg-[var(--ctl-hover)]"}`}>
                    {icon} {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button disabled={dots.size === 0}
            onPointerDown={(e) => { e.preventDefault(); startClearHold(); }}
            onPointerUp={cancelClearHold}
            onPointerLeave={cancelClearHold}
            onPointerCancel={cancelClearHold}
            className="relative w-full overflow-hidden flex items-center justify-center gap-1.5 py-2 rounded-xl text-[13px] text-[#f23a3a] hover:bg-[#f23a3a]/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors select-none touch-none">
            <Trash2 size={13} /> {clearProgress > 0 ? "Keep holding to clear…" : "Hold to Clear Layer"}
            {clearProgress > 0 && (
              <Progress value={clearProgress}
                className="absolute bottom-0 inset-x-0 h-1 rounded-none bg-[#f23a3a]/15 [&>*]:bg-[#f23a3a] [&>*]:transition-none" />
            )}
          </button>
        </div>

      </aside>

      {/* Scrim behind an open panel — tap to dismiss (compact only) */}
      {compact && (leftOpen || rightOpen) && (
        <div className="fixed inset-0 z-40 bg-black/30"
          onClick={() => { setLeftOpen(false); setRightOpen(false); }} />
      )}

      {/* ── Image import modal ── tune the conversion, then add to canvas ── */}
      {importOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          onClick={closeImport}>
          <div onClick={(e) => e.stopPropagation()}
            className={`dotart${dark ? " dark" : ""} bg-[var(--card)] text-[var(--txt-1)] rounded-3xl p-5 w-[94vw] h-[94vh] max-w-[2000px] max-h-[97vh] flex flex-col gap-4 shadow-2xl`}>
            <div className="flex items-center justify-between shrink-0">
              <h2 className="text-[16px] font-medium flex items-center gap-2"><ImagePlus size={16} /> Import Image</h2>
              <button onClick={closeImport}
                className="px-3 py-1.5 rounded-lg bg-[var(--ctl)] text-[13px] hover:bg-[var(--ctl-hover)]">Close</button>
            </div>

            <div className="flex flex-col sm:flex-row gap-4 flex-1 min-h-0">
              {/* Preview */}
              <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                <div ref={importPreviewBoxRef} className="rounded-2xl bg-[var(--ctl)] p-2 flex items-center justify-center flex-1 min-h-0">
                  {importImg
                    ? <canvas ref={importPreviewRef} className="rounded-lg" />
                    : <span className="text-[13px] text-[var(--txt-3)]">Choose an image to preview — or paste one, Ctrl+V</span>}
                </div>
                <button onClick={() => imageInputRef.current?.click()}
                  className="mt-2 w-full py-2.5 rounded-xl bg-[var(--ctl)] text-[13px] hover:bg-[var(--ctl-hover)] shrink-0">
                  {importImg ? "Choose a different image…" : "Choose image…"}
                </button>
                <input ref={imageInputRef} type="file" accept="image/*" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) openImportFile(f); e.target.value = ""; }} />
              </div>

              {/* Controls — grouped into Style / Appearance / Canvas, each its
                  own section so the modal reads as a sequence of decisions
                  (what colors → how dots look → what canvas they land on)
                  rather than one flat stack of fields. */}
              <div className="w-full sm:w-[340px] shrink-0 overflow-y-auto pr-1 flex flex-col gap-5">
                <div>
                  <div className="text-[13px] font-medium text-[var(--txt-2)] tracking-[-0.3px] mb-2">Style</div>
                  <div className="flex gap-1">
                    {([["palette", "Colors"], ["tonal", "Light & Shadow"]] as const).map(([s, lbl]) => (
                      <button key={s} onClick={() => setImgStyle(s)}
                        className={`flex-1 py-1.5 px-1 rounded-lg text-[11px] leading-tight transition-colors ${imgStyle === s ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-2)] hover:bg-[var(--ctl-hover)]"}`}>
                        {lbl}
                      </button>
                    ))}
                  </div>
                  {imgStyle === "tonal" && (
                    <label className="flex items-center gap-2 mt-2 text-[12px] text-[var(--txt-2)] cursor-pointer">
                      <input type="checkbox" checked={traceTonalColor}
                        onChange={(e) => setTraceTonalColor(e.target.checked)}
                        className="accent-[var(--solid)]" />
                      Use image colors
                    </label>
                  )}
                  <p className="text-[11px] text-[var(--txt-3)] leading-snug mt-1.5">
                    {imgStyle === "palette" ? "Image colors reduced to an editable palette."
                      : traceTonalColor ? "Image-colored dots sized by tone — shadows big, highlights small."
                        : "Gray dots sized by tone — shadows big, highlights small."}
                  </p>

                  {imgStyle === "palette" && (
                    <div className="mt-3">
                      <ValueSlider label="Colors" min={1} max={32} step={1} value={traceColorCount}
                        display={`${traceColorCount}`} onChange={setTraceColorCount} />

                      <label className="flex items-center gap-2 mt-3 text-[12px] text-[var(--txt-2)] cursor-pointer">
                        <input type="checkbox" checked={traceGlitch}
                          onChange={(e) => setTraceGlitch(e.target.checked)}
                          className="accent-[var(--solid)]" />
                        Glitch
                      </label>
                      {traceGlitch && (
                        <div className="mt-2">
                          <ValueSlider label="Amount" min={1} max={20} step={1} value={traceGlitchAmount}
                            display={`${traceGlitchAmount}`} onChange={setTraceGlitchAmount} />
                          <p className="text-[11px] text-[var(--txt-3)] leading-snug mt-1.5">
                            Red/blue channels sampled offset from green — a chromatic-aberration tear.
                          </p>
                        </div>
                      )}

                      {basePalette && effectivePalette && (
                        <>
                          <div className="flex flex-wrap gap-1.5 mt-2.5">
                            {basePalette.palette.map((originalHex, i) => {
                              const current = effectivePalette[i];
                              const edited = current !== originalHex;
                              return (
                                <div key={i} title={`${basePalette.counts[i]} dots`}
                                  className={`relative w-8 h-8 rounded-lg overflow-hidden border ${edited ? "ring-2 ring-[var(--solid)] border-transparent" : "border-[var(--overlay-border)]"}`}
                                  style={{ background: current }}>
                                  <input type="color" value={current}
                                    onChange={(e) => setPaletteEdits((p) => ({ ...p, [originalHex]: e.target.value }))}
                                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
                                </div>
                              );
                            })}
                          </div>
                          <p className="text-[11px] text-[var(--txt-3)] leading-snug mt-1.5">
                            Click a swatch to replace that color everywhere. {basePalette.palette.length} colors · {previewDots?.size ?? 0} dots
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div className="pt-4 border-t border-[var(--overlay-border)]">
                  <div className="text-[13px] font-medium text-[var(--txt-2)] tracking-[-0.3px] mb-2">Appearance</div>
                  <div className="flex flex-col gap-2.5">
                    <ValueSlider label="Dot size" min={1} max={20} step={0.5} value={traceDotSize}
                      display={`${traceDotSize}`} onChange={setTraceDotSize} />
                    <ValueSlider label={imgStyle === "tonal" ? "Shadow" : "Density"} min={0} max={1} step={0.01} value={traceThreshold}
                      display={traceThreshold.toFixed(2)} onChange={setTraceThreshold} />
                    <ValueSlider label="Min. Spacing" min={1} max={20} step={1} value={minSpacing}
                      display={`${minSpacing} step${minSpacing === 1 ? "" : "s"}`} onChange={setMinSpacing} />
                  </div>
                </div>

                <div className="pt-4 border-t border-[var(--overlay-border)]">
                  <div className="text-[13px] font-medium text-[var(--txt-2)] tracking-[-0.3px] mb-2">Canvas</div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[12px] text-[var(--txt-3)]">Size</span>
                    <button onClick={matchImageRatio} disabled={!importImg}
                      className="text-[11px] text-[var(--txt-2)] underline underline-offset-2 hover:text-[var(--txt-1)] disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline">
                      Match image ratio
                    </button>
                  </div>
                  <div className="flex gap-2">
                    {([
                      { label: "W", value: importWInput, onChange: setImportWInput, onCommit: commitImportW },
                      { label: "H", value: importHInput, onChange: setImportHInput, onCommit: commitImportH },
                    ]).map(({ label, value, onChange, onCommit }) => (
                      <div key={label} className="flex-1 flex items-center gap-1.5 bg-[var(--ctl)] rounded-lg px-2 py-1.5">
                        <span className="text-[12px] text-[var(--txt-2)] shrink-0">{label}</span>
                        <input type="number" min="0" step="any" value={value}
                          onChange={(e) => onChange(e.target.value)} onBlur={onCommit}
                          onFocus={(e) => e.target.select()}
                          onKeyDown={(e) => { if (e.key === "Enter") { onCommit(); (e.target as HTMLInputElement).blur(); } }}
                          className="w-full min-w-0 bg-transparent text-[12px] text-[var(--txt-1)] text-right focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
                      </div>
                    ))}
                    <span className="self-center text-[12px] text-[var(--txt-3)]">{unit}</span>
                  </div>
                  <p className="text-[11px] text-[var(--txt-3)] leading-snug mt-1.5">
                    → {importDims.physW}×{importDims.physH}{unit} · {importDims.cols}×{importDims.rows} cells
                  </p>

                  <div className="mt-3">
                    {(() => {
                      const longPhys = Math.max(importW, importH) || 1;
                      const minCell = longPhys / 100, maxCell = longPhys / 8;
                      const cell = Math.min(Math.max(importCell, minCell), maxCell);
                      return (
                        <ValueSlider label="Cell size" min={minCell} max={maxCell} step={(maxCell - minCell) / 200} value={cell}
                          display={`${importCell.toFixed(1)}${unit}`} onChange={setImportCell} />
                      );
                    })()}
                  </div>

                  <div className="mt-3">
                    <div className="text-[12px] text-[var(--txt-3)] mb-1.5">Sub-cell fill</div>
                    <div className="flex gap-1">
                      {([["corner", "Coarse"], ["both", "Fine"], ["fine", "Sub-grid"]] as const).map(([s, lbl]) => (
                        <button key={s} onClick={() => setTraceDetail(s)}
                          className={`flex-1 py-1.5 rounded-lg text-[12px] transition-colors ${traceDetail === s ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-2)] hover:bg-[var(--ctl-hover)]"}`}>
                          {lbl}
                        </button>
                      ))}
                    </div>
                    <p className="text-[11px] text-[var(--txt-3)] leading-snug mt-1.5">
                      {importDims ? `${importDims.cols}×${importDims.rows} cells` : "—"} · {previewDots ? `${previewDots.size} dots` : "—"}. Smaller cell = finer grid.
                    </p>
                  </div>

                  {imgStyle === "palette" && (
                    <label className="flex items-center gap-2 mt-3 text-[12px] text-[var(--txt-2)] cursor-pointer">
                      <input type="checkbox" checked={splitLayersByColor}
                        onChange={(e) => setSplitLayersByColor(e.target.checked)}
                        className="accent-[var(--solid)]" />
                      Split into layers by color
                    </label>
                  )}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1 shrink-0">
              <button onClick={closeImport}
                className="px-4 py-2.5 rounded-xl bg-[var(--ctl)] text-[13px] hover:bg-[var(--ctl-hover)]">Cancel</button>
              <button onClick={addImportToCanvas} disabled={!previewDots || previewDots.size === 0}
                className="px-5 py-2.5 rounded-xl bg-[var(--solid)] text-[var(--solid-fg)] text-[13px] disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90">
                Add to canvas
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Text → Dots modal ── typed text in any font, dissolved into dots ── */}
      {textOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          onClick={closeText}>
          <div onClick={(e) => e.stopPropagation()}
            className={`dotart${dark ? " dark" : ""} bg-[var(--card)] text-[var(--txt-1)] rounded-3xl p-5 w-full max-w-[760px] max-h-[90vh] overflow-auto flex flex-col gap-4 shadow-2xl`}>
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-medium flex items-center gap-2"><Type size={16} /> Text → Dots</h2>
              <button onClick={closeText}
                className="px-3 py-1.5 rounded-lg bg-[var(--ctl)] text-[13px] hover:bg-[var(--ctl-hover)]">Close</button>
            </div>

            <div className="flex flex-col sm:flex-row gap-4">
              {/* Preview */}
              <div className="flex-1 min-w-0">
                <div className="rounded-2xl bg-[var(--ctl)] p-2 flex items-center justify-center" style={{ minHeight: 260 }}>
                  {textDots
                    ? <canvas ref={textPreviewRef} className="max-w-full max-h-[60vh] rounded-lg" />
                    : <span className="text-[13px] text-[var(--txt-3)]">Type something to preview</span>}
                </div>
                <textarea value={textValue} onChange={(e) => setTextValue(e.target.value)} rows={3}
                  placeholder="Type text… (Enter for a new line)"
                  className="mt-2 w-full p-3 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[14px] resize-none outline-none" />
                <button onClick={() => fontInputRef.current?.click()}
                  className="mt-2 w-full py-2.5 rounded-xl bg-[var(--ctl)] text-[13px] hover:bg-[var(--ctl-hover)]">
                  {textFontName ? `Font: ${textFontName} — change…` : "Upload font (.ttf / .otf / .woff)…"}
                </button>
                <input ref={fontInputRef} type="file" accept=".ttf,.otf,.woff,.woff2,font/*" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFontFile(f); e.target.value = ""; }} />
              </div>

              {/* Controls */}
              <div className="w-full sm:w-[260px] shrink-0 flex flex-col gap-4">
                <div>
                  <div className="text-[12px] text-[var(--txt-3)] mb-1.5">Style</div>
                  <div className="flex gap-1">
                    {([["color", "Color"], ["mono", "Mono"], ["tonal", "Light & Shadow"]] as const).map(([s, lbl]) => (
                      <button key={s} onClick={() => setTraceStyle(s)}
                        className={`flex-1 py-1.5 px-1 rounded-lg text-[11px] leading-tight transition-colors ${traceStyle === s ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-2)] hover:bg-[var(--ctl-hover)]"}`}>
                        {lbl}
                      </button>
                    ))}
                  </div>
                  {traceStyle !== "tonal" && (
                    <label className="flex items-center gap-2 mt-2 text-[12px] text-[var(--txt-2)]">
                      {traceStyle === "mono" ? "Dot color" : "Text color"}
                      <input type="color" value={traceStyle === "mono" ? color : textColor}
                        onChange={(e) => traceStyle === "mono" ? (setColor(e.target.value), colorRef.current = e.target.value) : setTextColor(e.target.value)}
                        className="w-8 h-6 rounded cursor-pointer bg-transparent" />
                    </label>
                  )}
                </div>

                <label className="flex items-center gap-2 text-[12px] text-[var(--txt-2)]">
                  <span className="w-16 shrink-0">Dot size</span>
                  <input type="range" min={2} max={20} step={0.5} value={traceDotSize}
                    onChange={(e) => setTraceDotSize(parseFloat(e.target.value))}
                    className="flex-1 accent-[var(--solid)]" />
                  <span className="w-8 text-right tabular-nums">{traceDotSize}</span>
                </label>

                <label className="flex items-center gap-2 text-[12px] text-[var(--txt-2)]">
                  <span className="w-16 shrink-0">Scatter</span>
                  <input type="range" min={0} max={1} step={0.01} value={traceScatter}
                    onChange={(e) => setTraceScatter(parseFloat(e.target.value))}
                    className="flex-1 accent-[var(--solid)]" />
                  <span className="w-8 text-right tabular-nums">{traceScatter.toFixed(2)}</span>
                </label>

                <label className="flex items-center gap-2 text-[12px] text-[var(--txt-2)]">
                  <span className="w-16 shrink-0">Density</span>
                  <input type="range" min={0} max={1} step={0.01} value={traceThreshold}
                    onChange={(e) => setTraceThreshold(parseFloat(e.target.value))}
                    className="flex-1 accent-[var(--solid)]" />
                  <span className="w-8 text-right tabular-nums">{traceThreshold.toFixed(2)}</span>
                </label>

                {(() => {
                  const longPhys = Math.max(canvasPhysW, canvasPhysH) || 1;
                  const minCell = longPhys / 100, maxCell = longPhys / 8;
                  const cell = Math.min(Math.max(importCell, minCell), maxCell);
                  return (
                    <label className="flex items-center gap-2 text-[12px] text-[var(--txt-2)]">
                      <span className="w-16 shrink-0">Cell size</span>
                      <input type="range" min={minCell} max={maxCell} step={(maxCell - minCell) / 200} value={cell}
                        onChange={(e) => setImportCell(parseFloat(e.target.value))}
                        className="flex-1 accent-[var(--solid)]" />
                      <span className="w-14 text-right tabular-nums">{importCell.toFixed(1)}{unit}</span>
                    </label>
                  );
                })()}

                <div>
                  <div className="text-[12px] text-[var(--txt-3)] mb-1.5">Sub-cell fill</div>
                  <div className="flex gap-1">
                    {([["corner", "Coarse"], ["both", "Fine"], ["fine", "Sub-grid"]] as const).map(([s, lbl]) => (
                      <button key={s} onClick={() => setTraceDetail(s)}
                        className={`flex-1 py-1.5 rounded-lg text-[12px] transition-colors ${traceDetail === s ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-2)] hover:bg-[var(--ctl-hover)]"}`}>
                        {lbl}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-[var(--txt-3)] leading-snug mt-1.5">
                    {textDims ? `${textDims.cols}×${textDims.rows} cells` : "—"} · {textDots ? `${textDots.size} dots` : "—"}.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={closeText}
                className="px-4 py-2.5 rounded-xl bg-[var(--ctl)] text-[13px] hover:bg-[var(--ctl-hover)]">Cancel</button>
              <button onClick={addTextToCanvas} disabled={!textDots}
                className="px-5 py-2.5 rounded-xl bg-[var(--solid)] text-[var(--solid-fg)] text-[13px] disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90">
                Add to canvas
              </button>
            </div>
          </div>
        </div>
      )}

      {showHome && (
        <HomeScreen
          onOpenProject={openLibraryProject}
          onCreateNew={createNewProject}
          onOpenFile={openProjectFileAndRegister}
          onDeleteActive={notifyProjectDeleted}
          onOpenImageTool={() => window.open(`${import.meta.env.BASE_URL}image.html`, "_blank")}
          onOpenTextTool={() => window.open(`${import.meta.env.BASE_URL}text.html`, "_blank")}
          refreshSignal={homeRefresh}
          onClose={onHideHome}
        />
      )}
    </div>
  );
}
