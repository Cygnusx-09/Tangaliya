# Architecture

This is the durable reference for how the editor actually works — read it
before making a nontrivial change. It's distilled from the project's
day-to-day working notes, not a copy of them; if something here seems to
contradict the code, trust the code and fix this file.

## Entry chain

`src/main.tsx` → `src/app/App.tsx` → `src/app/components/DotArtTool.tsx`.

`DotArtTool.tsx` is the whole application — state, interaction, rendering,
undo/redo, layers, all six tools, import/export — as one component.
Everything **pure** it needs (no React, no refs, no DOM) lives in
`src/lib/`: `dots.ts` (the dot model + image/text→dots conversion, shared
with the standalone pages), `snap.ts` (the half-cell/sub-grid lattice math),
`path.ts` (the Line/Pen spacing engine), `shapes.ts` (dot rendering shape +
the Shape tool's primitives), `scene.ts` (the project-file format, unit
conversion, and `buildSVGString`). Anything that touches component state or
the ref-mirroring pattern below stays in `DotArtTool.tsx` for now — see
"Why the component isn't split further" at the end.

Two other standalone full-screen pages, `src/image/ImageTool.tsx` and
`src/text/TextTool.tsx`, reuse `src/lib/dots.ts` directly; they don't share
any code with `DotArtTool.tsx` itself.

## Coordinate & data model

The canvas is a single SVG. There are two coordinate systems: internal
**pixels** (the SVG viewBox) and user-facing **physical units** (mm/cm/in).
One grid cell is always `CELL_SIZE = 20` px internally;
`pxPerUnit = CELL_SIZE / cellPhysical` bridges the two. Changing units
converts every physical value so the design's real-world size stays
constant; changing cell size rescales the internal raster and counter-scales
the zoom so the canvas frame stays visually locked.

Dots live in a `Map<string, Dot>` keyed by **half-cell grid coordinates**
(`getKey(halfCol, halfRow)`, in `src/lib/dots.ts`), so two dots can never
occupy the same snap point. Snapping happens at corners, centers, and edge
midpoints depending on `snapMode` (`getNearestSnap`, `src/lib/snap.ts`). A
fourth mode, `"fine"` ("Sub-grid"), snaps to any of `GRID_SUBDIV` (10)
subdivisions per cell and uses a **separate key namespace** (`"f:col,row"`
via `getFineKey`) so it can never collide with the half-cell keyspace even
though both are small integer pairs.

## The state-vs-ref mirroring pattern — read this before touching handlers

Mouse/keyboard/wheel/pointer handlers are registered once and read live
values through **refs that mirror React state** (`dotsRef`, `selectedKeysRef`,
`toolRef`, `zoomRef`, `panRef`, and dozens more). `useEffect` hooks keep each
ref in sync with its state. When you mutate dots or selection imperatively,
update **both** the ref and the state — follow the existing
`setX(...); xRef.current = ...` pairs, or handlers will read stale data.

**The one rule that has caused every real crash in this codebase:** a
handler's own *body* can reference anything defined anywhere else in the
component, because the body only runs later, after the whole component
function has finished its render pass. A `useEffect`/`useCallback`
**dependency array is not this** — `[a, b, c]` is evaluated eagerly, in
source order, as part of the render pass itself. Referencing a `const` or
function declared *below* a dependency array throws
`ReferenceError: Cannot access 'X' before initialization` — a blank white
page, with no build-time error, because esbuild only strips TypeScript
types and never checks them.

**`npm run typecheck` (`tsc --noEmit`) catches this class of bug** as
`TS2448`/`TS2454` — it's the project's one static safety net, added
specifically for this failure mode. It does not catch everything (a
extraction that captures a stale ref, or breaks a `setX`/`xRef.current` pair,
is a logic bug tsc can't see) — it only catches the TDZ-ordering mistake.
Run it before committing anything that touches handlers or their dependency
arrays.

## Undo / redo

Undo/redo are `UndoSnapshot` entries (`{ layerId, dots }`, `src/lib/scene.ts`)
pushed onto ref-held stacks, capped at `MAX_UNDO`. Call `pushUndo()` *before*
a mutating action. Because dots live per-layer, a snapshot tags **which**
layer it belongs to — undo is a single cross-layer timeline (like
Procreate): draw on layer A, switch to B, draw there, and two undos land
back on A rather than corrupting B. `undo`/`redo` look up the snapshot's own
`layerId` in the current layer stack (not whichever layer happens to be
active) to build the opposite stack's entry, and switch to that layer if
it isn't the one currently showing. If the target layer was deleted since
the snapshot was taken (layer structure edits are **not** undoable — a
deliberate scope cut), the step is silently dropped rather than misdirected.

## Layers

`dots`/`setDots` are thin shims over the active layer, not real state:
`Layer = { id, name, visible, dots: Map<string,Dot> }`, and every existing
tool/handler reads/writes `dots` exactly as before — it lands in whichever
layer is active automatically. The composite SVG render draws
`layers.map(...)` bottom→top; selection/hover/drag only apply to the active
layer. `flattenLayers` (`src/lib/scene.ts`) merges every visible layer for
image export and the back-compat flat `dots` field in `SceneFile` — a top
layer's dot wins on a shared snap point, since layers can overlap (the
"one dot per point" invariant is per-layer, not global). `sceneToLayers(scene)`
prefers `scene.layers` when present, and otherwise migrates an older
flat-`dots` file into a single `"Layer 1"`.

## Export and the project file

`buildSVGString` (`src/lib/scene.ts`) is the **single source of truth** for
every output format: `exportSVG` downloads it directly, `exportPNG` and
`exportPDF` rasterize it through a canvas. These are final images, not
re-editable.

Separately, the **document** round-trips as JSON via `SceneFile`
(`src/lib/scene.ts`): dots/layers + canvas (unit, cell, W/H) + grid
appearance + snap mode + brush state. View state (zoom/pan/rotation) and UI
prefs (theme/mute) are deliberately excluded — loading fits the canvas to
the viewport instead. `saveProject`/`openProjectFile` round-trip a
`.json` file; a 400ms-debounced autosave writes the same shape to
`localStorage`, restored once at mount before first paint. Bump
`PROJECT_VERSION` and handle migration in `parseScene` if the shape changes.

## Image import: palette quantization and explicit canvas size

The Import Image modal's "Colors" style (`src/lib/palette.ts`, `buildPaletteDots`)
replaced the old Color/Mono buttons with an editable **median-cut palette**.
`medianCutPalette` recursively splits the RGB sample cloud at the median of
its widest channel until N boxes exist — deterministic (same image + same
slider value always yields the same palette, so scrubbing the Colors slider
back and forth never flickers) and O(n log n), no dependency. Above 4096
samples it quantizes on a uniform-stride subsample for speed, but always
does the final per-point nearest-color assignment (`nearestPaletteIndex`)
against the **full** survivor set, so dot placement itself is never
downsampled. The resulting palette is population-ordered (most-used first)
and deduped by hex — it can legitimately come back shorter than the
requested Colors count.

**Recolor without re-quantizing.** `buildPaletteDots` returns `{ dots,
palette, index, counts }` — `index` maps every dot's key to its palette
slot. Editing a swatch never touches `medianCutPalette` again: an
`effectivePalette` memo (`basePalette.palette.map(c => paletteEdits[c] ??
c)`) applies the edits, and `previewDots` does an O(dots) walk that reuses
each `Dot` object unchanged unless its slot's color actually changed — so an
untouched palette produces byte-identical `Dot` references (cheap, and lets
React bail out of re-rendering dots that didn't move). `paletteEdits` is
keyed by the **original quantized hex**, not the slot index, specifically so
an edit survives a Dot-size/Density/Colors recompute: as long as that same
hex reappears in the new quantization (likely, since the underlying image
didn't change), the edit still applies. It resets only on modal open and on
loading a new/different/pasted image — not on every recompute.

**Explicit canvas size.** The modal has its own `importW`/`importH`
override (seeded from the live canvas when the modal opens via
`openImportModal`), decoupled from `computeImportDims`'s old
aspect-derived-from-the-image sizing. `computeCanvasDims` (`src/lib/dots.ts`,
a sibling to `computeImportDims`) turns a direct W×H + cell size into a grid
— since the canvas must land on whole cells, the effective physical size can
shift slightly from what was typed (21cm at a 2cm cell rounds to 22cm), which
is why the modal shows a live `→ W×H · cols×rows cells` readout rather than
trusting the typed value silently. "Match image ratio" is the one-click way
back to the old aspect-fit behavior; Cancel never touches the live canvas,
only "Add to canvas" does (still going through the same `commitDots` both
modals share).

**Ctrl+V yields while the modal is open.** The global keydown handler's
Ctrl+V branch (the existing dot-clipboard paste) checks an `importOpenRef`
mirror of `importOpen` first and returns *before* calling
`e.preventDefault()` — skipping preventDefault matters, because Chromium
suppresses the browser's own native `paste` event for a Ctrl+V whose keydown
already had its default prevented. The modal's own `window`-level `"paste"`
listener (mounted only while `importOpen`) depends on that native event
reaching it, and calls `openImportFile` for the first image item it finds in
the clipboard, ignoring non-image items so a real paste-as-text into the
W/H fields still works normally.

## Touch / iPad

Pointer handlers live on the **container div wrapping the SVG, not the
`<svg>` itself** — WebKit's `setPointerCapture` is broken on SVG elements,
and without capture Safari cancels a Pencil drag as a system gesture.
WebKit also fires spurious `pointerleave` mid-stroke (pen still down,
zero `pointercancel`) — `handlePointerLeave` must ignore leave events while
any press-driven interaction is live, or every stroke dies after one dot.
Input model: pen/mouse draw/erase/select; one finger pans; two fingers
pan + pinch-zoom + twist-rotate. Below `max-width: 1100px` the side panels
become slide-in overlays.

## The Spacing model — a worked design tradeoff

The Line and Pen tools share one variable-spacing engine
(`computePathDots`, `src/lib/path.ts`): a density curve ρ(t) over the path
says how tightly dots pack at each point, and dots are placed at equal
steps of the cumulative density (inverse-CDF sampling). This replaced an
earlier version with five separate controls (start/step/repeat/direction) —
collapsed to one shape picker (Even/Ramp/Taper/Pulse) + a spacing slider.

The interesting part is *where* that density curve gets realized. A first
version computed continuous px-space positions and snapped each one to the
lattice independently — which visibly failed: on a coarse lattice (small
spacing, corner-only snap mode), the average gap is already the tightest
possible lattice step, so any density variation just gets quantized away
into perfectly even spacing. The fix realizes the density curve in **integer
gap-space** instead: integrate the density to a CDF, invert it in units of
whole lattice steps, and round to a monotonic step sequence (each gap ≥ 1
step, never decreasing). This keeps every dot on the bead-grid lattice
*and* preserves the variation, at the cost of a mild ±1-step jitter on very
gentle ramps — an intentional trilemma resolution: {smooth · on-grid ·
arbitrary shapes}, pick two. On-grid was non-negotiable (it's a counted
craft), so smoothness is what gives.

## Keyboard shortcuts, stray focus, and the delete-selection bug

Two separate hazards live here; both were suspects in the same
"marquee-select, press Delete, nothing happens, no console error" bug.

**Stray focus (real hazard, not the bug).** `handlePointerDown` calls
`e.preventDefault()` on every canvas click (needed to stop native
touch-scroll/text-selection while drawing). `preventDefault()` on
`pointerdown`/`mousedown` also suppresses the browser's *implicit*
focus-shift-to-clicked-element behavior. So typing into any text field
(cell size, canvas W/H, a hex color, a layer-rename input, ...) and then
clicking the canvas does **not** blur that field — `document.activeElement`
stays pointed at it, and the global keydown handler's `typing` guard (which
exists so shortcuts don't hijack real text editing) silently swallows
Delete/Backspace/every single-letter tool shortcut. `handlePointerDown`
blurs `document.activeElement` up front, before any tool-specific logic,
whenever it's an `INPUT`/`TEXTAREA`/contenteditable.

**The actual delete bug (fixed 2026-07-13, verified by headless-browser
repro).** `deleteSelected` queued a functional state update that read
`selectedKeysRef.current` *inside* the updater, then synchronously reset
`selectedKeysRef.current = new Set()` on the next line. React runs
functional updaters later, at render time — after the handler has finished
— so the updater iterated the already-emptied ref and deleted nothing. No
exception, no visual change beyond the selection highlight clearing. The
fix: snapshot the Set into a local (`const keys = selectedKeysRef.current`)
before queueing, and iterate the snapshot. The general rule: **a functional
`setState` updater must not read a ref that the same handler reassigns
after queueing it** — capture the value in a local first. (Sibling
functions like `chooseColor`/`updateSelectedDots` read the same ref inside
updaters but don't clear it afterward, which is why they never broke.)
Diagnosis lesson: the code read as correct line-by-line across three
sessions; what cracked it was logging `prev.size`/`next.size` *inside* the
updater and reproducing in a scripted headless browser, which proved the
handler ran but the deletes were no-ops.

## Placement gating: an app-wide minimum spacing

`farEnough(x, y, dots, minDistPx)` (`src/lib/snap.ts`) is a brute-force
scan — deliberately not spatially indexed, since dot counts have stayed
small enough that it hasn't needed to be — that returns false if any
existing dot in a map is closer than `minDistPx`. Every placement path in
the app (the Draw tool's click and brush walk, and Line/Pen/Shape's shared
`commitLineDots`, and hand-draw) gates each new dot through
`next.has(key) || farEnough(...)` before writing it, checked against the
*active layer only* — layers can already overlap by design, so a
cross-layer floor would fight that. The `next.has(key)` half of the check
is load-bearing: without it, redrawing or recoloring an already-placed dot
at its own exact point would get rejected as "too close to itself." The
floor is user-tunable (the "Min. Spacing" slider, in subgrid units of
`FINE_CELL`) but can only ever make placement *sparser* than the active
snap mode's own lattice, never finer — in a coarse mode where a lattice
step already exceeds the slider's distance, the gate is a no-op.

**Bulk variant for image import (added 2026-07-14).** The Image modal's
palette/tonal preview can generate up to ~10^6 candidate dots at fine detail
(a full-canvas grid, not an interactively-drawn set), so gating each one
through `farEnough`'s brute O(n) scan would make the whole preview O(n²) —
fine for the low hundreds of dots a hand-drawn layer accumulates, not for a
bulk grid. `filterMinSpacing` (`src/lib/snap.ts`) enforces the identical
"first dot wins, in scan order" rule via a spatial hash (bucket size =
`minDistPx`, check the 3×3 neighborhood of buckets instead of every existing
dot) — same semantics as `farEnough`, O(n) instead of O(n²). It's a generic
`Map<string, T extends {x,y}>` filter, applied once as the last step of the
modal's `previewDots` memo; nothing else in the app needs this variant yet
because nothing else places dots in bulk at this scale.

A second app-wide gate lives alongside it: **canvas bounds** (edges
inclusive — x = 0 and x = canvasW are real snap points). Most paths were
always bounded because they snap through `getNearestSnap`, which returns
null outside the canvas (draw clicks, hand-draw, Line/Pen/Shape outline
via `computePathDots`), the brush walk breaks at the edge, and shape fill
filters its scan. But four paths place or move dots through the unbounded
`keyFromPosition` and used to leak: the Array pipeline
(`computeArrayPlacements` now takes canvas dims and skips out-of-bounds
placements — the ghost preview and Apply share the gate, so what you see
is what you get), paste/duplicate (`placeDots` skips dots that won't
fit), and select-drag / arrow-nudge. The move paths don't skip per-dot —
that would tear a selection apart or silently delete dots at the re-key
step — they clamp the *whole offset* with `clampOffsetToCanvas`
(`src/lib/snap.ts`) against the selection's bounding box, so the
selection stops flush at the wall as a unit. The clamp quantizes in
whole lattice steps (offsets stay lattice-aligned) and never forces a
move: if legacy dots already sit outside the canvas, zero offset remains
legal, so they can always be dragged back in.

## The Array tool: repeating a motif

The Array tool (`src/lib/array.ts` for the pure geometry, wired into
`DotArtTool.tsx` as a seventh tool) takes the current selection as "the
motif" and repeats it — linear row, grid, or along a hand-drawn curve.
It is **destructive, not a live modifier**: sliders drive a ghost preview,
nothing writes to the dot map until Apply, and once applied the copies are
ordinary dots with no memory of how they were generated. A persistent,
re-tunable-forever array (Blender's actual modifier model) would need an
object type living outside the flat `Map<string,Dot>` every other tool in
this app assumes to exist — a materially bigger architecture change,
deliberately out of scope.

The design space (originally requested as five named patterns — row, grid,
brick, diagonal, curve) collapses to three general controls, because two of
the five are just parameter presets of the other two: **Linear** (angle +
count + spacing — a "diagonal" is just a non-zero angle) and **Grid** (rows
+ cols + spacing X/Y + a row-offset percentage — "brick" is that percentage
at 50%). **Curve** click-places anchors on the canvas exactly like the Pen
tool's state machine, then walks the resulting path at constant arc-length
steps (`pathPolyline`/`pathLength`/`pointAtArcLength`, the same engine
behind the Spacing model above), optionally rotating each copy to the local
tangent (sampled at `dist±ε`) — the Blender Curve-modifier behavior.

Both Linear and Grid also take a **Corner/Center anchor** (reusing the
Shape tool's existing Corner/Center vocabulary rather than inventing a new
one): Corner is the naive formula, where the motif is instance 0 and
every other copy is placed *ahead* of it, so the array only ever grows one
direction; Center reframes the motif as the array's midpoint by offsetting
each instance by `i - (count-1)/2` steps (and the 2D equivalent for Grid),
so it spreads symmetrically. Curve mode has no such toggle, since direction
there is just whatever path was drawn — and unlike Linear/Grid, Curve's
"instance 0" is the curve's start anchor, not the motif's own position, so
applying a Curve array always leaves the original motif in place and adds
N new copies alongside it (nothing in this app deletes dots implicitly).

One pipeline, `computeArrayPlacements`, serves both the live preview and
the real commit — it rotates and translates each instance, re-snaps every
dot to the active lattice, and gates the result through the min-spacing
floor above, incrementally, so instances within the same Apply also count
against each other. Because preview and commit are the same function call,
what's on screen when Apply is clicked is exactly what gets written. The
one real visual cost of re-snapping is that a rotated motif can visibly
deform on coarse snap modes (worst in Corner/Center, best in Sub-grid) —
the same lattice-locked-craft tension as the Spacing model's trilemma
above, and, like that trilemma, the live preview shows it before commit
rather than after.

## Cross-platform downloads

`src/lib/download.ts`'s `downloadBlob(blob, filename)` is the one path
every "save a file" action (SVG/PNG/PDF export, project save) goes
through, because plain `<a download>` clicks are not reliable on iOS
Safari. The specific failure: WebKit stops trusting a `download` click as
a genuine user action once it fires after an async step (an image
`onload`, `canvas.toBlob`, a dynamic `import()`) — the click silently does
nothing, no error. `downloadBlob` sniffs iOS and, there, routes through
the Web Share API (`navigator.share` with a `File`) instead, which pops
the native "Save Image"/"Save to Files" sheet and isn't sensitive to the
same gesture-timing rule; it falls back to opening the blob in a new tab
if Share is unavailable. Desktop and Android keep the direct blob-download
path, unchanged.

## Splitting the component: the pattern that works

`DotArtTool.tsx` is still ~4,300 lines after extracting everything pure.
Splitting the stateful remainder — handlers, refs, the ~90-ref mirroring
surface — into hooks multiplies exactly the operation that causes the
crash class described above (moving declarations, creating new dependency
arrays), so it only became defensible once behavioral coverage existed:
the smoke suite (`npm run smoke`, `tests/smoke.mjs`) drives the real app
in headless Chrome through draw/select+delete/undo/redo/line/pen/shape/
array/erase/layers/export. The suite is the gate — green before and after
every extraction.

The first extraction (`src/app/hooks/useLayers.ts`, 2026-07-13) sets the
pattern for the rest:

- **Move verbatim.** Callback bodies are cut-pasted, not redesigned. The
  hook returns everything under its old names — including raw setters and
  refs (`setLayers`, `layersRef`, `activeLayerIdRef`, `dotsRef`) — so
  outside writers like `applyScene` and the drag-commit paths need zero
  changes and the component-side diff is a destructure.
- **Inject cross-cutting concerns as callbacks held in refs.** Layer
  switches must clear the selection, but selection state stays in the
  component — so the hook takes `clearSelection: () => void` and stores it
  in a ref (`clearSelectionRef.current = clearSelection` every render).
  Its `[]`-dep callbacks call through the ref, so they can never capture a
  stale identity.
- **Mind declaration order.** The hook call needs its arguments
  initialized above it; `selectedKeys`/`selectedKeysRef` moved above the
  hook call for exactly this reason. `npm run typecheck` catches the
  use-before-declaration variants of getting this wrong.
- **Extend the suite in the same pass** with checks that exercise the
  moved code (the layers panel checks landed with the layers hook). A
  test-side lesson from writing those: selection highlight rings are also
  SVG `<circle>`s, so any dot-count assertion needs the selection cleared
  first or a cleared-baseline count.

Next best candidates, in order: the view transform (zoom/pan/rot +
`applyViewport`/`getSVGPoint` — self-contained, no selection coupling),
then clipboard/selection operations. The pointer handlers should go last,
if ever — they touch everything.
