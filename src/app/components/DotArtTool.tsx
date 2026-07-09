import { useState, useRef, useCallback, useEffect, useMemo, memo } from "react";
import { HexColorPicker } from "react-colorful";
import { Eraser, Pen, Trash2, ZoomIn, ZoomOut, Maximize2, Undo2, Redo2, MousePointer2, FileImage, FileCode2, Printer, Grid3x3, Magnet, Ruler, Plus, Minus, Droplet, PaintBucket, Moon, Sun, Volume2, VolumeX, Hand, GripHorizontal, Menu, SlidersHorizontal, Dices, Save, FolderOpen, ImagePlus, Type, FlipHorizontal2, FlipVertical2, Slash, PenTool, Circle, Layers as LayersIcon, Eye, EyeOff, Copy, ChevronUp, ChevronDown } from "lucide-react";
import { sfx, setSfxMuted } from "../sounds";
import { Progress } from "./ui/progress";
import {
  CELL_SIZE, HALF_CELL, getKey, generateGridPoints, rgbToHex, computeImportDims,
  buildDotsFromImage, buildDotsFromText, renderTextCanvas, type SnapMode, type Dot,
} from "@/lib/dots";
import { GRID_SUBDIV, FINE_CELL, getFineKey, snapSpacing, getNearestSnap, mirrorSnaps, keyFromPosition } from "@/lib/snap";
import {
  constrainAngle15, pathPolyline, computePathDots,
  type SpacingShape, type SpacingOpts,
} from "@/lib/path";
import {
  barRect, ellipsePolyline, gridPointsInEllipse, shapeVertices, gridPointsInPolygon, distToSegment,
  type DotShape, type ShapeKind,
} from "@/lib/shapes";
import {
  PROJECT_VERSION, AUTOSAVE_KEY, PROJECT_TAG, genLayerId, parseScene, sceneToLayers, flattenLayers,
  convertUnit, roundForUnit, fmt, buildSVGString,
  type Unit, type Layer, type UndoSnapshot, type SceneFile,
} from "@/lib/scene";

type Tool = "draw" | "erase" | "select" | "line" | "pen" | "shape";
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 20;
const MAX_UNDO = 60;

// One layer's dots rendered as a single memoized SVG group. Pointermove-driven
// state (hover, draw preview, drag) re-renders DotArtTool on every mouse move;
// before this extraction that meant re-creating every dot's <circle>/<rect> in
// every layer on every one of those. Because `setDots` (see its definition)
// only ever replaces the ACTIVE layer object in the `layers` array — inactive
// layer objects keep their reference — React.memo lets an inactive layer skip
// re-rendering entirely as long as its props stay referentially/shallowly
// equal. That's why the call site MUST pass constant props (selectedKeys:
// null, hoveredDotKey: null, isDragging: false, moveDx/moveDy: 0) to every
// inactive layer instead of the live values — otherwise hover/selection/drag
// churn on the active layer would change every layer's props and defeat the
// memo.
const DotLayer = memo(function DotLayer(props: {
  layer: Layer; isActive: boolean; dotShape: DotShape; zoom: number;
  selectionRingColor: string;
  selectedKeys: Set<string> | null;   // null for inactive layers
  hoveredDotKey: string | null;       // null for inactive layers
  isDragging: boolean; moveDx: number; moveDy: number;
  // Increments only for the active layer when the user switches layers via
  // the canvas nav arrows — bumps the inner <g>'s key so it remounts and
  // replays the one-shot "you're now looking at this layer" opacity pulse
  // (see .dotart-layer-pulse in theme.css). Left undefined for inactive
  // layers, so it never varies for them and never breaks their memo.
  pulseKey?: number;
}) {
  const { layer, isActive, dotShape, zoom, selectionRingColor, selectedKeys, hoveredDotKey, isDragging, moveDx, moveDy, pulseKey } = props;
  return (
    <g key={pulseKey ?? 0} className={pulseKey ? "dotart-layer-pulse" : undefined}>
      {Array.from(layer.dots.values()).map((dot) => {
        const isSelected = isActive && !!selectedKeys?.has(dot.key);
        const isDraggingThis = isActive && isDragging && isSelected;
        const cx = isDraggingThis ? dot.x + moveDx : dot.x;
        const cy = isDraggingThis ? dot.y + moveDy : dot.y;
        return (
          <g key={dot.key}>
            {isSelected && (
              <circle cx={cx} cy={cy} r={dot.radius + 4 / zoom}
                fill="none" stroke={selectionRingColor} strokeWidth={1.5 / zoom}
                strokeDasharray={isDragging ? `${3 / zoom},${2 / zoom}` : "none"}
                style={{ pointerEvents: "none" }} />
            )}
            {isActive && hoveredDotKey === dot.key && !isSelected && (
              <circle cx={dot.x} cy={dot.y} r={dot.radius + 4 / zoom}
                fill="none" stroke={selectionRingColor} strokeWidth={1 / zoom} opacity={0.5}
                style={{ pointerEvents: "none" }} />
            )}
            {dotShape === "bar" ? (() => {
              const b = barRect(cx, cy, dot.radius);
              return <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={b.rx} fill={dot.color} opacity={isDraggingThis ? 0.7 : 1} />;
            })() : (
              <circle cx={cx} cy={cy} r={dot.radius} fill={dot.color} opacity={isDraggingThis ? 0.7 : 1} />
            )}
          </g>
        );
      })}
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

// ── Hand-draw: MediaPipe Tasks Vision (HandLandmarker) ──
// Loaded on demand from a CDN ESM so it never enters the Vite bundle / npm audit
// surface. Returns normalized 0–1 landmarks; index fingertip = 8, thumb tip = 4.
const MP_VERSION = "0.10.18";
const MP_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const HAND_MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
let visionPromise: Promise<{ vision: any; fileset: any }> | null = null;
function loadVision(): Promise<{ vision: any; fileset: any }> {
  if (!visionPromise) {
    visionPromise = (async () => {
      const vision: any = await import(/* @vite-ignore */ MP_CDN);
      const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_CDN}/wasm`);
      return { vision, fileset };
    })();
  }
  return visionPromise;
}

function findDotAt(dots: Map<string, Dot>, wx: number, wy: number): Dot | null {
  let closest: Dot | null = null;
  let closestDist = Infinity;
  for (const dot of dots.values()) {
    const d = Math.hypot(dot.x - wx, dot.y - wy);
    if (d <= dot.radius + 4 && d < closestDist) { closest = dot; closestDist = d; }
  }
  return closest;
}

function dotsInRect(dots: Map<string, Dot>, wx1: number, wy1: number, wx2: number, wy2: number): Set<string> {
  const minX = Math.min(wx1, wx2); const maxX = Math.max(wx1, wx2);
  const minY = Math.min(wy1, wy2); const maxY = Math.max(wy1, wy2);
  const result = new Set<string>();
  for (const dot of dots.values())
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

export function DotArtTool() {
  // Restore the autosaved session once, before first paint, so the initial
  // fit-to-view uses the right canvas size (no flash, no double-fit).
  const bootRef = useRef<SceneFile | null | undefined>(undefined);
  if (bootRef.current === undefined) {
    try { bootRef.current = parseScene(localStorage.getItem(AUTOSAVE_KEY) ?? ""); }
    catch { bootRef.current = null; }
  }
  const boot = bootRef.current;

  // ── Layers ──
  // The stack is the source of truth; `dots`/`setDots` below are thin shims
  // over the ACTIVE layer, so every existing tool / undo / selection path keeps
  // editing "the dots" with no change — it just lands in the active layer.
  const initLayersRef = useRef<Layer[] | null>(null);
  if (initLayersRef.current === null) initLayersRef.current = sceneToLayers(boot);
  const [layers, setLayers] = useState<Layer[]>(() => initLayersRef.current!);
  const [activeLayerId, setActiveLayerId] = useState<string>(() => initLayersRef.current![initLayersRef.current!.length - 1].id);
  const activeLayerIdRef = useRef(activeLayerId);
  useEffect(() => { activeLayerIdRef.current = activeLayerId; }, [activeLayerId]);
  const layersRef = useRef(layers);
  useEffect(() => { layersRef.current = layers; }, [layers]);
  const activeLayer = layers.find((l) => l.id === activeLayerId) ?? layers[0];
  const dots = activeLayer.dots;
  const setDots = useCallback((u: Map<string, Dot> | ((prev: Map<string, Dot>) => Map<string, Dot>)) => {
    setLayers((ls) => ls.map((l) => l.id === activeLayerIdRef.current
      ? { ...l, dots: typeof u === "function" ? (u as (p: Map<string, Dot>) => Map<string, Dot>)(l.dots) : u }
      : l));
  }, []);
  const [showLayers, setShowLayers] = useState(false);
  // Canvas layer-nav arrows (up = layer above, down = layer below). pulseKey
  // bumps on every arrow switch so the newly-active DotLayer replays its
  // one-shot pulse; layerToast shows the landed-on layer's name briefly.
  const [layerPulseKey, setLayerPulseKey] = useState(0);
  const [layerToast, setLayerToast] = useState<{ name: string; dir: 1 | -1; id: number } | null>(null);
  const layerToastTimerRef = useRef<number>();

  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const [color, setColor] = useState(boot?.color ?? "#FF2A2A");
  const [recentColors, setRecentColors] = useState<string[]>(boot?.recentColors ?? []);
  const [radius, setRadius] = useState(boot?.radius ?? 3);
  // Dot render shape — global (all dots), snapping unaffected. Persisted.
  const [dotShape, setDotShape] = useState<DotShape>(() => {
    try { return localStorage.getItem("tangaliya-dot-shape") === "bar" ? "bar" : "circle"; } catch { return "circle"; }
  });
  useEffect(() => {
    try { localStorage.setItem("tangaliya-dot-shape", dotShape); } catch { /* ignore */ }
  }, [dotShape]);
  // Stroke snap reach, % of a lattice step: how far away a point "catches"
  // the pen during a stroke. High = eager/loose, low = deliberate placement.
  const [snapReach, setSnapReach] = useState(boot?.snapReach ?? 35);
  // Eraser size in world px — its own state, deliberately NOT shared with the
  // draw dot radius (resizing the eraser must not change the brush).
  const [eraseRadius, setEraseRadius] = useState(boot?.eraseRadius ?? 8);
  const [tool, setTool] = useState<Tool>("draw");
  const [snapMode, setSnapMode] = useState<SnapMode>(boot?.snapMode ?? "both");
  // Image import: a modal tunes the conversion; "Add to canvas" commits the dots.
  // These aren't part of the saved scene — they only configure the conversion.
  const [importOpen, setImportOpen] = useState(false);
  const [importImg, setImportImg] = useState<ImageBitmap | null>(null);
  const [traceStyle, setTraceStyle] = useState<"color" | "mono" | "tonal">("color");
  const [traceThreshold, setTraceThreshold] = useState(0.5);
  const [traceDotSize, setTraceDotSize] = useState(8);          // world-px dot radius
  const [traceDetail, setTraceDetail] = useState<SnapMode>("both"); // sub-cell fill
  const [importCell, setImportCell] = useState(10);             // cell size for the import (current unit)
  const [traceTonalColor, setTraceTonalColor] = useState(false); // Light & Shadow: keep image colors
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
  const [unit, setUnit] = useState<Unit>(boot?.unit ?? "mm");
  const [cellPhysical, setCellPhysical] = useState(boot?.cellPhysical ?? 10);   // value expressed in current `unit`
  const [canvasPhysW, setCanvasPhysW] = useState(boot?.canvasPhysW ?? 200);
  const [canvasPhysH, setCanvasPhysH] = useState(boot?.canvasPhysH ?? 150);
  const [cellInput, setCellInput] = useState(String(boot?.cellPhysical ?? 10));
  const [wInput, setWInput] = useState(String(boot?.canvasPhysW ?? 200));
  const [hInput, setHInput] = useState(String(boot?.canvasPhysH ?? 150));

  const [dark, setDark] = useState<boolean>(() => {
    try { return localStorage.getItem("tangaliya-theme") === "dark"; } catch { return false; }
  });
  const [theming, setTheming] = useState(false);
  const themeTimerRef = useRef<number>();
  useEffect(() => {
    try { localStorage.setItem("tangaliya-theme", dark ? "dark" : "light"); } catch { /* ignore */ }
  }, [dark]);
  const toggleTheme = useCallback(() => {
    setTheming(true);
    window.clearTimeout(themeTimerRef.current);
    themeTimerRef.current = window.setTimeout(() => setTheming(false), 350);
    setDark((d) => !d);
    sfx.toggle();
  }, []);

  const [muted, setMuted] = useState<boolean>(() => {
    try { return localStorage.getItem("tangaliya-muted") === "1"; } catch { return false; }
  });
  useEffect(() => {
    setSfxMuted(muted);
    try { localStorage.setItem("tangaliya-muted", muted ? "1" : "0"); } catch { /* ignore */ }
  }, [muted]);

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

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [marqueeBox, setMarqueeBox] = useState<{ wx1: number; wy1: number; wx2: number; wy2: number } | null>(null);
  const [dragOffset, setDragOffset] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const [hoveredDotKey, setHoveredDotKey] = useState<string | null>(null);

  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const rotRef = useRef(0);
  const dotsRef = useRef<Map<string, Dot>>(new Map());
  const undoStackRef = useRef<UndoSnapshot[]>([]);
  const redoStackRef = useRef<UndoSnapshot[]>([]);
  const clipboardRef = useRef<Dot[]>([]);
  const pasteCountRef = useRef(0);
  const marqueeBaseRef = useRef<Set<string>>(new Set());
  const selectedKeysRef = useRef<Set<string>>(new Set());
  const isPaintingRef = useRef(false);
  const isPanningRef = useRef(false);
  const isMarqueeingRef = useRef(false);
  const isDraggingDotsRef = useRef(false);
  const panStartRef = useRef<{ mx: number; my: number; px: number; py: number } | null>(null);
  const marqueeStartRef = useRef<{ wx: number; wy: number } | null>(null);
  const dragStartWorldRef = useRef<{ x: number; y: number } | null>(null);
  const preDragDotsRef = useRef<Map<string, Dot>>(new Map());
  const snappedOffsetRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const spaceDownRef = useRef(false);
  const toolRef = useRef<Tool>("draw");
  const colorRef = useRef("#FF2A2A");
  const radiusRef = useRef(3);
  const snapReachRef = useRef(35);
  const eraseRadiusRef = useRef(8);
  const snapModeRef = useRef<SnapMode>("both");
  const canvasBoundsRef = useRef({ w: 0, h: 0 });
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastPickRef = useRef("#000000");

  useEffect(() => { dotsRef.current = dots; }, [dots]);
  useEffect(() => { selectedKeysRef.current = selectedKeys; }, [selectedKeys]);
  useEffect(() => { toolRef.current = tool; }, [tool]);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { radiusRef.current = radius; }, [radius]);
  useEffect(() => { snapReachRef.current = snapReach; }, [snapReach]);
  useEffect(() => { eraseRadiusRef.current = eraseRadius; }, [eraseRadius]);
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

  // Snapshot the active layer's dots onto the undo stack, tagged with which
  // layer they belong to. Any new action invalidates redo.
  const pushUndo = useCallback(() => {
    const snapshot: UndoSnapshot = { layerId: activeLayerIdRef.current, dots: new Map(dotsRef.current) };
    const newStack = [...undoStackRef.current.slice(-(MAX_UNDO - 1)), snapshot];
    undoStackRef.current = newStack;
    setUndoCount(newStack.length);
    redoStackRef.current = [];
    setRedoCount(0);
  }, []);

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

  // Undo/redo is one cross-layer timeline: a step can target a layer other
  // than the currently active one (e.g. you drew on Layer A, switched to B and
  // drew there, then undo twice — the 2nd undo must land back on A). Each step
  // looks up its target layer's CURRENT dots (not dotsRef, which only mirrors
  // whichever layer is active right now) to build the opposite stack's entry,
  // writes the snapshot into that specific layer, and switches the active
  // layer to it so the change is visible. If the target layer was deleted
  // since the snapshot was taken (layer structure edits aren't undoable in
  // v1), the step is dropped rather than misdirected into the wrong layer.
  const undo = useCallback(() => {
    if (undoStackRef.current.length === 0) return;
    const popped = undoStackRef.current[undoStackRef.current.length - 1];
    const targetLayer = layersRef.current.find((l) => l.id === popped.layerId);
    if (!targetLayer) {
      undoStackRef.current = undoStackRef.current.slice(0, -1);
      setUndoCount(undoStackRef.current.length);
      return;
    }
    sfx.undo();
    redoStackRef.current = [...redoStackRef.current, { layerId: popped.layerId, dots: new Map(targetLayer.dots) }];
    setRedoCount(redoStackRef.current.length);
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    setUndoCount(undoStackRef.current.length);
    const nextLayers = layersRef.current.map((l) => (l.id === popped.layerId ? { ...l, dots: popped.dots } : l));
    setLayers(nextLayers); layersRef.current = nextLayers;
    if (activeLayerIdRef.current !== popped.layerId) {
      setActiveLayerId(popped.layerId); activeLayerIdRef.current = popped.layerId;
      setSelectedKeys(new Set()); selectedKeysRef.current = new Set();
    }
    dotsRef.current = popped.dots;
  }, []);

  const redo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;
    const popped = redoStackRef.current[redoStackRef.current.length - 1];
    const targetLayer = layersRef.current.find((l) => l.id === popped.layerId);
    if (!targetLayer) {
      redoStackRef.current = redoStackRef.current.slice(0, -1);
      setRedoCount(redoStackRef.current.length);
      return;
    }
    sfx.redo();
    undoStackRef.current = [...undoStackRef.current, { layerId: popped.layerId, dots: new Map(targetLayer.dots) }];
    setUndoCount(undoStackRef.current.length);
    redoStackRef.current = redoStackRef.current.slice(0, -1);
    setRedoCount(redoStackRef.current.length);
    const nextLayers = layersRef.current.map((l) => (l.id === popped.layerId ? { ...l, dots: popped.dots } : l));
    setLayers(nextLayers); layersRef.current = nextLayers;
    if (activeLayerIdRef.current !== popped.layerId) {
      setActiveLayerId(popped.layerId); activeLayerIdRef.current = popped.layerId;
      setSelectedKeys(new Set()); selectedKeysRef.current = new Set();
    }
    dotsRef.current = popped.dots;
  }, []);

  // ── Selection operations (keyboard-driven) ──
  const deleteSelected = useCallback(() => {
    if (selectedKeysRef.current.size === 0) return;
    pushUndo();
    setDots((prev) => {
      const next = new Map(prev);
      for (const key of selectedKeysRef.current) next.delete(key);
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
    const spacing = snapSpacing(snapModeRef.current);
    for (const dot of source) {
      const pos = keyFromPosition(dot.x + dx, dot.y + dy, spacing);
      next.set(pos.key, { ...dot, key: pos.key, x: pos.x, y: pos.y });
      newSelected.add(pos.key);
    }
    dotsRef.current = next;
    setDots(next);
    setTool("select");
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
    pushUndo();
    const base = new Map(dotsRef.current);
    const newSelected = new Set<string>();
    for (const key of selectedKeysRef.current) {
      const dot = base.get(key);
      if (!dot) continue;
      base.delete(key);
    }
    const spacing = snapSpacing(snapModeRef.current);
    for (const key of selectedKeysRef.current) {
      const dot = dotsRef.current.get(key);
      if (!dot) continue;
      const pos = keyFromPosition(dot.x + dx, dot.y + dy, spacing);
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
      if (e.code === "Space" && !e.repeat) { e.preventDefault(); spaceDownRef.current = true; }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") { spaceDownRef.current = false; isPanningRef.current = false; panStartRef.current = null; setIsGrabbing(false); }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
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
      if (mod && (e.key === "v" || e.key === "V")) { e.preventDefault(); pasteClipboard(); return; }
      if (mod && (e.key === "d" || e.key === "D")) { e.preventDefault(); duplicateSelected(); return; }

      // Pen tool: while a path is being built, these keys own the path
      // instead of their usual meaning (selection deletion / clear-selection).
      if (toolRef.current === "pen" && penAnchorsRef.current.length > 0) {
        if (e.key === "Enter") { e.preventDefault(); finishPenPathRef.current(penAnchorsRef.current); return; }
        if (e.key === "Escape") { e.preventDefault(); cancelPenPathRef.current(); return; }
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); popPenAnchor(); return; }
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
    };
    // Capture phase so our shortcuts run before any host/bubble handler that
    // might swallow Ctrl+Z (e.g. an embedding preview's own undo).
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [undo, redo, selectAll, copySelected, pasteClipboard, duplicateSelected, deleteSelected, nudgeSelected]);

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

  const applyDrawTool = useCallback((key: string, x: number, y: number) => {
    setDots((prev) => {
      const next = new Map(prev);
      if (toolRef.current === "erase") next.delete(key);
      else {
        next.set(key, { key, x, y, color: colorRef.current, radius: radiusRef.current });
        if (mirrorXRef.current || mirrorYRef.current) {
          const { w, h } = canvasBoundsRef.current;
          for (const m of mirrorSnaps(x, y, w, h, snapModeRef.current, mirrorXRef.current, mirrorYRef.current)) {
            if (m.key !== key) next.set(m.key, { key: m.key, x: m.x, y: m.y, color: colorRef.current, radius: radiusRef.current });
          }
        }
      }
      return next;
    });
  }, []);

  // ── Area eraser ──────────────────────────────────────────────────────────
  // The eraser is a swept circle, not a snap-point deleter: every dot whose
  // body overlaps the segment from the previous pen sample to this one goes,
  // so fast drags can't skip dots and the slider radius is the real hit area.
  const eraseStrokeRef = useRef<{ x: number; y: number } | null>(null);

  const eraseAlong = useCallback((x1: number, y1: number, x2: number, y2: number) => {
    const reach = eraseRadiusRef.current;
    setDots((prev) => {
      let changed = false;
      const next = new Map(prev);
      const { w, h } = canvasBoundsRef.current;
      const mx = mirrorXRef.current, my = mirrorYRef.current;
      for (const d of prev.values()) {
        if (distToSegment(d.x, d.y, x1, y1, x2, y2) <= reach + d.radius) {
          next.delete(d.key); changed = true;
          if (mx || my) {
            for (const m of mirrorSnaps(d.x, d.y, w, h, snapModeRef.current, mx, my)) {
              if (next.has(m.key)) { next.delete(m.key); changed = true; }
            }
          }
        }
      }
      return changed ? next : prev;
    });
  }, []);

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
    try { const v = Number(localStorage.getItem("tangaliya-line-amount")); return Number.isFinite(v) ? v : 50; } catch { return 50; }
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
      for (const p of pts) {
        next.set(p.key, { key: p.key, x: p.x, y: p.y, color: colorRef.current, radius: radiusRef.current });
        if (mirrorXRef.current || mirrorYRef.current) {
          for (const m of mirrorSnaps(p.x, p.y, w, h, snapModeRef.current, mirrorXRef.current, mirrorYRef.current)) {
            if (m.key !== p.key) next.set(m.key, { key: m.key, x: m.x, y: m.y, color: colorRef.current, radius: radiusRef.current });
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
      for (const s of steps) {
        if (toolRef.current === "erase") next.delete(s.key);
        else {
          next.set(s.key, { key: s.key, x: s.x, y: s.y, color: colorRef.current, radius: radiusRef.current });
          if (mx || my) {
            for (const m of mirrorSnaps(s.x, s.y, cw, ch, snapModeRef.current, mx, my)) {
              if (m.key !== s.key) next.set(m.key, { key: m.key, x: m.x, y: m.y, color: colorRef.current, radius: radiusRef.current });
            }
          }
        }
      }
      return next;
    });
  }, []);

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

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Only strokes that start on the canvas SVG count — the container div
    // also holds zoom buttons, panel FABs, and the webcam overlay.
    if (!svgRef.current || !svgRef.current.contains(e.target as Node)) return;
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
      const hit = findDotAt(dotsRef.current, world.x, world.y);
      if (hit) { setColor(hit.color); pushRecentColor(hit.color); }
      return;
    }

    if (toolRef.current === "select") {
      const hit = findDotAt(dotsRef.current, world.x, world.y);

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

      if (hit) {
        if (!selectedKeysRef.current.has(hit.key)) {
          const next = new Set([hit.key]);
          setSelectedKeys(next);
          selectedKeysRef.current = next;
        }
        pushUndo();
        isDraggingDotsRef.current = true;
        dragStartWorldRef.current = { x: world.x, y: world.y };
        preDragDotsRef.current = new Map(dotsRef.current);
        snappedOffsetRef.current = { dx: 0, dy: 0 };
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
  }, [getSVGPoint, applyDrawTool, eraseAlong, pushUndo, pushRecentColor, handleTouchNav, finishPenPath, penDots]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    // Select-same-color only makes sense in the select tool. Without this
    // gate, two quick pen taps while drawing register as a double-click and
    // surprise-select dots mid-stroke.
    if (toolRef.current !== "select") return;
    if (!svgRef.current || !svgRef.current.contains(e.target as Node)) return;
    if (e.button !== 0) return;
    const world = getSVGPoint(e);
    if (!world) return;
    const hit = findDotAt(dotsRef.current, world.x, world.y);
    if (hit) selectSameColor(hit.color);
  }, [getSVGPoint, selectSameColor]);

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
      if (isDraggingDotsRef.current && dragStartWorldRef.current) {
        const rawDx = world.x - dragStartWorldRef.current.x;
        const rawDy = world.y - dragStartWorldRef.current.y;
        const dragSpacing = snapSpacing(snapModeRef.current);
        const snappedDx = Math.round(rawDx / dragSpacing) * dragSpacing;
        const snappedDy = Math.round(rawDy / dragSpacing) * dragSpacing;
        snappedOffsetRef.current = { dx: snappedDx, dy: snappedDy };
        setDragOffset({ dx: snappedDx, dy: snappedDy });
      } else if (isMarqueeingRef.current && marqueeStartRef.current) {
        setMarqueeBox({ wx1: marqueeStartRef.current.wx, wy1: marqueeStartRef.current.wy, wx2: world.x, wy2: world.y });
        const keys = dotsInRect(dotsRef.current, marqueeStartRef.current.wx, marqueeStartRef.current.wy, world.x, world.y);
        const union = new Set(marqueeBaseRef.current);
        for (const k of keys) union.add(k);
        setSelectedKeys(union);
        selectedKeysRef.current = union;
      } else {
        const hit = findDotAt(dotsRef.current, world.x, world.y);
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
  }, [getSVGPoint, applyDrawTool, paintStrokeTo, handleTouchNav, penDots, spacingOpts, shapeDotsFor]);

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
      if (isDraggingDotsRef.current) {
        const { dx, dy } = snappedOffsetRef.current;
        if (dx !== 0 || dy !== 0) {
          const next = new Map(preDragDotsRef.current);
          const newSelected = new Set<string>();
          for (const key of selectedKeysRef.current) {
            const dot = preDragDotsRef.current.get(key);
            if (!dot) continue;
            next.delete(key);
            const newPos = keyFromPosition(dot.x + dx, dot.y + dy);
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
      isPanningRef.current || isDraggingDotsRef.current || isMarqueeingRef.current) return;
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
    setMarqueeBox(null);
  }, []);

  // ── Hand-draw mode ──────────────────────────────────────────────────────
  // Webcam → MediaPipe HandLandmarker → index fingertip mapped to the canvas.
  // A pinch (index↔thumb) is "pen down"; it places dots through the same snap
  // + undo path as the mouse, independent of the active tool (always draws).
  const [handMode, setHandMode] = useState(false);
  const [handStatus, setHandStatus] = useState<"off" | "loading" | "ready" | "error">("off");
  // Floating webcam window — draggable position + resizable width (height locked 4:3).
  const CAM_ASPECT = 0.75;
  const [camPos, setCamPos] = useState({ x: 16, y: 16 });
  const [camW, setCamW] = useState(200);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const camRef = useRef<HTMLDivElement>(null);
  const landmarkerRef = useRef<any>(null);
  const visionRef = useRef<any>(null);
  const connectionsRef = useRef<any>(null);
  const drawingUtilsRef = useRef<any>(null);
  const handModeRef = useRef(false);
  const handPresentRef = useRef(false);
  const lastHandKeyRef = useRef<string | null>(null);
  const handLoopRef = useRef<number>();
  const viewportRef = useRef(viewportSize);
  useEffect(() => { viewportRef.current = viewportSize; }, [viewportSize]);
  useEffect(() => { handModeRef.current = handMode; }, [handMode]);

  // Move the on-canvas fingertip cursor via direct DOM writes (no re-render at 60fps).
  const positionCursor = useCallback((sx: number, sy: number, active: boolean, show: boolean) => {
    const el = cursorRef.current;
    if (!el) return;
    el.style.opacity = show ? "1" : "0";
    el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -50%) scale(${active ? 0.62 : 1})`;
    el.style.background = active ? colorRef.current : "transparent";
    el.style.borderColor = active ? colorRef.current : "rgba(255,255,255,0.95)";
  }, []);

  const stopHandLoop = useCallback(() => {
    if (handLoopRef.current !== undefined) cancelAnimationFrame(handLoopRef.current);
    handLoopRef.current = undefined;
    handPresentRef.current = false;
  }, []);

  const startHandLoop = useCallback(() => {
    // Fingertip must land within GATE_FACTOR × the snap spacing to drop a dot,
    // so placement is deliberate instead of a continuous trail. Spacing is the
    // half-cell (10px world) in "both" mode, a full cell (20px) otherwise.
    const GATE_FACTOR = 0.4;
    const tick = () => {
      const video = videoRef.current;
      const lmk = landmarkerRef.current;
      const vp = viewportRef.current;
      const overlay = overlayRef.current;
      if (handModeRef.current && lmk && video && video.videoWidth) {
        let res: any;
        try { res = lmk.detectForVideo(video, performance.now()); } catch { /* between frames */ }
        const lms = res?.landmarks?.[0];

        // Draw the hand skeleton onto the webcam preview.
        if (overlay) {
          const ctx = overlay.getContext("2d");
          if (ctx) {
            ctx.clearRect(0, 0, overlay.width, overlay.height);
            if (!drawingUtilsRef.current && visionRef.current) drawingUtilsRef.current = new visionRef.current.DrawingUtils(ctx);
            if (lms && drawingUtilsRef.current) {
              drawingUtilsRef.current.drawConnectors(lms, connectionsRef.current, { color: "rgba(255,255,255,0.85)", lineWidth: 2 });
              drawingUtilsRef.current.drawLandmarks(lms, { color: "#ffffff", fillColor: colorRef.current, lineWidth: 1, radius: 3 });
            }
          }
        }

        if (lms) {
          // First detection after the hand was absent starts a fresh undo group.
          if (!handPresentRef.current) { handPresentRef.current = true; lastHandKeyRef.current = null; pushUndo(); }
          const tip = lms[8]; // index fingertip, normalized 0–1
          const sx = (1 - tip.x) * vp.width; // mirror X to read like a mirror
          const sy = tip.y * vp.height;
          const world = screenToWorld(sx, sy);
          const snap = getNearestSnap(world.x, world.y, CELL_SIZE, snapModeRef.current, canvasBoundsRef.current.w, canvasBoundsRef.current.h);
          const spacing = snapSpacing(snapModeRef.current);
          const within = !!snap && Math.hypot(world.x - snap.x, world.y - snap.y) <= spacing * GATE_FACTOR;
          positionCursor(sx, sy, within, true);
          if (within && snap) {
            if (snap.key !== lastHandKeyRef.current) {
              lastHandKeyRef.current = snap.key;
              setDots((prev) => {
                const next = new Map(prev);
                next.set(snap.key, { key: snap.key, x: snap.x, y: snap.y, color: colorRef.current, radius: radiusRef.current });
                if (mirrorXRef.current || mirrorYRef.current) {
                  const { w, h } = canvasBoundsRef.current;
                  for (const m of mirrorSnaps(snap.x, snap.y, w, h, snapModeRef.current, mirrorXRef.current, mirrorYRef.current)) {
                    if (m.key !== snap.key) next.set(m.key, { key: m.key, x: m.x, y: m.y, color: colorRef.current, radius: radiusRef.current });
                  }
                }
                return next;
              });
            }
          } else {
            lastHandKeyRef.current = null; // re-arm so returning to a point places again
          }
        } else {
          handPresentRef.current = false;
          positionCursor(0, 0, false, false);
        }
      } else {
        handPresentRef.current = false;
        positionCursor(0, 0, false, false);
      }
      handLoopRef.current = requestAnimationFrame(tick);
    };
    stopHandLoop();
    handLoopRef.current = requestAnimationFrame(tick);
  }, [positionCursor, pushUndo, stopHandLoop]);

  useEffect(() => {
    if (!handMode) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    setHandStatus("loading");
    (async () => {
      try {
        const { vision, fileset } = await loadVision();
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
        const video = videoRef.current;
        if (cancelled || !video) { stream?.getTracks().forEach((t) => t.stop()); return; }
        video.srcObject = stream;
        await video.play();
        const landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: HAND_MODEL },
          runningMode: "VIDEO",
          numHands: 1,
        });
        if (cancelled) { landmarker.close?.(); stream.getTracks().forEach((t) => t.stop()); return; }
        landmarkerRef.current = landmarker;
        visionRef.current = vision;
        connectionsRef.current = vision.HandLandmarker.HAND_CONNECTIONS;
        setHandStatus("ready");
        startHandLoop();
      } catch {
        if (!cancelled) setHandStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      stopHandLoop();
      try { landmarkerRef.current?.close?.(); } catch { /* ignore */ }
      landmarkerRef.current = null;
      drawingUtilsRef.current = null;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      setHandStatus("off");
    };
  }, [handMode, startHandLoop, stopHandLoop]);

  // Drag the camera window by its header; resize from the bottom-right grip.
  // Both write straight to the DOM during the gesture and commit to state on
  // release, so the big component doesn't re-render every pointer move.
  const startCamDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const el = camRef.current; if (!el) return;
    const px = e.clientX, py = e.clientY, ox = el.offsetLeft, oy = el.offsetTop;
    const move = (ev: PointerEvent) => {
      el.style.left = `${ox + (ev.clientX - px)}px`;
      el.style.top = `${oy + (ev.clientY - py)}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const vp = viewportRef.current;
      const x = Math.min(Math.max(0, el.offsetLeft), Math.max(0, vp.width - 40));
      const y = Math.min(Math.max(0, el.offsetTop), Math.max(0, vp.height - 40));
      setCamPos({ x, y });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

  const startCamResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const el = camRef.current; if (!el) return;
    const px = e.clientX, w0 = el.offsetWidth;
    const move = (ev: PointerEvent) => {
      const w = Math.max(120, Math.min(520, w0 + (ev.clientX - px)));
      el.style.width = `${w}px`;
      el.style.height = `${w * CAM_ASPECT}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setCamW(el.offsetWidth);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, []);

  const toggleHandMode = useCallback(() => {
    setHandMode((m) => {
      const next = !m;
      // Drop the window into the top-right of the canvas the first time it opens.
      if (next) setCamPos({ x: Math.max(12, viewportRef.current.width - camW - 12), y: compact ? 68 : 12 });
      return next;
    });
    sfx.toggle();
  }, [camW, compact]);

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
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "dot-art.svg"; a.click();
    URL.revokeObjectURL(url);
  }, [layers, canvasPxW, canvasPxH, pxPerUnit, unit, canvasBg, gridColor, gridOpacity, gridThickness, dotShape]);

  const exportPNG = useCallback(() => {
    sfx.export();
    const allDots = flattenLayers(layers);
    const content = buildSVGString(allDots, canvasPxW, canvasPxH, pxPerUnit, unit, canvasBg, gridColor, gridOpacity, gridThickness, CELL_SIZE, dotShape);
    const scale = 4;
    const outW = Math.max(1, Math.round(canvasPxW * scale));
    const outH = Math.max(1, Math.round(canvasPxH * scale));
    const svgBlob = new Blob([content], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = outW; canvas.height = outH;
      const ctx = canvas.getContext("2d");
      if (!ctx) { URL.revokeObjectURL(url); return; }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, outW, outH);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const dlUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = dlUrl; a.download = "dot-art.png"; a.click();
        URL.revokeObjectURL(dlUrl);
      }, "image/png");
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }, [layers, canvasPxW, canvasPxH, pxPerUnit, unit, canvasBg, gridColor, gridOpacity, gridThickness, dotShape]);

  const exportPDF = useCallback(() => {
    sfx.export();
    const allDots = flattenLayers(layers);
    const svgContent = buildSVGString(allDots, canvasPxW, canvasPxH, pxPerUnit, unit, canvasBg, gridColor, gridOpacity, gridThickness, CELL_SIZE, dotShape);

    // Physical dimensions in mm for PDF
    const widthMm = unit === "mm" ? canvasPhysW : convertUnit(canvasPhysW, unit, "mm");
    const heightMm = unit === "mm" ? canvasPhysH : convertUnit(canvasPhysH, unit, "mm");

    // Render at 300 DPI for print quality
    const dpi = 300;
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
      pdf.save("dot-art.pdf");
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }, [layers, canvasPxW, canvasPxH, pxPerUnit, unit, canvasBg, gridColor, gridOpacity, gridThickness, canvasPhysW, canvasPhysH, dotShape]);

  // ── Editable project: serialize / save / open / restore ──
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const importPreviewRef = useRef<HTMLCanvasElement>(null); // the modal's preview canvas
  const fontInputRef = useRef<HTMLInputElement>(null);
  const textPreviewRef = useRef<HTMLCanvasElement>(null);

  const buildScene = useCallback((): SceneFile => ({
    app: PROJECT_TAG,
    version: PROJECT_VERSION,
    dots: flattenLayers(layers), // flattened, for back-compat readers
    layers: layers.map((l) => ({ id: l.id, name: l.name, visible: l.visible, dots: Array.from(l.dots.values()) })),
    unit, cellPhysical, canvasPhysW, canvasPhysH,
    canvasBg, gridColor, gridOpacity, gridThickness,
    snapMode, color, radius, snapReach, eraseRadius, recentColors,
  }), [layers, unit, cellPhysical, canvasPhysW, canvasPhysH, canvasBg, gridColor,
    gridOpacity, gridThickness, snapMode, color, radius, snapReach, eraseRadius, recentColors]);

  // Replace the entire document with a loaded scene (undoable, re-fits the view).
  const applyScene = useCallback((scene: SceneFile) => {
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

  // ── Layer operations ──
  // Structure edits (add/delete/reorder/rename/visibility/activate) are NOT on
  // the undo stack in v1 — only dot edits within a layer are. They read the
  // live stack via `layersRef` and write `setLayers` + keep the ref in sync.
  const selectLayer = useCallback((id: string) => {
    setActiveLayerId(id); activeLayerIdRef.current = id;
    setSelectedKeys(new Set()); selectedKeysRef.current = new Set();
    sfx.toggle();
  }, []);
  const addLayer = useCallback(() => {
    const ls = layersRef.current;
    const idx = ls.findIndex((l) => l.id === activeLayerIdRef.current);
    const at = idx < 0 ? ls.length : idx + 1; // above the active layer
    const nl: Layer = { id: genLayerId(), name: `Layer ${ls.length + 1}`, visible: true, dots: new Map() };
    const next = [...ls.slice(0, at), nl, ...ls.slice(at)];
    setLayers(next); layersRef.current = next;
    setActiveLayerId(nl.id); activeLayerIdRef.current = nl.id;
    setSelectedKeys(new Set()); selectedKeysRef.current = new Set();
    sfx.toggle();
  }, []);
  const duplicateLayer = useCallback((id: string) => {
    const ls = layersRef.current;
    const idx = ls.findIndex((l) => l.id === id);
    if (idx < 0) return;
    const src = ls[idx];
    const nl: Layer = { id: genLayerId(), name: `${src.name} copy`, visible: src.visible, dots: new Map(src.dots) };
    const next = [...ls.slice(0, idx + 1), nl, ...ls.slice(idx + 1)];
    setLayers(next); layersRef.current = next;
    setActiveLayerId(nl.id); activeLayerIdRef.current = nl.id;
    sfx.toggle();
  }, []);
  const deleteLayer = useCallback((id: string) => {
    const ls = layersRef.current;
    if (ls.length <= 1) return; // always keep one layer
    const idx = ls.findIndex((l) => l.id === id);
    const next = ls.filter((l) => l.id !== id);
    setLayers(next); layersRef.current = next;
    if (activeLayerIdRef.current === id) {
      const na = next[Math.max(0, idx - 1)] ?? next[0];
      setActiveLayerId(na.id); activeLayerIdRef.current = na.id;
      setSelectedKeys(new Set()); selectedKeysRef.current = new Set();
    }
    sfx.toggle();
  }, []);
  const moveLayer = useCallback((id: string, dir: 1 | -1) => {
    const ls = layersRef.current;
    const idx = ls.findIndex((l) => l.id === id);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= ls.length) return;
    const next = [...ls];
    [next[idx], next[j]] = [next[j], next[idx]];
    setLayers(next); layersRef.current = next;
    sfx.toggle();
  }, []);
  const toggleLayerVisible = useCallback((id: string) => {
    const next = layersRef.current.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l));
    setLayers(next); layersRef.current = next;
    sfx.toggle();
  }, []);
  const renameLayer = useCallback((id: string, name: string) => {
    const next = layersRef.current.map((l) => (l.id === id ? { ...l, name } : l));
    setLayers(next); layersRef.current = next;
  }, []);
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
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "tangaliya-project.json"; a.click();
    URL.revokeObjectURL(url);
  }, [buildScene]);

  const openProjectFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const scene = parseScene(String(reader.result));
      if (!scene) { alert("That doesn't look like a Tangaliya project file."); return; }
      sfx.ui();
      applyScene(scene);
    };
    reader.readAsText(file);
  }, [applyScene]);

  // ── Image import (modal) ──
  // The "Import Image" modal tunes a conversion against a loaded image and shows
  // a live preview; "Add to canvas" commits the dots to the real editor.

  // Target canvas dims matching the loaded image's aspect ratio (keeps the cell
  // size and the current long-edge cell count). Drives both preview and commit.
  const importDims = useMemo(() => {
    if (!importImg) return null;
    const longPhys = Math.max(canvasPhysW, canvasPhysH) || 1;
    return computeImportDims(importImg.width, importImg.height, longPhys, importCell);
  }, [importImg, canvasPhysW, canvasPhysH, importCell]);

  // Live preview dots — recomputed whenever the image or any control changes.
  const previewDots = useMemo(() => {
    if (!importImg || !importDims) return null;
    return buildDotsFromImage(importImg, importDims.pxW, importDims.pxH, {
      style: traceStyle, threshold: traceThreshold, dotRadius: traceDotSize, snapMode: traceDetail, monoColor: color, tonalColor: traceTonalColor,
    });
  }, [importImg, importDims, traceStyle, traceThreshold, traceDotSize, traceDetail, color, traceTonalColor]);

  const openImportFile = useCallback(async (file: File) => {
    try {
      const bitmap = await createImageBitmap(file);
      setImportImg(bitmap);
    } catch {
      alert("Couldn't read that image.");
    }
  }, []);

  // Close the modal and drop the loaded image so each open starts fresh.
  const closeImport = useCallback(() => { setImportOpen(false); setImportImg(null); }, []);

  // Shared commit: resize the canvas to the source aspect + cell size, fit the
  // view, and replace the dots (undoable). Used by the image and text modals.
  const commitDots = useCallback((map: Map<string, Dot>, dims: { pxW: number; pxH: number; physW: number; physH: number }, cell: number) => {
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

    pushUndo();
    const next = new Map(map);
    setDots(next); dotsRef.current = next;
    setSelectedKeys(new Set()); selectedKeysRef.current = new Set();
    sfx.ui();
  }, [pushUndo, applyViewport]);

  const addImportToCanvas = useCallback(() => {
    if (!importDims || !previewDots) return;
    commitDots(previewDots, importDims, importCell);
    setImportOpen(false); setImportImg(null);
  }, [importDims, previewDots, importCell, commitDots]);

  // Render the preview dots into the modal's canvas (fit to a fixed box).
  useEffect(() => {
    const cv = importPreviewRef.current;
    if (!cv || !importDims) return;
    const BOX = 420;
    const s = Math.min(BOX / importDims.pxW, BOX / importDims.pxH);
    cv.width = Math.round(importDims.pxW * s);
    cv.height = Math.round(importDims.pxH * s);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = canvasBg;
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (!previewDots) return;
    ctx.scale(s, s);
    for (const d of previewDots.values()) {
      ctx.fillStyle = d.color;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.radius, 0, Math.PI * 2);
      ctx.fill();
    }
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

  // Autosave the document to localStorage (debounced) on any change.
  useEffect(() => {
    const id = window.setTimeout(() => {
      try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(buildScene())); } catch { /* quota / private mode */ }
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

  // Grid lines are pure functions of the canvas size / grid style / zoom —
  // memoized so pointermove-driven re-renders (hover, preview, drag) skip
  // rebuilding ~350 <line> elements when none of that actually changed. Deps
  // include both cols/rows AND canvasPxW/canvasPxH: cols/rows are Math.round()
  // of the latter, so a canvas-size change that doesn't cross a rounding
  // boundary could leave cols/rows unchanged while canvasPxW/H (the lines'
  // actual x2/y2 bounds) did change — depending on only one pair would risk a
  // stale-length grid.
  const gridLines = useMemo(() => (
    <>
      {Array.from({ length: cols * GRID_SUBDIV - 1 }, (_, idx) => {
        const i = idx + 1;
        if (i % GRID_SUBDIV === 0) return null;
        const isMid = i % GRID_SUBDIV === GRID_SUBDIV / 2;
        const x = i * (CELL_SIZE / GRID_SUBDIV);
        return <line key={`sv${i}`} x1={x} y1={0} x2={x} y2={canvasPxH}
          stroke={gridColor} strokeOpacity={gridOpacity * (isMid ? 0.72 : 0.4)} strokeWidth={(gridThickness * (isMid ? 0.8 : 0.5)) / zoom} />;
      })}
      {Array.from({ length: rows * GRID_SUBDIV - 1 }, (_, idx) => {
        const i = idx + 1;
        if (i % GRID_SUBDIV === 0) return null;
        const isMid = i % GRID_SUBDIV === GRID_SUBDIV / 2;
        const y = i * (CELL_SIZE / GRID_SUBDIV);
        return <line key={`sh${i}`} x1={0} y1={y} x2={canvasPxW} y2={y}
          stroke={gridColor} strokeOpacity={gridOpacity * (isMid ? 0.72 : 0.4)} strokeWidth={(gridThickness * (isMid ? 0.8 : 0.5)) / zoom} />;
      })}
      {Array.from({ length: cols + 1 }, (_, i) => (
        <line key={`v${i}`} x1={i * CELL_SIZE} y1={0} x2={i * CELL_SIZE} y2={canvasPxH}
          stroke={gridColor} strokeOpacity={gridOpacity} strokeWidth={gridThickness / zoom} />
      ))}
      {Array.from({ length: rows + 1 }, (_, i) => (
        <line key={`h${i}`} x1={0} y1={i * CELL_SIZE} x2={canvasPxW} y2={i * CELL_SIZE}
          stroke={gridColor} strokeOpacity={gridOpacity} strokeWidth={gridThickness / zoom} />
      ))}
    </>
  ), [cols, rows, canvasPxW, canvasPxH, gridColor, gridOpacity, gridThickness, zoom]);

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

  const selectedDots = Array.from(selectedKeys).map((k) => dots.get(k)).filter(Boolean) as Dot[];
  const selColors = [...new Set(selectedDots.map((d) => d.color))];
  const selRadii = [...new Set(selectedDots.map((d) => d.radius))];
  const selColor = selColors.length === 1 ? selColors[0] : color;
  const selRadius = selRadii.length === 1 ? selRadii[0] : radius;
  const selMixed = selColors.length > 1 || selRadii.length > 1;

  // ── Right-panel context: what the inspector currently edits ──
  const editingSelection = tool === "select" && selectedKeys.size > 0;
  const rightCtx: "erase" | "selection" | "dot" | "grid" | "background" =
    tool === "erase" ? "erase" : editingSelection ? "selection" : inspect;
  const ctxTitle = rightCtx === "dot" && tool === "line" ? "Sparse Line"
    : rightCtx === "dot" && tool === "pen" ? "Pen Path"
      : rightCtx === "dot" && tool === "shape" ? ({ ellipse: "Ellipse", rect: "Rectangle", diamond: "Diamond", triangle: "Triangle", polygon: "Polygon" }[shapeType])
        : { erase: "Eraser", selection: "Selection", dot: "Dot Color", grid: "Grid", background: "Background" }[rightCtx];
  const isColorCtx = rightCtx === "dot" || rightCtx === "selection";
  const activeColor = editingSelection ? selColor : color;
  const activeRadius = editingSelection ? selRadius : radius;
  const colorMixed = editingSelection && selMixed;
  const setActiveColor = (c: string) => { editingSelection ? updateSelectedDots({ color: c }) : setColor(c); pushRecentColor(c); };
  const setActiveRadius = (v: number) => { editingSelection ? updateSelectedDots({ radius: v }) : setRadius(v); };
  // Recolor the selection live during a picker drag, without pushing an undo snapshot every tick.
  const recolorSelectionLive = (c: string) => {
    setDots((prev) => {
      const next = new Map(prev);
      for (const k of selectedKeysRef.current) { const d = next.get(k); if (d) next.set(k, { ...d, color: c }); }
      return next;
    });
  };
  const onPickerChange = (c: string) => { lastPickRef.current = c; editingSelection ? recolorSelectionLive(c) : setColor(c); };

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

        {/* Brand header */}
        <div className="bg-[var(--card)] rounded-3xl px-5 py-3.5 flex items-center gap-3 shrink-0">
          <svg width="34" height="34" viewBox="0 0 39 39" className="shrink-0" aria-label="morii logo">
            {[
              [18.5, 3.5],  // top
              [3.5, 18.5],  // left
              [18.5, 18.5], // center
              [34.5, 18.5], // right
              [18.5, 34.5], // bottom
            ].map(([cx, cy]) => (
              <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={3.5} fill="#FF2A2A" />
            ))}
          </svg>
          <span className="text-[26px] font-bold tracking-[-0.8px] text-[var(--brand)] leading-none">Tangaliya</span>
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <button onClick={() => setMuted((m) => !m)} title={muted ? "Unmute sounds" : "Mute sounds"}
              aria-label="Toggle interface sounds"
              className="w-9 h-9 rounded-xl flex items-center justify-center bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)] transition-all">
              {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
            </button>
            <button onClick={toggleTheme} title={dark ? "Switch to light mode" : "Switch to dark mode"}
              aria-label="Toggle dark mode"
              className="w-9 h-9 rounded-xl flex items-center justify-center bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)] transition-all">
              {dark ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </div>
        </div>

        {/* Controls card */}
        <div className="bg-[var(--card)] rounded-3xl p-4 flex-1 overflow-y-auto flex flex-col gap-5 [&>*]:shrink-0" style={{ scrollbarWidth: "none" }}>

          {/* Tools */}
          <div>
            <div className="grid grid-cols-6 gap-2">
              {([
                { t: "select" as Tool, icon: <MousePointer2 size={20} />, label: "Select (V)" },
                { t: "draw" as Tool, icon: <Pen size={20} />, label: "Draw (B)" },
                { t: "erase" as Tool, icon: <Eraser size={20} />, label: "Erase (E)" },
                { t: "line" as Tool, icon: <Slash size={20} />, label: "Line (L)" },
                { t: "pen" as Tool, icon: <PenTool size={20} />, label: "Pen (P)" },
                { t: "shape" as Tool, icon: <Circle size={20} />, label: "Shape (S)" },
              ]).map(({ t, icon, label }) => (
                <button key={t} title={label}
                  onClick={() => {
                    // Switching away from Pen mid-path discards the pending
                    // anchors — you can't leave a dangling path around.
                    if (tool === "pen" && t !== "pen" && penAnchorsRef.current.length > 0) cancelPenPath();
                    setTool(t);
                    if (t === "select") sfx.toolSelect(); else if (t === "draw" || t === "line" || t === "pen" || t === "shape") sfx.toolDraw(); else sfx.toolErase();
                    if (t === "draw" || t === "line" || t === "pen" || t === "shape") setInspect("dot");
                    if (t !== "select") { setSelectedKeys(new Set()); selectedKeysRef.current = new Set(); }
                  }}
                  className={`aspect-square rounded-xl flex items-center justify-center transition-all ${tool === t ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
                    }`}>
                  {icon}
                </button>
              ))}
            </div>
          </div>

          {/* Units */}
          <div>
            <div className="text-[14px] text-[var(--txt-2)] tracking-[-0.3px] mb-2">Units</div>
            <div className="flex gap-2">
              {(["mm", "cm", "in"] as Unit[]).map((u) => (
                <button key={u} onClick={() => changeUnit(u)}
                  className={`flex-1 py-2 rounded-xl text-[16px] transition-all ${unit === u ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
                    }`}>
                  {u}
                </button>
              ))}
            </div>
          </div>

          {/* Canvas Size */}
          <div>
            <div className="text-[14px] text-[var(--txt-2)] tracking-[-0.3px] mb-2">Canvas Size</div>
            <div className="flex gap-2">
              {([
                { label: "W", value: wInput, onChange: setWInput, onCommit: commitW },
                { label: "H", value: hInput, onChange: setHInput, onCommit: commitH },
              ]).map(({ label, value, onChange, onCommit }) => (
                <div key={label} className="flex-1 flex items-center gap-1.5 bg-[var(--ctl)] rounded-xl px-3 py-2">
                  <span className="text-[16px] text-[var(--txt-2)] shrink-0">{label}</span>
                  <input type="number" min="1" step="any" value={value}
                    onChange={(e) => onChange(e.target.value)} onBlur={onCommit}
                    onFocus={(e) => e.target.select()}
                    onKeyDown={(e) => { if (e.key === "Enter") { onCommit(); (e.target as HTMLInputElement).blur(); } }}
                    className="w-full min-w-0 bg-transparent text-[16px] text-[var(--txt-1)] text-right focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-2">
              {[
                { mm_w: 100, mm_h: 100, label: "100²" },
                { mm_w: 200, mm_h: 150, label: "4:3" },
                { mm_w: 297, mm_h: 210, label: "A4" },
              ].map((p) => {
                const w = roundForUnit(convertUnit(p.mm_w, "mm", unit), unit);
                const h = roundForUnit(convertUnit(p.mm_h, "mm", unit), unit);
                return (
                  <button key={p.label}
                    onClick={() => { setCanvasPhysW(w); setCanvasPhysH(h); setWInput(String(w)); setHInput(String(h)); }}
                    className="flex-1 py-1.5 rounded-lg text-[12px] text-[var(--txt-2)] bg-[var(--ctl)] hover:bg-[var(--ctl-hover)] transition-all">
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Cell Size */}
          <div>
            <div className="text-[14px] text-[var(--txt-2)] tracking-[-0.3px] mb-2">Cell Size</div>
            <div className="flex items-center gap-2">
              <button onClick={() => stepCell(-1)} title="Smaller cell"
                className="w-10 h-10 rounded-lg bg-[var(--ctl)] text-[var(--txt-1)] flex items-center justify-center hover:bg-[var(--ctl-hover)] transition-all shrink-0">
                <Minus size={18} />
              </button>
              <div className="flex-1 flex items-center justify-center gap-1.5 bg-[var(--ctl)] rounded-xl py-2">
                <input type="number" min="0.01" step="any" value={cellInput}
                  onChange={(e) => setCellInput(e.target.value)} onBlur={commitCell}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => { if (e.key === "Enter") { commitCell(); (e.target as HTMLInputElement).blur(); } }}
                  className="w-12 bg-transparent text-[16px] text-[var(--txt-1)] text-center focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
                <span className="text-[13px] text-[var(--txt-2)]">{unit}</span>
              </div>
              <button onClick={() => stepCell(1)} title="Larger cell"
                className="w-10 h-10 rounded-lg bg-[var(--ctl)] text-[var(--txt-1)] flex items-center justify-center hover:bg-[var(--ctl-hover)] transition-all shrink-0">
                <Plus size={18} />
              </button>
            </div>
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

        {/* Hand Draw (webcam) — pinned above the status line, always visible regardless of scroll */}
        <div className="bg-[var(--card)] rounded-3xl p-3 shrink-0">
          <button onClick={toggleHandMode}
            title="Draw with your hand via webcam — hover your index fingertip over a snap point to place a dot"
            className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 transition-all ${handMode ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
              }`}>
            <Hand size={18} className="shrink-0" />
            <span className="flex flex-col items-start leading-tight min-w-0">
              <span className="text-[14px]">{handMode ? "Hand draw on" : "Hand draw off"}</span>
              <span className={`text-[11px] ${handMode ? "opacity-80" : "text-[var(--txt-3)]"}`}>
                {handStatus === "loading" ? "Starting camera…"
                  : handStatus === "ready" ? "Aim fingertip at a dot"
                    : handStatus === "error" ? "Camera unavailable"
                      : "Webcam · MediaPipe"}
              </span>
            </span>
          </button>
        </div>

        {/* Status footer */}
        <div className="bg-[var(--card)] rounded-3xl p-3 shrink-0 flex items-center justify-between px-4 text-[12px] text-[var(--txt-3)]">
          <span>{dots.size} dot{dots.size !== 1 ? "s" : ""}</span>
          <span className="font-mono">{Math.round(zoom * 100)}%</span>
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
        <svg ref={svgRef} width={viewportSize.width} height={viewportSize.height}
          className="absolute inset-0 select-none" style={{ cursor, touchAction: "none" }}>

          <rect width={viewportSize.width} height={viewportSize.height} style={{ fill: "var(--viewport)" }} />

          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom}) rotate(${(rot * 180) / Math.PI})`}>
            <rect x={6 / zoom} y={8 / zoom} width={canvasPxW} height={canvasPxH} fill="#000" opacity={0.12} />
            <rect x={0} y={0} width={canvasPxW} height={canvasPxH} fill={canvasBg} />

            {/* Minor + main grid lines — memoized, see `gridLines` above */}
            {gridLines}

            <rect x={0} y={0} width={canvasPxW} height={canvasPxH} fill="none"
              stroke="#999" strokeWidth={1 / zoom} />

            {/* Mirror axes: the center line(s) dots reflect across while a
                mirror toggle is on — a visual reference only (never exported,
                never a dot). Left-right mirror = vertical center line;
                top-bottom mirror = horizontal center line. */}
            {mirrorX && (
              <line x1={canvasPxW / 2} y1={0} x2={canvasPxW / 2} y2={canvasPxH}
                stroke={selectionRingColor} strokeOpacity={0.6} strokeWidth={1 / zoom}
                strokeDasharray={`${7 / zoom},${5 / zoom}`} style={{ pointerEvents: "none" }} />
            )}
            {mirrorY && (
              <line x1={0} y1={canvasPxH / 2} x2={canvasPxW} y2={canvasPxH / 2}
                stroke={selectionRingColor} strokeOpacity={0.6} strokeWidth={1 / zoom}
                strokeDasharray={`${7 / zoom},${5 / zoom}`} style={{ pointerEvents: "none" }} />
            )}

            {/* Composite every visible layer bottom→top; selection/hover rings
                and drag-offset only apply to the active layer being edited.
                Inactive layers get CONSTANT props (null/false/0) so hover,
                selection, and drag churn on the active layer never re-renders
                them — see DotLayer's module-scope definition above. */}
            {layers.map((layer) => layer.visible && (
              <DotLayer key={layer.id}
                layer={layer}
                isActive={layer.id === activeLayerId}
                dotShape={dotShape}
                zoom={zoom}
                selectionRingColor={selectionRingColor}
                selectedKeys={layer.id === activeLayerId ? selectedKeys : null}
                hoveredDotKey={layer.id === activeLayerId ? hoveredDotKey : null}
                isDragging={layer.id === activeLayerId ? isDragging : false}
                moveDx={layer.id === activeLayerId ? moveDx : 0}
                moveDy={layer.id === activeLayerId ? moveDy : 0}
                pulseKey={layer.id === activeLayerId ? layerPulseKey : undefined}
              />
            ))}

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
        </svg>

        {/* Layers panel (floating, top-right) */}
        <div className="absolute top-4 right-4 z-20 flex flex-col items-end gap-2">
          <button onClick={() => setShowLayers((v) => !v)} title="Layers"
            className={`h-9 px-3 flex items-center gap-1.5 rounded-xl text-[13px] backdrop-blur-sm border border-[var(--overlay-border)]/60 shadow-sm transition-colors ${showLayers ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--overlay)]/85 text-[var(--overlay-fg)] hover:bg-[var(--ctl-hover)]"}`}>
            <LayersIcon size={15} /> Layers
          </button>
          {showLayers && (
            <div className="w-64 bg-[var(--card)] rounded-2xl p-2 shadow-xl border border-[var(--overlay-border)]/60 flex flex-col gap-2">
              <div className="flex items-center justify-between px-1">
                <span className="text-[13px] text-[var(--txt-2)]">Layers</span>
                <button onClick={addLayer} title="New layer"
                  className="w-7 h-7 flex items-center justify-center rounded-lg bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)] transition-colors">
                  <Plus size={16} />
                </button>
              </div>
              <div className="flex flex-col gap-1 max-h-[52vh] overflow-y-auto" style={{ scrollbarWidth: "none" }}>
                {layers.map((l, i) => ({ l, i })).reverse().map(({ l, i }) => {
                  const active = l.id === activeLayerId;
                  return (
                    <div key={l.id} onClick={() => selectLayer(l.id)}
                      className={`flex items-center gap-1 rounded-xl px-1.5 py-1.5 cursor-pointer transition-colors ${active ? "bg-[var(--solid)]/15 ring-1 ring-[var(--solid)]/40" : "bg-[var(--ctl)] hover:bg-[var(--ctl-hover)]"}`}>
                      <button onClick={(e) => { e.stopPropagation(); toggleLayerVisible(l.id); }} title={l.visible ? "Hide" : "Show"}
                        className="w-6 h-6 flex items-center justify-center rounded text-[var(--txt-2)] hover:text-[var(--txt-1)] shrink-0">
                        {l.visible ? <Eye size={15} /> : <EyeOff size={15} />}
                      </button>
                      <input value={l.name} onChange={(e) => renameLayer(l.id, e.target.value)}
                        className="flex-1 min-w-0 bg-transparent text-[13px] text-[var(--txt-1)] outline-none" />
                      <span className="text-[10px] text-[var(--txt-3)] tabular-nums shrink-0 mr-0.5">{l.dots.size}</span>
                      <button onClick={(e) => { e.stopPropagation(); moveLayer(l.id, 1); }} disabled={i === layers.length - 1} title="Move up"
                        className="w-6 h-6 flex items-center justify-center rounded text-[var(--txt-2)] hover:text-[var(--txt-1)] disabled:opacity-25 shrink-0"><ChevronUp size={14} /></button>
                      <button onClick={(e) => { e.stopPropagation(); moveLayer(l.id, -1); }} disabled={i === 0} title="Move down"
                        className="w-6 h-6 flex items-center justify-center rounded text-[var(--txt-2)] hover:text-[var(--txt-1)] disabled:opacity-25 shrink-0"><ChevronDown size={14} /></button>
                      <button onClick={(e) => { e.stopPropagation(); duplicateLayer(l.id); }} title="Duplicate"
                        className="w-6 h-6 flex items-center justify-center rounded text-[var(--txt-2)] hover:text-[var(--txt-1)] shrink-0"><Copy size={13} /></button>
                      <button onClick={(e) => { e.stopPropagation(); deleteLayer(l.id); }} disabled={layers.length <= 1} title="Delete"
                        className="w-6 h-6 flex items-center justify-center rounded text-[var(--txt-2)] hover:text-[#ef4444] disabled:opacity-25 shrink-0"><Trash2 size={13} /></button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Status pill (bottom-left) */}
        <div className="absolute bottom-4 left-4 flex items-center gap-2 text-[11px] text-[var(--overlay-fg)] pointer-events-none bg-[var(--overlay)]/80 backdrop-blur-sm rounded-lg px-3 py-1.5 border border-[var(--overlay-border)]/60 shadow-sm">
          <Ruler size={11} className="text-[var(--overlay-fg-muted)]" />
          <span className="font-mono">{fmt(canvasPhysW, unit)} × {fmt(canvasPhysH, unit)}</span>
          <span className="text-[var(--overlay-fg-muted)]">·</span>
          <span className="font-mono text-[var(--overlay-fg-muted)]">{cols}×{rows}</span>
          <span className="text-[var(--overlay-fg-muted)]">·</span>
          <span className="text-[var(--overlay-fg)]">{dots.size} dot{dots.size !== 1 ? "s" : ""}</span>
        </div>

        {/* Undo / redo cluster (bottom-center) — floats on the canvas so it's
            one tap on iPad without opening the tools panel; targets are kept
            big (48px tall, wide pads) so a finger can't miss mid-flow. */}
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-0.5 bg-[var(--overlay)] border border-[var(--overlay-border)] rounded-xl shadow-sm px-1 py-1">
          <button onClick={undo} disabled={undoCount === 0} title="Undo (Ctrl+Z)" aria-label="Undo"
            className="h-12 px-5 flex items-center justify-center gap-2 rounded-lg hover:bg-[var(--ctl-hover)] text-[var(--overlay-fg)] text-[13px] disabled:opacity-30 disabled:cursor-not-allowed transition-colors select-none touch-none">
            <Undo2 size={19} /> Undo
          </button>
          <div className="w-px h-5 bg-[var(--overlay-border)] mx-0.5" />
          <button onClick={redo} disabled={redoCount === 0} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"
            className="h-12 px-5 flex items-center justify-center gap-2 rounded-lg hover:bg-[var(--ctl-hover)] text-[var(--overlay-fg)] text-[13px] disabled:opacity-30 disabled:cursor-not-allowed transition-colors select-none touch-none">
            Redo <Redo2 size={19} />
          </button>
          <div className="w-px h-5 bg-[var(--overlay-border)] mx-0.5" />
          <button onClick={toggleRuler} aria-pressed={rulerOn} aria-label="Toggle magnetic ruler"
            title={rulerOn ? "Magnetic ruler on — strokes straighten onto a line (tap to turn off for curves)" : "Magnetic ruler off — strokes follow the hand freely"}
            className={`h-12 px-4 flex items-center justify-center rounded-lg text-[13px] transition-colors select-none touch-none ${rulerOn ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "text-[var(--overlay-fg)] hover:bg-[var(--ctl-hover)]"}`}>
            <Ruler size={19} />
          </button>
          <div className="w-px h-5 bg-[var(--overlay-border)] mx-0.5" />
          <button onClick={toggleMirrorX} aria-pressed={mirrorX} aria-label="Toggle left-right mirror"
            title={mirrorX ? "Left-right mirror on — every dot reflects across the vertical center" : "Left-right mirror off"}
            className={`h-12 px-4 flex items-center justify-center rounded-lg text-[13px] transition-colors select-none touch-none ${mirrorX ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "text-[var(--overlay-fg)] hover:bg-[var(--ctl-hover)]"}`}>
            <FlipHorizontal2 size={19} />
          </button>
          <button onClick={toggleMirrorY} aria-pressed={mirrorY} aria-label="Toggle top-bottom mirror"
            title={mirrorY ? "Top-bottom mirror on — every dot reflects across the horizontal center" : "Top-bottom mirror off"}
            className={`h-12 px-4 flex items-center justify-center rounded-lg text-[13px] transition-colors select-none touch-none ${mirrorY ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "text-[var(--overlay-fg)] hover:bg-[var(--ctl-hover)]"}`}>
            <FlipVertical2 size={19} />
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

        {!compact && (
          <div className="absolute top-4 left-4 text-[11px] text-[var(--overlay-fg-muted)] pointer-events-none">
            Scroll zoom · Space+drag pan · B/E/V tools · Alt+click eyedropper · Ctrl+C/V copy · Ctrl+D dup · ⌫ delete · Arrows nudge
          </div>
        )}

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

        {/* Hand-draw overlay: fingertip cursor + mirrored webcam preview */}
        {handMode && (
          <>
            <div ref={cursorRef}
              className="absolute top-0 left-0 z-20 rounded-full border-[2.5px] pointer-events-none shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
              style={{ width: 26, height: 26, opacity: 0, transition: "opacity 140ms ease, transform 60ms linear" }} />
            <div ref={camRef}
              className="absolute z-20 rounded-xl overflow-hidden border border-[var(--overlay-border)] shadow-lg bg-black/50 backdrop-blur-sm select-none"
              style={{ left: camPos.x, top: camPos.y, width: camW, height: camW * CAM_ASPECT }}>
              <video ref={videoRef} autoPlay muted playsInline
                className="block w-full h-full object-cover" style={{ transform: "scaleX(-1)" }} />
              <canvas ref={overlayRef} width={320} height={240}
                className="absolute inset-0 w-full h-full pointer-events-none" style={{ transform: "scaleX(-1)" }} />
              {/* drag header */}
              <div onPointerDown={startCamDrag}
                className="absolute top-0 inset-x-0 h-6 flex items-center justify-between px-2 cursor-move bg-gradient-to-b from-black/60 to-transparent">
                <span className="text-[10px] font-mono text-white/90 pointer-events-none">
                  {handStatus === "ready" ? "● tracking" : handStatus === "loading" ? "starting…" : handStatus === "error" ? "no camera" : ""}
                </span>
                <GripHorizontal size={13} className="text-white/70 pointer-events-none" />
              </div>
              {/* resize grip */}
              <div onPointerDown={startCamResize} title="Drag to resize"
                className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize"
                style={{ background: "linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.7) 50%)" }} />
            </div>
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

              {recentColors.length > 0 && (
                <div className="bg-[var(--ctl)] rounded-xl p-3">
                  <div className="text-[15px] text-[var(--txt-1)] mb-2">Recent</div>
                  <div className="flex flex-wrap gap-2">
                    {recentColors.map((c) => (
                      <button key={c} onClick={() => chooseColor(c)} title={c.toUpperCase()}
                        className="w-9 h-9 rounded-lg transition-all hover:scale-105 active:scale-95"
                        style={{ backgroundColor: c, border: "1px solid rgba(0,0,0,0.1)" }} />
                    ))}
                  </div>
                </div>
              )}

              <div className="bg-[var(--ctl)] rounded-xl p-3">
                <div className="text-[15px] text-[var(--txt-1)] mb-2">Palette</div>
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

              <button onClick={shuffleColors} title="Random background + grid + brush combination"
                className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] transition-all">
                <Dices className="w-4 h-4" />
                Shuffle colors
              </button>

              <ValueSlider label="Dot Size" min={1} max={14}
                value={colorMixed ? 7 : activeRadius}
                display={colorMixed ? "—" : `${activeRadius}`}
                onChange={setActiveRadius} />
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
          {/* Editable project: save / reopen (separate from the image exports below) */}
          <div className="flex gap-2">
            <button onClick={saveProject} title="Download an editable project file"
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-black text-[#a3bfc8] text-[13px] hover:bg-[#1a1a1a] transition-colors">
              <Save size={13} /> Save Project
            </button>
            <button onClick={() => fileInputRef.current?.click()} title="Open a saved project file"
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] transition-colors">
              <FolderOpen size={13} /> Open
            </button>
            <input ref={fileInputRef} type="file" accept="application/json,.json" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) openProjectFile(f); e.target.value = ""; }} />
          </div>

          {/* Image / Text → dots: each opens a modal to tune, preview, then commit */}
          <div className="flex gap-2">
            <button onClick={() => { setImportCell(cellPhysical); setImportOpen(true); }} title="Convert an image into editable dots"
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] transition-colors">
              <ImagePlus size={13} /> Image
            </button>
            <button onClick={() => { setImportCell(cellPhysical); setTextOpen(true); }} title="Convert typed text in any font into dissolving dots"
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] transition-colors">
              <Type size={13} /> Text
            </button>
          </div>
          <div className="flex gap-2">
            <button onClick={() => window.open(`${import.meta.env.BASE_URL}image.html`, "_blank")}
              title="Open the full-screen image tool in a new tab"
              className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl bg-transparent text-[var(--txt-2)] text-[12px] hover:bg-[var(--ctl)] transition-colors">
              <ImagePlus size={12} /> Image tool ↗
            </button>
            <button onClick={() => window.open(`${import.meta.env.BASE_URL}text.html`, "_blank")}
              title="Open the full-screen text tool in a new tab"
              className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl bg-transparent text-[var(--txt-2)] text-[12px] hover:bg-[var(--ctl)] transition-colors">
              <Type size={12} /> Text tool ↗
            </button>
          </div>

          <div className="h-px bg-[var(--ctl)] mx-1" />
          <div className="flex gap-2">
            <button onClick={exportSVG} className="flex-1 flex items-center justify-center gap-1 py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] transition-colors">
              <FileCode2 size={13} /> SVG
            </button>
            <button onClick={exportPNG} className="flex-1 flex items-center justify-center gap-1 py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] transition-colors">
              <FileImage size={13} /> PNG
            </button>
            <button onClick={exportPDF} className="flex-1 flex items-center justify-center gap-1 py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] transition-colors">
              <Printer size={13} /> PDF
            </button>
          </div>
          <button disabled={dots.size === 0}
            onPointerDown={(e) => { e.preventDefault(); startClearHold(); }}
            onPointerUp={cancelClearHold}
            onPointerLeave={cancelClearHold}
            onPointerCancel={cancelClearHold}
            className="relative w-full overflow-hidden flex items-center justify-center gap-1.5 py-2 rounded-xl text-[13px] text-[#f23a3a] hover:bg-[#f23a3a]/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors select-none touch-none">
            <Trash2 size={13} /> {clearProgress > 0 ? "Keep holding to clear…" : "Hold to Clear Canvas"}
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
            className="dotart bg-[var(--card)] text-[var(--txt-1)] rounded-3xl p-5 w-full max-w-[760px] max-h-[90vh] overflow-auto flex flex-col gap-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-[16px] font-medium flex items-center gap-2"><ImagePlus size={16} /> Import Image</h2>
              <button onClick={closeImport}
                className="px-3 py-1.5 rounded-lg bg-[var(--ctl)] text-[13px] hover:bg-[var(--ctl-hover)]">Close</button>
            </div>

            <div className="flex flex-col sm:flex-row gap-4">
              {/* Preview */}
              <div className="flex-1 min-w-0">
                <div className="rounded-2xl bg-[var(--ctl)] p-2 flex items-center justify-center min-h-[260px]"
                  style={{ minHeight: 260 }}>
                  {importImg
                    ? <canvas ref={importPreviewRef} className="max-w-full max-h-[60vh] rounded-lg" />
                    : <span className="text-[13px] text-[var(--txt-3)]">Choose an image to preview</span>}
                </div>
                <button onClick={() => imageInputRef.current?.click()}
                  className="mt-2 w-full py-2.5 rounded-xl bg-[var(--ctl)] text-[13px] hover:bg-[var(--ctl-hover)]">
                  {importImg ? "Choose a different image…" : "Choose image…"}
                </button>
                <input ref={imageInputRef} type="file" accept="image/*" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) openImportFile(f); e.target.value = ""; }} />
              </div>

              {/* Controls */}
              <div className="w-full sm:w-[260px] shrink-0 flex flex-col gap-4">
                <div>
                  <div className="text-[12px] text-[var(--txt-3)] mb-1.5">Style</div>
                  <div className="flex gap-1">
                    {([["color", "Color"], ["mono", "Mono"], ["tonal", "Light & Shadow"]] as const).map(([s, lbl]) => (
                      <button key={s} onClick={() => setTraceStyle(s)}
                        className={`flex-1 py-1.5 px-1 rounded-lg text-[11px] leading-tight transition-colors ${traceStyle === s ? "bg-[var(--solid)] text-white" : "bg-[var(--ctl)] text-[var(--txt-2)] hover:bg-[var(--ctl-hover)]"}`}>
                        {lbl}
                      </button>
                    ))}
                  </div>
                  {traceStyle === "mono" && (
                    <label className="flex items-center gap-2 mt-2 text-[12px] text-[var(--txt-2)]">
                      Dot color
                      <input type="color" value={color} onChange={(e) => { setColor(e.target.value); colorRef.current = e.target.value; }}
                        className="w-8 h-6 rounded cursor-pointer bg-transparent" />
                    </label>
                  )}
                  {traceStyle === "tonal" && (
                    <label className="flex items-center gap-2 mt-2 text-[12px] text-[var(--txt-2)] cursor-pointer">
                      <input type="checkbox" checked={traceTonalColor}
                        onChange={(e) => setTraceTonalColor(e.target.checked)}
                        className="accent-[var(--solid)]" />
                      Use image colors
                    </label>
                  )}
                  <p className="text-[11px] text-[var(--txt-3)] leading-snug mt-1.5">
                    {traceStyle === "color" ? "Each dot uses the image's color."
                      : traceStyle === "mono" ? "All dots one color, uniform size."
                        : traceTonalColor ? "Image-colored dots sized by tone — shadows big, highlights small."
                          : "Gray dots sized by tone — shadows big, highlights small."}
                  </p>
                </div>

                <label className="flex items-center gap-2 text-[12px] text-[var(--txt-2)]">
                  <span className="w-16 shrink-0">Dot size</span>
                  <input type="range" min={2} max={20} step={0.5} value={traceDotSize}
                    onChange={(e) => setTraceDotSize(parseFloat(e.target.value))}
                    className="flex-1 accent-[var(--solid)]" />
                  <span className="w-8 text-right tabular-nums">{traceDotSize}</span>
                </label>

                <label className="flex items-center gap-2 text-[12px] text-[var(--txt-2)]">
                  <span className="w-16 shrink-0">{traceStyle === "tonal" ? "Shadow" : "Density"}</span>
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
                        className={`flex-1 py-1.5 rounded-lg text-[12px] transition-colors ${traceDetail === s ? "bg-[var(--solid)] text-white" : "bg-[var(--ctl)] text-[var(--txt-2)] hover:bg-[var(--ctl-hover)]"}`}>
                        {lbl}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-[var(--txt-3)] leading-snug mt-1.5">
                    {importDims ? `${importDims.cols}×${importDims.rows} cells` : "—"} · {previewDots ? `${previewDots.size} dots` : "—"}. Smaller cell = finer grid.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={closeImport}
                className="px-4 py-2.5 rounded-xl bg-[var(--ctl)] text-[13px] hover:bg-[var(--ctl-hover)]">Cancel</button>
              <button onClick={addImportToCanvas} disabled={!previewDots}
                className="px-5 py-2.5 rounded-xl bg-[var(--solid)] text-white text-[13px] disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90">
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
            className="dotart bg-[var(--card)] text-[var(--txt-1)] rounded-3xl p-5 w-full max-w-[760px] max-h-[90vh] overflow-auto flex flex-col gap-4 shadow-2xl">
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
                        className={`flex-1 py-1.5 px-1 rounded-lg text-[11px] leading-tight transition-colors ${traceStyle === s ? "bg-[var(--solid)] text-white" : "bg-[var(--ctl)] text-[var(--txt-2)] hover:bg-[var(--ctl-hover)]"}`}>
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
                        className={`flex-1 py-1.5 rounded-lg text-[12px] transition-colors ${traceDetail === s ? "bg-[var(--solid)] text-white" : "bg-[var(--ctl)] text-[var(--txt-2)] hover:bg-[var(--ctl-hover)]"}`}>
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
                className="px-5 py-2.5 rounded-xl bg-[var(--solid)] text-white text-[13px] disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90">
                Add to canvas
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
