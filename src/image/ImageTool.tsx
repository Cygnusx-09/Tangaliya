import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { buildDotsFromImage, computeImportDims, type SnapMode } from "@/lib/dots";
import { ImagePlus, Download, Maximize2 } from "lucide-react";

// Standalone full-screen image → dot/halftone converter. Reuses the editor's
// dot-building code (src/lib/dots). Load an image, tune, export a PNG. No grid
// editing here — it's a converter/viewer.
export default function ImageTool() {
  const [img, setImg] = useState<ImageBitmap | null>(null);
  const [style, setStyle] = useState<"color" | "mono" | "tonal">("color");
  const [threshold, setThreshold] = useState(0.5);
  const [dotSize, setDotSize] = useState(8);
  const [tonalColor, setTonalColor] = useState(false);
  const [monoColor, setMonoColor] = useState("#d4ff3f");
  const [bg, setBg] = useState("#0a0a0a");
  const [cells, setCells] = useState(90);           // cells across the long edge
  const [detail, setDetail] = useState<SnapMode>("both");
  const [dragOver, setDragOver] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Virtual canvas: long edge = `cells` cells (cellPhysical=1 → longCells=cells).
  const dims = useMemo(() => (img ? computeImportDims(img.width, img.height, cells, 1) : null), [img, cells]);
  const dots = useMemo(() => (img && dims)
    ? buildDotsFromImage(img, dims.pxW, dims.pxH, { style, threshold, dotRadius: dotSize, snapMode: detail, monoColor, tonalColor })
    : null, [img, dims, style, threshold, dotSize, detail, monoColor, tonalColor]);

  const loadFile = useCallback(async (f: File) => {
    if (!f.type.startsWith("image/")) return;
    try { setImg(await createImageBitmap(f)); } catch { alert("Couldn't read that image."); }
  }, []);

  // Paint the on-screen preview (capped resolution; CSS contains it to the area).
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !dims) return;
    const MAX = 1800;
    const s = Math.min(1, MAX / Math.max(dims.pxW, dims.pxH));
    cv.width = Math.round(dims.pxW * s);
    cv.height = Math.round(dims.pxH * s);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (!dots) return;
    ctx.scale(s, s);
    for (const d of dots.values()) {
      ctx.fillStyle = d.color;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [dots, dims, bg]);

  const downloadPNG = useCallback(() => {
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
    cv.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "dot-image.png"; a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }, [dims, dots, bg]);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  };

  const seg = (active: boolean) =>
    `flex-1 py-1.5 px-1 rounded-lg text-[12px] leading-tight transition-colors ${active ? "bg-[#d4ff3f] text-black" : "bg-white/10 text-white/70 hover:bg-white/20"}`;

  return (
    <div className="h-full w-full flex text-white" style={{ background: "#0a0a0a" }}>
      {/* Preview stage */}
      <div
        className="relative flex-1 flex items-center justify-center p-6 overflow-hidden"
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) loadFile(f); }}
      >
        {img
          ? <canvas ref={canvasRef} className="max-w-full max-h-full rounded-xl shadow-2xl"
              style={{ imageRendering: "auto" }} />
          : (
            <button onClick={() => fileRef.current?.click()}
              className={`flex flex-col items-center gap-3 px-10 py-16 rounded-3xl border-2 border-dashed transition-colors ${dragOver ? "border-[#d4ff3f] bg-[#d4ff3f]/5" : "border-white/20 hover:border-white/40"}`}>
              <ImagePlus size={40} className="text-white/50" />
              <span className="text-[15px] text-white/70">Drop an image, or click to load</span>
            </button>
          )}
        {dragOver && img && (
          <div className="absolute inset-4 rounded-2xl border-2 border-dashed border-[#d4ff3f] bg-[#d4ff3f]/5 pointer-events-none" />
        )}
      </div>

      {/* Control panel */}
      <aside className="w-[300px] shrink-0 h-full overflow-auto bg-white/[0.04] backdrop-blur border-l border-white/10 p-5 flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <h1 className="text-[15px] font-medium">Image → Dots</h1>
          <button onClick={toggleFullscreen} title="Toggle full screen"
            className="p-2 rounded-lg bg-white/10 hover:bg-white/20"><Maximize2 size={14} /></button>
        </div>

        <div className="flex gap-2">
          <button onClick={() => fileRef.current?.click()}
            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-white/10 text-[13px] hover:bg-white/20">
            <ImagePlus size={13} /> {img ? "Change" : "Load image"}
          </button>
          <button onClick={downloadPNG} disabled={!dots} title="Download PNG"
            className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl bg-white/10 text-[13px] hover:bg-white/20 disabled:opacity-40 disabled:cursor-not-allowed">
            <Download size={13} />
          </button>
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); e.target.value = ""; }} />

        <div>
          <div className="text-[12px] text-white/50 mb-1.5">Style</div>
          <div className="flex gap-1">
            {([["color", "Color"], ["mono", "Mono"], ["tonal", "Light & Shadow"]] as const).map(([s, lbl]) => (
              <button key={s} onClick={() => setStyle(s)} className={seg(style === s)}>{lbl}</button>
            ))}
          </div>
          {style === "mono" && (
            <label className="flex items-center gap-2 mt-2 text-[12px] text-white/70">
              Dot color
              <input type="color" value={monoColor} onChange={(e) => setMonoColor(e.target.value)}
                className="w-8 h-6 rounded cursor-pointer bg-transparent" />
            </label>
          )}
          {style === "tonal" && (
            <label className="flex items-center gap-2 mt-2 text-[12px] text-white/70 cursor-pointer">
              <input type="checkbox" checked={tonalColor} onChange={(e) => setTonalColor(e.target.checked)}
                className="accent-[#d4ff3f]" />
              Use image colors
            </label>
          )}
        </div>

        <Slider label="Dot size" min={2} max={20} step={0.5} value={dotSize} onChange={setDotSize} fixed={1} />
        <Slider label={style === "tonal" ? "Shadow" : "Density"} min={0} max={1} step={0.01} value={threshold} onChange={setThreshold} fixed={2} />
        <Slider label="Detail" min={20} max={200} step={2} value={cells} onChange={setCells} suffix=" cells" />

        <div>
          <div className="text-[12px] text-white/50 mb-1.5">Sub-cell fill</div>
          <div className="flex gap-1">
            {([["corner", "Coarse"], ["both", "Fine"]] as const).map(([s, lbl]) => (
              <button key={s} onClick={() => setDetail(s)} className={seg(detail === s)}>{lbl}</button>
            ))}
          </div>
          <p className="text-[11px] text-white/40 mt-1.5">{dots ? `${dots.size} dots` : "—"}</p>
        </div>

        <label className="flex items-center gap-2 text-[12px] text-white/70">
          <span className="w-20 shrink-0">Background</span>
          <input type="color" value={bg} onChange={(e) => setBg(e.target.value)}
            className="w-8 h-6 rounded cursor-pointer bg-transparent" />
        </label>
      </aside>
    </div>
  );
}

function Slider({ label, min, max, step, value, onChange, fixed, suffix }: {
  label: string; min: number; max: number; step: number; value: number;
  onChange: (v: number) => void; fixed?: number; suffix?: string;
}) {
  return (
    <label className="flex items-center gap-2 text-[12px] text-white/70">
      <span className="w-20 shrink-0">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 accent-[#d4ff3f]" />
      <span className="w-14 text-right tabular-nums">{fixed != null ? value.toFixed(fixed) : value}{suffix ?? ""}</span>
    </label>
  );
}
