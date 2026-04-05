import { create } from "zustand";

type AsyncFn = () => Promise<void>;

export interface TreeCommand {
  undo: AsyncFn;
  redo: AsyncFn;
}

const MAX_HISTORY = 50;

interface HistoryState {
  past: TreeCommand[];
  future: TreeCommand[];
  canUndo: boolean;
  canRedo: boolean;
  /** True while an undo/redo is in progress — suppresses history pushes */
  isReplaying: boolean;
  push: (cmd: TreeCommand) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  clear: () => void;
}

export const useTreeHistoryStore = create<HistoryState>()((set, get) => ({
  past: [],
  future: [],
  canUndo: false,
  canRedo: false,
  isReplaying: false,

  push(cmd) {
    set((state) => {
      const past = [...state.past, cmd].slice(-MAX_HISTORY);
      return { past, future: [], canUndo: true, canRedo: false };
    });
  },

  async undo() {
    const { past, isReplaying } = get();
    if (past.length === 0 || isReplaying) return;
    const cmd = past[past.length - 1];
    set({ isReplaying: true });
    try {
      await cmd.undo();
    } finally {
      set((state) => {
        const newPast = state.past.slice(0, -1);
        const newFuture = [cmd, ...state.future];
        return {
          past: newPast,
          future: newFuture,
          canUndo: newPast.length > 0,
          canRedo: true,
          isReplaying: false,
        };
      });
    }
  },

  async redo() {
    const { future, isReplaying } = get();
    if (future.length === 0 || isReplaying) return;
    const cmd = future[0];
    set({ isReplaying: true });
    try {
      await cmd.redo();
    } finally {
      set((state) => {
        const newFuture = state.future.slice(1);
        const newPast = [...state.past, cmd];
        return {
          past: newPast,
          future: newFuture,
          canUndo: true,
          canRedo: newFuture.length > 0,
          isReplaying: false,
        };
      });
    }
  },

  clear() {
    set({ past: [], future: [], canUndo: false, canRedo: false });
  },
}));
