import { create } from "zustand";
import type { ExternalRoot, ReloadConflictState } from "./types";

interface MuteEntry {
  rootId: string;
  relPath: string;
  until: number;
}

interface ExternalRootState {
  roots: ExternalRoot[];
  missingRoots: ExternalRoot[];
  isInitialized: boolean;
  conflicts: ReloadConflictState[];
  mutedWrites: MuteEntry[];
  setRoots: (roots: ExternalRoot[]) => void;
  addRoot: (root: ExternalRoot) => void;
  removeRoot: (rootId: string) => void;
  setMissingRoots: (roots: ExternalRoot[]) => void;
  setInitialized: (value: boolean) => void;
  enqueueConflict: (conflict: ReloadConflictState) => void;
  shiftConflict: () => void;
  mutePath: (rootId: string, relPath: string, ms?: number) => void;
  isMuted: (rootId: string, relPath: string) => boolean;
}

const MUTE_MS = 1500;

export const useExternalRootStore = create<ExternalRootState>()((set, get) => ({
  roots: [],
  missingRoots: [],
  isInitialized: false,
  conflicts: [],
  mutedWrites: [],

  setRoots: (roots) => set({ roots }),
  addRoot: (root) =>
    set((s) => ({
      roots: [...s.roots.filter((r) => r.id !== root.id), root],
    })),
  removeRoot: (rootId) =>
    set((s) => ({ roots: s.roots.filter((r) => r.id !== rootId) })),
  setMissingRoots: (missingRoots) => set({ missingRoots }),
  setInitialized: (isInitialized) => set({ isInitialized }),
  enqueueConflict: (conflict) =>
    set((s) => ({ conflicts: [...s.conflicts, conflict] })),
  shiftConflict: () => set((s) => ({ conflicts: s.conflicts.slice(1) })),

  mutePath: (rootId, relPath, ms = MUTE_MS) => {
    const until = Date.now() + ms;
    set((s) => ({
      mutedWrites: [
        ...s.mutedWrites.filter(
          (m) => !(m.rootId === rootId && m.relPath === relPath),
        ),
        { rootId, relPath, until },
      ],
    }));
  },

  isMuted: (rootId, relPath) => {
    const now = Date.now();
    const entry = get().mutedWrites.find(
      (m) => m.rootId === rootId && m.relPath === relPath,
    );
    return entry != null && entry.until > now;
  },
}));

export function isFileBackedNode(
  sourceUri: string | null | undefined,
): boolean {
  if (!sourceUri) return false;
  return !sourceUri.endsWith("/.mount");
}
