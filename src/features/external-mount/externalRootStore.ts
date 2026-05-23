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
  conflict: ReloadConflictState | null;
  mutedWrites: MuteEntry[];
  setRoots: (roots: ExternalRoot[]) => void;
  addRoot: (root: ExternalRoot) => void;
  removeRoot: (rootId: string) => void;
  setMissingRoots: (roots: ExternalRoot[]) => void;
  setInitialized: (value: boolean) => void;
  setConflict: (conflict: ReloadConflictState | null) => void;
  mutePath: (rootId: string, relPath: string, ms?: number) => void;
  isMuted: (rootId: string, relPath: string) => boolean;
}

const MUTE_MS = 1500;

export const useExternalRootStore = create<ExternalRootState>()((set, get) => ({
  roots: [],
  missingRoots: [],
  isInitialized: false,
  conflict: null,
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
  setConflict: (conflict) => set({ conflict }),

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
