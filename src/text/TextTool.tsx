import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { buildDotsFromText, computeImportDims, renderTextCanvas, type SnapMode } from "@/lib/dots";
import { Type, Download, Maximize2, Upload } from "lucide-react";

// Standalone full-screen text → dissolving dot-halftone converter. Type text in
// any uploaded font; reuses the shared dot code (src/lib/dots). Export a PNG.
export default function TextTool() {
  const [text, setText] = useState("Prompt them.\nStack them.\nShare them.");
  const [fontFamily, setFontFamily] = useState<string | null>(null);
  const [fontName, setFontName] = useState("");
  const [style, setStyle] = useState<"color" | "mono" | "tonal">("color");
  const [threshold, setThreshold] = useState(0.5);
  const [dotSize, setDotSize] = useState(8);
  const [scatter, setScatter] = useState(0.35);
  const [textColor, setTextColor] = useState("#d4ff3f");
  const [monoColor, setMonoColor] = useState("#d4ff3f");
  const [bg, setBg] = useState("#0a0a0a");
  const [cells, setCells] = useState(110);          // cells across the long edge
  const [detail, setDetail] = useState<SnapMode>("both");
  const [hoverRadius, setHoverRadius] = useState(120);  // cursor influence radius (dot-space px)
  const [hoverGlow, setHoverGlow] = useState(0.8);      // swell + brighten near cursor
  const [hoverWave, setHoverWave] = useState(7);        // ripple amplitude (dot-space px)

  const fontRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sRef = useRef(1);                                 // preview scale (dot-space → canvas px)
  const rafRef = useRef(0);
  const paintRef = useRef<() => void>(() => {});
  // Live cursor influence: position in dot-space + an eased presence (0..1).
  const hoverRef = useRef({ x: 0, y: 0, active: false, strength: 0 });

  const textCanvas = useMemo(() => renderTextCanvas(text, fontFamily), [text, fontFamily]);
  const dims = useMemo(() => (textCanvas ? computeImportDims(textCanvas.width, textCanvas.height, cells, 1) : null), [textCanvas, cells]);
  const dots = useMemo(() => (textCanvas && dims)
    ? buildDotsFromText(textCanvas, dims.pxW, dims.pxH, { style, threshold, dotRadius: dotSize, snapMode: detail, textColor, monoColor, scatter })
    : null, [textCanvas, dims, style, threshold, dotSize, detail, textColor, monoColor, scatter]);

  // Load an uploaded font locally (no network).
  const loadFontFile = useCallback(async (f: File) => {
    try {
      const buf = await f.arrayBuffer();
      const family = `DotFont-${Date.now()}`;
      const face = new FontFace(family, buf);
      await face.load();
      (document as Document & { fonts: FontFaceSet }).fonts.add(face);
      setFontFamily(family);
      setFontName(f.name.replace(/\.[^.]+$/, ""));
    } catch {
      alert("Couldn't load that font file.");
    }
  }, []);

  // Paint one frame. Near the cursor, dots swell + brighten (glow) and an
  // animated ripple flows outward through them (wave). Both fade with distance
  // and with the eased hover presence, so it feels organic and springs back.
  const paint = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv || !dims) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (!dots) return;
    ctx.scale(sRef.current, sRef.current);

    const h = hoverRef.current;
    const R = hoverRadius;
    const on = h.strength > 0.001 && R > 0;
    const t = performance.now() / 1000;
    const WAVELEN = 30, SPEED = 4.5;          // ripple spacing + flow speed
    for (const d of dots.values()) {
      let x = d.x, y = d.y, r = d.radius, color = d.color;
      if (on) {
        const dx = d.x - h.x, dy = d.y - h.y;
        const dist = Math.hypot(dx, dy);
        if (dist < R) {
          let f = 1 - dist / R;
          f = f * f * (3 - 2 * f);            // smoothstep falloff
          const e = f * h.strength;           // eased influence at this dot
          // Wave: ripple displacement outward from the cursor.
          const ripple = Math.sin(dist / WAVELEN - t * SPEED) * hoverWave * e;
          const inv = dist > 0.0001 ? 1 / dist : 0;
          x += dx * inv * ripple;
          y += dy * inv * ripple;
          // Glow: swell + brighten toward white.
          r = d.radius * (1 + e * hoverGlow);
          color = lighten(d.color, e * hoverGlow * 0.85);
        }
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [dots, dims, bg, hoverRadius, hoverGlow, hoverWave]);

  useEffect(() => { paintRef.current = paint; }, [paint]);

  // Size the canvas when the dot dimensions change (capped resolution).
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !dims) return;
    const MAX = 1800;
    const s = Math.min(1, MAX / Math.max(dims.pxW, dims.pxH));
    sRef.current = s;
    cv.width = Math.round(dims.pxW * s);
    cv.height = Math.round(dims.pxH * s);
  }, [dims]);

  // Static repaint on any change when not mid-interaction.
  useEffect(() => {
    const h = hoverRef.current;
    if (!h.active && h.strength < 0.002) paint();
  }, [paint]);

  // Animation loop: ease the hover presence toward 0/1 and repaint until settled.
  const tick = useCallback(() => {
    const h = hoverRef.current;
    h.strength += ((h.active ? 1 : 0) - h.strength) * 0.2;
    paintRef.current();
    if (h.active || h.strength > 0.002) {
      rafRef.current = requestAnimationFrame(tick);
    } else {
      h.strength = 0;
      rafRef.current = 0;
      paintRef.current();
    }
  }, []);

  const onHoverMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current;
    if (!cv || !dims) return;
    const rect = cv.getBoundingClientRect();
    const h = hoverRef.current;
    h.x = ((e.clientX - rect.left) / rect.width) * dims.pxW;
    h.y = ((e.clientY - rect.top) / rect.height) * dims.pxH;
    h.active = true;
    if (!rafRef.current) rafRef.current = requestAnimationFrame(tick);
  }, [dims, tick]);

  const onHoverLeave = useCallback(() => {
    hoverRef.current.active = false;
    if (!rafRef.current) rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

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
      a.href = url; a.download = "dot-text.png"; a.click();
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
      <div className="relative flex-1 flex items-center justify-center p-6 overflow-hidden">
        {dots
          ? <canvas ref={canvasRef} onPointerMove={onHoverMove} onPointerLeave={onHoverLeave}
              className="max-w-full max-h-full rounded-xl shadow-2xl" style={{ touchAction: "none" }} />
          : <span className="text-[15px] text-white/40">Type something to preview</span>}
      </div>

      {/* Control panel */}
      <aside className="w-[300px] shrink-0 h-full overflow-auto bg-white/[0.04] backdrop-blur border-l border-white/10 p-5 flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <h1 className="text-[15px] font-medium flex items-center gap-2"><Type size={15} /> Text → Dots</h1>
          <button onClick={toggleFullscreen} title="Toggle full screen"
            className="p-2 rounded-lg bg-white/10 hover:bg-white/20"><Maximize2 size={14} /></button>
        </div>

        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3}
          placeholder="Type text… (Enter for a new line)"
          className="w-full p-3 rounded-xl bg-white/10 text-white text-[14px] resize-none outline-none placeholder:text-white/40" />

        <div className="flex gap-2">
          <button onClick={() => fontRef.current?.click()}
            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-white/10 text-[13px] hover:bg-white/20 truncate">
            <Upload size={13} /> {fontName ? fontName : "Upload font"}
          </button>
          <button onClick={downloadPNG} disabled={!dots} title="Download PNG"
            className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl bg-white/10 text-[13px] hover:bg-white/20 disabled:opacity-40 disabled:cursor-not-allowed">
            <Download size={13} />
          </button>
        </div>
        <input ref={fontRef} type="file" accept=".ttf,.otf,.woff,.woff2,font/*" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFontFile(f); e.target.value = ""; }} />

        <div>
          <div className="text-[12px] text-white/50 mb-1.5">Style</div>
          <div className="flex gap-1">
            {([["color", "Color"], ["mono", "Mono"], ["tonal", "Light & Shadow"]] as const).map(([s, lbl]) => (
              <button key={s} onClick={() => setStyle(s)} className={seg(style === s)}>{lbl}</button>
            ))}
          </div>
          {style !== "tonal" && (
            <label className="flex items-center gap-2 mt-2 text-[12px] text-white/70">
              {style === "mono" ? "Dot color" : "Text color"}
              <input type="color" value={style === "mono" ? monoColor : textColor}
                onChange={(e) => style === "mono" ? setMonoColor(e.target.value) : setTextColor(e.target.value)}
                className="w-8 h-6 rounded cursor-pointer bg-transparent" />
            </label>
          )}
        </div>

        <Slider label="Dot size" min={2} max={20} step={0.5} value={dotSize} onChange={setDotSize} fixed={1} />
        <Slider label="Scatter" min={0} max={1} step={0.01} value={scatter} onChange={setScatter} fixed={2} />
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

        <div className="flex flex-col gap-2">
          <div className="text-[12px] text-white/50 mb-0.5">Hover (glow + wave)</div>
          <Slider label="Radius" min={0} max={300} step={2} value={hoverRadius} onChange={setHoverRadius} />
          <Slider label="Glow" min={0} max={2} step={0.05} value={hoverGlow} onChange={setHoverGlow} fixed={2} />
          <Slider label="Wave" min={0} max={24} step={0.5} value={hoverWave} onChange={setHoverWave} fixed={1} />
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

// Mix a #rrggbb color toward white by t (0..1) → the glow brighten.
function lighten(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const m = (c: number) => Math.round(c + (255 - c) * t);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
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
