# Tangaliya

A browser-based dot/bead-grid art editor inspired by the Tangaliya weaving
craft of Saurashtra, Gujarat — where raised dots of contrasting thread
(daana) are twisted onto the warp to build geometric motifs. The editor
encodes that craft's constraints (a discrete grid, whole-step spacing,
counted placement) into the interaction layer itself, rather than offering
a free-form raster canvas.

**Live:** https://cygnusx-09.github.io/Tangaliya/

## Features

- **Half-cell snap grid** — corners, centers, edge midpoints, plus a finer
  "Sub-grid" mode — in real-world units (mm/cm/in), with a graph-paper
  render (bold cell lines + minor subdivisions).
- **Six tools**: Draw, Erase, Select (marquee/drag-move/nudge/copy-paste),
  Line (sparse straight rows with a variable-density Spacing model —
  Even/Ramp/Taper/Pulse), Pen (multi-anchor paths, straight or smooth
  Catmull-Rom curves), Shape (ellipse/rectangle/diamond/triangle/polygon,
  outline or filled).
- **Layers** — add/delete/duplicate/reorder/rename/show-hide, with
  layer-aware undo/redo.
- **Mirror drawing** — left-right and/or top-bottom symmetry live, on every
  tool.
- **Brush strokes** with a tunable snap-reach halo and an optional magnetic
  ruler (Freeform-style straightening).
- **iPad + Apple Pencil support** — pen draws, one finger pans, two fingers
  pan/pinch-zoom/rotate; multi-finger tap gestures for undo/redo.
- **Editable projects** — save/open as JSON, with debounced browser
  autosave.
- **Image → dots and Text → dots** converters, including two standalone
  full-screen pages (`image.html`, `text.html`) for cover-fit sampling and
  a dissolve-style text effect.
- Dark mode, soft UI sounds, SVG / PNG / PDF export.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for how the grid, snapping,
layers, and export model actually work.

## Running

```bash
npm i
npm run dev        # Vite dev server
npm run typecheck  # tsc --noEmit — the project's one static safety net
npm run build       # production build → dist/
```

Pushing to `main` deploys to GitHub Pages automatically.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

MIT — see [`LICENSE`](./LICENSE). Third-party licenses (shadcn/ui) are
listed in [`ATTRIBUTIONS.md`](./ATTRIBUTIONS.md).
