import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { buildDotsFromImage, computeImportDims, type SnapMode, type Dot } from "@/lib/dots";
import { ImagePlus, Download, Maximize2, Moon, Sun } from "lucide-react";

// Standalone full-screen image → dot/halftone converter. Reuses the editor's
// dot-building code (src/lib/dots) and its .dotart chrome palette. Load an image,
// tune, pan/zoom to inspect, export PNG or (vector) SVG. No grid editing here.
export default function ImageTool() {
  const [img, setImg] = useState<ImageBitmap | null>(null);
  const [style, setStyle] = useState<"color" | "mono" | "tonal">("color");
  const [threshold, setThreshold] = useState(0.5);
  const [dotSize, setDotSize] = useState(8);
  const [tonalColor, setTonalColor] = useState(false);
  const [monoColor, setMonoColor] = useState("#ff2a2a");
  const [bg, setBg] = useState("#0a0a0a");
  const [cells, setCells] = useState(90);           // cells across the long edge
  const [detail, setDetail] = useState<SnapMode>("both");
  const [dragOver, setDragOver] = useState(false);

  const [dark, setDark] = useState<boolean>(() => {
    try { return localStorage.getItem("tangaliya-theme") === "dark"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("tangaliya-theme", dark ? "dark" : "light"); } catch { /* ignore */ }
  }, [dark]);

  const fileRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Virtual canvas: long edge = `cells` cells (cellPhysical=1 → longCells=cells).
  const dims = useMemo(() => (img ? computeImportDims(img.width, img.height, cells, 1) : null), [img, cells]);
  const dots = useMemo(() => (img && dims)
    ? buildDotsFromImage(img, dims.pxW, dims.pxH, { style, threshold, dotRadius: dotSize, snapMode: detail, monoColor, tonalColor })
    : null, [img, dims, style, threshold, dotSize, detail, monoColor, tonalColor]);

  // View transform for the preview: user zoom on top of the fit, + pan (screen px).
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });
  const fitRef = useRef(1);                          // px→screen fit factor, set each paint
  const panRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const resetView = useCallback(() => setView({ scale: 1, tx: 0, ty: 0 }), []);

  const loadFile = useCallback(async (f: File) => {
    if (!f.type.startsWith("image/")) return;
    try { setImg(await createImageBitmap(f)); resetView(); }
    catch { alert("Couldn't read that image."); }
  }, [resetView]);

  // Paint the preview (device-pixel sized to the stage; dots drawn under the
  // fit×zoom transform so they stay crisp at any zoom).
  useEffect(() => {
    const cv = canvasRef.current, stage = stageRef.current;
    if (!cv || !stage) return;
    const paint = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = stage.clientWidth, H = stage.clientHeight;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cv.style.width = `${W}px`; cv.style.height = `${H}px`;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (!dims) return;
      const fit = Math.min((W - 48) / dims.pxW, (H - 48) / dims.pxH);
      fitRef.current = fit;
      const eff = fit * view.scale;
      ctx.save();
      ctx.translate(W / 2 + view.tx, H / 2 + view.ty);
      ctx.scale(eff, eff);
      ctx.translate(-dims.pxW / 2, -dims.pxH / 2);
      // artwork background rect (user bg), then dots
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, dims.pxW, dims.pxH);
      if (dots) for (const d of dots.values()) {
        ctx.fillStyle = d.color;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.radius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    };
    paint();
    const ro = new ResizeObserver(paint);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [dots, dims, bg, view]);

  // Wheel zoom, anchored so the point under the cursor stays put.
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!dims) return;
    e.preventDefault();
    const stage = stageRef.current!;
    const rect = stage.getBoundingClientRect();
    const mx = e.clientX - rect.left - rect.width / 2;
    const my = e.clientY - rect.top - rect.height / 2;
    setView((v) => {
      const next = Math.min(12, Math.max(0.2, v.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      const eff = fitRef.current * v.scale;
      const eff2 = fitRef.current * next;
      return {
        scale: next,
        tx: mx - ((mx - v.tx) / eff) * eff2,
        ty: my - ((my - v.ty) / eff) * eff2,
      };
    });
  }, [dims]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!dims) return;
    panRef.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = panRef.current;
    if (!p) return;
    setView((v) => ({ ...v, tx: p.tx + (e.clientX - p.x), ty: p.ty + (e.clientY - p.y) }));
  };
  const endPan = () => { panRef.current = null; };

  const downloadBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  };

  const exportPNG = useCallback(() => {
    if (!dims || !dots) return;
    const cv = document.createElement("canvas");
    cv.width = dims.pxW; cv.height = dims.pxH;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = bg; ctx.fillRect(0, 0, cv.width, cv.height);
    for (const d of dots.values()) {
      ctx.fillStyle = d.color;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    cv.toBlob((b) => b && downloadBlob(b, "dot-image.png"), "image/png");
  }, [dims, dots, bg]);

  const exportSVG = useCallback(() => {
    if (!dims || !dots) return;
    const r2 = (n: number) => +n.toFixed(2);
    let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${dims.pxW}" height="${dims.pxH}" viewBox="0 0 ${dims.pxW} ${dims.pxH}">`;
    s += `<rect width="${dims.pxW}" height="${dims.pxH}" fill="${bg}"/>`;
    for (const d of dots.values() as IterableIterator<Dot>)
      s += `<circle cx="${r2(d.x)}" cy="${r2(d.y)}" r="${r2(d.radius)}" fill="${d.color}"/>`;
    s += `</svg>`;
    downloadBlob(new Blob([s], { type: "image/svg+xml" }), "dot-image.svg");
  }, [dims, dots, bg]);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  };

  const seg = (active: boolean) =>
    `flex-1 py-2 px-1 rounded-xl text-[12px] leading-tight transition-all ${active
      ? "bg-[var(--solid)] text-[var(--solid-fg)]"
      : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"}`;
  const iconBtn = "w-9 h-9 rounded-xl flex items-center justify-center bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)] transition-all";

  return (
    <div className={`dotart${dark ? " dark" : ""} flex h-dvh w-screen overflow-hidden bg-[var(--app-bg)] text-[var(--app-fg)]`}>
      {/* Preview stage */}
      <div
        ref={stageRef}
        className="relative flex-1 h-dvh overflow-hidden"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onDoubleClick={resetView}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) loadFile(f); }}
        style={{ touchAction: "none", cursor: img ? (panRef.current ? "grabbing" : "grab") : "default" }}
      >
        <canvas ref={canvasRef} className="absolute inset-0" />
        {!img && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <button onClick={() => fileRef.current?.click()}
              className={`flex flex-col items-center gap-3 px-10 py-16 rounded-3xl border-2 border-dashed transition-colors ${dragOver
                ? "border-[var(--solid)] bg-[var(--card)]"
                : "border-[var(--overlay-border)] hover:border-[var(--txt-3)]"}`}>
              <ImagePlus size={40} className="text-[var(--txt-3)]" />
              <span className="text-[15px] text-[var(--txt-2)]">Drop an image, or click to load</span>
            </button>
          </div>
        )}
        {dragOver && img && (
          <div className="absolute inset-4 rounded-2xl border-2 border-dashed border-[var(--solid)] pointer-events-none" />
        )}
        {img && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-[var(--card)] text-[var(--txt-2)] text-[11px] shadow-lg pointer-events-none select-none">
            {Math.round(view.scale * 100)}% · scroll to zoom · drag to pan · double-click to fit
          </div>
        )}
      </div>

      {/* Control column — editor chrome */}
      <aside className="w-[300px] max-w-[88vw] shrink-0 h-dvh p-4 flex flex-col gap-4 overflow-hidden">
        {/* Header pill */}
        <div className="bg-[var(--card)] rounded-3xl px-5 py-3.5 flex items-center gap-3 shrink-0">
          <svg width="30" height="30" viewBox="0 0 39 39" className="shrink-0" aria-label="morii logo">
            {[[18.5, 3.5], [3.5, 18.5], [18.5, 18.5], [34.5, 18.5], [18.5, 34.5]].map(([cx, cy]) => (
              <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={3.5} fill="#FF2A2A" />
            ))}
          </svg>
          <span className="text-[19px] font-bold tracking-[-0.6px] text-[var(--brand)] leading-none">Image → Dots</span>
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <button onClick={() => setDark((d) => !d)} title={dark ? "Light mode" : "Dark mode"} className={iconBtn}>
              {dark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button onClick={toggleFullscreen} title="Full screen" className={iconBtn}>
              <Maximize2 size={15} />
            </button>
          </div>
        </div>

        {/* Controls card */}
        <div className="bg-[var(--card)] rounded-3xl p-4 flex-1 overflow-y-auto flex flex-col gap-5 [&>*]:shrink-0" style={{ scrollbarWidth: "none" }}>
          {/* Load / export */}
          <div className="flex flex-col gap-2">
            <button onClick={() => fileRef.current?.click()}
              className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[var(--solid)] text-[var(--solid-fg)] text-[13px] hover:opacity-90 transition-opacity">
              <ImagePlus size={14} /> {img ? "Change image" : "Load image"}
            </button>
            <div className="flex gap-2">
              <button onClick={exportPNG} disabled={!dots}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                <Download size={13} /> PNG
              </button>
              <button onClick={exportSVG} disabled={!dots}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                <Download size={13} /> SVG
              </button>
            </div>
          </div>
          <input ref={fileRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ""; }} />

          {/* Style */}
          <div>
            <div className="text-[12px] text-[var(--txt-2)] mb-1.5">Style</div>
            <div className="flex gap-1.5">
              {([["color", "Color"], ["mono", "Mono"], ["tonal", "Light & Shadow"]] as const).map(([s, lbl]) => (
                <button key={s} onClick={() => setStyle(s)} className={seg(style === s)}>{lbl}</button>
              ))}
            </div>
            {style === "mono" && (
              <ColorRow label="Dot color" value={monoColor} onChange={setMonoColor} className="mt-2" />
            )}
            {style === "tonal" && (
              <label className="flex items-center gap-2 mt-2 text-[12px] text-[var(--txt-1)] cursor-pointer">
                <input type="checkbox" checked={tonalColor} onChange={(e) => setTonalColor(e.target.checked)}
                  className="accent-[var(--solid)]" />
                Use image colors
              </label>
            )}
          </div>

          <Slider label="Dot size" min={2} max={20} step={0.5} value={dotSize} onChange={setDotSize} fixed={1} />
          <Slider label={style === "tonal" ? "Shadow" : "Density"} min={0} max={1} step={0.01} value={threshold} onChange={setThreshold} fixed={2} />
          <Slider label="Detail" min={20} max={200} step={2} value={cells} onChange={setCells} suffix=" cells" />

          {/* Sub-cell fill */}
          <div>
            <div className="text-[12px] text-[var(--txt-2)] mb-1.5">Sub-cell fill</div>
            <div className="flex gap-1.5">
              {([["corner", "Coarse"], ["both", "Fine"]] as const).map(([s, lbl]) => (
                <button key={s} onClick={() => setDetail(s)} className={seg(detail === s)}>{lbl}</button>
              ))}
            </div>
            <p className="text-[11px] text-[var(--txt-3)] mt-1.5">{dots ? `${dots.size} dots` : "—"}</p>
          </div>

          <ColorRow label="Background" value={bg} onChange={setBg} />
        </div>
      </aside>
    </div>
  );
}

// Editor-style track-pill slider (label left, value right, whole-row scrub).
function Slider({ label, min, max, step, value, onChange, fixed, suffix }: {
  label: string; min: number; max: number; step: number; value: number;
  onChange: (v: number) => void; fixed?: number; suffix?: string;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef(false);
  const frac = Math.min(1, Math.max(0, (value - min) / (max - min)));
  const TL = 92, TR = 52;
  const quantize = (raw: number) => {
    const stepped = min + Math.round((raw - min) / step) * step;
    const decimals = (String(step).split(".")[1] ?? "").length;
    return Math.min(max, Math.max(min, Number(stepped.toFixed(decimals))));
  };
  const scrub = (clientX: number) => {
    const row = rowRef.current;
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const trackW = rect.width - TL - TR;
    onChange(quantize(min + ((clientX - rect.left - TL) / trackW) * (max - min)));
  };
  return (
    <div
      ref={rowRef}
      onPointerDown={(e) => { if (e.pointerType === "mouse" && e.button !== 0) return; e.preventDefault(); dragRef.current = true; rowRef.current?.setPointerCapture(e.pointerId); scrub(e.clientX); }}
      onPointerMove={(e) => { if (dragRef.current) scrub(e.clientX); }}
      onPointerUp={() => { dragRef.current = false; }}
      onPointerCancel={() => { dragRef.current = false; }}
      className="relative flex items-center h-11 rounded-[12px] bg-[var(--track)] select-none touch-none cursor-pointer"
    >
      <div className="absolute inset-y-0 left-0 rounded-[12px] bg-[var(--track-fill)] pointer-events-none"
        style={{ width: `calc(${TL}px + ${frac} * (100% - ${TL}px - ${TR}px))` }} />
      <span className="relative z-10 pl-[10px] text-[12px] text-[var(--txt-1)] tracking-[-0.25px] pointer-events-none whitespace-nowrap">{label}</span>
      <div className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-[2px] h-[17px] rounded-[12px] bg-[var(--txt-1)] pointer-events-none"
        style={{ left: `calc(${TL}px + ${frac} * (100% - ${TL}px - ${TR}px))` }} />
      <span className="absolute right-3 z-10 text-[15px] leading-none text-[var(--txt-1)] tracking-[-0.4px] tabular-nums pointer-events-none">
        {fixed != null ? value.toFixed(fixed) : value}{suffix ?? ""}
      </span>
    </div>
  );
}

function ColorRow({ label, value, onChange, className = "" }: {
  label: string; value: string; onChange: (v: string) => void; className?: string;
}) {
  return (
    <label className={`flex items-center gap-2 text-[12px] text-[var(--txt-1)] ${className}`}>
      <span className="flex-1">{label}</span>
      <span className="relative w-8 h-8 rounded-lg overflow-hidden border border-[var(--overlay-border)]" style={{ background: value }}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
      </span>
    </label>
  );
}
