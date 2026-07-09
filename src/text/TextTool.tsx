import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { buildDotsFromText, computeImportDims, renderTextCanvas, hash01, type SnapMode, type Dot } from "@/lib/dots";
import { noise2, curl2, backOut } from "@/lib/anim";
import { Download, Maximize2, Upload, Moon, Sun, Play, Pause, RotateCcw, Repeat, Video, Square, Save, FolderOpen, Film, Dices } from "lucide-react";
import { buildZip } from "@/lib/zip";

// Re-editable project file: every setting the artwork derives from, plus the
// uploaded font embedded as base64 so a saved file reopens identical anywhere.
// (View/transport state — phase, playing, recording — is deliberately excluded.)
const PROJECT_VERSION = 1;
const AUTOSAVE_KEY = "tangaliya-text-autosave";
type TextProject = {
  version: number;
  text: string; style: "color" | "mono" | "tonal"; threshold: number; dotSize: number; scatter: number;
  drift: number; driftAngle: number;
  textColor: string; monoColor: string; bg: string; transparent: boolean;
  cells: number; detail: SnapMode;
  hoverRadius: number; hoverGlow: number; hoverWave: number;
  duration: number; loop: boolean; breathe: number; turb: number; wave: number; wavelen: number;
  twinkle: number; twMin: number; twMax: number; twSpeed: number; speed: number; noiseScale: number;
  seed: number; flowSpeed: number; flowAngle: number; noisePhase: number;
  fontName?: string; fontData?: string;
};
function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// Standalone full-screen text → dissolving dot-halftone converter. Type text in
// any uploaded font; reuses the shared dot code (src/lib/dots) and the editor's
// .dotart chrome. Hover the preview for a live glow + ripple. Export PNG or SVG.
export default function TextTool() {
  const [text, setText] = useState("Morii");
  const [fontFamily, setFontFamily] = useState<string | null>(null);
  const [fontName, setFontName] = useState("");
  const [style, setStyle] = useState<"color" | "mono" | "tonal">("color");
  const [threshold, setThreshold] = useState(0.5);
  const [dotSize, setDotSize] = useState(8);
  const [scatter, setScatter] = useState(0.35);
  const [drift, setDrift] = useState(0);                // directional smear amount (0..1)
  const [driftAngle, setDriftAngle] = useState(135);    // smear direction (deg, 135 = down-left)
  const [textColor, setTextColor] = useState("#ff2a2a");
  const [monoColor, setMonoColor] = useState("#ff2a2a");
  const [bg, setBg] = useState("#0a0a0a");
  const [transparent, setTransparent] = useState(false);
  const [cells, setCells] = useState(110);          // cells across the long edge
  const [detail, setDetail] = useState<SnapMode>("both");
  const [hoverRadius, setHoverRadius] = useState(120);  // cursor influence radius (dot-space px)
  const [hoverGlow, setHoverGlow] = useState(0.8);      // swell + brighten near cursor
  const [hoverWave, setHoverWave] = useState(7);        // ripple amplitude (dot-space px)

  // Noise animation: a Reveal transport (dots pop in/out in clumpy noise order)
  // + stackable ambient layers (breathe / turbulence / wave) over the home dots.
  const [duration, setDuration] = useState(2.4);        // seconds for a full reveal
  const [loop, setLoop] = useState(false);              // ping-pong the reveal
  const [phase, setPhase] = useState(1);                // 0=hidden, 1=full text (UI mirror of revealRef.phase)
  const [playing, setPlaying] = useState(false);        // transport UI state
  const [breathe, setBreathe] = useState(0.3);          // dot-size swell amount (0..1)
  const [turb, setTurb] = useState(0);                  // curl-noise drift amplitude (px)
  const [wave, setWave] = useState(0);                  // traveling wave amplitude (px)
  const [wavelen, setWavelen] = useState(40);           // wave spacing (px)
  const [twinkle, setTwinkle] = useState(0);            // starfield sparkle amount (0..1)
  const [twMin, setTwMin] = useState(1);                // twinkle size range (× base radius):
  const [twMax, setTwMax] = useState(2.5);              // rest size … spike-peak size
  const [twSpeed, setTwSpeed] = useState(1);            // twinkle-only clock multiplier
  const [speed, setSpeed] = useState(1);                // shared time multiplier
  const [noiseScale, setNoiseScale] = useState(0.012);  // shared noise spatial frequency
  const [seed, setSeed] = useState(0);                  // re-rolls the whole noise pattern
  const [flowSpeed, setFlowSpeed] = useState(0.6);      // field drift rate (0 = frozen)
  const [flowAngle, setFlowAngle] = useState(325);      // field drift direction (deg)
  const [noisePhase, setNoisePhase] = useState(0);      // manual field scrub

  const [dark, setDark] = useState<boolean>(() => {
    try { return localStorage.getItem("tangaliya-theme") === "dark"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("tangaliya-theme", dark ? "dark" : "light"); } catch { /* ignore */ }
  }, [dark]);

  const fontRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sRef = useRef(1);                                 // preview scale (dot-space → canvas px)
  const rafRef = useRef(0);
  const paintRef = useRef<() => void>(() => {});
  // Live cursor influence: position in dot-space + an eased presence (0..1).
  const hoverRef = useRef({ x: 0, y: 0, active: false, strength: 0 });

  // Lock the on-screen canvas box: sized by the TEXT's aspect (continuous) fit
  // into the measured stage — never by the quantized grid dims, so scrubbing
  // Detail can't move or resize the canvas.
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => {
      const r = es[0].contentRect;
      setStage({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const textCanvas = useMemo(() => renderTextCanvas(text, fontFamily), [text, fontFamily]);
  const disp = useMemo(() => {
    if (!textCanvas || !stage.w || !stage.h) return null;
    const k = Math.min(stage.w / textCanvas.width, stage.h / textCanvas.height);
    return { w: textCanvas.width * k, h: textCanvas.height * k };
  }, [textCanvas, stage]);
  const dims = useMemo(() => (textCanvas ? computeImportDims(textCanvas.width, textCanvas.height, cells, 1) : null), [textCanvas, cells]);
  const dots = useMemo(() => (textCanvas && dims)
    ? buildDotsFromText(textCanvas, dims.pxW, dims.pxH, { style, threshold, dotRadius: dotSize, snapMode: detail, textColor, monoColor, scatter, drift, driftAngle })
    : null, [textCanvas, dims, style, threshold, dotSize, detail, textColor, monoColor, scatter, drift, driftAngle]);

  // Reveal playback state lives in a ref (rAF-driven, avoids stale closures);
  // config is mirrored so the loop reads live values without re-subscribing.
  // `ambient` keeps the loop alive while any always-on layer is audible.
  const revealRef = useRef({ phase: 1, playing: false, dir: 1 });
  const timeRef = useRef(0);                              // shared animation clock (s × speed)
  const cfgRef = useRef({ duration, loop, speed, ambient: breathe > 0 || turb > 0 || wave > 0 || twinkle > 0 });
  useEffect(() => { cfgRef.current = { duration, loop, speed, ambient: breathe > 0 || turb > 0 || wave > 0 || twinkle > 0 }; },
    [duration, loop, speed, breathe, turb, wave, twinkle]);

  // Load a font from raw bytes (upload or project file). Keeps the base64 in a
  // ref (encoded once) so save/autosave can embed it without re-encoding.
  const fontDataRef = useRef<string | null>(null);
  const loadFontBuffer = useCallback(async (buf: ArrayBuffer, name: string) => {
    const family = `DotFont-${Date.now()}`;
    const face = new FontFace(family, buf);
    await face.load();
    (document as Document & { fonts: FontFaceSet }).fonts.add(face);
    fontDataRef.current = bufToB64(buf);
    setFontFamily(family);
    setFontName(name);
  }, []);

  // Load an uploaded font locally (no network).
  const loadFontFile = useCallback(async (f: File) => {
    try {
      await loadFontBuffer(await f.arrayBuffer(), f.name.replace(/\.[^.]+$/, ""));
    } catch {
      alert("Couldn't load that font file.");
    }
  }, [loadFontBuffer]);

  const buildProject = (): TextProject => ({
    version: PROJECT_VERSION,
    text, style, threshold, dotSize, scatter, drift, driftAngle, textColor, monoColor, bg, transparent,
    cells, detail, hoverRadius, hoverGlow, hoverWave,
    duration, loop, breathe, turb, wave, wavelen, twinkle, twMin, twMax, twSpeed, speed, noiseScale,
    seed, flowSpeed, flowAngle, noisePhase,
    fontName: fontName || undefined,
    fontData: fontDataRef.current ?? undefined,
  });

  // Apply a parsed project: each field validated individually so a partial or
  // future-version file restores what it can instead of failing whole.
  const applyProject = useCallback((p: Partial<TextProject>) => {
    if (!p || typeof p !== "object" || typeof p.text !== "string") throw new Error("not a text project");
    const num = (v: unknown, set: (n: number) => void) => { if (typeof v === "number" && isFinite(v)) set(v); };
    const str = (v: unknown, set: (s: string) => void) => { if (typeof v === "string") set(v); };
    const bool = (v: unknown, set: (b: boolean) => void) => { if (typeof v === "boolean") set(v); };
    setText(p.text);
    if (p.style === "color" || p.style === "mono" || p.style === "tonal") setStyle(p.style);
    if (p.detail === "corner" || p.detail === "both") setDetail(p.detail);
    num(p.threshold, setThreshold); num(p.dotSize, setDotSize); num(p.scatter, setScatter);
    num(p.drift, setDrift); num(p.driftAngle, setDriftAngle); num(p.twinkle, setTwinkle);
    num(p.twMin, setTwMin); num(p.twMax, setTwMax); num(p.twSpeed, setTwSpeed);
    num(p.seed, setSeed); num(p.flowSpeed, setFlowSpeed); num(p.flowAngle, setFlowAngle); num(p.noisePhase, setNoisePhase);
    str(p.textColor, setTextColor); str(p.monoColor, setMonoColor); str(p.bg, setBg);
    bool(p.transparent, setTransparent);
    num(p.cells, setCells);
    num(p.hoverRadius, setHoverRadius); num(p.hoverGlow, setHoverGlow); num(p.hoverWave, setHoverWave);
    num(p.duration, setDuration); bool(p.loop, setLoop);
    num(p.breathe, setBreathe); num(p.turb, setTurb); num(p.wave, setWave); num(p.wavelen, setWavelen);
    num(p.speed, setSpeed); num(p.noiseScale, setNoiseScale);
    if (typeof p.fontData === "string" && p.fontData)
      loadFontBuffer(b64ToBuf(p.fontData), typeof p.fontName === "string" ? p.fontName : "font").catch(() => {});
  }, [loadFontBuffer]);

  // Restore the last session once at mount, then autosave (debounced) on any change.
  const applyRef = useRef(applyProject);
  useEffect(() => { applyRef.current = applyProject; }, [applyProject]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (raw) applyRef.current(JSON.parse(raw));
    } catch { /* ignore a corrupt autosave */ }
  }, []);
  useEffect(() => {
    const id = setTimeout(() => {
      try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(buildProject())); } catch { /* quota */ }
    }, 400);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, style, threshold, dotSize, scatter, drift, driftAngle, textColor, monoColor, bg, transparent, cells, detail,
    hoverRadius, hoverGlow, hoverWave, duration, loop, breathe, turb, wave, wavelen, twinkle, twMin, twMax, twSpeed, speed, noiseScale,
    seed, flowSpeed, flowAngle, noisePhase, fontName]);

  // Paint one frame. Near the cursor, dots swell + brighten (glow) and an
  // animated ripple flows outward through them (wave). Both fade with distance
  // and with the eased hover presence, so it feels organic and springs back.
  const paint = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv || !dims) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (transparent) {
      ctx.clearRect(0, 0, cv.width, cv.height);
    } else {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, cv.width, cv.height);
    }
    ctx.scale(sRef.current, sRef.current);

    const h = hoverRef.current;
    const R = hoverRadius;
    const on = h.strength > 0.001 && R > 0;
    const t = performance.now() / 1000;
    const WAVELEN = 30, SPEED = 4.5;          // ripple spacing + flow speed
    // Draw one dot from its base (pre-hover) position, applying the cursor
    // glow + ripple on top of whatever base the current mode produced.
    const draw = (bx: number, by: number, br: number, bcolor: string) => {
      let x = bx, y = by, r = br, color = bcolor;
      if (on) {
        const dx = bx - h.x, dy = by - h.y;
        const dist = Math.hypot(dx, dy);
        if (dist < R) {
          let f = 1 - dist / R;
          f = f * f * (3 - 2 * f);            // smoothstep falloff
          const e = f * h.strength;           // eased influence at this dot
          const ripple = Math.sin(dist / WAVELEN - t * SPEED) * hoverWave * e;
          const inv = dist > 0.0001 ? 1 / dist : 0;
          x += dx * inv * ripple;
          y += dy * inv * ripple;
          r = br * (1 + e * hoverGlow);
          color = lighten(bcolor, e * hoverGlow * 0.85);
        }
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    };

    if (dots) {
      const P = revealRef.current.phase;
      const T = timeRef.current;
      const ns = noiseScale;
      // Field offsets, once per frame: seed relocates the pattern, flow drifts
      // it (angle × rate × clock, plus the manual phase scrub).
      const sx = seed * 137.31, sy = seed * 91.17;
      const fl = noisePhase + T * flowSpeed;
      const fa = (flowAngle * Math.PI) / 180;
      const fx = Math.cos(fa) * fl + sx, fy = Math.sin(fa) * fl + sy;
      for (const d of dots.values()) {
        let x = d.x, y = d.y, r = d.radius, col = d.color;
        // Reveal: each dot's birth order = clumpy noise + a dash of per-dot
        // sparkle; it pops in with an overshoot as the phase sweeps past it.
        // Seed-shifted but NOT flow-shifted (birth order must hold mid-reveal).
        if (P < 1) {
          const birth = 0.8 * noise2(d.x * ns + sx, d.y * ns + sy) + 0.2 * hash01(d.x + seed * 13, d.y - seed * 7);
          const p = (P - birth * 0.82) / 0.18;
          if (p <= 0) continue;
          if (p < 1) r *= backOut(p);
        }
        // Breathe: slow-drifting noise swells/shrinks dot size in patches.
        if (breathe > 0) r = Math.max(0, r * (1 + (noise2(d.x * ns + fx, d.y * ns + fy) - 0.5) * 2 * breathe));
        // Turbulence: curl-noise drift (divergence-free — swirls, never bunches).
        // Half the flow rate + a constant offset so it doesn't move in lockstep
        // with breathe.
        if (turb > 0) {
          const [u, v] = curl2(d.x * ns + fx * 0.5 + 31.7, d.y * ns + fy * 0.5 - 12.9);
          x += u * turb; y += v * turb;
        }
        // Wave: a directional pulse rolling left→right through the word.
        if (wave > 0) y += Math.sin(x / wavelen - T * 3) * wave;
        // Twinkle: hash-picked dots spike once per cycle, each on its own random
        // phase/rate — a starfield sparkle. Size swings twMin×…twMax× the base
        // radius (rest…peak); color stays constant, size-only by design.
        if (twinkle > 0) {
          const h1 = hash01(d.x * 7.13 + seed * 13.7, d.y * 3.71 - seed * 7.9);
          if (h1 < 0.15 + 0.45 * twinkle) {
            const h2 = hash01(d.y * 5.77 + seed * 5.3, d.x * 9.31 - seed * 3.1);
            const p = (T * twSpeed * (0.35 + 0.4 * h2) + 17 * h2) % 1;
            const e = Math.pow(Math.max(0, Math.sin(Math.PI * p)), 6);
            r *= twMin + (twMax - twMin) * e;
          }
        }
        draw(x, y, r, col);
      }
    }
  }, [dots, dims, bg, transparent, hoverRadius, hoverGlow, hoverWave, breathe, turb, wave, wavelen, twinkle, twMin, twMax, twSpeed, noiseScale, seed, flowSpeed, flowAngle, noisePhase]);

  useEffect(() => { paintRef.current = paint; }, [paint]);

  // Size the canvas when the dot dimensions change. Always normalize the long
  // edge to MAX (up- or down-scaling) so the canvas size doesn't follow Detail.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !dims) return;
    const MAX = 1800;
    const s = MAX / Math.max(dims.pxW, dims.pxH);
    sRef.current = s;
    cv.width = Math.round(dims.pxW * s);
    cv.height = Math.round(dims.pxH * s);
  }, [dims]);

  // Static repaint on any change when not mid-interaction.
  useEffect(() => {
    const h = hoverRef.current;
    if (!h.active && h.strength < 0.002) paint();
  }, [paint]);

  // Animation loop: advance the reveal phase (when playing) and ease the hover
  // presence, repainting until both are settled.
  const lastRef = useRef(0);
  const tick = useCallback(() => {
    const now = performance.now();
    const dt = lastRef.current ? Math.min(0.05, (now - lastRef.current) / 1000) : 0;
    lastRef.current = now;

    const m = revealRef.current, c = cfgRef.current;
    timeRef.current += dt * c.speed;
    if (m.playing) {
      m.phase += (dt / Math.max(0.1, c.duration)) * m.dir;
      if (m.phase >= 1) { m.phase = 1; if (c.loop) m.dir = -1; else { m.playing = false; setPlaying(false); } }
      else if (m.phase <= 0) { m.phase = 0; if (c.loop) m.dir = 1; else { m.playing = false; setPlaying(false); } }
      setPhase(m.phase);
    }

    const h = hoverRef.current;
    h.strength += ((h.active ? 1 : 0) - h.strength) * 0.2;

    paintRef.current();

    // Mirror the preview into the fixed-size recording canvas (contain-fit).
    const rc = recCastRef.current;
    const src = canvasRef.current;
    if (rc && src) {
      rc.ctx.clearRect(0, 0, rc.cv.width, rc.cv.height);
      const k = Math.min(rc.cv.width / src.width, rc.cv.height / src.height);
      rc.ctx.drawImage(src, (rc.cv.width - src.width * k) / 2, (rc.cv.height - src.height * k) / 2, src.width * k, src.height * k);
    }

    if (m.playing || c.ambient || h.active || h.strength > 0.002 || rc) {
      rafRef.current = requestAnimationFrame(tick);
    } else {
      h.strength = 0;
      lastRef.current = 0;
      rafRef.current = 0;
      paintRef.current();
    }
  }, []);

  const ensureRaf = useCallback(() => {
    if (!rafRef.current) { lastRef.current = 0; rafRef.current = requestAnimationFrame(tick); }
  }, [tick]);
  const playReveal = useCallback(() => {
    const m = revealRef.current;
    if (m.phase >= 1) { m.phase = 0; m.dir = 1; }   // restart from hidden
    m.playing = true; setPlaying(true); ensureRaf();
  }, [ensureRaf]);
  const pauseReveal = useCallback(() => { revealRef.current.playing = false; setPlaying(false); }, []);
  const resetReveal = useCallback(() => {
    const m = revealRef.current; m.playing = false; m.phase = 1; m.dir = 1;
    setPlaying(false); setPhase(1); paintRef.current();
  }, []);
  const scrubPhase = useCallback((v: number) => {
    const m = revealRef.current; m.playing = false; setPlaying(false); m.phase = v; setPhase(v); paintRef.current();
  }, []);

  // Ambient layers need the loop running even with no transport/hover.
  useEffect(() => {
    if (breathe > 0 || turb > 0 || wave > 0 || twinkle > 0) ensureRaf();
  }, [breathe, turb, wave, twinkle, ensureRaf]);

  const onHoverMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current;
    if (!cv || !dims || exportingRef.current) return;
    const rect = cv.getBoundingClientRect();
    const h = hoverRef.current;
    h.x = ((e.clientX - rect.left) / rect.width) * dims.pxW;
    h.y = ((e.clientY - rect.top) / rect.height) * dims.pxH;
    h.active = true;
    if (!rafRef.current) rafRef.current = requestAnimationFrame(tick);
  }, [dims, tick]);

  const onHoverLeave = useCallback(() => {
    hoverRef.current.active = false;
    if (!rafRef.current && !exportingRef.current) rafRef.current = requestAnimationFrame(tick);
  }, [tick]);

  // Cleanup must also zero the ref: every loop-starter guards on !rafRef.current,
  // so a stale id after unmount/HMR would block the loop from ever restarting.
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); rafRef.current = 0; }, []);

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
    if (!transparent) { ctx.fillStyle = bg; ctx.fillRect(0, 0, cv.width, cv.height); }
    for (const d of dots.values()) {
      ctx.fillStyle = d.color;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    cv.toBlob((b) => b && downloadBlob(b, "dot-text.png"), "image/png");
  }, [dims, dots, bg, transparent]);

  const exportSVG = useCallback(() => {
    if (!dims || !dots) return;
    const r2 = (n: number) => +n.toFixed(2);
    let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${dims.pxW}" height="${dims.pxH}" viewBox="0 0 ${dims.pxW} ${dims.pxH}">`;
    if (!transparent) s += `<rect width="${dims.pxW}" height="${dims.pxH}" fill="${bg}"/>`;
    for (const d of dots.values() as IterableIterator<Dot>)
      s += `<circle cx="${r2(d.x)}" cy="${r2(d.y)}" r="${r2(d.radius)}" fill="${d.color}"/>`;
    s += `</svg>`;
    downloadBlob(new Blob([s], { type: "image/svg+xml" }), "dot-text.svg");
  }, [dims, dots, bg, transparent]);

  const projRef = useRef<HTMLInputElement>(null);
  const saveProject = () =>
    downloadBlob(new Blob([JSON.stringify(buildProject())], { type: "application/json" }), "dot-text-project.json");
  const openProjectFile = async (f: File) => {
    try { applyProject(JSON.parse(await f.text())); }
    catch { alert("Couldn't open that project file."); }
  };

  // Record the live preview canvas → MP4 where the browser can mux it (Chrome
  // 126+), else WebM. Captures whatever animates — start playback, hit Record,
  // hit Stop. H.264/VP9 have no alpha, so a transparent bg records as black.
  // The stream comes from a fixed-size MIRROR canvas, not the preview: sliders
  // like Detail resize the preview's backing store mid-stream and H.264 glitches
  // on resolution changes. The tick loop copies preview → mirror every frame
  // (contain-fit), so any parameter can change freely while recording.
  const [recording, setRecording] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const recCastRef = useRef<{ cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null>(null);
  const toggleRecord = useCallback(() => {
    if (recRef.current) { recRef.current.stop(); return; }
    const cv = canvasRef.current;
    if (!cv) return;
    const mime = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"]
      .find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) { alert("This browser can't record video."); return; }
    const rcv = document.createElement("canvas");
    rcv.width = cv.width; rcv.height = cv.height;   // locked for the whole take
    const rctx = rcv.getContext("2d")!;
    rctx.drawImage(cv, 0, 0);
    const stream = rcv.captureStream(60);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      downloadBlob(new Blob(chunks, { type: mime }), mime.startsWith("video/mp4") ? "dot-text.mp4" : "dot-text.webm");
      recRef.current = null;
      recCastRef.current = null;
      setRecording(false);
    };
    rec.start();
    recRef.current = rec;
    recCastRef.current = { cv: rcv, ctx: rctx };
    setRecording(true);
    ensureRaf();   // keep frames flowing for the whole take, even when idle
  }, [ensureRaf]);

  // Offline PNG-sequence export (keeps alpha — the After Effects path). Renders
  // deterministically: from the current Phase, play forward `duration` seconds
  // at 30fps, stepping the clock frame-exactly (no dropped frames, no realtime).
  const [renderPct, setRenderPct] = useState<number | null>(null);
  const exportingRef = useRef(false);
  const exportFrames = useCallback(async () => {
    const cv = canvasRef.current;
    if (!cv || !dots || exportingRef.current) return;
    exportingRef.current = true;
    // Freeze the live loop so wall-clock ticks don't advance time between frames.
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    const m = revealRef.current;
    const saved = { phase: m.phase, playing: m.playing, t: timeRef.current };
    m.playing = false;
    const FPS = 30;
    const c = cfgRef.current;
    const n = Math.max(2, Math.round(FPS * Math.max(0.4, c.duration)));
    const files: { name: string; data: Uint8Array }[] = [];
    try {
      for (let i = 0; i < n; i++) {
        m.phase = Math.min(1, saved.phase + (i / FPS) / Math.max(0.1, c.duration));
        timeRef.current = saved.t + (i / FPS) * c.speed;
        paintRef.current();
        const blob = await new Promise<Blob>((res, rej) =>
          cv.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
        files.push({ name: `frame_${String(i).padStart(4, "0")}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
        setRenderPct(Math.round(((i + 1) / n) * 100));
      }
      downloadBlob(new Blob([buildZip(files)], { type: "application/zip" }), "dot-text-frames.zip");
    } catch {
      alert("Frame export failed.");
    } finally {
      m.phase = saved.phase; m.playing = saved.playing; timeRef.current = saved.t;
      setRenderPct(null);
      exportingRef.current = false;
      paintRef.current();
      ensureRaf();   // tick stops itself next frame if nothing is animating
    }
  }, [dots, ensureRaf]);

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
      {/* Left column — text, font, dot controls */}
      <aside className="w-[300px] max-w-[88vw] shrink-0 h-dvh p-4 flex flex-col gap-4 overflow-hidden">
        {/* Header pill */}
        <div className="bg-[var(--card)] rounded-3xl px-5 py-3.5 flex items-center gap-3 shrink-0">
          <svg width="30" height="30" viewBox="0 0 39 39" className="shrink-0" aria-label="morii logo">
            {[[18.5, 3.5], [3.5, 18.5], [18.5, 18.5], [34.5, 18.5], [18.5, 34.5]].map(([cx, cy]) => (
              <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={3.5} fill="#FF2A2A" />
            ))}
          </svg>
          <span className="text-[19px] font-bold tracking-[-0.6px] text-[var(--brand)] leading-none">Text → Dots</span>
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
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3}
            placeholder="Type text… (Enter for a new line)"
            className="w-full p-3 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[14px] resize-none outline-none placeholder:text-[var(--txt-3)]" />

          {/* Project save / open */}
          <div className="flex gap-2">
            <button onClick={saveProject}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] transition-all">
              <Save size={13} /> Save
            </button>
            <button onClick={() => projRef.current?.click()}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] transition-all">
              <FolderOpen size={13} /> Open
            </button>
          </div>
          <input ref={projRef} type="file" accept=".json,application/json" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) openProjectFile(f); e.target.value = ""; }} />

          {/* Font / export */}
          <div className="flex flex-col gap-2">
            <button onClick={() => fontRef.current?.click()}
              className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] transition-all truncate">
              <Upload size={13} /> {fontName ? fontName : "Upload font"}
            </button>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={exportPNG} disabled={!dots}
                className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                <Download size={13} /> PNG
              </button>
              <button onClick={exportSVG} disabled={!dots}
                className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                <Download size={13} /> SVG
              </button>
              <button onClick={toggleRecord} disabled={!dots}
                className={`flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[13px] disabled:opacity-40 disabled:cursor-not-allowed transition-all ${recording
                  ? "bg-red-500 text-white hover:bg-red-600"
                  : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"}`}>
                {recording ? <Square size={13} /> : <Video size={13} />} {recording ? "Stop" : "Video"}
              </button>
              <button onClick={exportFrames} disabled={!dots || renderPct != null} title="PNG sequence with alpha (30fps, Duration long) — for After Effects"
                className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                <Film size={13} /> {renderPct != null ? `${renderPct}%` : "Frames"}
              </button>
            </div>
          </div>
          <input ref={fontRef} type="file" accept=".ttf,.otf,.woff,.woff2,font/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFontFile(f); e.target.value = ""; }} />

          {/* Style */}
          <div>
            <div className="text-[12px] text-[var(--txt-2)] mb-1.5">Style</div>
            <div className="flex gap-1.5">
              {([["color", "Color"], ["mono", "Mono"], ["tonal", "Light & Shadow"]] as const).map(([s, lbl]) => (
                <button key={s} onClick={() => setStyle(s)} className={seg(style === s)}>{lbl}</button>
              ))}
            </div>
            {style !== "tonal" && (
              <ColorRow label={style === "mono" ? "Dot color" : "Text color"}
                value={style === "mono" ? monoColor : textColor}
                onChange={style === "mono" ? setMonoColor : setTextColor} className="mt-2" />
            )}
          </div>

          <Slider label="Dot size" min={2} max={20} step={0.5} value={dotSize} onChange={setDotSize} fixed={1} />
          <Slider label="Scatter" min={0} max={1} step={0.01} value={scatter} onChange={setScatter} fixed={2} />
          <Slider label="Drift" min={0} max={1} step={0.01} value={drift} onChange={setDrift} fixed={2} />
          {drift > 0 && <Slider label="Drift angle" min={0} max={360} step={5} value={driftAngle} onChange={setDriftAngle} suffix="°" />}
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

          <div className="flex items-center gap-2">
            <div className="flex-1"><ColorRow label="Background" value={bg} onChange={setBg} /></div>
            <button onClick={() => setTransparent((v) => !v)} title="Transparent background (PNG/SVG keep alpha)"
              className={`h-8 px-2.5 rounded-lg text-[11px] transition-all ${transparent
                ? "bg-[var(--solid)] text-[var(--solid-fg)]"
                : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"}`}>
              Transparent
            </button>
          </div>
        </div>
      </aside>

      {/* Preview stage */}
      <div ref={stageRef} className="relative flex-1 h-dvh flex items-center justify-center p-6 overflow-hidden">
        {dots
          ? <canvas ref={canvasRef} onPointerMove={onHoverMove} onPointerLeave={onHoverLeave}
              className="rounded-2xl shadow-2xl"
              style={{ touchAction: "none", ...(disp && { width: disp.w, height: disp.h }), ...(transparent && {
                backgroundImage: "conic-gradient(rgba(127,127,127,.18) 25%, transparent 0 50%, rgba(127,127,127,.18) 0 75%, transparent 0)",
                backgroundSize: "22px 22px",
              }) }} />
          : <span className="text-[15px] text-[var(--txt-3)]">Type something to preview</span>}
      </div>

      {/* Right column — animation (reveal + layers + hover) */}
      <aside className="w-[300px] max-w-[88vw] shrink-0 h-dvh p-4 flex flex-col gap-4 overflow-hidden">
        <div className="bg-[var(--card)] rounded-3xl px-5 py-3.5 flex items-center shrink-0">
          <span className="text-[15px] font-bold tracking-[-0.4px] text-[var(--txt-1)] leading-none">Animation</span>
        </div>

        <div className="bg-[var(--card)] rounded-3xl p-4 flex-1 overflow-y-auto flex flex-col gap-5 [&>*]:shrink-0" style={{ scrollbarWidth: "none" }}>
          {/* Reveal (dots pop in/out in clumpy noise order) */}
          <div className="flex flex-col gap-2">
            <div className="text-[12px] text-[var(--txt-2)] mb-0.5">Reveal</div>
            <div className="flex gap-1.5">
              <button onClick={playing ? pauseReveal : playReveal} title={playing ? "Pause" : "Play reveal"}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-[var(--solid)] text-[var(--solid-fg)] text-[13px] hover:opacity-90 transition-opacity">
                {playing ? <Pause size={14} /> : <Play size={14} />} {playing ? "Pause" : "Play"}
              </button>
              <button onClick={resetReveal} title="Show full text" className={iconBtn}>
                <RotateCcw size={15} />
              </button>
              <button onClick={() => setLoop((v) => !v)} title="Loop (in ↔ out)"
                className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all ${loop
                  ? "bg-[var(--solid)] text-[var(--solid-fg)]"
                  : "bg-[var(--ctl)] text-[var(--txt-1)] hover:bg-[var(--ctl-hover)]"}`}>
                <Repeat size={15} />
              </button>
            </div>
            <Slider label="Phase" min={0} max={1} step={0.01} value={phase} onChange={scrubPhase} fixed={2} />
            <Slider label="Duration" min={0.4} max={8} step={0.1} value={duration} onChange={setDuration} fixed={1} suffix="s" />
          </div>

          {/* Ambient layers (stackable, 0 = off) */}
          <div className="flex flex-col gap-2 pt-1 border-t border-[var(--overlay-border)]">
            <div className="text-[12px] text-[var(--txt-2)] mb-0.5">Layers</div>
            <Slider label="Breathe" min={0} max={1} step={0.01} value={breathe} onChange={setBreathe} fixed={2} />
            <Slider label="Turbulence" min={0} max={60} step={1} value={turb} onChange={setTurb} />
            <Slider label="Wave" min={0} max={24} step={0.5} value={wave} onChange={setWave} fixed={1} />
            <Slider label="Wave length" min={10} max={140} step={2} value={wavelen} onChange={setWavelen} />
            <Slider label="Twinkle" min={0} max={1} step={0.01} value={twinkle} onChange={setTwinkle} fixed={2} />
            {twinkle > 0 && (
              <>
                <Slider label="Twinkle min" min={0.1} max={2} step={0.05} value={twMin} onChange={setTwMin} fixed={2} suffix="×" />
                <Slider label="Twinkle max" min={0.5} max={5} step={0.1} value={twMax} onChange={setTwMax} fixed={1} suffix="×" />
                <Slider label="Twinkle speed" min={0.02} max={2} step={0.02} value={twSpeed} onChange={setTwSpeed} fixed={2} suffix="×" />
              </>
            )}
          </div>

          {/* Shared noise field */}
          <div className="flex flex-col gap-2 pt-1 border-t border-[var(--overlay-border)]">
            <div className="text-[12px] text-[var(--txt-2)] mb-0.5">Noise field</div>
            <Slider label="Speed" min={0.1} max={3} step={0.05} value={speed} onChange={setSpeed} fixed={2} />
            <Slider label="Noise scale" min={0.002} max={0.06} step={0.002} value={noiseScale} onChange={setNoiseScale} fixed={3} />
            <Slider label="Flow speed" min={0} max={2} step={0.02} value={flowSpeed} onChange={setFlowSpeed} fixed={2} />
            <Slider label="Flow angle" min={0} max={360} step={5} value={flowAngle} onChange={setFlowAngle} suffix="°" />
            <Slider label="Noise phase" min={0} max={20} step={0.05} value={noisePhase} onChange={setNoisePhase} fixed={2} />
            <button onClick={() => setSeed(Math.floor(Math.random() * 10000))}
              className="flex items-center justify-between py-2.5 px-3 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] hover:bg-[var(--ctl-hover)] transition-all">
              <span className="flex items-center gap-1.5"><Dices size={14} /> New seed</span>
              <span className="tabular-nums text-[var(--txt-2)]">{seed}</span>
            </button>
          </div>

          {/* Hover interaction */}
          <div className="flex flex-col gap-2">
            <div className="text-[12px] text-[var(--txt-2)] mb-0.5">Hover (glow + wave)</div>
            <Slider label="Radius" min={0} max={300} step={2} value={hoverRadius} onChange={setHoverRadius} />
            <Slider label="Glow" min={0} max={2} step={0.05} value={hoverGlow} onChange={setHoverGlow} fixed={2} />
            <Slider label="Wave" min={0} max={24} step={0.5} value={hoverWave} onChange={setHoverWave} fixed={1} />
          </div>
        </div>
      </aside>
    </div>
  );
}

// Mix a color toward white by t (0..1) → the glow brighten. Accepts #rrggbb or
// its own rgb(...) output, so twinkle + hover can stack on the same dot.
function lighten(color: string, t: number): string {
  let r: number, g: number, b: number;
  if (color[0] === "#") {
    const n = parseInt(color.slice(1), 16);
    r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255;
  } else {
    const m = color.match(/\d+/g);
    if (!m) return color;
    r = +m[0]; g = +m[1]; b = +m[2];
  }
  const mix = (c: number) => Math.round(c + (255 - c) * t);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
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
