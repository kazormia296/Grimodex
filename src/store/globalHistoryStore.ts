import { create } from "zustand";
import { isVersionConflictError } from "@/lib/versionConflict";

type AsyncFn = () => Promise<void>;

export type HistoryKind =
  | "scenes"
  | "codex"
  | "map"
  | "snippets"
  | "pins"
  | "phase"
  | "tags"
  | "foreshadow"
  | "plot";

export interface HistoryCommand {
  kind: HistoryKind;
  label: string;
  /** Entity id for per-entry invalidation on external writes. */
  entityId?: string;
  undo: AsyncFn;
  redo: AsyncFn;
}

const MAX_HISTORY = 50;

/**
 * Conflict surfacer registered by the concurrency layer (externalWriteFeed).
 * Kept OUT of this low-level store on purpose: importing tabStore /
 * externalWriteStore here forms a module-init cycle with projectStore→treeStore
 * (treeStore's createStore calls getCurrentProjectId(), which reads
 * useProjectStore before it is initialized → TDZ ReferenceError). Dependency
 * injection via registration keeps globalHistoryStore free of feature-store
 * imports. When no handler is registered, conflict surfacing is a no-op (the
 * failed entry is still dropped from history by undo/redo).
 */
let undoConflictHandler: ((cmd: HistoryCommand) => void) | null = null;

export function setUndoConflictHandler(
  handler: ((cmd: HistoryCommand) => void) | null,
): void {
  undoConflictHandler = handler;
}

function surfaceUndoConflict(cmd: HistoryCommand): void {
  undoConflictHandler?.(cmd);
}

/**
 * Pending-navigation guard injected by the inline-AI layer (pendingGuard). Same
 * dependency-injection rationale as {@link setUndoConflictHandler}: this
 * low-level store must not import feature stores (inlineAiStore) directly or it
 * forms a module-init cycle. When registered and it returns `true`, undo/redo is
 * vetoed — replaying history while an inline-AI diff is pending would rebuild the
 * active editor doc out from under the un-accepted generated text (data loss).
 * Unregistered → always allowed.
 */
let replayGuard: (() => boolean) | null = null;

export function setHistoryReplayGuard(guard: (() => boolean) | null): void {
  replayGuard = guard;
}

/**
 * Active batch frame for {@link HistoryState.runAsTransaction}. When set, `push`
 * appends into `entries` instead of committing to `past`, so that one user
 * action made of several store mutations (e.g. dragging a plot marker that
 * moves the marker AND re-anchors a branch edge) collapses into a SINGLE undo
 * entry. Kept module-level (not in zustand state) so it never triggers a
 * re-render and so reentrancy is cheap to detect. Not concurrency-safe across
 * truly parallel transactions — UI commit handlers run sequentially, which is
 * the only caller.
 */
interface BatchFrame {
  meta: { kind: HistoryKind; label: string; entityId?: string };
  entries: HistoryCommand[];
}
let activeBatch: BatchFrame | null = null;

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
  /**
   * Run `fn` collecting every `push` it triggers into ONE composite history
   * entry labelled by `meta`. Undo replays the collected undos in reverse
   * order; redo replays the redos forward. Zero pushes → nothing is recorded;
   * any number of pushes → exactly one entry. Use for a single user action that
   * fans out into multiple store mutations.
   */
  runAsTransaction: (
    meta: {
      kind: HistoryKind;
      label: string;
      entityId?: string;
      /**
       * 完了時にこの述語が false を返したら合成エントリを commit しない（破棄）。
       * 例: 非同期 bulk 操作中にプロジェクトが切り替わった場合、旧プロジェクトの
       * 行を参照する undo クロージャを新プロジェクトの履歴へ載せない XPROJ ガード。
       */
      shouldCommit?: () => boolean;
    },
    fn: () => Promise<void>,
  ) => Promise<void>;
}

export const useGlobalHistoryStore = create<HistoryState>()((set, get) => ({
  past: [],
  future: [],
  canUndo: false,
  canRedo: false,
  isReplaying: false,

  push(cmd) {
    // Safety net: ignore pushes triggered during undo/redo replay so that
    // a missing call-site guard cannot corrupt the timeline. Call sites
    // should still guard themselves to skip building closures on the no-op
    // path (defense in depth).
    if (get().isReplaying) return;
    // Inside a transaction, divert into the batch frame instead of committing
    // so the whole user action becomes one undo entry (see runAsTransaction).
    if (activeBatch) {
      activeBatch.entries.push(cmd);
      return;
    }
    set((state) => {
      const past = [...state.past, cmd].slice(-MAX_HISTORY);
      return { past, future: [], canUndo: true, canRedo: false };
    });
  },

  async undo() {
    const { past, isReplaying } = get();
    if (past.length === 0 || isReplaying) return;
    // Veto while an inline-AI diff is pending (would destroy un-accepted text).
    if (replayGuard?.()) return;
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
    // Veto while an inline-AI diff is pending (would destroy un-accepted text).
    if (replayGuard?.()) return;
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

  async runAsTransaction(meta, fn) {
    // During replay or inside another transaction, just run inline: replay
    // must not record, and a nested transaction's pushes belong to the outer
    // frame (flatten). The reentrancy guard keeps the single batch frame valid.
    if (get().isReplaying || activeBatch) {
      await fn();
      return;
    }
    const frame: BatchFrame = { meta, entries: [] };
    activeBatch = frame;
    try {
      await fn();
    } finally {
      activeBatch = null;
    }
    const entries = frame.entries;
    if (entries.length === 0) return;
    // 完了ガード: 例えば await 中にプロジェクトが切り替わった場合、旧プロジェクトの
    // 行を参照するクロージャを新プロジェクトの履歴へ commit しない（XPROJ 汚染防止）。
    if (meta.shouldCommit && !meta.shouldCommit()) return;
    get().push({
      kind: meta.kind,
      label: meta.label,
      entityId: meta.entityId,
      async undo() {
        for (let i = entries.length - 1; i >= 0; i--) {
          await entries[i].undo();
        }
      },
      async redo() {
        for (const entry of entries) {
          await entry.redo();
        }
      },
    });
  },
}));
