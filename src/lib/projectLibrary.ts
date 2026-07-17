// projectLibrary.ts — the local project library backing the Home screen.
// Stores each project (its SceneFile + a small thumbnail) in IndexedDB, keyed
// by id. Pure, no React — HomeScreen/DotArtTool call into this directly.
// Separate from the single-slot localStorage autosave (AUTOSAVE_KEY in
// scene.ts), which stays as the last-active-project boot mechanism.

import type { SceneFile } from "@/lib/scene";

const DB_NAME = "tangaliya-projects";
const DB_VERSION = 1;
const STORE = "projects";

export interface ProjectRecord {
  id: string;
  name: string;
  thumbnail: string; // PNG dataURL, "" until first capture
  lastModified: number; // epoch ms
  scene: SceneFile;
}
// The Home grid only needs this — listProjects strips `scene` so a library
// listing never pulls every project's full dot data into memory at once.
export type ProjectMeta = Omit<ProjectRecord, "scene">;

export function genProjectId(): string {
  return `P${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// Default names for new/auto-registered projects — Indian-origin flowers in
// Hinglish, fitting Tangaliya's own textile-art roots, and a real upgrade
// over an undifferentiated wall of "Untitled" tiles once a library grows
// past a handful of entries. No dedup/entropy — a repeat is fine, same as
// "Untitled" repeating was fine before.
const FLOWER_NAMES = [
  "Gulab", "Chameli", "Kamal", "Champa", "Genda", "Mogra", "Parijat", "Kaner",
  "Ashoka", "Palash", "Gulmohar", "Juhi", "Bela", "Kewda", "Sonchafa",
  "Rajnigandha", "Kachnar", "Raat Rani",
];
export function randomProjectName(): string {
  return FLOWER_NAMES[Math.floor(Math.random() * FLOWER_NAMES.length)];
}

// Which library entry the live editor is currently mirroring — read
// synchronously at boot (alongside AUTOSAVE_KEY) so the very first render
// knows whether it's resuming a tracked project. Separate from the document
// content itself, which still lives in AUTOSAVE_KEY/IndexedDB.
export const ACTIVE_PROJECT_ID_KEY = "tangaliya-active-project-id";

export function getActiveProjectId(): string | null {
  try { return localStorage.getItem(ACTIVE_PROJECT_ID_KEY); } catch { return null; }
}
export function setActiveProjectId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_PROJECT_ID_KEY);
    else localStorage.setItem(ACTIVE_PROJECT_ID_KEY, id);
  } catch { /* quota / private mode */ }
}

let dbPromise: Promise<IDBDatabase> | null = null;
function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => {
      const metas = (req.result as ProjectRecord[])
        .map(({ id, name, thumbnail, lastModified }) => ({ id, name, thumbnail, lastModified }))
        .sort((a, b) => b.lastModified - a.lastModified);
      resolve(metas);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getProject(id: string): Promise<ProjectRecord | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result as ProjectRecord | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function putProject(record: ProjectRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function renameProject(id: string, name: string): Promise<void> {
  const record = await getProject(id);
  if (!record) return;
  // Deliberately does NOT touch lastModified — renaming is metadata, not a
  // content edit, and bumping it made the timestamp lie ("just now" on a
  // 3-week-old project) and teleported old work to the top of the
  // recency-sorted grid on a rename alone.
  await putProject({ ...record, name });
}

export async function duplicateProject(id: string): Promise<ProjectRecord | undefined> {
  const record = await getProject(id);
  if (!record) return undefined;
  const copy: ProjectRecord = { ...record, id: genProjectId(), name: `${record.name} copy`, lastModified: Date.now() };
  await putProject(copy);
  return copy;
}
