# Tangaliya

A browser-based dot-grid art editor inspired by the Tangaliya weaving craft of
Saurashtra, Gujarat — where raised dots of contrasting thread (daana) are
twisted onto the warp to build geometric motifs.

**Live:** https://cygnusx-09.github.io/Tangaliya/

## Features

- Half-cell snap grid (corners, centers, edge midpoints) with real-world units (mm/cm/in)
- Draw / erase / select tools, marquee + drag-move, copy/paste, undo/redo
- Brush-style continuous strokes with tunable snap reach
- iPad + Apple Pencil support: pen draws, one finger pans, two fingers pinch-zoom
- Hand-draw mode: webcam hand tracking (MediaPipe) — draw with your index finger
- Dark mode, soft UI sounds, SVG / PNG / PDF export

## Running

```bash
npm i
npm run dev    # Vite dev server
npm run build  # production build → dist/
```

Pushing to `main` deploys to GitHub Pages automatically.
