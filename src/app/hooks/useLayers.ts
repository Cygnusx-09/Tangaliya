// useLayers — the layer stack, the dots/setDots shims over the active layer,
// and the cross-layer undo/redo timeline. Extracted from DotArtTool so the
// subsystem has one home; the component destructures everything (including
// the raw setters/refs, which applyScene and the drag-commit paths still
// write directly) so no call site changed.
//
// `clearSelection` is injected because selection state stays in the
// component: layer switches (select/add/delete, and undo/redo landing on a
// different layer) must drop the selection, whose keys belong to the
// previous layer's dots.

import { useState, useRef, useCallback, useEffect } from "react";
import { sfx } from "../sounds";
import type { Dot } from "@/lib/dots";
import {
  genLayerId, sceneToLayers,
  type Layer, type UndoSnapshot, type SceneFile,
} from "@/lib/scene";

const MAX_UNDO = 60;

export function useLayers(boot: SceneFile | null, clearSelection: () => void) {
  // Ref-held so the []-dep callbacks below can never capture a stale identity.
  const clearSelectionRef = useRef(clearSelection);
  clearSelectionRef.current = clearSelection;

  // The stack is the source of truth; `dots`/`setDots` below are thin shims
  // over the ACTIVE layer, so every existing tool / undo / selection path keeps
  // editing "the dots" with no change — it just lands in the active layer.
  const initLayersRef = useRef<Layer[] | null>(null);
  if (initLayersRef.current === null) initLayersRef.current = sceneToLayers(boot);
  const [layers, setLayers] = useState<Layer[]>(() => initLayersRef.current!);
  const [activeLayerId, setActiveLayerId] = useState<string>(() => initLayersRef.current![initLayersRef.current!.length - 1].id);
  const activeLayerIdRef = useRef(activeLayerId);
  useEffect(() => { activeLayerIdRef.current = activeLayerId; }, [activeLayerId]);
  const layersRef = useRef(layers);
  useEffect(() => { layersRef.current = layers; }, [layers]);
  const activeLayer = layers.find((l) => l.id === activeLayerId) ?? layers[0];
  const dots = activeLayer.dots;
  const setDots = useCallback((u: Map<string, Dot> | ((prev: Map<string, Dot>) => Map<string, Dot>)) => {
    setLayers((ls) => ls.map((l) => l.id === activeLayerIdRef.current
      ? { ...l, dots: typeof u === "function" ? (u as (p: Map<string, Dot>) => Map<string, Dot>)(l.dots) : u }
      : l));
  }, []);

  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const dotsRef = useRef<Map<string, Dot>>(new Map());
  const undoStackRef = useRef<UndoSnapshot[]>([]);
  const redoStackRef = useRef<UndoSnapshot[]>([]);
  useEffect(() => { dotsRef.current = dots; }, [dots]);

  // Snapshot the active layer's dots onto the undo stack, tagged with which
  // layer they belong to. Any new action invalidates redo.
  const pushUndo = useCallback(() => {
    const snapshot: UndoSnapshot = { layerId: activeLayerIdRef.current, dots: new Map(dotsRef.current) };
    const newStack = [...undoStackRef.current.slice(-(MAX_UNDO - 1)), snapshot];
    undoStackRef.current = newStack;
    setUndoCount(newStack.length);
    redoStackRef.current = [];
    setRedoCount(0);
  }, []);

  // Undo/redo is one cross-layer timeline: a step can target a layer other
  // than the currently active one (e.g. you drew on Layer A, switched to B and
  // drew there, then undo twice — the 2nd undo must land back on A). Each step
  // looks up its target layer's CURRENT dots (not dotsRef, which only mirrors
  // whichever layer is active right now) to build the opposite stack's entry,
  // writes the snapshot into that specific layer, and switches the active
  // layer to it so the change is visible. If the target layer was deleted
  // since the snapshot was taken (layer structure edits aren't undoable in
  // v1), the step is dropped rather than misdirected into the wrong layer.
  const undo = useCallback(() => {
    if (undoStackRef.current.length === 0) return;
    const popped = undoStackRef.current[undoStackRef.current.length - 1];
    const targetLayer = layersRef.current.find((l) => l.id === popped.layerId);
    if (!targetLayer) {
      undoStackRef.current = undoStackRef.current.slice(0, -1);
      setUndoCount(undoStackRef.current.length);
      return;
    }
    sfx.undo();
    redoStackRef.current = [...redoStackRef.current, { layerId: popped.layerId, dots: new Map(targetLayer.dots) }];
    setRedoCount(redoStackRef.current.length);
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    setUndoCount(undoStackRef.current.length);
    const nextLayers = layersRef.current.map((l) => (l.id === popped.layerId ? { ...l, dots: popped.dots } : l));
    setLayers(nextLayers); layersRef.current = nextLayers;
    if (activeLayerIdRef.current !== popped.layerId) {
      setActiveLayerId(popped.layerId); activeLayerIdRef.current = popped.layerId;
      clearSelectionRef.current();
    }
    dotsRef.current = popped.dots;
  }, []);

  const redo = useCallback(() => {
    if (redoStackRef.current.length === 0) return;
    const popped = redoStackRef.current[redoStackRef.current.length - 1];
    const targetLayer = layersRef.current.find((l) => l.id === popped.layerId);
    if (!targetLayer) {
      redoStackRef.current = redoStackRef.current.slice(0, -1);
      setRedoCount(redoStackRef.current.length);
      return;
    }
    sfx.redo();
    undoStackRef.current = [...undoStackRef.current, { layerId: popped.layerId, dots: new Map(targetLayer.dots) }];
    setUndoCount(undoStackRef.current.length);
    redoStackRef.current = redoStackRef.current.slice(0, -1);
    setRedoCount(redoStackRef.current.length);
    const nextLayers = layersRef.current.map((l) => (l.id === popped.layerId ? { ...l, dots: popped.dots } : l));
    setLayers(nextLayers); layersRef.current = nextLayers;
    if (activeLayerIdRef.current !== popped.layerId) {
      setActiveLayerId(popped.layerId); activeLayerIdRef.current = popped.layerId;
      clearSelectionRef.current();
    }
    dotsRef.current = popped.dots;
  }, []);

  // Structure edits (add/delete/reorder/rename/visibility/activate) are NOT on
  // the undo stack in v1 — only dot edits within a layer are. They read the
  // live stack via `layersRef` and write `setLayers` + keep the ref in sync.
  const selectLayer = useCallback((id: string) => {
    setActiveLayerId(id); activeLayerIdRef.current = id;
    clearSelectionRef.current();
    sfx.toggle();
  }, []);
  const addLayer = useCallback(() => {
    const ls = layersRef.current;
    const idx = ls.findIndex((l) => l.id === activeLayerIdRef.current);
    const at = idx < 0 ? ls.length : idx + 1; // above the active layer
    const nl: Layer = { id: genLayerId(), name: `Layer ${ls.length + 1}`, visible: true, dots: new Map() };
    const next = [...ls.slice(0, at), nl, ...ls.slice(at)];
    setLayers(next); layersRef.current = next;
    setActiveLayerId(nl.id); activeLayerIdRef.current = nl.id;
    clearSelectionRef.current();
    sfx.toggle();
  }, []);
  const duplicateLayer = useCallback((id: string) => {
    const ls = layersRef.current;
    const idx = ls.findIndex((l) => l.id === id);
    if (idx < 0) return;
    const src = ls[idx];
    const nl: Layer = { id: genLayerId(), name: `${src.name} copy`, visible: src.visible, dots: new Map(src.dots) };
    const next = [...ls.slice(0, idx + 1), nl, ...ls.slice(idx + 1)];
    setLayers(next); layersRef.current = next;
    setActiveLayerId(nl.id); activeLayerIdRef.current = nl.id;
    sfx.toggle();
  }, []);
  const deleteLayer = useCallback((id: string) => {
    const ls = layersRef.current;
    if (ls.length <= 1) return; // always keep one layer
    const idx = ls.findIndex((l) => l.id === id);
    const next = ls.filter((l) => l.id !== id);
    setLayers(next); layersRef.current = next;
    if (activeLayerIdRef.current === id) {
      const na = next[Math.max(0, idx - 1)] ?? next[0];
      setActiveLayerId(na.id); activeLayerIdRef.current = na.id;
      clearSelectionRef.current();
    }
    sfx.toggle();
  }, []);
  const moveLayer = useCallback((id: string, dir: 1 | -1) => {
    const ls = layersRef.current;
    const idx = ls.findIndex((l) => l.id === id);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= ls.length) return;
    const next = [...ls];
    [next[idx], next[j]] = [next[j], next[idx]];
    setLayers(next); layersRef.current = next;
    sfx.toggle();
  }, []);
  const toggleLayerVisible = useCallback((id: string) => {
    const next = layersRef.current.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l));
    setLayers(next); layersRef.current = next;
    sfx.toggle();
  }, []);
  const renameLayer = useCallback((id: string, name: string) => {
    const next = layersRef.current.map((l) => (l.id === id ? { ...l, name } : l));
    setLayers(next); layersRef.current = next;
  }, []);
  // Merges >=2 layers into one, in their existing stack order (bottom-most
  // selected layer's dots first, so a higher selected layer's dot wins on a
  // key collision — matching what's visually on top). The merged layer takes
  // the topmost selected layer's name and lands in the slot of the lowest
  // selected layer, so its position relative to untouched layers is
  // unchanged. Structure edit like add/delete/reorder: not on the undo stack,
  // no confirm (same precedent as delete).
  const mergeLayers = useCallback((ids: string[]) => {
    const ls = layersRef.current;
    const idSet = new Set(ids);
    const selected = ls.filter((l) => idSet.has(l.id));
    if (selected.length < 2) return;
    const combined = new Map<string, Dot>();
    for (const l of selected) for (const [k, d] of l.dots) combined.set(k, d);
    const top = selected[selected.length - 1];
    const merged: Layer = { id: genLayerId(), name: top.name, visible: selected.some((l) => l.visible), dots: combined };
    let inserted = false;
    const next: Layer[] = [];
    for (const l of ls) {
      if (!idSet.has(l.id)) { next.push(l); continue; }
      if (!inserted) { next.push(merged); inserted = true; }
    }
    setLayers(next); layersRef.current = next;
    setActiveLayerId(merged.id); activeLayerIdRef.current = merged.id;
    clearSelectionRef.current();
    sfx.toggle();
  }, []);

  return {
    layers, setLayers, layersRef,
    activeLayerId, setActiveLayerId, activeLayerIdRef,
    activeLayer, dots, setDots, dotsRef,
    undoCount, redoCount, pushUndo, undo, redo,
    selectLayer, addLayer, duplicateLayer, deleteLayer,
    moveLayer, toggleLayerVisible, renameLayer, mergeLayers,
  };
}
