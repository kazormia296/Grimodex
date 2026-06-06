import { create } from "zustand";
import { isVersionConflictError } from "@/lib/versionConflict";
import { useExternalWriteStore } from "@/features/concurrency/externalWriteStore";
import { useTabStore } from "@/features/editor/tabStore";

type AsyncFn = () => Promise<void>;

export type HistoryKind =
  | "scenes"
  | "codex"
  | "map"
  | "snippets"
  | "pins"
  | "phase"
  | "tags"
  | "foreshadow";

export interface HistoryCommand {
  kind: HistoryKind;
  label: string;
  /** Entity id for per-entry invalidation on external writes. */
  entityId?: string;
  undo: AsyncFn;
  redo: AsyncFn;
}

const MAX_HISTORY = 50;

function domainForKind(kind: HistoryKind): string | null {
  switch (kind) {
    case "codex":
      return "codex";
    case "snippets":
      return "snippet";
    case "scenes":
      return "grid";
    default:
      return null;
  }
}

function surfaceUndoConflict(cmd: HistoryCommand): void {
  const entityId = cmd.entityId;
  const domain = domainForKind(cmd.kind);
  if (!entityId || !domain) return;

  const extStore = useExternalWriteStore.getState();
  const dirtyTabIds = useTabStore.getState().dirtyTabIds;
  if (dirtyTabIds.has(entityId)) {
    extStore.pushConflict({
      sceneId: entityId,
      domain,
      opType: "undo.version_conflict",
      entityId,
    });
  } else {
    extStore.bumpReloadNonce(entityId);
  }
}

interface HistoryState {
  past: HistoryCommand[];
  future: HistoryCommand[];
  canUndo: boolean;
  canRedo: boolean;
  isReplaying: boolean;
  push: (cmd: HistoryCommand) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  clear: () => void;
  /** Drop history entries targeting an entity after external mutation. */
  invalidateForEntity: (kind: HistoryKind, entityId: string) => void;
}

export const useGlobalHistoryStore = create<HistoryState>()((set, get) => ({
  past: [],
  future: [],
  canUndo: false,
  canRedo: false,
  isReplaying: false,

  push(cmd) {
    set((state) => {
      // Safety net: ignore pushes triggered during undo/redo replay so that
      // a missing call-site guard cannot corrupt the timeline. Call sites
      // should still guard themselves to skip building closures on the no-op
      // path (defense in depth).
      if (state.isReplaying) return state;
      const past = [...state.past, cmd].slice(-MAX_HISTORY);
      return { past, future: [], canUndo: true, canRedo: false };
    });
  },

  async undo() {
    const { past, isReplaying } = get();
    if (past.length === 0 || isReplaying) return;
    const cmd = past[past.length - 1];
    set({ isReplaying: true });
    let versionConflict = false;
    try {
      await cmd.undo();
    } catch (err) {
      if (isVersionConflictError(err)) {
        versionConflict = true;
        surfaceUndoConflict(cmd);
      } else {
        get().clear();
        throw err;
      }
    } finally {
      set((state) => {
        if (state.isReplaying === false) return state;
        if (versionConflict) {
          const newPast = state.past.slice(0, -1);
          return {
            past: newPast,
            future: state.future,
            canUndo: newPast.length > 0,
            canRedo: state.future.length > 0,
            isReplaying: false,
          };
        }
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
    let versionConflict = false;
    try {
      await cmd.redo();
    } catch (err) {
      if (isVersionConflictError(err)) {
        versionConflict = true;
        surfaceUndoConflict(cmd);
      } else {
        get().clear();
        throw err;
      }
    } finally {
      set((state) => {
        if (state.isReplaying === false) return state;
        if (versionConflict) {
          const newFuture = state.future.slice(1);
          return {
            past: state.past,
            future: newFuture,
            canUndo: state.past.length > 0,
            canRedo: newFuture.length > 0,
            isReplaying: false,
          };
        }
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
    set({
      past: [],
      future: [],
      canUndo: false,
      canRedo: false,
      isReplaying: false,
    });
  },

  invalidateForEntity(kind, entityId) {
    set((state) => {
      const matches = (c: HistoryCommand) =>
        c.kind === kind && c.entityId === entityId;
      const past = state.past.filter((c) => !matches(c));
      const future = state.future.filter((c) => !matches(c));
      return {
        past,
        future,
        canUndo: past.length > 0,
        canRedo: future.length > 0,
      };
    });
  },
}));
