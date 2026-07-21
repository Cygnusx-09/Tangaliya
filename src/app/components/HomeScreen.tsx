// HomeScreen — a Photoshop-Home-style project library screen. Shows on cold
// opens (a fresh tab/window — see App.tsx's sessionStorage gate) as well as
// being reachable via a button in the editor header; a same-session reload
// skips it and goes straight to the resumed document. Renders as a
// full-screen overlay *inside* DotArtTool's own JSX (see the
// {showHome && <HomeScreen/>} call site) rather than a separate route/page,
// so it shares the app's theme vars and never needs a router for what's
// effectively a two-state switch.
//
// Pure UI + direct projectLibrary.ts calls for tile management (rename/
// duplicate/delete are library-only operations, no live-editor involvement).
// Opening/creating a project is delegated to the callbacks DotArtTool passes
// in, since those need to reach into the live document (applyScene etc).

import { useEffect, useRef, useState } from "react";
import { Grid2x2, List, Search, Plus, FolderOpen, X, Pencil, Copy, Trash2, ImagePlus, Type } from "lucide-react";
import {
  listProjects, deleteProject, renameProject, duplicateProject,
  type ProjectMeta,
} from "@/lib/projectLibrary";
import { Logo } from "./Logo";

type Layout = "grid" | "list";
const LAYOUT_KEY = "tangaliya-home-layout";

function relativeDate(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}

export interface HomeScreenProps {
  onOpenProject: (id: string) => Promise<boolean>;
  onCreateNew: () => Promise<void>;
  onOpenFile: (file: File) => Promise<boolean>;
  onDeleteActive: (id: string) => void;
  onOpenImageTool: () => void;
  onOpenTextTool: () => void;
  onClose: () => void;
  // Bumped by DotArtTool's boot-flush effect after it refreshes the active
  // tile's thumbnail/timestamp on a cold boot — re-lists so that tile isn't
  // stuck showing whatever the last coarse flush captured. Optional since
  // Home reached via the header button (mid-session) has nothing to flush.
  refreshSignal?: number;
}

export function HomeScreen({ onOpenProject, onCreateNew, onOpenFile, onDeleteActive, onOpenImageTool, onOpenTextTool, refreshSignal, onClose }: HomeScreenProps) {
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null);
  const [layout, setLayout] = useState<Layout>(() => {
    try { return localStorage.getItem(LAYOUT_KEY) === "list" ? "list" : "grid"; } catch { return "grid"; }
  });
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { listProjects().then(setProjects); }, [refreshSignal]);
  useEffect(() => { try { localStorage.setItem(LAYOUT_KEY, layout); } catch { /* ignore */ } }, [layout]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && renamingId === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, renamingId]);

  const filtered = (projects ?? []).filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));

  const commitRename = async (id: string) => {
    const name = renameDraft.trim();
    setRenamingId(null);
    if (!name) return;
    await renameProject(id, name);
    setProjects((ps) => ps && ps.map((p) => (p.id === id ? { ...p, name, lastModified: Date.now() } : p)));
  };

  const handleDuplicate = async (id: string) => {
    const copy = await duplicateProject(id);
    if (copy) setProjects((ps) => (ps ? [{ id: copy.id, name: copy.name, thumbnail: copy.thumbnail, lastModified: copy.lastModified }, ...ps] : ps));
  };

  const handleDelete = async (id: string) => {
    await deleteProject(id);
    onDeleteActive(id);
    setProjects((ps) => ps && ps.filter((p) => p.id !== id));
  };

  return (
    <div className="fixed inset-0 z-[90] bg-[var(--app-bg)] text-[var(--app-fg)] flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 shrink-0 border-b border-[var(--ctl)]">
        <div className="flex items-center gap-2.5">
          <Logo size={24} />
          <span className="text-[20px] font-bold tracking-[-0.6px] text-[var(--brand)] leading-none">Tangaliya</span>
        </div>

        <div className="ml-4 flex-1 max-w-[360px] relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--txt-3)]" />
          <input
            value={query} onChange={(e) => setQuery(e.target.value)} autoFocus
            placeholder="Search projects"
            className="w-full pl-8 pr-3 py-2 rounded-xl bg-[var(--ctl)] text-[var(--txt-1)] text-[13px] outline-none"
          />
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          {/* bg-[var(--ctl)] is nearly indistinguishable from the page's
              --app-bg in light mode (#ebebeb vs #e8e8ea) — these buttons sit
              directly on that open background (no --card panel underneath
              them, unlike the editor's chrome), so they use the --overlay +
              border treatment the floating canvas pills already rely on for
              the same reason instead. */}
          <button onClick={() => setLayout("grid")} title="Grid view"
            className={`w-9 h-9 rounded-xl flex items-center justify-center transition-colors ${layout === "grid" ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--overlay)] text-[var(--overlay-fg)] border border-[var(--overlay-border)] hover:bg-[var(--ctl-hover)]"}`}>
            <Grid2x2 size={16} />
          </button>
          <button onClick={() => setLayout("list")} title="List view"
            className={`w-9 h-9 rounded-xl flex items-center justify-center transition-colors ${layout === "list" ? "bg-[var(--solid)] text-[var(--solid-fg)]" : "bg-[var(--overlay)] text-[var(--overlay-fg)] border border-[var(--overlay-border)] hover:bg-[var(--ctl-hover)]"}`}>
            <List size={16} />
          </button>
          <button onClick={() => fileInputRef.current?.click()} title="Open a saved project file"
            className="ml-1 flex items-center gap-1.5 px-3.5 h-9 rounded-xl bg-[var(--overlay)] text-[var(--overlay-fg)] border border-[var(--overlay-border)] text-[13px] hover:bg-[var(--ctl-hover)] transition-colors">
            <FolderOpen size={14} /> Open from file
          </button>
          <input ref={fileInputRef} type="file" accept="application/json,.json" className="hidden" data-home-file-input=""
            onChange={async (e) => {
              const f = e.target.files?.[0]; e.target.value = "";
              if (!f) return;
              if (await onOpenFile(f)) onClose();
            }} />
          <button onClick={onClose} title="Close" aria-label="Close Home"
            className="w-9 h-9 rounded-xl flex items-center justify-center bg-[var(--overlay)] text-[var(--overlay-fg)] border border-[var(--overlay-border)] hover:bg-[var(--ctl-hover)] transition-colors">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Secondary tools — the full-screen image/text converters are launch
          points, opened in a new tab. */}
      <div className="flex items-center gap-2 px-6 py-2.5 border-b border-[var(--ctl)] shrink-0">
        <span className="text-[11px] text-[var(--txt-3)] mr-1">Tools</span>
        <button onClick={onOpenImageTool} title="Open the full-screen image tool in a new tab"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--ctl)] text-[var(--txt-2)] text-[12px] hover:bg-[var(--ctl-hover)] hover:text-[var(--txt-1)] transition-colors">
          <ImagePlus size={12} /> Image tool ↗
        </button>
        <button onClick={onOpenTextTool} title="Open the full-screen text tool in a new tab"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--ctl)] text-[var(--txt-2)] text-[12px] hover:bg-[var(--ctl-hover)] hover:text-[var(--txt-1)] transition-colors">
          <Type size={12} /> Text tool ↗
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-6">
        {layout === "grid" ? (
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
            <CreateNewTile layout="grid" onClick={() => onCreateNew().then(onClose)} />
            {filtered.map((p) => (
              <Tile key={p.id} p={p} layout="grid"
                renaming={renamingId === p.id} renameDraft={renameDraft} setRenameDraft={setRenameDraft}
                onOpen={() => onOpenProject(p.id).then((ok) => ok && onClose())}
                onRenameStart={() => { setRenamingId(p.id); setRenameDraft(p.name); }}
                onRenameCommit={() => commitRename(p.id)}
                onDuplicate={() => handleDuplicate(p.id)}
                onDelete={() => handleDelete(p.id)} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-2 max-w-[640px]">
            <CreateNewTile layout="list" onClick={() => onCreateNew().then(onClose)} />
            {filtered.map((p) => (
              <Tile key={p.id} p={p} layout="list"
                renaming={renamingId === p.id} renameDraft={renameDraft} setRenameDraft={setRenameDraft}
                onOpen={() => onOpenProject(p.id).then((ok) => ok && onClose())}
                onRenameStart={() => { setRenamingId(p.id); setRenameDraft(p.name); }}
                onRenameCommit={() => commitRename(p.id)}
                onDuplicate={() => handleDuplicate(p.id)}
                onDelete={() => handleDelete(p.id)} />
            ))}
          </div>
        )}

        {projects !== null && filtered.length === 0 && query && (
          <p className="text-[13px] text-[var(--txt-3)] mt-6">No projects match "{query}".</p>
        )}
      </div>
    </div>
  );
}

function CreateNewTile({ layout, onClick }: { layout: Layout; onClick: () => void }) {
  if (layout === "list") {
    return (
      <button onClick={onClick}
        className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-[var(--card)] hover:bg-[var(--ctl-hover)] transition-colors text-left">
        <div className="w-10 h-10 rounded-lg bg-[var(--ctl)] flex items-center justify-center shrink-0">
          <Plus size={16} className="text-[var(--txt-2)]" />
        </div>
        <span className="text-[13px] text-[var(--txt-1)]">Create New</span>
      </button>
    );
  }
  // Structured to match Tile's grid layout exactly (square thumbnail area +
  // name row + date row) so the two tiles are the same height side by side —
  // a bare aspect-square button here used to sit shorter than every real
  // tile below it, which has that extra text underneath its square.
  return (
    <button onClick={onClick}
      className="rounded-2xl bg-[var(--card)] hover:bg-[var(--ctl-hover)] transition-colors overflow-hidden flex flex-col text-left">
      <div className="aspect-square flex items-center justify-center">
        <Plus size={22} className="text-[var(--txt-2)]" />
      </div>
      <div className="px-2.5 py-2">
        <span className="text-[13px] text-[var(--txt-1)]">Create New</span>
      </div>
      <div className="px-2.5 pb-2 -mt-1 text-[11px] text-[var(--txt-3)]">&nbsp;</div>
    </button>
  );
}

function Tile({ p, layout, renaming, renameDraft, setRenameDraft, onOpen, onRenameStart, onRenameCommit, onDuplicate, onDelete }: {
  p: ProjectMeta; layout: Layout;
  renaming: boolean; renameDraft: string; setRenameDraft: (s: string) => void;
  onOpen: () => void; onRenameStart: () => void; onRenameCommit: () => void;
  onDuplicate: () => void; onDelete: () => void;
}) {
  const nameEl = renaming ? (
    <input autoFocus value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={onRenameCommit}
      onKeyDown={(e) => { if (e.key === "Enter") onRenameCommit(); if (e.key === "Escape") { e.stopPropagation(); onRenameCommit(); } }}
      className="w-full bg-[var(--ctl)] rounded px-1.5 py-0.5 text-[13px] text-[var(--txt-1)] outline-none" />
  ) : (
    <span className="text-[13px] text-[var(--txt-1)] truncate">{p.name}</span>
  );

  const actions = (
    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
      <button title="Rename" onClick={(e) => { e.stopPropagation(); onRenameStart(); }}
        className="w-6 h-6 rounded flex items-center justify-center hover:bg-[var(--ctl-hover)] text-[var(--txt-2)]"><Pencil size={12} /></button>
      <button title="Duplicate" onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
        className="w-6 h-6 rounded flex items-center justify-center hover:bg-[var(--ctl-hover)] text-[var(--txt-2)]"><Copy size={12} /></button>
      <button title="Delete" onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="w-6 h-6 rounded flex items-center justify-center hover:bg-[var(--ctl-hover)] text-[var(--txt-2)]"><Trash2 size={12} /></button>
    </div>
  );

  if (layout === "list") {
    return (
      <div data-project-tile="" onClick={onOpen}
        className="group flex items-center gap-3 px-3 py-2.5 rounded-xl bg-[var(--card)] hover:bg-[var(--ctl-hover)] transition-colors cursor-pointer">
        <div className="w-10 h-10 rounded-lg bg-[var(--ctl)] overflow-hidden shrink-0 flex items-center justify-center">
          {p.thumbnail && <img src={p.thumbnail} alt="" className="w-full h-full object-cover" />}
        </div>
        <div className="min-w-0 flex-1">{nameEl}</div>
        <span className="text-[11px] text-[var(--txt-3)] shrink-0">{relativeDate(p.lastModified)}</span>
        {actions}
      </div>
    );
  }
  return (
    <div data-project-tile="" onClick={onOpen}
      className="group rounded-2xl bg-[var(--card)] hover:bg-[var(--ctl-hover)] transition-colors cursor-pointer overflow-hidden flex flex-col">
      <div className="aspect-square bg-[var(--ctl)] flex items-center justify-center overflow-hidden">
        {p.thumbnail && <img src={p.thumbnail} alt="" className="w-full h-full object-cover" />}
      </div>
      <div className="px-2.5 py-2 flex items-center gap-1.5">
        <div className="min-w-0 flex-1">{nameEl}</div>
        {actions}
      </div>
      <div className="px-2.5 pb-2 -mt-1 text-[11px] text-[var(--txt-3)]">{relativeDate(p.lastModified)}</div>
    </div>
  );
}
