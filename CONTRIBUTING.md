# Contributing

Thanks for taking a look at Tangaliya. This is a solo-maintained creative
tool, not a big project with a formal process — but a few things will make
a contribution land smoothly.

## Setup

```bash
npm i
npm run dev
```

Open the dev server URL. There's no `.env`, no external services required
— everything runs locally except the hand-draw mode's MediaPipe model,
which loads from a CDN at runtime and needs a secure context
(`localhost` counts).

## Before you open a PR

There is **no automated test suite**. Verification is:

1. `npm run typecheck` must pass. This is the one static safety net the
   project has — it specifically catches a recurring crash class (a
   `useEffect`/`useCallback` dependency array referencing something declared
   later in the file). See [`ARCHITECTURE.md`](./ARCHITECTURE.md#the-state-vs-ref-mirroring-pattern--read-this-before-touching-handlers)
   for why this matters before you touch any handler.
2. `npm run build` must succeed.
3. Manually exercise the change in the browser. At minimum, run through
   **SMOKE-QUICK** below; if your change touches drawing, tools, layers, or
   export, run **SMOKE-FULL**.

### SMOKE-QUICK (~2 min)

- App loads with no white screen and no console errors.
- Draw a stroke, undo, redo.
- Toggle dark mode.
- Export SVG.
- Hold the Clear button to completion (verifies the one active shadcn
  component, `Progress`).

### SMOKE-FULL (~10 min)

SMOKE-QUICK, plus:

- Erase; select/move/nudge/copy-paste.
- Line tool: drag with each Spacing shape (Even/Ramp/Taper/Pulse) + Shift
  to constrain angle + wheel-scrub spacing mid-drag.
- Pen tool: straight and curved paths, Enter to finish, click-near-start to
  close a loop.
- Shape tool: at least one outline shape and one filled shape, both anchor
  modes (center/corner).
- Mirror drawing (X and/or Y) on the Draw tool.
- Layers: add, draw, switch, draw again, undo across the switch, delete.
- Save Project, reload the page (autosave should restore), then Open the
  saved file.
- PNG and PDF export.
- Image modal → Add to canvas; Text modal → Add to canvas.
- Open `image.html` and `text.html` directly.
- Snap mode switch, including Sub-grid.

## Code conventions

- No test runner, no linter, no strict type checking — match the existing
  style in whatever file you're editing rather than imposing a new one.
- Pure logic (no React, no refs, no DOM) belongs in `src/lib/`, not inside
  `DotArtTool.tsx`. If you're adding a self-contained helper, it probably
  belongs there.
- Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) before editing anything
  inside the `DotArtTool` component function — the state-vs-ref mirroring
  pattern is not optional to understand first.
- Comments should explain *why*, not *what* — the code should already say
  what it does.

## Deployment

**Pushing to `main` deploys to GitHub Pages automatically.** There is no
staging environment. Treat a push to `main` as a live deploy, not just a
commit.

## License

By contributing, you agree your contribution is licensed under this
project's [MIT license](./LICENSE).
