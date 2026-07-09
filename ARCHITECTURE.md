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
image export and the back-compat flat `dots` field in `SceneFile` — a
top layer's dot wins on a shared snap point, since layers can overlap (the
"one dot per point" invariant is per-layer, not global).

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

## Why the component isn't split further (yet)

`DotArtTool.tsx` is still ~3,900 lines after extracting everything pure.
Splitting the stateful remainder — handlers, refs, the ~90-ref mirroring
surface — into hooks is a real option, but it multiplies exactly the
operation that causes the crash class described above (moving declarations,
creating new dependency arrays) across dozens of interlinked pieces, with
no behavioral test coverage to catch a subtle regression. If you're
considering it: get `typecheck` green and keep it green, add at least one
smoke test that mounts the app and exercises a draw→undo round trip, and
split one self-contained subsystem at a time (Layers is the best
candidate) rather than attempting it all at once.
