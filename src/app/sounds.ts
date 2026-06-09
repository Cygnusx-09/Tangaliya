// Soft & organic UI sound palette for Tangaliya, built on @web-kits/audio.
// All sounds are sine/triangle based, low-register and muted (gain budget per the
// library's validate rules: per-layer gain <= 0.4, summed layers <= 0.6).
import { defineSound, ensureReady, setMasterVolume } from "@web-kits/audio";
import type { PlayOptions } from "@web-kits/audio";

let muted = false;
let primed = false;

// Resume the AudioContext on the first real interaction (browsers gate audio
// behind a user gesture; every caller here is a click/drag, so this is safe).
function prime() {
  if (primed) return;
  primed = true;
  ensureReady();
}

// Rounded sine pop — the generic UI click (tools, snap, units).
const click = defineSound({
  source: { type: "sine", frequency: { start: 600, end: 420 } },
  envelope: { attack: 0.002, decay: 0.06, release: 0.03 },
  gain: 0.2,
});

// Warm triangle swell for the theme toggle.
const swell = defineSound({
  source: { type: "triangle", frequency: { start: 320, end: 540 } },
  envelope: { attack: 0.006, decay: 0.13, release: 0.05 },
  gain: 0.17,
});

// Undo steps the pitch down, redo steps it up.
const undoSound = defineSound({
  source: { type: "triangle", frequency: { start: 500, end: 300 } },
  envelope: { attack: 0.002, decay: 0.1, release: 0.04 },
  gain: 0.2,
});
const redoSound = defineSound({
  source: { type: "triangle", frequency: { start: 300, end: 500 } },
  envelope: { attack: 0.002, decay: 0.1, release: 0.04 },
  gain: 0.2,
});

// Clear canvas — a soft downward whoosh: low sine sweep + filtered brown noise.
const clearSound = defineSound({
  layers: [
    {
      source: { type: "sine", frequency: { start: 320, end: 90 } },
      envelope: { attack: 0.004, decay: 0.3, release: 0.08 },
      gain: 0.22,
    },
    {
      source: { type: "noise", color: "brown" },
      filter: { type: "lowpass", frequency: 900, resonance: 0.7 },
      envelope: { decay: 0.28, release: 0.06 },
      gain: 0.12,
    },
  ],
});

// Export — a warm two-note confirming chime (perfect fifth).
const exportSound = defineSound({
  layers: [
    {
      source: { type: "sine", frequency: 660 },
      envelope: { attack: 0.004, decay: 0.12, release: 0.06 },
      gain: 0.2,
    },
    {
      source: { type: "sine", frequency: 990 },
      delay: 0.09,
      envelope: { attack: 0.004, decay: 0.16, release: 0.08 },
      gain: 0.18,
    },
  ],
});

// Tiny tick for slider scrubbing — pitched by the slider's position.
const tick = defineSound({
  source: { type: "sine", frequency: 760 },
  envelope: { decay: 0.025, release: 0.01 },
  gain: 0.09,
});

function play(fn: (o?: PlayOptions) => unknown, opts?: PlayOptions) {
  if (muted) return;
  prime();
  try { fn(opts); } catch { /* never let an audio glitch break an interaction */ }
}

let lastTick = 0;

export const sfx = {
  toolSelect: () => play(click, { detune: 0 }),
  toolDraw: () => play(click, { detune: 180 }),
  toolErase: () => play(click, { detune: -160 }),
  ui: () => play(click),
  toggle: () => play(swell),
  undo: () => play(undoSound),
  redo: () => play(redoSound),
  clear: () => play(clearSound),
  export: () => play(exportSound),
  // Throttled so dragging a slider ticks pleasantly instead of machine-gunning.
  slider: (frac: number) => {
    const now = performance.now();
    if (now - lastTick < 28) return;
    lastTick = now;
    play(tick, { detune: Math.round((frac - 0.5) * 1200) });
  },
};

export function setSfxMuted(m: boolean) {
  muted = m;
  setMasterVolume(m ? 0 : 1);
}
