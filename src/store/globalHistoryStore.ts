import { create } from "zustand";
import { isVersionConflictError } from "@/lib/versionConflict";
import type { DocumentKey } from "@/features/editor/document/documentKey";
import { canScheduleQuiescenceMutation } from "@/application/lifecycle/quiescenceLease";
import {
  createQuiescenceProviderId,
  registerQuiescenceProvider,
} from "@/lib/quiescenceProviders";
import { isUnknownIpcOutcomeError } from "@/lib/ipcOutcome";
import { isChatNavigationBlocked } from "@/lib/chatNavigationGuard";

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
  | "plot"
  | "chronicle"
  | "editor";

export interface HistoryCommand {
  kind: HistoryKind;
  label: string;
  /**
   * Stable backend operation identity. Retrying an idempotent write returns
   * the original undo journal id; keep that replay from adding the same
   * command to history twice.
   */
  operationId?: string;
  /**
   * Stable operation identities represented by a compound command.
   * `runAsTransaction` derives this from its collected commands.
   */
  operationIds?: readonly string[];
  /** Entity id for per-entry invalidation on external writes. */
  entityId?: string;
  /**
   * Every entity owned by a composite command. An external write to any one of
   * these targets invalidates the whole command rather than leaving a replay
   * closure whose mixed OCC snapshot is already stale.
   */
  affectedEntities?: readonly {
    kind: HistoryKind;
    entityId: string;
  }[];
  /** Exact editor document affected by the command, when one exists. */
  documentKey?: DocumentKey;
  /**
   * Keep this command on its source stack when replay hits a version conflict.
   * Phase replay uses this so a failed CAS is visible and does not silently
   * consume the user's undo/redo entry.
   */
  retainOnVersionConflict?: boolean;
  undo: AsyncFn;
  redo: AsyncFn;
}

const MAX_HISTORY = 50;
const MAX_SEEN_OPERATION_IDS = 4096;
/**
 * Session/project-scoped replay registry. Project lifecycle calls `clear()`,
 * which resets this alongside both stacks. IDs deliberately survive normal
 * stack eviction and per-entity invalidation.
 */
const seenOperationIds = new Set<string>();
const pendingHistoryReplays = new Set<Promise<void>>();

function commandOperationIds(command: HistoryCommand): string[] {
  return [
    ...(command.operationId ? [command.operationId] : []),
    ...(command.operationIds ?? []),
  ].filter((id, index, ids) => id.length > 0 && ids.indexOf(id) === index);
}

function rememberOperationIds(ids: readonly string[]): void {
  for (const id of ids) {
    seenOperationIds.add(id);
  }
  while (seenOperationIds.size > MAX_SEEN_OPERATION_IDS) {
    const oldest = seenOperationIds.values().next().value as string | undefined;
    if (oldest === undefined) break;
    seenOperationIds.delete(oldest);
  }
}

function removeCommandByIdentity(
  stack: HistoryCommand[],
  command: HistoryCommand,
  findFromEnd: boolean,
): HistoryCommand[] | null {
  const index = findFromEnd
    ? stack.lastIndexOf(command)
    : stack.indexOf(command);
  if (index < 0) return null;
  return [...stack.slice(0, index), ...stack.slice(index + 1)];
}

async function runTrackedHistoryReplay(replay: AsyncFn): Promise<void> {
  let pending: Promise<void>;
  try {
    // Invoke synchronously so a lifecycle boundary cannot appear between the
    // scheduling gate and registration of the resulting persistence task.
    pending = Promise.resolve(replay());
  } catch (error) {
    pending = Promise.reject(error);
  }
  pendingHistoryReplays.add(pending);
  try {
    await pending;
  } finally {
    pendingHistoryReplays.delete(pending);
  }
}

async function awaitPendingHistoryReplays(): Promise<void> {
  const failures: unknown[] = [];
  while (pendingHistoryReplays.size > 0) {
    const results = await Promise.allSettled([...pendingHistoryReplays]);
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "One or more history replays failed");
  }
}

registerQuiescenceProvider({
  id: createQuiescenceProviderId("global-history-replays"),
  stage: "scoped-mutations",
  flush: awaitPendingHistoryReplays,
});

/**
 * Conflict surfacer registered by the concurrency layer (externalWriteFeed).
 * Kept OUT of this low-level store on purpose: importing tabStore /
 * externalWriteStore here forms a module-init cycle with projectStore→treeStore
 * (treeStore's createStore calls getCurrentProjectId(), which reads
 * useProjectStore before it is initialized → TDZ ReferenceError). Dependency
 * injection via registration keeps globalHistoryStore free of feature-store
 * imports. When no handler is registered, conflict surfacing is a no-op.
 * Commands opt into retaining their source-stack entry with
 * `retainOnVersionConflict`; other commands keep the legacy drop-on-conflict
 * behavior.
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
 * Explicit sink for one compound user operation. Feature mutations receive
 * this object as an argument; ambient global state is deliberately forbidden
 * because an `await` yields to unrelated UI events.
 */
export interface HistoryCollector {
  push: (cmd: HistoryCommand) => void;
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
  invalidateKind: (kind: HistoryKind) => void;
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
    fn: (collector: HistoryCollector) => Promise<void>,
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
    const operationIds = commandOperationIds(cmd);
    if (
      operationIds.some(
        (id) =>
          seenOperationIds.has(id) ||
          [...get().past, ...get().future].some((entry) =>
            commandOperationIds(entry).includes(id),
          ),
      )
    ) {
      return;
    }
    rememberOperationIds(operationIds);
    set((state) => {
      const past = [...state.past, cmd].slice(-MAX_HISTORY);
      return { past, future: [], canUndo: true, canRedo: false };
    });
  },

  async undo() {
    const { past, isReplaying } = get();
    if (past.length === 0 || isReplaying) return;
    // Project / Workspace replacement and window close own a destructive
    // lifecycle lease. Refuse before touching either stack so a shortcut
    // cannot create a post-quiescence DB write or consume a no-op command.
    if (!canScheduleQuiescenceMutation()) return;
    // Tree history can replace the active Scene as part of create/delete
    // replay. Keep the source stack intact while either editor or Chat owns
    // authority that must not be navigated away from.
    if (replayGuard?.() || isChatNavigationBlocked()) return;
    const cmd = past[past.length - 1];
    set({ isReplaying: true });
    let versionConflict = false;
    let unknownOutcome = false;
    try {
      await runTrackedHistoryReplay(cmd.undo);
    } catch (err) {
      if (isVersionConflictError(err)) {
        versionConflict = true;
        surfaceUndoConflict(cmd);
      } else if (isUnknownIpcOutcomeError(err)) {
        // The native write may already have committed. Keep the exact command
        // closure reachable so the user can retry with its retained requestId.
        unknownOutcome = true;
        throw err;
      } else {
        get().clear();
        throw err;
      }
    } finally {
      set((state) => {
        if (state.isReplaying === false) return state;
        if (unknownOutcome) {
          return { ...state, isReplaying: false };
        }
        if (versionConflict) {
          if (cmd.retainOnVersionConflict) {
            return { ...state, isReplaying: false };
          }
          const newPast = removeCommandByIdentity(state.past, cmd, true);
          if (newPast === null) {
            return {
              ...state,
              canUndo: state.past.length > 0,
              canRedo: state.future.length > 0,
              isReplaying: false,
            };
          }
          return {
            past: newPast,
            future: state.future,
            canUndo: newPast.length > 0,
            canRedo: state.future.length > 0,
            isReplaying: false,
          };
        }
        const newPast = removeCommandByIdentity(state.past, cmd, true);
        if (newPast === null) {
          return {
            ...state,
            canUndo: state.past.length > 0,
            canRedo: state.future.length > 0,
            isReplaying: false,
          };
        }
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
    if (!canScheduleQuiescenceMutation()) return;
    // See undo: both guards must run before consuming the future entry.
    if (replayGuard?.() || isChatNavigationBlocked()) return;
    const cmd = future[0];
    set({ isReplaying: true });
    let versionConflict = false;
    let unknownOutcome = false;
    try {
      await runTrackedHistoryReplay(cmd.redo);
    } catch (err) {
      if (isVersionConflictError(err)) {
        versionConflict = true;
        surfaceUndoConflict(cmd);
      } else if (isUnknownIpcOutcomeError(err)) {
        // See undo: preserving the source stack preserves the idempotency
        // request identity captured by this history command.
        unknownOutcome = true;
        throw err;
      } else {
        get().clear();
        throw err;
      }
    } finally {
      set((state) => {
        if (state.isReplaying === false) return state;
        if (unknownOutcome) {
          return { ...state, isReplaying: false };
        }
        if (versionConflict) {
          if (cmd.retainOnVersionConflict) {
            return { ...state, isReplaying: false };
          }
          const newFuture = removeCommandByIdentity(state.future, cmd, false);
          if (newFuture === null) {
            return {
              ...state,
              canUndo: state.past.length > 0,
              canRedo: state.future.length > 0,
              isReplaying: false,
            };
          }
          return {
            past: state.past,
            future: newFuture,
            canUndo: state.past.length > 0,
            canRedo: newFuture.length > 0,
            isReplaying: false,
          };
        }
        const newFuture = removeCommandByIdentity(state.future, cmd, false);
        if (newFuture === null) {
          return {
            ...state,
            canUndo: state.past.length > 0,
            canRedo: state.future.length > 0,
            isReplaying: false,
          };
        }
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
    seenOperationIds.clear();
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
        (c.kind === kind && c.entityId === entityId) ||
        c.affectedEntities?.some(
          (affected) =>
            affected.kind === kind && affected.entityId === entityId,
        ) === true;
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

  invalidateKind(kind) {
    set((state) => {
      const matches = (command: HistoryCommand) =>
        command.kind === kind ||
        command.affectedEntities?.some((affected) => affected.kind === kind) ===
          true;
      const past = state.past.filter((command) => !matches(command));
      const future = state.future.filter((command) => !matches(command));
      return {
        past,
        future,
        canUndo: past.length > 0,
        canRedo: future.length > 0,
      };
    });
  },

  async runAsTransaction(meta, fn) {
    // Replay must never create history. Pass a no-op collector so feature
    // mutations can keep the same explicit call shape.
    if (get().isReplaying) {
      await fn({ push: () => {} });
      return;
    }
    // A new compound UI operation is subject to the same lifecycle barrier as
    // a direct undo/redo. Existing replay is allowed above so strict
    // quiescence can wait for and finish work that began before acquisition.
    if (!canScheduleQuiescenceMutation()) return;
    const entries: HistoryCommand[] = [];
    const collectedOperationIds = new Set<string>();
    const collector: HistoryCollector = {
      push: (command) => {
        const operationIds = commandOperationIds(command);
        if (
          operationIds.some(
            (id) => seenOperationIds.has(id) || collectedOperationIds.has(id),
          )
        ) {
          return;
        }
        entries.push(command);
        for (const id of operationIds) collectedOperationIds.add(id);
      },
    };
    // A rejected callback commits no composite entry. Already-persisted
    // feature mutations remain an operation-level atomicity concern, but they
    // cannot contaminate unrelated history.
    await fn(collector);
    if (entries.length === 0) return;
    // 完了ガード: 例えば await 中にプロジェクトが切り替わった場合、旧プロジェクトの
    // 行を参照するクロージャを新プロジェクトの履歴へ commit しない（XPROJ 汚染防止）。
    if (meta.shouldCommit && !meta.shouldCommit()) return;
    get().push({
      kind: meta.kind,
      label: meta.label,
      ...(collectedOperationIds.size > 0
        ? { operationIds: [...collectedOperationIds] }
        : {}),
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
