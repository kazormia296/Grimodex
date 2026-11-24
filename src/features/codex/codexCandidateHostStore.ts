import { create } from "zustand";
import { toast } from "sonner";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import {
  extractCodexCandidatesResult,
  type CodexCandidate,
} from "./candidateExtractor";
import {
  loadDismissedCandidateKeys,
  saveDismissedCandidateKeys,
} from "./codexCandidateDismissals";
import { activeCandidates, candidateKey } from "./codexCandidates";
import { isCodexStructureExtractionReviewEnabled } from "./codexStructureExtractionFlag";

export type CodexCandidateScan = {
  status: "idle" | "scanning" | "done" | "failed";
  candidates: CodexCandidate[];
};

export interface CodexCandidateHostState {
  projectId: string | null;
  generation: number;
  scan: CodexCandidateScan;
  dismissed: Set<string>;
  dismissedLoaded: boolean;
  structureOpen: boolean;
  structureEverOpened: boolean;
  syncProject: (projectId: string | null) => void;
  setStructureOpen: (open: boolean) => void;
  openStructureReview: () => void;
  /**
   * 走査を要求する（同時に走る走査は 1 つ、待ちは最新の 1 つ）。
   * - 既定：走査中なら合流し、`done` ならその結果を再利用する（件数の読み取り用）。
   * - `refresh`：走査中なら合流し、`done` でも走査し直す（Report を開き直したとき、
   *   本文の変更を拾う。世代は進めない）。
   * - `force`：世代を進めて前の結果を捨て、走っている走査の後に 1 回だけ走査し直す（手動の再スキャン）。
   */
  requestScan: (options?: {
    force?: boolean;
    refresh?: boolean;
  }) => Promise<void>;
  commitDismissed: (next: Set<string>) => void;
  mutateDismissed: (
    next: Set<string>,
    prev: Set<string>,
    label: string,
    dismissFailedMessage: () => string,
  ) => void;
  reset: () => void;
}

interface ScanTask {
  projectId: string;
  generation: number;
  projectToken: number;
  promise: Promise<void>;
}

function emptyHostState() {
  return {
    projectId: null,
    generation: 0,
    scan: { status: "idle", candidates: [] } as CodexCandidateScan,
    dismissed: new Set<string>(),
    dismissedLoaded: false,
    structureOpen: false,
    structureEverOpened: false,
  };
}

export const useCodexCandidateHostStore = create<CodexCandidateHostState>()((
  set,
  get,
) => {
  let activeScan: ScanTask | null = null;
  let pendingScan: ScanTask | null = null;
  let projectToken = 0;
  let writeChain: Promise<unknown> = Promise.resolve();

  const persistValue = (
    projectId: string,
    value: Set<string>,
    dismissFailedMessage: () => string,
  ): Promise<void> => {
    const run = writeChain
      .catch(() => {})
      .then(() => saveDismissedCandidateKeys(projectId, value))
      .catch((error) => {
        if (get().projectId !== projectId || get().dismissed !== value) {
          return;
        }
        toast.error(dismissFailedMessage(), { description: String(error) });
        return loadDismissedCandidateKeys(projectId)
          .then((keys) => {
            if (get().projectId === projectId && get().dismissed === value) {
              set({ dismissed: keys });
            }
          })
          .catch(() => {});
      });
    writeChain = run;
    return run;
  };

  const startScan = (
    projectId: string,
    generation: number,
    token: number,
  ): Promise<void> => {
    set((state) =>
      projectToken === token &&
      state.projectId === projectId &&
      state.generation === generation
        ? {
            scan: {
              status: "scanning",
              candidates: state.scan.candidates,
            },
          }
        : state,
    );
    const task: ScanTask = {
      projectId,
      generation,
      projectToken: token,
      promise: Promise.resolve(),
    };
    task.promise = Promise.resolve()
      .then(() => extractCodexCandidatesResult(projectId))
      .then((result) => {
        if (
          projectToken !== token ||
          get().projectId !== projectId ||
          get().generation !== generation
        ) {
          return;
        }
        set({
          scan: result.ok
            ? { status: "done", candidates: result.candidates }
            : { status: "failed", candidates: [] },
        });
      })
      .catch(() => {
        if (
          projectToken === token &&
          get().projectId === projectId &&
          get().generation === generation
        ) {
          set({ scan: { status: "failed", candidates: [] } });
        }
      })
      .finally(() => {
        if (activeScan === task) activeScan = null;
      });
    activeScan = task;
    return task.promise;
  };

  const scanAfterActive = (
    projectId: string,
    generation: number,
    token: number,
  ): Promise<void> => {
    set((state) =>
      state.projectId === projectId && state.generation === generation
        ? {
            scan: {
              status: "scanning",
              candidates: state.scan.candidates,
            },
          }
        : state,
    );
    if (pendingScan) {
      pendingScan.projectId = projectId;
      pendingScan.generation = generation;
      pendingScan.projectToken = token;
      return pendingScan.promise;
    }
    if (!activeScan) return startScan(projectId, generation, token);

    const task: ScanTask = {
      projectId,
      generation,
      projectToken: token,
      promise: Promise.resolve(),
    };
    task.promise = activeScan.promise
      .catch(() => {})
      .then(() => {
        if (pendingScan !== task) return;
        pendingScan = null;
        const current = get();
        if (
          projectToken !== task.projectToken ||
          current.projectId !== task.projectId ||
          current.generation !== task.generation
        ) {
          return;
        }
        return startScan(task.projectId, task.generation, task.projectToken);
      });
    pendingScan = task;
    return task.promise;
  };

  return {
    ...emptyHostState(),

    syncProject(projectId) {
      const current = get();
      if (current.projectId === projectId) return;
      const generation = current.generation + 1;
      projectToken += 1;
      pendingScan = null;
      set({
        projectId,
        generation,
        scan: { status: "idle", candidates: [] },
        dismissed: new Set(),
        dismissedLoaded: false,
        structureOpen: false,
      });
      if (!projectId) return;
      const token = projectToken;
      void loadDismissedCandidateKeys(projectId)
        .then((keys) => {
          if (
            projectToken === token &&
            get().projectId === projectId &&
            get().generation === generation
          ) {
            set({ dismissed: keys, dismissedLoaded: true });
          }
        })
        .catch(() => {});
    },

    setStructureOpen(open) {
      if (open && !isCodexStructureExtractionReviewEnabled()) return;
      set((state) => ({
        structureOpen: open,
        structureEverOpened: state.structureEverOpened || open,
      }));
    },

    openStructureReview() {
      get().setStructureOpen(true);
    },

    requestScan(options) {
      const initial = get();
      if (!initial.projectId) return Promise.resolve();

      if (options?.force) {
        set((state) => ({
          generation: state.generation + 1,
          scan: { status: "scanning", candidates: state.scan.candidates },
        }));
      }
      const current = get();
      const projectId = current.projectId;
      if (!projectId) return Promise.resolve();
      if (
        !options?.force &&
        !options?.refresh &&
        current.scan.status === "done"
      ) {
        return Promise.resolve();
      }
      if (pendingScan) {
        pendingScan.projectId = projectId;
        pendingScan.generation = current.generation;
        pendingScan.projectToken = projectToken;
        return pendingScan.promise;
      }
      if (activeScan) {
        if (
          !options?.force &&
          activeScan.projectId === projectId &&
          activeScan.generation === current.generation &&
          activeScan.projectToken === projectToken
        ) {
          return activeScan.promise;
        }
        return scanAfterActive(projectId, current.generation, projectToken);
      }
      return startScan(projectId, current.generation, projectToken);
    },

    commitDismissed(next) {
      set({ dismissed: next });
    },

    mutateDismissed(next, prev, label, dismissFailedMessage) {
      const projectId = get().projectId;
      if (!projectId) return;
      get().commitDismissed(next);
      void persistValue(projectId, next, dismissFailedMessage);
      if (useGlobalHistoryStore.getState().isReplaying) return;
      useGlobalHistoryStore.getState().push({
        kind: "codex",
        label,
        async undo() {
          if (get().projectId === projectId) get().commitDismissed(prev);
          await persistValue(projectId, prev, dismissFailedMessage);
        },
        async redo() {
          if (get().projectId === projectId) get().commitDismissed(next);
          await persistValue(projectId, next, dismissFailedMessage);
        },
      });
    },

    reset() {
      projectToken += 1;
      activeScan = null;
      pendingScan = null;
      set((state) => ({ ...state, ...emptyHostState() }));
    },
  };
});

export function selectCodexCandidateCount(
  state: Pick<
    CodexCandidateHostState,
    "scan" | "dismissed" | "dismissedLoaded"
  >,
  entries: ReadonlyArray<{ name: string | null; aliases: string | null }>,
):
  | { status: "ready"; count: number }
  | { status: "not-counted" }
  | { status: "unavailable" } {
  if (state.scan.status === "failed") return { status: "unavailable" };
  if (state.scan.status !== "done" || !state.dismissedLoaded) {
    return { status: "not-counted" };
  }
  return {
    status: "ready",
    count: activeCandidates(state.scan.candidates, entries).filter(
      (candidate) => !state.dismissed.has(candidateKey(candidate.surface)),
    ).length,
  };
}
