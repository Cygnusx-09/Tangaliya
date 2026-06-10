import { useState, useRef, useCallback, useEffect } from "react";
import { HexColorPicker } from "react-colorful";
import { Eraser, Pen, Trash2, ZoomIn, ZoomOut, Maximize2, Undo2, Redo2, MousePointer2, FileImage, FileCode2, Printer, Grid3x3, Magnet, Ruler, Plus, Minus, Droplet, PaintBucket, Moon, Sun, Volume2, VolumeX, Hand, GripHorizontal, Menu, SlidersHorizontal } from "lucide-react";
import { sfx, setSfxMuted } from "../sounds";
import { Progress } from "./ui/progress";

type SnapMode = "both" | "corner" | "center";
type Tool = "draw" | "erase" | "select";
type Unit = "mm" | "cm" | "in";

interface Dot {
  key: string;
  x: number;
  y: number;
  color: string;
  radius: number;
}

const CELL_SIZE = 20;
const HALF_CELL = CELL_SIZE / 2;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 20;
const MAX_UNDO = 60;

const PALETTE = [
  "#FF2A2A", "#FF6B35", "#FFCC00", "#29CC74",
  "#00B4D8", "#4361EE", "#9B5DE5", "#F72585",
  "#000000", "#444444", "#999999", "#FFFFFF",
];

// Unit conversion (everything goes through mm internally for conversion)
const TO_MM: Record<Unit, number> = { mm: 1, cm: 10, in: 25.4 };
function convertUnit(value: number, from: Unit, to: Unit): number {
  return (value * TO_MM[from]) / TO_MM[to];
}
function roundForUnit(value: number, unit: Unit): number {
  const decimals = unit === "in" ? 3 : unit === "cm" ? 2 : 1;
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
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

function getKey(halfCol: number, halfRow: number) {
  return `${halfCol},${halfRow}`;
}

function getNearestSnap(
  mx: number, my: number, cellSize: number, snapMode: SnapMode, canvasW: number, canvasH: number
): { key: string; x: number; y: number } | null {
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

function keyFromPosition(x: number, y: number): { key: string; x: number; y: number } {
  const snappedX = Math.round(x / HALF_CELL) * HALF_CELL;
  const snappedY = Math.round(y / HALF_CELL) * HALF_CELL;
  const halfCol = Math.round(snappedX / HALF_CELL);
  const halfRow = Math.round(snappedY / HALF_CELL);
  return { key: getKey(halfCol, halfRow), x: snappedX, y: snappedY };
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

function fmt(value: number, unit: Unit): string {
  if (unit === "in") return `${value.toFixed(2)}"`;
  return `${value % 1 === 0 ? value : value.toFixed(1)}${unit}`;
}

function buildSVGString(
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
): string {
  const wPhys = (canvasPxW / pxPerUnit).toFixed(2);
  const hPhys = (canvasPxH / pxPerUnit).toFixed(2);
  const halfCell = cellSize / 2;
  const cols = Math.round(canvasPxW / cellSize);
  const rows = Math.round(canvasPxH / cellSize);
  const visible = dots.filter((d) => d.x >= -d.radius && d.x <= canvasPxW + d.radius && d.y >= -d.radius && d.y <= canvasPxH + d.radius);

  // Build sub-grid lines (thinner, at half-cell intervals)
  const subGridLines: string[] = [];
  for (let i = 0; i < cols; i++)
    subGridLines.push(`<line x1="${i * cellSize + halfCell}" y1="0" x2="${i * cellSize + halfCell}" y2="${canvasPxH}" stroke="${gridColor}" stroke-opacity="${gridOpacity * 0.4}" stroke-width="${gridThickness * 0.5}"/>`);
  for (let i = 0; i < rows; i++)
    subGridLines.push(`<line x1="0" y1="${i * cellSize + halfCell}" x2="${canvasPxW}" y2="${i * cellSize + halfCell}" stroke="${gridColor}" stroke-opacity="${gridOpacity * 0.4}" stroke-width="${gridThickness * 0.5}"/>`);

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
  ${visible.map((d) => `<circle cx="${d.x}" cy="${d.y}" r="${d.radius}" fill="${d.color}"/>`).join("\n  ")}
</svg>`;
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
  const [dots, setDots] = useState<Map<string, Dot>>(new Map());
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const [color, setColor] = useState("#FF2A2A");
  const [recentColors, setRecentColors] = useState<string[]>([]);
  const [radius, setRadius] = useState(3);
  const [tool, setTool] = useState<Tool>("draw");
  const [snapMode, setSnapMode] = useState<SnapMode>("both");
  const [preview, setPreview] = useState<{ x: number; y: number } | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 800, height: 600 });
  const [canvasBg, setCanvasBg] = useState<string>("#ffffff");
  const [gridColor, setGridColor] = useState("#000000");
  const [gridOpacity, setGridOpacity] = useState(0.07);
  const [gridThickness, setGridThickness] = useState(0.5);

  // ── Universal unit (project-wide) ──
  const [unit, setUnit] = useState<Unit>("mm");
  const [cellPhysical, setCellPhysical] = useState(10);          // value expressed in current `unit`
  const [canvasPhysW, setCanvasPhysW] = useState(200);
  const [canvasPhysH, setCanvasPhysH] = useState(150);
  const [cellInput, setCellInput] = useState("10");
  const [wInput, setWInput] = useState("200");
  const [hInput, setHInput] = useState("150");

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
  const dotsRef = useRef<Map<string, Dot>>(new Map());
  const undoStackRef = useRef<Map<string, Dot>[]>([]);
  const redoStackRef = useRef<Map<string, Dot>[]>([]);
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
    applyViewport(newZoom, { x: px, y: py });
  }, [viewportSize, canvasPxW, canvasPxH, applyViewport]);

  const didInitialFitRef = useRef(false);
  useEffect(() => {
    if (!didInitialFitRef.current && viewportSize.width > 100) {
      fitToViewport();
      didInitialFitRef.current = true;
    }
  }, [viewportSize, fitToViewport]);

  // Snapshot current dots onto the undo stack. Any new action invalidates redo.
  const pushUndo = useCallback(() => {
    const snapshot = new Map(dotsRef.current);
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

  const undo = useCallback(() => {
    if (undoStackRef.current.length === 0) return;
    sfx.undo();
    const newStack = undoStackRef.current.slice(0, -1);
    const restored = new Map(undoStackRef.current[undoStackRef.current.length - 1]);
    redoStackRef.current = [...redoStackRef.current, new Map(dotsRef.current)];
    setRedoCount(redoStackRef.current.length);
    undoStackRef.current = newStack;
    dotsRef.current = restored;
    setDots(restored);
    setUndoCount(newStack.length);
  }, []);

  const redo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;
    sfx.redo();
    const next = new Map(redoStackRef.current[redoStackRef.current.length - 1]);
    undoStackRef.current = [...undoStackRef.current, new Map(dotsRef.current)];
    setUndoCount(undoStackRef.current.length);
    redoStackRef.current = redoStackRef.current.slice(0, -1);
    setRedoCount(redoStackRef.current.length);
    dotsRef.current = next;
    setDots(next);
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
    for (const dot of source) {
      const pos = keyFromPosition(dot.x + dx, dot.y + dy);
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
    for (const key of selectedKeysRef.current) {
      const dot = dotsRef.current.get(key);
      if (!dot) continue;
      const pos = keyFromPosition(dot.x + dx, dot.y + dy);
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

      // Undo / redo are canvas-level — keep them working even when a field has focus.
      if (mod && (e.key === "z" || e.key === "Z")) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); return; }

      // Everything below would clash with editing a text field, so bail while typing.
      if (typing) return;

      if (mod && (e.key === "a" || e.key === "A")) { e.preventDefault(); selectAll(); return; }
      if (mod && (e.key === "c" || e.key === "C")) { e.preventDefault(); copySelected(); return; }
      if (mod && (e.key === "v" || e.key === "V")) { e.preventDefault(); pasteClipboard(); return; }
      if (mod && (e.key === "d" || e.key === "D")) { e.preventDefault(); duplicateSelected(); return; }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedKeysRef.current.size > 0) { e.preventDefault(); deleteSelected(); }
        return;
      }
      if (e.key.startsWith("Arrow") && selectedKeysRef.current.size > 0) {
        e.preventDefault();
        const step = e.shiftKey ? CELL_SIZE : HALF_CELL;
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

  const screenToWorld = (sx: number, sy: number) => ({
    x: (sx - panRef.current.x) / zoomRef.current,
    y: (sy - panRef.current.y) / zoomRef.current,
  });

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
      else next.set(key, { key, x, y, color: colorRef.current, radius: radiusRef.current });
      return next;
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

  const paintStrokeTo = useCallback((wx: number, wy: number) => {
    const spacing = snapModeRef.current === "both" ? HALF_CELL : CELL_SIZE;
    const { w, h } = canvasBoundsRef.current;
    const steps: { key: string; x: number; y: number }[] = [];
    let last = lastPaintRef.current;
    for (let guard = 0; last && guard < 256; guard++) {
      const dx = wx - last.x, dy = wy - last.y;
      const dist = Math.hypot(dx, dy);
      // 45° sector bucketing: a component counts only past cos(67.5°) ≈ 0.3827
      const sx = Math.abs(dx) > dist * 0.3827 ? Math.sign(dx) : 0;
      const sy = Math.abs(dy) > dist * 0.3827 ? Math.sign(dy) : 0;
      if (!sx && !sy) break;
      const stepLen = spacing * Math.hypot(sx, sy);
      if (dist < stepLen * 0.65) break; // hysteresis: hold this bead until the pen commits
      const nx = last.x + sx * spacing, ny = last.y + sy * spacing;
      if (nx < 0 || nx > w || ny < 0 || ny > h) { last = null; break; } // re-seed on re-entry
      const pos = keyFromPosition(nx, ny);
      steps.push(pos);
      last = { x: pos.x, y: pos.y };
    }
    lastPaintRef.current = last;
    if (steps.length === 0) return;
    // One Map copy for the whole walk (applyDrawTool per step would copy per bead).
    setDots((prev) => {
      const next = new Map(prev);
      for (const s of steps) {
        if (toolRef.current === "erase") next.delete(s.key);
        else next.set(s.key, { key: s.key, x: s.x, y: s.y, color: colorRef.current, radius: radiusRef.current });
      }
      return next;
    });
  }, []);

  // ── Touch (finger) navigation: one-finger pan, two-finger pinch-zoom. ──
  // Pen / mouse draw & select; fingers navigate. While a pen is actively
  // drawing, touch points are ignored — palm rejection.
  const touchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gestureRef = useRef<{ dist: number; cx: number; cy: number } | null>(null);
  const penActiveRef = useRef(false);

  const handleTouchNav = useCallback((e: React.PointerEvent, phase: "down" | "move") => {
    const svg = svgRef.current;
    if (!svg) return;
    if (phase === "down") {
      touchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      gestureRef.current = null; // re-seed when a 2nd finger starts moving
      return;
    }
    if (!touchesRef.current.has(e.pointerId)) return;
    const prev = touchesRef.current.get(e.pointerId)!;
    const cur = { x: e.clientX, y: e.clientY };
    touchesRef.current.set(e.pointerId, cur);
    const pts = [...touchesRef.current.values()];
    if (pts.length === 1) {
      // one-finger pan
      const newPan = { x: panRef.current.x + (cur.x - prev.x), y: panRef.current.y + (cur.y - prev.y) };
      panRef.current = newPan; setPan({ ...newPan });
    } else if (pts.length >= 2) {
      // two-finger pinch-zoom (anchored at the centroid) + drag-pan
      const [a, b] = pts;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const g = gestureRef.current;
      if (g && g.dist > 0) {
        const rect = svg.getBoundingClientRect();
        const oldZoom = zoomRef.current;
        const newZoom = Math.min(Math.max(oldZoom * (dist / g.dist), MIN_ZOOM), MAX_ZOOM);
        const ax = cx - rect.left, ay = cy - rect.top;
        const newPan = {
          x: ax - (ax - panRef.current.x) * (newZoom / oldZoom) + (cx - g.cx),
          y: ay - (ay - panRef.current.y) * (newZoom / oldZoom) + (cy - g.cy),
        };
        zoomRef.current = newZoom; panRef.current = newPan;
        setZoom(newZoom); setPan({ ...newPan });
      }
      gestureRef.current = { dist, cx, cy };
    }
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "touch") {
      if (penActiveRef.current) return; // palm rejection while a pen is drawing
      e.preventDefault();
      handleTouchNav(e, "down");
      return;
    }
    // ── pen / mouse: draw, erase, select ──
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
    penActiveRef.current = true;

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

    pushUndo();
    isPaintingRef.current = true;
    const snap = getNearestSnap(world.x, world.y, CELL_SIZE, snapModeRef.current, canvasBoundsRef.current.w, canvasBoundsRef.current.h);
    if (snap) { setPreview({ x: snap.x, y: snap.y }); applyDrawTool(snap.key, snap.x, snap.y); }
    lastPaintRef.current = snap ? { x: snap.x, y: snap.y } : null;
  }, [getSVGPoint, applyDrawTool, pushUndo, pushRecentColor, handleTouchNav]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    // Select-same-color only makes sense in the select tool. Without this
    // gate, two quick pen taps while drawing register as a double-click and
    // surprise-select dots mid-stroke.
    if (toolRef.current !== "select") return;
    if (e.button !== 0) return;
    const world = getSVGPoint(e);
    if (!world) return;
    const hit = findDotAt(dotsRef.current, world.x, world.y);
    if (hit) selectSameColor(hit.color);
  }, [getSVGPoint, selectSameColor]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "touch") {
      if (penActiveRef.current) return;
      handleTouchNav(e, "move");
      return;
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
        const snappedDx = Math.round(rawDx / HALF_CELL) * HALF_CELL;
        const snappedDy = Math.round(rawDy / HALF_CELL) * HALF_CELL;
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
  }, [getSVGPoint, applyDrawTool, paintStrokeTo, handleTouchNav]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "touch") {
      touchesRef.current.delete(e.pointerId);
      if (touchesRef.current.size < 2) gestureRef.current = null;
      return;
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

    isPaintingRef.current = false;
    lastPaintRef.current = null;
  }, []);

  const handlePointerLeave = useCallback(() => {
    setPreview(null);
    isPaintingRef.current = false;
    lastPaintRef.current = null;
    isPanningRef.current = false;
    panStartRef.current = null;
    setIsGrabbing(false);
    setHoveredDotKey(null);
  }, []);

  const handlePointerCancel = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === "touch") {
      touchesRef.current.delete(e.pointerId);
      if (touchesRef.current.size < 2) gestureRef.current = null;
      return;
    }
    penActiveRef.current = false;
    isPaintingRef.current = false;
    lastPaintRef.current = null;
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
          const spacing = snapModeRef.current === "both" ? HALF_CELL : CELL_SIZE;
          const within = !!snap && Math.hypot(world.x - snap.x, world.y - snap.y) <= spacing * GATE_FACTOR;
          positionCursor(sx, sy, within, true);
          if (within && snap) {
            if (snap.key !== lastHandKeyRef.current) {
              lastHandKeyRef.current = snap.key;
              setDots((prev) => {
                const next = new Map(prev);
                next.set(snap.key, { key: snap.key, x: snap.x, y: snap.y, color: colorRef.current, radius: radiusRef.current });
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
    const allDots = Array.from(dots.values());
    const content = buildSVGString(allDots, canvasPxW, canvasPxH, pxPerUnit, unit, canvasBg, gridColor, gridOpacity, gridThickness, CELL_SIZE);
    const blob = new Blob([content], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "dot-art.svg"; a.click();
    URL.revokeObjectURL(url);
  }, [dots, canvasPxW, canvasPxH, pxPerUnit, unit, canvasBg, gridColor, gridOpacity, gridThickness]);

  const exportPNG = useCallback(() => {
    sfx.export();
    const allDots = Array.from(dots.values());
    const content = buildSVGString(allDots, canvasPxW, canvasPxH, pxPerUnit, unit, canvasBg, gridColor, gridOpacity, gridThickness, CELL_SIZE);
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
  }, [dots, canvasPxW, canvasPxH, pxPerUnit, unit, canvasBg, gridColor, gridOpacity, gridThickness]);

  const exportPDF = useCallback(() => {
    sfx.export();
    const allDots = Array.from(dots.values());
    const svgContent = buildSVGString(allDots, canvasPxW, canvasPxH, pxPerUnit, unit, canvasBg, gridColor, gridOpacity, gridThickness, CELL_SIZE);

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
      const pdf = new jsPDF({
        orientation: orientation as "landscape" | "portrait",
        unit: "mm",
        format: [widthMm, heightMm],
      });
      const imgData = canvas.toDataURL("image/png");
      pdf.addImage(imgData, "PNG", 0, 0, widthMm, heightMm);
      pdf.save("dot-art.pdf");
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }, [dots, canvasPxW, canvasPxH, pxPerUnit, unit, canvasBg, gridColor, gridOpacity, gridThickness, canvasPhysW, canvasPhysH]);

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
        cancelClearHold();
        return;
      }
      clearRafRef.current = requestAnimationFrame(tick);
    };
    clearRafRef.current = requestAnimationFrame(tick);
  }, [pushUndo, cancelClearHold]);

  const commitCell = () => {
    const parsed = parseFloat(cellInput);
    if (!isNaN(parsed) && parsed > 0) setCellPhysical(parsed);
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
    setCellPhysical(next);
    setCellInput(String(next));
  };

  const cols = Math.round(canvasPxW / CELL_SIZE);
  const rows = Math.round(canvasPxH / CELL_SIZE);
  const zoomPct = Math.round(zoom * 100);
  const isDragging = isDraggingDotsRef.current;
  const { dx: moveDx, dy: moveDy } = dragOffset;

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
  const ctxTitle = { erase: "Eraser", selection: "Selection", dot: "Dot Color", grid: "Grid", background: "Background" }[rightCtx];
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

  return (
    <div className={`dotart${dark ? " dark" : ""}${theming ? " theming" : ""} flex h-screen w-screen overflow-hidden bg-[var(--app-bg)] text-[var(--app-fg)]`}>

      {/* ── Left panel — tools & controls ── */}
      <aside className={`${compact ? `fixed left-0 top-0 z-50 bg-[var(--app-bg)] shadow-2xl transition-transform duration-300 ${leftOpen ? "translate-x-0" : "-translate-x-full"}` : "relative"} w-[300px] max-w-[88vw] shrink-0 h-screen p-4 flex flex-col gap-4 overflow-hidden`}>

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
        <div className="bg-[var(--card)] rounded-3xl p-4 flex-1 overflow-y-auto flex flex-col gap-5" style={{ scrollbarWidth: "none" }}>

          {/* Tools */}
          <div>
            <div className="grid grid-cols-3 gap-2">
              {([
                { t: "select" as Tool, icon: <MousePointer2 size={22} />, label: "Select (V)" },
                { t: "draw" as Tool, icon: <Pen size={22} />, label: "Draw (B)" },
                { t: "erase" as Tool, icon: <Eraser size={22} />, label: "Erase (E)" },
              ]).map(({ t, icon, label }) => (
                <button key={t} title={label}
                  onClick={() => {
                    setTool(t);
                    if (t === "select") sfx.toolSelect(); else if (t === "draw") sfx.toolDraw(); else sfx.toolErase();
                    if (t === "draw") setInspect("dot");
                    if (t !== "select") { setSelectedKeys(new Set()); selectedKeysRef.current = new Set(); }
                  }}
                  className={`aspect-square rounded-xl flex items-center justify-center transition-all ${
                    tool === t ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
                  }`}>
                  {icon}
                </button>
              ))}
            </div>
            <div className="flex gap-2 mt-2">
              <button onClick={undo} disabled={undoCount === 0} title="Undo (Ctrl+Z)"
                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] disabled:opacity-30 disabled:cursor-not-allowed transition-all">
                <Undo2 size={15} /> Undo
              </button>
              <button onClick={redo} disabled={redoCount === 0} title="Redo (Ctrl+Shift+Z)"
                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] disabled:opacity-30 disabled:cursor-not-allowed transition-all">
                <Redo2 size={15} /> Redo
              </button>
            </div>
          </div>

          {/* Hand Draw (webcam) */}
          <div>
            <div className="text-[14px] text-[var(--txt-2)] tracking-[-0.3px] mb-2">Hand Draw</div>
            <button onClick={toggleHandMode}
              title="Draw with your hand via webcam — hover your index fingertip over a snap point to place a dot"
              className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 transition-all ${
                handMode ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
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

          {/* Units */}
          <div>
            <div className="text-[14px] text-[var(--txt-2)] tracking-[-0.3px] mb-2">Units</div>
            <div className="flex gap-2">
              {(["mm", "cm", "in"] as Unit[]).map((u) => (
                <button key={u} onClick={() => changeUnit(u)}
                  className={`flex-1 py-2 rounded-xl text-[16px] transition-all ${
                    unit === u ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
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
            <div className="flex gap-2">
              {([
                { value: "both" as SnapMode, label: "Both" },
                { value: "corner" as SnapMode, label: "Corner" },
                { value: "center" as SnapMode, label: "Center" },
              ]).map(({ value, label }) => (
                <button key={value} onClick={() => { setSnapMode(value); sfx.ui(); }}
                  className={`flex-1 py-2 rounded-xl text-[13px] transition-all ${
                    snapMode === value ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"
                  }`}>
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
                    className={`flex items-center gap-3 rounded-xl px-3 py-2.5 transition-all ${
                      active ? "bg-[var(--card-active)] ring-2 ring-[var(--solid)]/80" : "bg-[var(--ctl)] hover:bg-[var(--ctl-hover)]"
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

        {/* Export / footer card */}
        <div className="bg-[var(--card)] rounded-3xl p-3 shrink-0 flex flex-col gap-2">
          <div className="flex gap-2">
            <button onClick={exportSVG} className="flex-1 flex items-center justify-center gap-1 py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] transition-colors">
              <FileCode2 size={13} /> SVG
            </button>
            <button onClick={exportPNG} className="flex-1 flex items-center justify-center gap-1 py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] transition-colors">
              <FileImage size={13} /> PNG
            </button>
            <button onClick={exportPDF} className="flex-1 flex items-center justify-center gap-1 py-2.5 rounded-xl bg-[#f23a3a] text-white text-[13px] hover:bg-[#d92f2f] transition-colors">
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
          <div className="flex items-center justify-between px-1 pt-0.5 text-[12px] text-[var(--txt-3)]">
            <span>{dots.size} dot{dots.size !== 1 ? "s" : ""}</span>
            <span className="font-mono">{Math.round(zoom * 100)}%</span>
          </div>
        </div>

      </aside>

      {/* ── Canvas ── */}
      <div ref={containerRef} className="flex-1 relative overflow-hidden">
        <svg ref={svgRef} width={viewportSize.width} height={viewportSize.height}
          className="absolute inset-0 select-none" style={{ cursor, touchAction: "none" }}
          onPointerDown={handlePointerDown} onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp} onPointerLeave={handlePointerLeave}
          onPointerCancel={handlePointerCancel}
          onDoubleClick={handleDoubleClick}>

          <rect width={viewportSize.width} height={viewportSize.height} style={{ fill: "var(--viewport)" }} />

          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
            <rect x={6 / zoom} y={8 / zoom} width={canvasPxW} height={canvasPxH} fill="#000" opacity={0.12} />
            <rect x={0} y={0} width={canvasPxW} height={canvasPxH} fill={canvasBg} />

            {/* Sub-grid: thinner lines at half-cell intervals (2×2 per cell) */}
            {Array.from({ length: cols }, (_, i) => (
              <line key={`sv${i}`} x1={i * CELL_SIZE + HALF_CELL} y1={0} x2={i * CELL_SIZE + HALF_CELL} y2={canvasPxH}
                stroke={gridColor} strokeOpacity={gridOpacity * 0.4} strokeWidth={(gridThickness * 0.5) / zoom} />
            ))}
            {Array.from({ length: rows }, (_, i) => (
              <line key={`sh${i}`} x1={0} y1={i * CELL_SIZE + HALF_CELL} x2={canvasPxW} y2={i * CELL_SIZE + HALF_CELL}
                stroke={gridColor} strokeOpacity={gridOpacity * 0.4} strokeWidth={(gridThickness * 0.5) / zoom} />
            ))}

            {/* Main grid lines */}
            {Array.from({ length: cols + 1 }, (_, i) => (
              <line key={`v${i}`} x1={i * CELL_SIZE} y1={0} x2={i * CELL_SIZE} y2={canvasPxH}
                stroke={gridColor} strokeOpacity={gridOpacity} strokeWidth={gridThickness / zoom} />
            ))}
            {Array.from({ length: rows + 1 }, (_, i) => (
              <line key={`h${i}`} x1={0} y1={i * CELL_SIZE} x2={canvasPxW} y2={i * CELL_SIZE}
                stroke={gridColor} strokeOpacity={gridOpacity} strokeWidth={gridThickness / zoom} />
            ))}

            <rect x={0} y={0} width={canvasPxW} height={canvasPxH} fill="none"
              stroke="#999" strokeWidth={1 / zoom} />

            {Array.from(dots.values()).map((dot) => {
              const isSelected = selectedKeys.has(dot.key);
              const isDraggingThis = isDragging && isSelected;
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
                  {hoveredDotKey === dot.key && !isSelected && (
                    <circle cx={dot.x} cy={dot.y} r={dot.radius + 4 / zoom}
                      fill="none" stroke={selectionRingColor} strokeWidth={1 / zoom} opacity={0.5}
                      style={{ pointerEvents: "none" }} />
                  )}
                  <circle cx={cx} cy={cy} r={dot.radius} fill={dot.color}
                    opacity={isDraggingThis ? 0.7 : 1} />
                </g>
              );
            })}

            {preview && tool === "draw" && (
              <circle cx={preview.x} cy={preview.y} r={radius} fill={color} opacity={0.4} style={{ pointerEvents: "none" }} />
            )}
            {preview && tool === "erase" && (
              <circle cx={preview.x} cy={preview.y} r={Math.max(radius, 4)} fill="none"
                stroke="#ef4444" strokeWidth={1.5 / zoom} strokeDasharray={`${3 / zoom},${2 / zoom}`}
                style={{ pointerEvents: "none" }} />
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

        {/* Status pill (bottom-left) */}
        <div className="absolute bottom-4 left-4 flex items-center gap-2 text-[11px] text-[var(--overlay-fg)] pointer-events-none bg-[var(--overlay)]/80 backdrop-blur-sm rounded-lg px-3 py-1.5 border border-[var(--overlay-border)]/60 shadow-sm">
          <Ruler size={11} className="text-[var(--overlay-fg-muted)]" />
          <span className="font-mono">{fmt(canvasPhysW, unit)} × {fmt(canvasPhysH, unit)}</span>
          <span className="text-[var(--overlay-fg-muted)]">·</span>
          <span className="font-mono text-[var(--overlay-fg-muted)]">{cols}×{rows}</span>
          <span className="text-[var(--overlay-fg-muted)]">·</span>
          <span className="text-[var(--overlay-fg)]">{dots.size} dot{dots.size !== 1 ? "s" : ""}</span>
        </div>

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

        {/* Compact: floating buttons to reveal the tool / properties panels.
            Pen draws · one finger pans · two fingers pinch-zoom. */}
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
      <aside className={`${compact ? `fixed right-0 top-0 z-50 bg-[var(--app-bg)] shadow-2xl transition-transform duration-300 ${rightOpen ? "translate-x-0" : "translate-x-full"}` : "relative"} w-[300px] max-w-[88vw] shrink-0 h-screen p-4 flex flex-col gap-4 overflow-hidden`}>
        <div className="bg-[var(--card)] rounded-3xl p-4 flex-1 overflow-y-auto flex flex-col gap-4" style={{ scrollbarWidth: "none" }}>

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

              <ValueSlider label="Dot Size" min={1} max={14}
                value={colorMixed ? 7 : activeRadius}
                display={colorMixed ? "—" : `${activeRadius}`}
                onChange={setActiveRadius} />
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
                      className={`rounded-xl h-16 flex items-end justify-start p-2 transition-all ${
                        canvasBg.toLowerCase() === hex ? "ring-2 ring-[var(--solid)]/80" : ""
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
                  style={{ width: Math.max(radius * 4, 16), height: Math.max(radius * 4, 16) }} />
              </div>
              <ValueSlider label="Radius" min={1} max={14}
                value={radius} display={`${radius}`}
                onChange={setRadius} />
              <p className="text-[13px] text-[var(--txt-3)] leading-relaxed px-1">
                Click or drag across the canvas to remove dots within the radius.
              </p>
            </>
          )}

        </div>
      </aside>

      {/* Scrim behind an open panel — tap to dismiss (compact only) */}
      {compact && (leftOpen || rightOpen) && (
        <div className="fixed inset-0 z-40 bg-black/30"
          onClick={() => { setLeftOpen(false); setRightOpen(false); }} />
      )}
    </div>
  );
}
