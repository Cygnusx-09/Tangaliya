import { useState, useRef, useCallback, useEffect } from "react";
import { Eraser, Pen, Trash2, ZoomIn, ZoomOut, Maximize2, Undo2, Redo2, MousePointer2, FileImage, FileCode2, Printer, Grid3x3, Magnet, Ruler } from "lucide-react";

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

// ── Stable subcomponents (defined OUTSIDE DotArtTool so React doesn't remount
//    them on every parent render — otherwise inputs lose focus mid-type) ──

const Card: React.FC<{ icon: React.ReactNode; title: string; children: React.ReactNode; trailing?: React.ReactNode }> = ({ icon, title, children, trailing }) => (
  <section className="rounded-xl border border-neutral-200/80 bg-white">
    <header className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5">
      <div className="flex items-center gap-1.5 text-neutral-700">
        <span className="text-neutral-400">{icon}</span>
        <span className="text-[10px] uppercase tracking-[0.14em] font-medium">{title}</span>
      </div>
      {trailing}
    </header>
    <div className="px-3 pb-3">{children}</div>
  </section>
);

const UnitInput: React.FC<{
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  unit: Unit;
  min?: string;
}> = ({ value, onChange, onCommit, unit, min = "0.01" }) => (
  <div className="relative flex-1 min-w-0">
    <input
      type="number"
      min={min}
      step="any"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit();
          (e.target as HTMLInputElement).blur();
        }
      }}
      className="w-full pl-2.5 pr-8 py-1.5 rounded-md border border-neutral-200 text-[12px] text-neutral-800 bg-neutral-50 focus:outline-none focus:border-neutral-900 focus:bg-white focus:ring-2 focus:ring-neutral-900/5 transition-all"
    />
    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-neutral-400 font-mono uppercase pointer-events-none">{unit}</span>
  </div>
);

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
  const [canvasBg, setCanvasBg] = useState<"white" | "black">("white");
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

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isGrabbing, setIsGrabbing] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);

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
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const mod = e.ctrlKey || e.metaKey;

      if (mod && (e.key === "z" || e.key === "Z")) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); return; }
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
      if (e.key === "v" || e.key === "V") { setTool("select"); }
      if (e.key === "b" || e.key === "B") { setTool("draw"); }
      if (e.key === "e" || e.key === "E") { setTool("erase"); }
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

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && spaceDownRef.current)) {
      e.preventDefault();
      isPanningRef.current = true;
      panStartRef.current = { mx: e.clientX, my: e.clientY, px: panRef.current.x, py: panRef.current.y };
      setIsGrabbing(true);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();

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
  }, [getSVGPoint, applyDrawTool, pushUndo, pushRecentColor]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const world = getSVGPoint(e);
    if (!world) return;
    const hit = findDotAt(dotsRef.current, world.x, world.y);
    if (hit) selectSameColor(hit.color);
  }, [getSVGPoint, selectSameColor]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
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
    if (snap) {
      setPreview({ x: snap.x, y: snap.y });
      if (isPaintingRef.current) applyDrawTool(snap.key, snap.x, snap.y);
    }
  }, [getSVGPoint, applyDrawTool]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
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
  }, []);

  const handleMouseLeave = useCallback(() => {
    setPreview(null);
    isPaintingRef.current = false;
    isPanningRef.current = false;
    panStartRef.current = null;
    setIsGrabbing(false);
    setHoveredDotKey(null);
  }, []);

  const zoomTo = useCallback((newZoom: number) => {
    const cx = viewportSize.width / 2; const cy = viewportSize.height / 2;
    const clamped = Math.min(Math.max(newZoom, MIN_ZOOM), MAX_ZOOM);
    applyViewport(clamped, { x: cx - (cx - panRef.current.x) * (clamped / zoomRef.current), y: cy - (cy - panRef.current.y) * (clamped / zoomRef.current) });
  }, [viewportSize, applyViewport]);

  const exportSVG = useCallback(() => {
    const allDots = Array.from(dots.values());
    const content = buildSVGString(allDots, canvasPxW, canvasPxH, pxPerUnit, unit, canvasBg, gridColor, gridOpacity, gridThickness, CELL_SIZE);
    const blob = new Blob([content], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "dot-art.svg"; a.click();
    URL.revokeObjectURL(url);
  }, [dots, canvasPxW, canvasPxH, pxPerUnit, unit, canvasBg, gridColor, gridOpacity, gridThickness]);

  const exportPNG = useCallback(() => {
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

  const selectionRingColor = canvasBg === "white" ? "#4361EE" : "#FFD700";

  const selectedDots = Array.from(selectedKeys).map((k) => dots.get(k)).filter(Boolean) as Dot[];
  const selColors = [...new Set(selectedDots.map((d) => d.color))];
  const selRadii = [...new Set(selectedDots.map((d) => d.radius))];
  const selColor = selColors.length === 1 ? selColors[0] : color;
  const selRadius = selRadii.length === 1 ? selRadii[0] : radius;
  const selMixed = selColors.length > 1 || selRadii.length > 1;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#e8e8e8]">

      {/* ── Left panel ── */}
      <aside className="w-[216px] bg-white border-r border-neutral-200 flex flex-col h-screen overflow-hidden shrink-0">

        <div className="px-5 py-4 border-b border-neutral-200 shrink-0">
          <span className="text-[11px] font-bold tracking-[0.22em] uppercase text-neutral-400">Dot Art</span>
        </div>

        <div className="px-4 py-4 border-b border-neutral-200 shrink-0">
          <div className="text-[9px] font-semibold tracking-[0.2em] uppercase text-neutral-400 mb-3">Tools</div>
          <div className="flex flex-col gap-0.5 mb-3">
            {([
              { t: "draw" as Tool, icon: <Pen size={13} />, label: "Draw", shortcut: "B" },
              { t: "erase" as Tool, icon: <Eraser size={13} />, label: "Erase", shortcut: "E" },
              { t: "select" as Tool, icon: <MousePointer2 size={13} />, label: "Select", shortcut: "V" },
            ]).map(({ t, icon, label, shortcut }) => (
              <button key={t}
                onClick={() => { setTool(t); if (t !== "select") { setSelectedKeys(new Set()); selectedKeysRef.current = new Set(); } }}
                title={`${label} (${shortcut})`}
                className={`flex items-center gap-2.5 px-3 py-2.5 text-[12px] font-medium transition-all ${
                  tool === t ? "bg-black text-white" : "text-neutral-600 hover:bg-neutral-100"
                }`}>
                {icon}<span>{label}</span>
                <span className={`ml-auto text-[10px] font-mono ${tool === t ? "text-white/40" : "text-neutral-300"}`}>{shortcut}</span>
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            <button onClick={undo} disabled={undoCount === 0} title="Undo (Ctrl+Z)"
              className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-25 disabled:cursor-not-allowed transition-all">
              <Undo2 size={12} /><span>Undo</span>
            </button>
            <button onClick={redo} disabled={redoCount === 0} title="Redo (Ctrl+Shift+Z)"
              className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 disabled:opacity-25 disabled:cursor-not-allowed transition-all">
              <Redo2 size={12} /><span>Redo</span>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "none" }}>
          {(tool === "draw" || (tool === "select" && selectedKeys.size > 0)) && (
            <div className="px-4 py-4">
              <div className="text-[9px] font-semibold tracking-[0.2em] uppercase text-neutral-400 mb-3">
                {tool === "select" ? "Edit" : "Brush"}
              </div>
              <div className="grid grid-cols-6 gap-2 mb-3">
                {PALETTE.map((c) => {
                  const isActive = tool === "select" ? (selColor === c && !selMixed) : color === c;
                  return (
                    <button key={c}
                      onClick={() => chooseColor(c)}
                      className="aspect-square transition-all hover:scale-110 active:scale-95"
                      style={{ backgroundColor: c, outline: isActive ? "2.5px solid #111" : "2px solid transparent", outlineOffset: "2px", border: c === "#FFFFFF" ? "1px solid #ddd" : "none" }} />
                  );
                })}
              </div>
              {recentColors.length > 0 && (
                <div className="mb-3">
                  <div className="text-[9px] font-semibold tracking-[0.2em] uppercase text-neutral-400 mb-1.5">Recent</div>
                  <div className="flex gap-1.5">
                    {recentColors.map((c) => (
                      <button key={c} onClick={() => chooseColor(c)} title={c.toUpperCase()}
                        className="w-5 h-5 transition-all hover:scale-110 active:scale-95"
                        style={{ backgroundColor: c, border: c.toLowerCase() === "#ffffff" ? "1px solid #ddd" : "none" }} />
                    ))}
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2.5 mb-4">
                <input type="color"
                  value={tool === "select" ? selColor : color}
                  onChange={(e) => tool === "select" ? updateSelectedDots({ color: e.target.value }) : setColor(e.target.value)}
                  onBlur={(e) => pushRecentColor(e.target.value)}
                  className="w-8 h-8 cursor-pointer border border-neutral-200 p-0.5 shrink-0" />
                <span className="text-[11px] text-neutral-400 font-mono uppercase">
                  {tool === "select" && selMixed ? "mixed" : (tool === "select" ? selColor : color)}
                </span>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[9px] font-semibold tracking-[0.2em] uppercase text-neutral-400">Size</span>
                  <span className="text-[11px] text-neutral-600 font-mono">
                    {tool === "select" ? (selMixed ? "mixed" : `${selRadius}px`) : `${radius}px`}
                  </span>
                </div>
                <input type="range" min={1} max={14}
                  value={tool === "select" ? (selMixed ? 7 : selRadius) : radius}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    tool === "select" ? updateSelectedDots({ radius: v }) : setRadius(v);
                  }}
                  className="w-full accent-neutral-800" />
              </div>
            </div>
          )}

          {tool === "erase" && (
            <div className="px-4 py-4">
              <div className="text-[9px] font-semibold tracking-[0.2em] uppercase text-neutral-400 mb-3">Eraser</div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[9px] font-semibold tracking-[0.2em] uppercase text-neutral-400">Radius</span>
                  <span className="text-[11px] text-neutral-600 font-mono">{radius}px</span>
                </div>
                <input type="range" min={1} max={14} value={radius}
                  onChange={(e) => setRadius(Number(e.target.value))}
                  className="w-full accent-neutral-800" />
              </div>
            </div>
          )}

          {tool === "select" && selectedKeys.size === 0 && (
            <div className="px-4 py-4">
              <div className="text-[9px] font-semibold tracking-[0.2em] uppercase text-neutral-400 mb-3">Select</div>
              <p className="text-[11px] text-neutral-400 leading-relaxed">
                Click a dot · Shift+click to add · Drag to marquee · Double-click to select same color · Ctrl+A all · Esc to deselect
              </p>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-neutral-200 shrink-0 flex items-center justify-between">
          <span className="text-[10px] text-neutral-400">{dots.size} dot{dots.size !== 1 ? "s" : ""}</span>
          <span className="text-[10px] text-neutral-400 font-mono">{Math.round(zoom * 100)}%</span>
        </div>

      </aside>

      {/* ── Canvas ── */}
      <div ref={containerRef} className="flex-1 relative overflow-hidden">
        <svg ref={svgRef} width={viewportSize.width} height={viewportSize.height}
          className="absolute inset-0 select-none" style={{ cursor }}
          onMouseMove={handleMouseMove} onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp} onMouseLeave={handleMouseLeave}
          onDoubleClick={handleDoubleClick}>

          <rect width={viewportSize.width} height={viewportSize.height} fill="#e8e8ea" />

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
        <div className="absolute bottom-4 left-4 flex items-center gap-2 text-[11px] text-neutral-600 pointer-events-none bg-white/80 backdrop-blur-sm rounded-lg px-3 py-1.5 border border-neutral-200/60 shadow-sm">
          <Ruler size={11} className="text-neutral-400" />
          <span className="font-mono">{fmt(canvasPhysW, unit)} × {fmt(canvasPhysH, unit)}</span>
          <span className="text-neutral-300">·</span>
          <span className="font-mono text-neutral-400">{cols}×{rows}</span>
          <span className="text-neutral-300">·</span>
          <span className="text-neutral-500">{dots.size} dot{dots.size !== 1 ? "s" : ""}</span>
        </div>

        {/* Zoom cluster (bottom-right) */}
        <div className="absolute bottom-4 right-4 flex items-center gap-0.5 bg-white border border-neutral-200 rounded-lg shadow-sm px-1 py-1">
          <button onClick={() => zoomTo(zoom / 1.3)} className="w-7 h-7 flex items-center justify-center rounded hover:bg-neutral-100 text-neutral-500 transition-colors"><ZoomOut size={13} /></button>
          <button onClick={fitToViewport} className="px-2 h-7 flex items-center justify-center rounded hover:bg-neutral-100 text-neutral-700 transition-colors font-mono" style={{ fontSize: "11px", minWidth: "44px" }}>{zoomPct}%</button>
          <button onClick={() => zoomTo(zoom * 1.3)} className="w-7 h-7 flex items-center justify-center rounded hover:bg-neutral-100 text-neutral-500 transition-colors"><ZoomIn size={13} /></button>
          <div className="w-px h-4 bg-neutral-200 mx-0.5" />
          <button onClick={fitToViewport} title="Fit to view" className="w-7 h-7 flex items-center justify-center rounded hover:bg-neutral-100 text-neutral-400 transition-colors"><Maximize2 size={12} /></button>
        </div>

        <div className="absolute top-4 left-4 text-[11px] text-neutral-400 pointer-events-none">
          Scroll zoom · Space+drag pan · B/E/V tools · Alt+click eyedropper · Ctrl+C/V copy · Ctrl+D dup · ⌫ delete · Arrows nudge
        </div>
      </div>

      {/* ── Right panel ── */}
      <aside className="w-[232px] bg-white border-l border-neutral-200 flex flex-col h-screen overflow-hidden shrink-0">

        <div className="px-5 py-4 border-b border-neutral-200 shrink-0">
          <div className="text-[9px] font-semibold tracking-[0.2em] uppercase text-neutral-400 mb-3">Canvas</div>
          <div className="flex items-center gap-2 mb-2.5">
            <UnitInput value={wInput} onChange={setWInput} onCommit={commitW} unit={unit} />
            <span className="text-neutral-300 text-xs shrink-0">×</span>
            <UnitInput value={hInput} onChange={setHInput} onCommit={commitH} unit={unit} />
          </div>
          <div className="flex gap-1 mb-3">
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
                  className="flex-1 py-1.5 text-[10px] font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 transition-all">
                  {p.label}
                </button>
              );
            })}
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <div className="text-[9px] font-semibold tracking-[0.2em] uppercase text-neutral-400 mb-1.5">Cell</div>
              <UnitInput value={cellInput} onChange={setCellInput} onCommit={commitCell} unit={unit} />
            </div>
            <div className="flex-1">
              <div className="text-[9px] font-semibold tracking-[0.2em] uppercase text-neutral-400 mb-1.5">Units</div>
              <div className="flex bg-neutral-100 p-0.5">
                {(["mm", "cm", "in"] as Unit[]).map((u) => (
                  <button key={u} onClick={() => changeUnit(u)}
                    className={`flex-1 py-1 text-[11px] font-mono transition-all ${
                      unit === u ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-700"
                    }`}>
                    {u}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5" style={{ scrollbarWidth: "none" }}>{/* settings */}

          <div>
            <div className="flex items-center gap-1.5 text-[9px] font-semibold tracking-[0.2em] uppercase text-neutral-400 mb-2.5">
              <Magnet size={9} /><span>Snap to</span>
            </div>
            <div className="flex gap-1">
              {([
                { value: "both" as SnapMode, label: "All 9" },
                { value: "corner" as SnapMode, label: "Corners" },
                { value: "center" as SnapMode, label: "Centers" },
              ]).map(({ value, label }) => (
                <button key={value} onClick={() => setSnapMode(value)}
                  className={`flex-1 py-2 text-[10px] font-medium transition-all ${
                    snapMode === value ? "bg-black text-white" : "text-neutral-500 hover:bg-neutral-100"
                  }`}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[9px] font-semibold tracking-[0.2em] uppercase text-neutral-400 mb-2.5">Background</div>
            <div className="flex gap-1">
              {(["white", "black"] as const).map((bg) => (
                <button key={bg}
                  onClick={() => { setCanvasBg(bg); setGridColor(bg === "black" ? "#ffffff" : "#000000"); }}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 text-[11px] font-medium transition-all ${
                    canvasBg === bg ? "bg-black text-white" : "text-neutral-500 hover:bg-neutral-100"
                  }`}>
                  <span className="w-3 h-3 border border-neutral-300 shrink-0 inline-block" style={{ backgroundColor: bg }} />
                  {bg.charAt(0).toUpperCase() + bg.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center gap-1.5 text-[9px] font-semibold tracking-[0.2em] uppercase text-neutral-400 mb-2.5">
              <Grid3x3 size={9} /><span>Grid</span>
            </div>
            <div className="flex items-center gap-2.5 mb-3">
              <input type="color" value={gridColor} onChange={(e) => setGridColor(e.target.value)}
                className="w-7 h-7 cursor-pointer border border-neutral-200 p-0.5 shrink-0" />
              <span className="text-[10px] text-neutral-400 font-mono uppercase">{gridColor}</span>
            </div>
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-neutral-400 w-11 shrink-0">Opacity</span>
                <input type="range" min={0} max={1} step={0.01} value={gridOpacity}
                  onChange={(e) => setGridOpacity(Number(e.target.value))} className="flex-1 accent-neutral-800" />
                <span className="text-[10px] text-neutral-500 font-mono w-7 text-right shrink-0">{Math.round(gridOpacity * 100)}%</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-neutral-400 w-11 shrink-0">Width</span>
                <input type="range" min={0.25} max={4} step={0.25} value={gridThickness}
                  onChange={(e) => setGridThickness(Number(e.target.value))} className="flex-1 accent-neutral-800" />
                <span className="text-[10px] text-neutral-500 font-mono w-7 text-right shrink-0">{gridThickness}px</span>
              </div>
            </div>
          </div>

        </div>

        <div className="px-4 py-3 bg-black shrink-0">
          <div className="flex gap-1.5 mb-2">
            <button onClick={exportSVG}
              className="flex-1 flex items-center justify-center gap-1 py-2.5 bg-white/10 text-white text-[11px] font-medium hover:bg-white/20 transition-colors">
              <FileCode2 size={11} /> SVG
            </button>
            <button onClick={exportPNG}
              className="flex-1 flex items-center justify-center gap-1 py-2.5 bg-white/10 text-white text-[11px] font-medium hover:bg-white/20 transition-colors">
              <FileImage size={11} /> PNG
            </button>
            <button onClick={exportPDF}
              className="flex-1 flex items-center justify-center gap-1 py-2.5 bg-blue-500/25 text-blue-300 text-[11px] font-medium hover:bg-blue-500/40 transition-colors">
              <Printer size={11} /> PDF
            </button>
          </div>
          {confirmingClear ? (
            <div className="flex gap-1.5">
              <button onClick={() => { pushUndo(); setDots(new Map()); setSelectedKeys(new Set()); selectedKeysRef.current = new Set(); setConfirmingClear(false); }}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-medium bg-red-500 text-white hover:bg-red-600 transition-colors">
                <Trash2 size={11} /> Clear
              </button>
              <button onClick={() => setConfirmingClear(false)}
                className="flex-1 flex items-center justify-center py-2 text-[11px] font-medium text-white/70 hover:text-white hover:bg-white/10 transition-colors">
                Cancel
              </button>
            </div>
          ) : (
            <button onClick={() => setConfirmingClear(true)} disabled={dots.size === 0}
              className="w-full flex items-center justify-center gap-1.5 py-2 text-[11px] text-red-400 hover:bg-red-500/10 disabled:opacity-25 disabled:cursor-not-allowed transition-colors">
              <Trash2 size={11} /> Clear Canvas
            </button>
          )}
        </div>

      </aside>
    </div>
  );
}
