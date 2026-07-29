import { create } from "zustand";
import i18next from "i18next";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { generateKeyBetween, cmpKeys } from "@/features/tree/fractionalIndex";
import {
  useGlobalHistoryStore,
  type HistoryCollector,
} from "@/store/globalHistoryStore";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import {
  PLOT_PHASE_TYPES,
  type PlotPhaseType,
  type PlotBranchKind,
} from "@/db/schema";
import {
  listPlotThreads,
  listPlotThreadLinks,
  listPlotThreadBranches,
  createPlotThread,
  updatePlotThread,
  deletePlotThread,
  createPlotThreadLink,
  updatePlotThreadLink,
  deletePlotThreadLink,
  createPlotThreadBranch,
  updatePlotThreadBranch,
  deletePlotThreadBranch,
  restorePlotThreadSnapshot,
  deletePlotThreadSnapshot,
  movePlotMarkerBundle,
  type PlotThreadRow,
  type PlotThreadLinkRow,
  type PlotThreadBranchRow,
  type PlotThreadMoveMarkerBundle,
  type PlotThreadMoveMarkerBundleResult,
} from "./api";
import {
  captureMutationAuthority,
  isCurrentMutationAuthority,
  runAuthoritativeMutation,
  type MutationAuthority,
  type MutationOutcome,
} from "@/features/concurrency/mutationAuthority";
import {
  getCreateResultMetadata,
  isCreateResultEntityPresent,
} from "@/lib/createResultMetadata";
import {
  createPendingCreateRequestRegistry,
  type PendingCreateRequest,
  type PendingCreateRequestRegistry,
} from "@/lib/pendingCreateRequestRegistry";
import { isUnknownIpcOutcomeError } from "@/lib/ipcOutcome";

/**
 * Undo/Redo: プロットスレッド操作を globalHistoryStore に1エントリ積む。
 * replay 中は no-op（push 自体も safety net で弾くが、ここで早期 return して
 * クロージャ生成も省く）。closures は逆操作 API + set を直接叩き、ストアの公開
 * mutation を呼ばない（再 push の再帰を避ける。codexStore と同方針）。
 * マーカー＋分岐は moveMarkerBundle がDB原子性と単一history entryを所有し、
 * 一括importのような独立mutation群だけを明示collectorへ束ねる。
 */
function recordPlotHistory(
  cmd: {
    label: string;
    entityId?: string;
    undo: () => Promise<void>;
    redo: () => Promise<void>;
  },
  collector?: HistoryCollector,
  authority: MutationAuthority = captureMutationAuthority(
    getCurrentProjectId(),
    getCurrentProjectId,
  ),
): void {
  const history = useGlobalHistoryStore.getState();
  if (history.isReplaying || !isCurrentMutationAuthority(authority)) return;
  (collector ?? history).push({
    kind: "plot",
    ...cmd,
    undo: async () => {
      if (!isCurrentMutationAuthority(authority)) return;
      await cmd.undo();
    },
    redo: async () => {
      if (!isCurrentMutationAuthority(authority)) return;
      await cmd.redo();
    },
  });
  // Single timelapse chokepoint for every plot mutation (thread / marker /
  // branch). `label` is already the human-readable action string, so it doubles
  // as the caption. Metadata domain — no rebaseline. no-op when recording off.
  recordChangeEvent({
    domain: "plot",
    opType: "change",
    entityType: "plot",
    entityId: cmd.entityId ?? null,
    payload: { label: cmd.label },
  });
}

async function replayPlotMutation<T>(
  authority: MutationAuthority,
  mutation: () => Promise<T>,
  publish: (value: T) => void,
): Promise<void> {
  const outcome = await runAuthoritativeMutation(authority, mutation);
  if (outcome.status === "current") publish(outcome.value);
}

export type PlotThreadImportIssueCode =
  | "INVALID_PROPOSAL"
  | "INVALID_PHASE"
  | "MISSING_NODE"
  | "DUPLICATE"
  | "CREATE_FAILED";

export interface PlotThreadImportIssue {
  kind: "thread" | "marker";
  proposalIndex: number;
  markerIndex?: number;
  label: string;
  code: PlotThreadImportIssueCode;
}

export interface PlotThreadImportResult {
  createdThreads: PlotThreadRow[];
  createdMarkers: PlotThreadLinkRow[];
  skipped: PlotThreadImportIssue[];
  failed: PlotThreadImportIssue[];
  aborted: boolean;
}

export interface PlotThreadImportProposal {
  /** Stable identity for retries of one extracted candidate. */
  retryKey?: string;
  name: string;
  description?: string | null;
  color?: string | null;
  markers: Array<{
    nodeId: string;
    phaseType: PlotPhaseType;
    note?: string | null;
  }>;
}

export interface PlotMarkerMovePlan {
  markerId: string;
  markerPatch: Partial<Pick<PlotThreadLinkRow, "threadId" | "nodeId">>;
  branchCreates?: Array<
    Pick<
      PlotThreadBranchRow,
      "fromThreadId" | "toThreadId" | "atNodeId" | "kind"
    >
  >;
  branchUpdates?: Array<{
    id: string;
    patch: Partial<
      Pick<PlotThreadBranchRow, "fromThreadId" | "toThreadId" | "atNodeId">
    >;
  }>;
  branchDeletes?: string[];
}

interface PlotThreadState {
  /** Project whose rows are currently allowed to be displayed or mutated. */
  activeProjectId: string | null;
  threads: PlotThreadRow[];
  links: PlotThreadLinkRow[];
  branches: PlotThreadBranchRow[];
  loading: boolean;
  /**
   * Synchronous Project-commit boundary. Old rows must disappear before the
   * best-effort optional hydrate starts, otherwise stale UI callbacks can call
   * the id-only mutation APIs against the previous Project.
   */
  resetForProject: (projectId: string) => void;
  load: (projectId: string) => Promise<void>;
  addThread: (
    projectId: string,
    name: string,
    color?: string | null,
  ) => Promise<void>;
  renameThread: (
    id: string,
    name: string,
    options?: { preexistingDraft?: boolean },
  ) => Promise<void>;
  setThreadColor: (id: string, color: string | null) => Promise<void>;
  /** ヘッダーのドラッグ並べ替え用。sortOrder を更新して行順を変える。 */
  reorderThread: (id: string, sortOrder: string) => Promise<void>;
  deleteThread: (id: string) => Promise<void>;
  addMarker: (
    threadId: string,
    nodeId: string,
    phaseType: PlotPhaseType,
  ) => Promise<void>;
  /**
   * Phase 4a: 抽出ウィザードの提案を一括取り込み（**1 undo**）。各提案 = 新規
   * スレッド + マーカー群。全体を runAsTransaction で 1 history エントリにまとめる。
   * 不正 phase / 重複 (threadId,nodeId,phaseType) はスキップ。プロジェクト切替で中断。
   */
  importPlotThreads: (
    projectId: string,
    proposals: PlotThreadImportProposal[],
  ) => Promise<PlotThreadImportResult>;
  updateMarker: (
    id: string,
    patch: Partial<
      Pick<PlotThreadLinkRow, "threadId" | "nodeId" | "phaseType" | "note">
    >,
    history?: HistoryCollector,
    options?: { preexistingDraft?: boolean },
  ) => Promise<void>;
  /** Marker + dependent branch transitions commit and replay as one DB unit. */
  moveMarkerBundle: (plan: PlotMarkerMovePlan) => Promise<void>;
  deleteMarker: (id: string) => Promise<void>;
  addBranch: (
    data: {
      projectId: string;
      fromThreadId: string;
      toThreadId: string;
      atNodeId: string;
      kind: PlotBranchKind;
    },
    history?: HistoryCollector,
  ) => Promise<void>;
  updateBranch: (
    id: string,
    patch: Partial<
      Pick<PlotThreadBranchRow, "fromThreadId" | "toThreadId" | "atNodeId">
    >,
    history?: HistoryCollector,
  ) => Promise<void>;
  deleteBranch: (id: string, history?: HistoryCollector) => Promise<void>;
}

let plotLoadGeneration = 0;
const pendingThreadCreates =
  createPendingCreateRequestRegistry<Parameters<typeof createPlotThread>[0]>();
const pendingLinkCreates =
  createPendingCreateRequestRegistry<
    Parameters<typeof createPlotThreadLink>[0]
  >();
const pendingBranchCreates =
  createPendingCreateRequestRegistry<
    Parameters<typeof createPlotThreadBranch>[0]
  >();
const pendingPlotDeleteSnapshots =
  createPendingCreateRequestRegistry<
    Parameters<typeof deletePlotThreadSnapshot>[0]
  >();
const pendingPlotMarkerMoves =
  createPendingCreateRequestRegistry<PlotThreadMoveMarkerBundle>();
const pendingPlotImportThreads = new Map<string, string>();

function shouldRetainPendingCreate(error: unknown): boolean {
  return isUnknownIpcOutcomeError(error);
}

function releasePlotCreateRequests(): void {
  pendingThreadCreates.clear();
  pendingLinkCreates.clear();
  pendingBranchCreates.clear();
  pendingPlotDeleteSnapshots.clear();
  pendingPlotMarkerMoves.clear();
  pendingPlotImportThreads.clear();
}

async function runRetainedPlotCreate<TPayload, TResult>(
  authority: MutationAuthority,
  requests: PendingCreateRequestRegistry<TPayload>,
  pending: PendingCreateRequest<TPayload>,
  createEntity: (payload: TPayload) => Promise<TResult>,
): Promise<MutationOutcome<TResult>> {
  try {
    const outcome = await runAuthoritativeMutation(authority, () =>
      createEntity(pending.payload),
    );
    requests.release(pending);
    return outcome;
  } catch (error) {
    if (!shouldRetainPendingCreate(error)) {
      requests.release(pending);
    }
    throw error;
  }
}

type PlotRestoreSnapshotPayload = Parameters<
  typeof restorePlotThreadSnapshot
>[0];
type PlotDeleteSnapshotPayload = Parameters<typeof deletePlotThreadSnapshot>[0];

async function runRetainedPlotRestore(
  requests: PendingCreateRequestRegistry<PlotRestoreSnapshotPayload>,
  snapshot: Omit<PlotRestoreSnapshotPayload, "requestId">,
): Promise<void> {
  const signature = JSON.stringify(snapshot);
  const pending = requests.acquire("restore", signature, (requestId) => ({
    ...snapshot,
    requestId,
  }));
  try {
    const result = await restorePlotThreadSnapshot(pending.payload);
    requests.release(pending);
    if (!isCreateResultEntityPresent(result)) {
      throw new Error(
        "plot restore replay refers to rows that are no longer present",
      );
    }
  } catch (error) {
    if (!shouldRetainPendingCreate(error)) {
      requests.release(pending);
    }
    throw error;
  }
}

async function runRetainedPlotDelete(
  requests: PendingCreateRequestRegistry<PlotDeleteSnapshotPayload>,
  key: string,
  snapshot: Omit<PlotDeleteSnapshotPayload, "requestId">,
): Promise<void> {
  const signature = JSON.stringify(snapshot);
  const pending = requests.acquire(key, signature, (requestId) => ({
    ...snapshot,
    requestId,
  }));
  try {
    const result = await deletePlotThreadSnapshot(pending.payload);
    requests.release(pending);
    if (!isCreateResultEntityPresent(result)) {
      throw new Error(
        "plot delete replay no longer matches the current marker rows",
      );
    }
  } catch (error) {
    if (!shouldRetainPendingCreate(error)) {
      requests.release(pending);
    }
    throw error;
  }
}

async function runRetainedPlotMarkerMove(
  requests: PendingCreateRequestRegistry<PlotThreadMoveMarkerBundle>,
  key: string,
  bundle: Omit<PlotThreadMoveMarkerBundle, "requestId">,
): Promise<PlotThreadMoveMarkerBundleResult> {
  const signature = JSON.stringify(bundle);
  const pending = requests.acquire(key, signature, (requestId) => ({
    ...bundle,
    requestId,
  }));
  try {
    const result = await movePlotMarkerBundle(pending.payload);
    requests.release(pending);
    if (!isCreateResultEntityPresent(result)) {
      throw new Error(
        "plot marker move replay no longer matches the current marker rows",
      );
    }
    return result;
  } catch (error) {
    if (!shouldRetainPendingCreate(error)) {
      requests.release(pending);
    }
    throw error;
  }
}

function reversePlotMarkerMove(
  bundle: Omit<PlotThreadMoveMarkerBundle, "requestId">,
): Omit<PlotThreadMoveMarkerBundle, "requestId"> {
  return {
    projectId: bundle.projectId,
    markerBefore: bundle.markerAfter,
    markerAfter: bundle.markerBefore,
    branchTransitions: bundle.branchTransitions.map((transition) => ({
      before: transition.after,
      after: transition.before,
    })),
  };
}

function captureBoundPlotAuthority(
  state: PlotThreadState,
  projectId = getCurrentProjectId(),
): MutationAuthority | null {
  if (
    state.activeProjectId !== projectId ||
    getCurrentProjectId() !== projectId
  ) {
    return null;
  }
  return captureMutationAuthority(projectId, getCurrentProjectId);
}

export const usePlotThreadStore = create<PlotThreadState>((set, get) => ({
  activeProjectId: null,
  threads: [],
  links: [],
  branches: [],
  loading: false,

  resetForProject: (projectId) => {
    plotLoadGeneration++;
    releasePlotCreateRequests();
    set({
      activeProjectId: projectId,
      threads: [],
      links: [],
      branches: [],
      loading: false,
    });
  },

  load: async (projectId) => {
    const authority = captureBoundPlotAuthority(get(), projectId);
    if (!authority) return;
    const generation = ++plotLoadGeneration;
    set({ loading: true });
    try {
      const [threads, links, branches] = await Promise.all([
        listPlotThreads(projectId),
        listPlotThreadLinks(projectId),
        listPlotThreadBranches(projectId),
      ]);
      // Project IDだけでなく、同一pathを開き直したworkspace revisionも照合する。
      if (
        generation !== plotLoadGeneration ||
        get().activeProjectId !== projectId ||
        !isCurrentMutationAuthority(authority)
      ) {
        return;
      }
      set({ threads, links, branches, loading: false });
    } catch (error) {
      if (
        generation === plotLoadGeneration &&
        get().activeProjectId === projectId &&
        isCurrentMutationAuthority(authority)
      ) {
        set({ loading: false });
      }
      throw error;
    }
  },

  addThread: async (projectId, name, color = null) => {
    const authority = captureBoundPlotAuthority(get(), projectId);
    if (!authority) return;
    // sortOrder は「末尾」ではなく実際の最大キーの後に置く
    // （listPlotThreads の返却順に依存しないため）。
    const maxKey = get().threads.reduce<string | null>(
      (m, t) => (m === null || cmpKeys(t.sortOrder, m) > 0 ? t.sortOrder : m),
      null,
    );
    const sortOrder = generateKeyBetween(maxKey, null);
    const signature = JSON.stringify({ projectId, name, color });
    const pending = pendingThreadCreates.acquire(
      `thread:${signature}`,
      signature,
      (id) => ({ id, projectId, name, color, sortOrder }),
    );
    const outcome = await runRetainedPlotCreate(
      authority,
      pendingThreadCreates,
      pending,
      createPlotThread,
    );
    if (outcome.status !== "current") return;
    const created = outcome.value;
    if (!isCreateResultEntityPresent(created)) return;
    if (getCreateResultMetadata(created)?.replayed) {
      if (get().threads.some((thread) => thread.id === created.id)) return;
      set({ threads: [...get().threads, created] });
    } else {
      set({ threads: [...get().threads, created] });
    }
    const captured = { ...created };
    const redoRestoreRequests =
      createPendingCreateRequestRegistry<PlotRestoreSnapshotPayload>();
    recordPlotHistory(
      {
        label: i18next.t("plotThread.history.addThread", "スレッド追加"),
        entityId: captured.id,
        undo: async () => {
          await replayPlotMutation(
            authority,
            () => deletePlotThread(captured.id),
            () =>
              set({
                threads: get().threads.filter((t) => t.id !== captured.id),
              }),
          );
        },
        redo: async () => {
          await replayPlotMutation(
            authority,
            () =>
              runRetainedPlotRestore(redoRestoreRequests, {
                projectId: captured.projectId,
                thread: captured,
                links: [],
                branches: [],
              }),
            () => set({ threads: [...get().threads, captured] }),
          );
        },
      },
      undefined,
      authority,
    );
  },

  renameThread: async (id, name, options) => {
    const before = get().threads.find((t) => t.id === id)?.name;
    if (before === undefined) {
      if (options?.preexistingDraft) {
        throw new Error(`Plot thread draft target is unavailable: ${id}`);
      }
      return;
    }
    const authority = captureBoundPlotAuthority(get());
    if (!authority) {
      if (options?.preexistingDraft) {
        throw new Error(`Plot thread draft authority is stale: ${id}`);
      }
      return;
    }
    const outcome = await runAuthoritativeMutation(
      authority,
      () => updatePlotThread(id, { name }),
      options,
    );
    if (outcome.status !== "current") {
      if (options?.preexistingDraft) {
        throw new Error(`Plot thread draft authority changed: ${id}`);
      }
      return;
    }
    set({
      threads: get().threads.map((thread) =>
        thread.id === id ? outcome.value : thread,
      ),
    });
    recordPlotHistory(
      {
        label: i18next.t("plotThread.history.renameThread", "スレッド名変更"),
        entityId: id,
        undo: async () => {
          await replayPlotMutation(
            authority,
            () => updatePlotThread(id, { name: before }),
            (updated) =>
              set({
                threads: get().threads.map((t) => (t.id === id ? updated : t)),
              }),
          );
        },
        redo: async () => {
          await replayPlotMutation(
            authority,
            () => updatePlotThread(id, { name }),
            (updated) =>
              set({
                threads: get().threads.map((t) => (t.id === id ? updated : t)),
              }),
          );
        },
      },
      undefined,
      authority,
    );
  },

  setThreadColor: async (id, color) => {
    const before = get().threads.find((t) => t.id === id);
    if (!before) return;
    const authority = captureBoundPlotAuthority(get());
    if (!authority) return;
    const outcome = await runAuthoritativeMutation(authority, () =>
      updatePlotThread(id, { color }),
    );
    if (outcome.status !== "current") return;
    set({
      threads: get().threads.map((thread) =>
        thread.id === id ? outcome.value : thread,
      ),
    });
    const prevColor = before.color;
    recordPlotHistory(
      {
        label: i18next.t("plotThread.history.colorThread", "スレッド色変更"),
        entityId: id,
        undo: async () => {
          await replayPlotMutation(
            authority,
            () => updatePlotThread(id, { color: prevColor }),
            (updated) =>
              set({
                threads: get().threads.map((t) => (t.id === id ? updated : t)),
              }),
          );
        },
        redo: async () => {
          await replayPlotMutation(
            authority,
            () => updatePlotThread(id, { color }),
            (updated) =>
              set({
                threads: get().threads.map((t) => (t.id === id ? updated : t)),
              }),
          );
        },
      },
      undefined,
      authority,
    );
  },

  reorderThread: async (id, sortOrder) => {
    const before = get().threads.find((t) => t.id === id)?.sortOrder;
    if (before === undefined) return;
    const authority = captureBoundPlotAuthority(get());
    if (!authority) return;
    // 楽観更新: ドロップ直後にアニメの目標が新ホーム順になるよう、IPC await の前に
    // store の順序を先に反映する（失敗時のみ元へ戻す）。これをしないと await の間
    // homeLaneModel が旧順序のままで、掴んでいたスレッドが旧位置へ逆向きにイージング
    // してから新位置へ飛ぶチラつきが出る。
    set({
      threads: get().threads.map((t) =>
        t.id === id ? { ...t, sortOrder } : t,
      ),
    });
    try {
      const outcome = await runAuthoritativeMutation(authority, () =>
        updatePlotThread(id, { sortOrder }),
      );
      if (outcome.status !== "current") {
        if (isCurrentMutationAuthority(authority)) {
          set({
            threads: get().threads.map((thread) =>
              thread.id === id ? { ...thread, sortOrder: before } : thread,
            ),
          });
        }
        return;
      }
      set({
        threads: get().threads.map((thread) =>
          thread.id === id ? outcome.value : thread,
        ),
      });
    } catch (e) {
      if (before !== undefined && isCurrentMutationAuthority(authority))
        set({
          threads: get().threads.map((t) =>
            t.id === id ? { ...t, sortOrder: before } : t,
          ),
        });
      throw e;
    }
    recordPlotHistory(
      {
        label: i18next.t(
          "plotThread.history.reorderThread",
          "スレッド並べ替え",
        ),
        entityId: id,
        undo: async () => {
          await replayPlotMutation(
            authority,
            () => updatePlotThread(id, { sortOrder: before }),
            (updated) =>
              set({
                threads: get().threads.map((t) => (t.id === id ? updated : t)),
              }),
          );
        },
        redo: async () => {
          await replayPlotMutation(
            authority,
            () => updatePlotThread(id, { sortOrder }),
            (updated) =>
              set({
                threads: get().threads.map((t) => (t.id === id ? updated : t)),
              }),
          );
        },
      },
      undefined,
      authority,
    );
  },

  deleteThread: async (id) => {
    const thread = get().threads.find((t) => t.id === id);
    if (!thread) return;
    const authority = captureBoundPlotAuthority(get());
    if (!authority) return;
    const removedLinks = get().links.filter((l) => l.threadId === id);
    // from/to どちらかが消えた分岐エッジも CASCADE で消える。
    const removedBranches = get().branches.filter(
      (b) => b.fromThreadId === id || b.toThreadId === id,
    );
    const applyDelete = () =>
      set({
        threads: get().threads.filter((t) => t.id !== id),
        links: get().links.filter((l) => l.threadId !== id), // CASCADE をローカルにも反映
        branches: get().branches.filter(
          (b) => b.fromThreadId !== id && b.toThreadId !== id,
        ),
      });
    const outcome = await runAuthoritativeMutation(authority, () =>
      deletePlotThread(id),
    );
    if (outcome.status !== "current") return;
    applyDelete();
    const undoRestoreRequests =
      createPendingCreateRequestRegistry<PlotRestoreSnapshotPayload>();
    recordPlotHistory(
      {
        label: i18next.t("plotThread.history.deleteThread", "スレッド削除"),
        entityId: id,
        undo: async () => {
          await replayPlotMutation(
            authority,
            () =>
              runRetainedPlotRestore(undoRestoreRequests, {
                projectId: thread.projectId,
                thread,
                links: removedLinks,
                branches: removedBranches,
              }),
            () =>
              set({
                threads: [...get().threads, thread],
                links: [...get().links, ...removedLinks],
                branches: [...get().branches, ...removedBranches],
              }),
          );
        },
        redo: async () => {
          await replayPlotMutation(
            authority,
            () => deletePlotThread(id),
            applyDelete,
          );
        },
      },
      undefined,
      authority,
    );
  },

  addMarker: async (threadId, nodeId, phaseType) => {
    if (!get().threads.some((thread) => thread.id === threadId)) return;
    const authority = captureBoundPlotAuthority(get());
    if (!authority) return;
    const signature = JSON.stringify({
      projectId: authority.projectId,
      threadId,
      nodeId,
      phaseType,
    });
    const pending = pendingLinkCreates.acquire(
      `link:${signature}`,
      signature,
      (id) => ({ id, threadId, nodeId, phaseType }),
    );
    const outcome = await runRetainedPlotCreate(
      authority,
      pendingLinkCreates,
      pending,
      createPlotThreadLink,
    );
    if (outcome.status !== "current") return;
    const created = outcome.value;
    if (!isCreateResultEntityPresent(created)) return;
    if (getCreateResultMetadata(created)?.replayed) {
      if (get().links.some((link) => link.id === created.id)) return;
      set({ links: [...get().links, created] });
    } else {
      set({ links: [...get().links, created] });
    }
    const captured = { ...created };
    const redoRestoreRequests =
      createPendingCreateRequestRegistry<PlotRestoreSnapshotPayload>();
    recordPlotHistory(
      {
        label: i18next.t("plotThread.history.addMarker", "マーカー追加"),
        entityId: captured.id,
        undo: async () => {
          await replayPlotMutation(
            authority,
            () => deletePlotThreadLink(captured.id),
            () =>
              set({
                links: get().links.filter((link) => link.id !== captured.id),
              }),
          );
        },
        redo: async () => {
          await replayPlotMutation(
            authority,
            () =>
              runRetainedPlotRestore(redoRestoreRequests, {
                projectId: authority.projectId,
                thread: null,
                links: [captured],
                branches: [],
              }),
            () => set({ links: [...get().links, captured] }),
          );
        },
      },
      undefined,
      authority,
    );
  },

  importPlotThreads: async (projectId, proposals) => {
    const result: PlotThreadImportResult = {
      createdThreads: [],
      createdMarkers: [],
      skipped: [],
      failed: [],
      aborted: false,
    };
    const authority = captureBoundPlotAuthority(get(), projectId);
    if (!authority) {
      result.aborted = true;
      return result;
    }
    const importProgressKeys = new Set<string>();

    // 成功した mutation だけを明示 collector へ入れ、部分失敗時にも正確な
    // composite Undo と項目別結果を返す。ambient な async batch は使わない。
    await useGlobalHistoryStore.getState().runAsTransaction(
      {
        kind: "plot",
        label: i18next.t("plotThread.history.importThreads", "スレッド取込"),
        shouldCommit: () =>
          !result.aborted && isCurrentMutationAuthority(authority),
      },
      async (collector) => {
        for (const [proposalIndex, proposal] of proposals.entries()) {
          const name = proposal.name.trim();
          if (name.length === 0 || proposal.markers.length === 0) {
            result.skipped.push({
              kind: "thread",
              proposalIndex,
              label: name || proposal.name,
              code: "INVALID_PROPOSAL",
            });
            continue;
          }
          if (!isCurrentMutationAuthority(authority)) {
            result.aborted = true;
            return;
          }

          // --- thread ---
          const color = proposal.color ?? null;
          const description = proposal.description?.trim() || null;
          const threadPayloadSignature = JSON.stringify({
            projectId,
            name,
            color,
            description,
          });
          const proposalRetryKey =
            proposal.retryKey ??
            JSON.stringify({
              proposalIndex,
              projectId,
              name,
              color,
              description,
            });
          const importProgressKey = `${projectId}:${proposalRetryKey}`;
          importProgressKeys.add(importProgressKey);
          const resumedThreadId =
            pendingPlotImportThreads.get(importProgressKey);
          let thread = resumedThreadId
            ? get().threads.find(
                (candidate) => candidate.id === resumedThreadId,
              )
            : undefined;
          const resumedImportThread = thread !== undefined;
          if (resumedThreadId && !thread) {
            pendingPlotImportThreads.delete(importProgressKey);
          }

          if (!thread) {
            const maxKey = get().threads.reduce<string | null>(
              (max, candidate) =>
                max === null || cmpKeys(candidate.sortOrder, max) > 0
                  ? candidate.sortOrder
                  : max,
              null,
            );
            const sortOrder = generateKeyBetween(maxKey, null);
            const pendingThread = pendingThreadCreates.acquire(
              `import-thread:${proposalRetryKey}:${threadPayloadSignature}`,
              threadPayloadSignature,
              (id) => ({
                id,
                projectId,
                name,
                color,
                description,
                sortOrder,
              }),
            );
            let threadOutcome;
            try {
              threadOutcome = await runRetainedPlotCreate(
                authority,
                pendingThreadCreates,
                pendingThread,
                createPlotThread,
              );
            } catch {
              result.failed.push({
                kind: "thread",
                proposalIndex,
                label: name,
                code: "CREATE_FAILED",
              });
              continue;
            }
            if (threadOutcome.status !== "current") {
              result.aborted = true;
              return;
            }
            thread = threadOutcome.value;
            if (!isCreateResultEntityPresent(thread)) {
              result.failed.push({
                kind: "thread",
                proposalIndex,
                label: name,
                code: "CREATE_FAILED",
              });
              continue;
            }
            const threadAlreadyPresent = get().threads.some(
              (candidate) => candidate.id === thread?.id,
            );
            if (!threadAlreadyPresent) {
              set({ threads: [...get().threads, thread] });
            }
            result.createdThreads.push(thread);
            pendingPlotImportThreads.set(importProgressKey, thread.id);

            if (
              !getCreateResultMetadata(thread)?.replayed ||
              !threadAlreadyPresent
            ) {
              const capturedThread = { ...thread };
              const redoRestoreRequests =
                createPendingCreateRequestRegistry<PlotRestoreSnapshotPayload>();
              recordPlotHistory(
                {
                  label: i18next.t(
                    "plotThread.history.addThread",
                    "スレッド追加",
                  ),
                  entityId: capturedThread.id,
                  undo: async () => {
                    await replayPlotMutation(
                      authority,
                      () => deletePlotThread(capturedThread.id),
                      () =>
                        set({
                          threads: get().threads.filter(
                            (candidate) => candidate.id !== capturedThread.id,
                          ),
                        }),
                    );
                  },
                  redo: async () => {
                    await replayPlotMutation(
                      authority,
                      () =>
                        runRetainedPlotRestore(redoRestoreRequests, {
                          projectId: capturedThread.projectId,
                          thread: capturedThread,
                          links: [],
                          branches: [],
                        }),
                      () =>
                        set({
                          threads: [...get().threads, capturedThread],
                        }),
                    );
                  },
                },
                collector,
                authority,
              );
            }
          }

          if (!thread) {
            result.failed.push({
              kind: "thread",
              proposalIndex,
              label: name,
              code: "CREATE_FAILED",
            });
            continue;
          }

          // --- markers（phase 検証 + dedup）---
          const seen = new Set<string>();
          for (const [markerIndex, marker] of proposal.markers.entries()) {
            const markerLabel = marker.nodeId || name;
            if (
              !(PLOT_PHASE_TYPES as readonly string[]).includes(
                marker.phaseType,
              )
            ) {
              result.skipped.push({
                kind: "marker",
                proposalIndex,
                markerIndex,
                label: markerLabel,
                code: "INVALID_PHASE",
              });
              continue;
            }
            if (!marker.nodeId) {
              result.skipped.push({
                kind: "marker",
                proposalIndex,
                markerIndex,
                label: name,
                code: "MISSING_NODE",
              });
              continue;
            }
            const key = `${marker.nodeId}::${marker.phaseType}`;
            if (seen.has(key)) {
              result.skipped.push({
                kind: "marker",
                proposalIndex,
                markerIndex,
                label: markerLabel,
                code: "DUPLICATE",
              });
              continue;
            }
            seen.add(key);
            if (
              get().links.some(
                (link) =>
                  link.threadId === thread.id &&
                  link.nodeId === marker.nodeId &&
                  link.phaseType === marker.phaseType,
              )
            ) {
              if (resumedImportThread) {
                continue;
              }
              result.skipped.push({
                kind: "marker",
                proposalIndex,
                markerIndex,
                label: markerLabel,
                code: "DUPLICATE",
              });
              continue;
            }
            if (!isCurrentMutationAuthority(authority)) {
              result.aborted = true;
              return;
            }

            const note = marker.note?.trim() || null;
            const linkSignature = JSON.stringify({
              projectId,
              threadId: thread.id,
              nodeId: marker.nodeId,
              phaseType: marker.phaseType,
              note,
            });
            const pendingLink = pendingLinkCreates.acquire(
              `import-link:${proposalRetryKey}:${markerIndex}:${linkSignature}`,
              linkSignature,
              (id) => ({
                id,
                threadId: thread.id,
                nodeId: marker.nodeId,
                phaseType: marker.phaseType,
                note,
              }),
            );
            let linkOutcome;
            try {
              linkOutcome = await runRetainedPlotCreate(
                authority,
                pendingLinkCreates,
                pendingLink,
                createPlotThreadLink,
              );
            } catch {
              result.failed.push({
                kind: "marker",
                proposalIndex,
                markerIndex,
                label: markerLabel,
                code: "CREATE_FAILED",
              });
              continue;
            }
            if (linkOutcome.status !== "current") {
              result.aborted = true;
              return;
            }
            const link = linkOutcome.value;
            if (!isCreateResultEntityPresent(link)) {
              result.failed.push({
                kind: "marker",
                proposalIndex,
                markerIndex,
                label: markerLabel,
                code: "CREATE_FAILED",
              });
              continue;
            }
            const linkAlreadyPresent = get().links.some(
              (candidate) => candidate.id === link.id,
            );
            if (!linkAlreadyPresent) {
              set({ links: [...get().links, link] });
            }
            result.createdMarkers.push(link);
            if (getCreateResultMetadata(link)?.replayed && linkAlreadyPresent) {
              continue;
            }
            const capturedLink = { ...link };
            const redoRestoreRequests =
              createPendingCreateRequestRegistry<PlotRestoreSnapshotPayload>();
            recordPlotHistory(
              {
                label: i18next.t(
                  "plotThread.history.addMarker",
                  "マーカー追加",
                ),
                entityId: capturedLink.id,
                undo: async () => {
                  await replayPlotMutation(
                    authority,
                    () => deletePlotThreadLink(capturedLink.id),
                    () =>
                      set({
                        links: get().links.filter(
                          (candidate) => candidate.id !== capturedLink.id,
                        ),
                      }),
                  );
                },
                redo: async () => {
                  await replayPlotMutation(
                    authority,
                    () =>
                      runRetainedPlotRestore(redoRestoreRequests, {
                        projectId: authority.projectId,
                        thread: null,
                        links: [capturedLink],
                        branches: [],
                      }),
                    () => set({ links: [...get().links, capturedLink] }),
                  );
                },
              },
              collector,
              authority,
            );
          }
        }
      },
    );
    if (
      !result.aborted &&
      result.skipped.length === 0 &&
      result.failed.length === 0
    ) {
      for (const key of importProgressKeys) {
        pendingPlotImportThreads.delete(key);
      }
    }
    return result;
  },

  updateMarker: async (id, patch, history, options) => {
    const before = get().links.find((l) => l.id === id);
    if (!before) {
      if (options?.preexistingDraft) {
        throw new Error(`Plot marker draft target is unavailable: ${id}`);
      }
      return;
    }
    if (
      patch.threadId !== undefined &&
      !get().threads.some((thread) => thread.id === patch.threadId)
    ) {
      if (options?.preexistingDraft) {
        throw new Error(`Plot marker draft thread is unavailable: ${id}`);
      }
      return;
    }
    const authority = captureBoundPlotAuthority(get());
    if (!authority) {
      if (options?.preexistingDraft) {
        throw new Error(`Plot marker draft authority is stale: ${id}`);
      }
      return;
    }
    const outcome = await runAuthoritativeMutation(
      authority,
      () => updatePlotThreadLink(id, patch),
      options,
    );
    if (outcome.status !== "current") {
      if (options?.preexistingDraft) {
        throw new Error(`Plot marker draft authority changed: ${id}`);
      }
      return;
    }
    set({
      links: get().links.map((link) => (link.id === id ? outcome.value : link)),
    });
    // patch で触れたキーだけ元値を控える before patch を作る。
    const beforePatch: typeof patch = {};
    if ("threadId" in patch) beforePatch.threadId = before.threadId;
    if ("nodeId" in patch) beforePatch.nodeId = before.nodeId;
    if ("phaseType" in patch) beforePatch.phaseType = before.phaseType;
    if ("note" in patch) beforePatch.note = before.note;
    recordPlotHistory(
      {
        label: markerPatchLabel(patch),
        entityId: id,
        undo: async () => {
          await replayPlotMutation(
            authority,
            () => updatePlotThreadLink(id, beforePatch),
            (updated) =>
              set({
                links: get().links.map((link) =>
                  link.id === id ? updated : link,
                ),
              }),
          );
        },
        redo: async () => {
          await replayPlotMutation(
            authority,
            () => updatePlotThreadLink(id, patch),
            (updated) =>
              set({
                links: get().links.map((link) =>
                  link.id === id ? updated : link,
                ),
              }),
          );
        },
      },
      history,
      authority,
    );
  },

  moveMarkerBundle: async (plan) => {
    const markerBefore = get().links.find((link) => link.id === plan.markerId);
    const authority = captureBoundPlotAuthority(get());
    if (!markerBefore || !authority) return;
    const markerThreadId = plan.markerPatch.threadId ?? markerBefore.threadId;
    if (!get().threads.some((thread) => thread.id === markerThreadId)) return;

    const deletes = new Set(plan.branchDeletes ?? []);
    const updateIds = new Set(
      (plan.branchUpdates ?? []).map((transition) => transition.id),
    );
    if (
      deletes.size !== (plan.branchDeletes ?? []).length ||
      updateIds.size !== (plan.branchUpdates ?? []).length ||
      [...deletes].some((id) => updateIds.has(id))
    ) {
      return;
    }

    const branchById = new Map(
      get().branches.map((branch) => [branch.id, branch] as const),
    );
    const branchUpdates = (plan.branchUpdates ?? []).map((transition) => {
      const before = branchById.get(transition.id);
      return before
        ? { before, after: { ...before, ...transition.patch } }
        : null;
    });
    if (branchUpdates.some((transition) => transition === null)) return;
    const deletedBranches = [...deletes].map((id) => branchById.get(id));
    if (deletedBranches.some((branch) => branch === undefined)) return;

    const knownThread = (id: string) =>
      get().threads.some((thread) => thread.id === id);
    const proposedBranches = [
      ...get()
        .branches.filter((branch) => !deletes.has(branch.id))
        .map(
          (branch) =>
            branchUpdates.find(
              (transition) => transition?.before.id === branch.id,
            )?.after ?? branch,
        ),
      ...(plan.branchCreates ?? []).map((branch, index) => ({
        id: `pending:${index}`,
        projectId: authority.projectId,
        ...branch,
        createdAt: "",
        updatedAt: "",
      })),
    ];
    const topology = new Set<string>();
    for (const branch of proposedBranches) {
      if (
        branch.fromThreadId === branch.toThreadId ||
        !knownThread(branch.fromThreadId) ||
        !knownThread(branch.toThreadId)
      ) {
        return;
      }
      const key = JSON.stringify([
        branch.fromThreadId,
        branch.toThreadId,
        branch.atNodeId,
        branch.kind,
      ]);
      if (topology.has(key)) return;
      topology.add(key);
    }

    const markerChanged =
      markerThreadId !== markerBefore.threadId ||
      (plan.markerPatch.nodeId !== undefined &&
        plan.markerPatch.nodeId !== markerBefore.nodeId);
    if (
      !markerChanged &&
      branchUpdates.length === 0 &&
      deletes.size === 0 &&
      (plan.branchCreates ?? []).length === 0
    ) {
      return;
    }

    const semanticSignature = JSON.stringify({
      projectId: authority.projectId,
      markerBefore,
      markerPatch: plan.markerPatch,
      branchUpdates,
      deletedBranches,
      branchCreates: plan.branchCreates ?? [],
    });
    const pending = pendingPlotMarkerMoves.acquire(
      `marker-move:${authority.projectId}:${plan.markerId}`,
      semanticSignature,
      (requestId) => {
        const now = new Date().toISOString();
        return {
          requestId,
          projectId: authority.projectId,
          markerBefore,
          markerAfter: {
            ...markerBefore,
            ...plan.markerPatch,
            updatedAt: now,
          },
          branchTransitions: [
            ...branchUpdates.map((transition) => {
              const value = transition!;
              return {
                before: value.before,
                after: { ...value.after, updatedAt: now },
              };
            }),
            ...deletedBranches.map((branch) => ({
              before: branch!,
              after: null,
            })),
            ...(plan.branchCreates ?? []).map((branch) => ({
              before: null,
              after: {
                id: crypto.randomUUID(),
                projectId: authority.projectId,
                ...branch,
                createdAt: now,
                updatedAt: now,
              },
            })),
          ],
        };
      },
    );
    const outcome = await runRetainedPlotCreate(
      authority,
      pendingPlotMarkerMoves,
      pending,
      movePlotMarkerBundle,
    );
    if (
      outcome.status !== "current" ||
      !isCreateResultEntityPresent(outcome.value)
    ) {
      return;
    }

    const bundle = {
      projectId: pending.payload.projectId,
      markerBefore: pending.payload.markerBefore,
      markerAfter: pending.payload.markerAfter,
      branchTransitions: pending.payload.branchTransitions,
    };
    const publish = (
      appliedBundle: Omit<PlotThreadMoveMarkerBundle, "requestId">,
      result: PlotThreadMoveMarkerBundleResult,
    ) => {
      const transitionedIds = new Set(
        appliedBundle.branchTransitions.flatMap((transition) => [
          ...(transition.before ? [transition.before.id] : []),
          ...(transition.after ? [transition.after.id] : []),
        ]),
      );
      set({
        links: get().links.map((link) =>
          link.id === appliedBundle.markerBefore.id ? result.marker : link,
        ),
        branches: [
          ...get().branches.filter((branch) => !transitionedIds.has(branch.id)),
          ...result.branches,
        ],
      });
    };
    publish(bundle, outcome.value);

    const reverseBundle = reversePlotMarkerMove(bundle);
    const undoRequests =
      createPendingCreateRequestRegistry<PlotThreadMoveMarkerBundle>();
    const redoRequests =
      createPendingCreateRequestRegistry<PlotThreadMoveMarkerBundle>();
    recordPlotHistory(
      {
        label: i18next.t("plotThread.history.moveMarker", "マーカー移動"),
        entityId: markerBefore.id,
        undo: async () => {
          await replayPlotMutation(
            authority,
            () =>
              runRetainedPlotMarkerMove(
                undoRequests,
                "undo-marker-move",
                reverseBundle,
              ),
            (result) => publish(reverseBundle, result),
          );
        },
        redo: async () => {
          await replayPlotMutation(
            authority,
            () =>
              runRetainedPlotMarkerMove(
                redoRequests,
                "redo-marker-move",
                bundle,
              ),
            (result) => publish(bundle, result),
          );
        },
      },
      undefined,
      authority,
    );
  },

  deleteMarker: async (id) => {
    const link = get().links.find((l) => l.id === id);
    if (!link) return;
    const authority = captureBoundPlotAuthority(get());
    if (!authority) return;
    // アンカー側のエッジをカスケード削除。統一モデル: branch も merge も
    // マーカーは移動先 = to 側に乗る（PlotBranchEditor / D&D 共通）。よってアンカー =
    // to===threadId && atNodeId===nodeId のエッジ。
    // ただし同一(thread,scene)に別 phase のマーカーが残るなら、そのエッジは
    // まだアンカーされているので消さない（複数 phase の取り残し防止）。
    const orphanIds = new Set<string>();
    const stillAnchored = get().links.some(
      (l) =>
        l.id !== id && l.threadId === link.threadId && l.nodeId === link.nodeId,
    );
    if (!stillAnchored) {
      for (const b of get().branches) {
        if (b.atNodeId === link.nodeId && b.toThreadId === link.threadId) {
          orphanIds.add(b.id);
        }
      }
    }
    // set より前（まだ存在するうち）に消えるエッジの完全な行を控える。
    const removedBranches = get().branches.filter((b) => orphanIds.has(b.id));
    const deleteSnapshot = {
      projectId: authority.projectId,
      link,
      branches: removedBranches,
    };
    const outcome = await runAuthoritativeMutation(authority, () =>
      runRetainedPlotDelete(
        pendingPlotDeleteSnapshots,
        `marker:${authority.projectId}:${id}`,
        deleteSnapshot,
      ),
    );
    if (outcome.status !== "current") return;
    set({
      links: get().links.filter((l) => l.id !== id),
      branches: get().branches.filter((b) => !orphanIds.has(b.id)),
    });
    const removedLink = link;
    const undoRestoreRequests =
      createPendingCreateRequestRegistry<PlotRestoreSnapshotPayload>();
    const redoDeleteRequests =
      createPendingCreateRequestRegistry<PlotDeleteSnapshotPayload>();
    recordPlotHistory(
      {
        label: i18next.t("plotThread.history.deleteMarker", "マーカー削除"),
        entityId: id,
        undo: async () => {
          await replayPlotMutation(
            authority,
            () =>
              runRetainedPlotRestore(undoRestoreRequests, {
                projectId: authority.projectId,
                thread: null,
                links: [removedLink],
                branches: removedBranches,
              }),
            () =>
              set({
                links: [...get().links, removedLink],
                branches: [...get().branches, ...removedBranches],
              }),
          );
        },
        redo: async () => {
          await replayPlotMutation(
            authority,
            () =>
              runRetainedPlotDelete(
                redoDeleteRequests,
                "delete",
                deleteSnapshot,
              ),
            () =>
              set({
                links: get().links.filter((candidate) => candidate.id !== id),
                branches: get().branches.filter(
                  (candidate) =>
                    !removedBranches.some(
                      (removed) => removed.id === candidate.id,
                    ),
                ),
              }),
          );
        },
      },
      undefined,
      authority,
    );
  },

  addBranch: async (data, history) => {
    const authority = captureBoundPlotAuthority(get(), data.projectId);
    // 自己参照を弾く。
    if (data.fromThreadId === data.toThreadId) return;
    if (!authority || !isCurrentMutationAuthority(authority)) return;
    // UX 向け XPROJ preflight: from/to は現在ロード中（＝同一 project）の
    // スレッドのみ許可。native create transaction でも最終的に再検証する。
    const threads = get().threads;
    const known = (id: string) => threads.some((t) => t.id === id);
    if (!known(data.fromThreadId) || !known(data.toThreadId)) return;
    // 同一(from,to,atNode,kind)の重複を弾く（DnD/手動の両経路で共通）。
    const dup = get().branches.some(
      (b) =>
        b.fromThreadId === data.fromThreadId &&
        b.toThreadId === data.toThreadId &&
        b.atNodeId === data.atNodeId &&
        b.kind === data.kind,
    );
    if (dup) return;
    const signature = JSON.stringify(data);
    const pending = pendingBranchCreates.acquire(
      `branch:${signature}`,
      signature,
      (id) => ({ id, ...data }),
    );
    const outcome = await runRetainedPlotCreate(
      authority,
      pendingBranchCreates,
      pending,
      createPlotThreadBranch,
    );
    if (outcome.status !== "current") return;
    const created = outcome.value;
    if (!isCreateResultEntityPresent(created)) return;
    if (getCreateResultMetadata(created)?.replayed) {
      if (get().branches.some((branch) => branch.id === created.id)) return;
      set({ branches: [...get().branches, created] });
    } else {
      set({ branches: [...get().branches, created] });
    }
    const captured = { ...created };
    const redoRestoreRequests =
      createPendingCreateRequestRegistry<PlotRestoreSnapshotPayload>();
    recordPlotHistory(
      {
        label: i18next.t("plotThread.history.addBranch", "分岐 / 合流を追加"),
        entityId: captured.id,
        undo: async () => {
          await replayPlotMutation(
            authority,
            () => deletePlotThreadBranch(captured.id),
            () =>
              set({
                branches: get().branches.filter(
                  (candidate) => candidate.id !== captured.id,
                ),
              }),
          );
        },
        redo: async () => {
          await replayPlotMutation(
            authority,
            () =>
              runRetainedPlotRestore(redoRestoreRequests, {
                projectId: captured.projectId,
                thread: null,
                links: [],
                branches: [captured],
              }),
            () => set({ branches: [...get().branches, captured] }),
          );
        },
      },
      history,
      authority,
    );
  },

  updateBranch: async (id, patch, history) => {
    const before = get().branches.find((b) => b.id === id);
    if (!before) return;
    const nextFromThreadId = patch.fromThreadId ?? before.fromThreadId;
    const nextToThreadId = patch.toThreadId ?? before.toThreadId;
    if (
      !get().threads.some((thread) => thread.id === nextFromThreadId) ||
      !get().threads.some((thread) => thread.id === nextToThreadId)
    ) {
      return;
    }
    const authority = captureBoundPlotAuthority(get());
    if (!authority) return;
    const outcome = await runAuthoritativeMutation(authority, () =>
      updatePlotThreadBranch(id, patch),
    );
    if (outcome.status !== "current") return;
    set({
      branches: get().branches.map((branch) =>
        branch.id === id ? outcome.value : branch,
      ),
    });
    const beforePatch: typeof patch = {};
    if ("fromThreadId" in patch) beforePatch.fromThreadId = before.fromThreadId;
    if ("toThreadId" in patch) beforePatch.toThreadId = before.toThreadId;
    if ("atNodeId" in patch) beforePatch.atNodeId = before.atNodeId;
    recordPlotHistory(
      {
        label: i18next.t(
          "plotThread.history.updateBranch",
          "分岐 / 合流を変更",
        ),
        entityId: id,
        undo: async () => {
          await replayPlotMutation(
            authority,
            () => updatePlotThreadBranch(id, beforePatch),
            (updated) =>
              set({
                branches: get().branches.map((branch) =>
                  branch.id === id ? updated : branch,
                ),
              }),
          );
        },
        redo: async () => {
          await replayPlotMutation(
            authority,
            () => updatePlotThreadBranch(id, patch),
            (updated) =>
              set({
                branches: get().branches.map((branch) =>
                  branch.id === id ? updated : branch,
                ),
              }),
          );
        },
      },
      history,
      authority,
    );
  },

  deleteBranch: async (id, history) => {
    const removed = get().branches.find((b) => b.id === id);
    if (!removed) return;
    const authority = captureBoundPlotAuthority(get());
    if (!authority) return;
    const outcome = await runAuthoritativeMutation(authority, () =>
      deletePlotThreadBranch(id),
    );
    if (outcome.status !== "current") return;
    set({ branches: get().branches.filter((b) => b.id !== id) });
    const undoRestoreRequests =
      createPendingCreateRequestRegistry<PlotRestoreSnapshotPayload>();
    recordPlotHistory(
      {
        label: i18next.t(
          "plotThread.history.deleteBranch",
          "分岐 / 合流を削除",
        ),
        entityId: id,
        undo: async () => {
          await replayPlotMutation(
            authority,
            () =>
              runRetainedPlotRestore(undoRestoreRequests, {
                projectId: removed.projectId,
                thread: null,
                links: [],
                branches: [removed],
              }),
            () => set({ branches: [...get().branches, removed] }),
          );
        },
        redo: async () => {
          await replayPlotMutation(
            authority,
            () => deletePlotThreadBranch(id),
            () =>
              set({
                branches: get().branches.filter((branch) => branch.id !== id),
              }),
          );
        },
      },
      history,
      authority,
    );
  },
}));

/** updateMarker の patch から、何を変えたか分かる履歴ラベルを選ぶ。 */
function markerPatchLabel(
  patch: Partial<
    Pick<PlotThreadLinkRow, "threadId" | "nodeId" | "phaseType" | "note">
  >,
): string {
  if ("phaseType" in patch) {
    return i18next.t("plotThread.history.phaseMarker", "段階変更");
  }
  if ("threadId" in patch || "nodeId" in patch) {
    return i18next.t("plotThread.history.moveMarker", "マーカー移動");
  }
  if ("note" in patch) {
    return i18next.t("plotThread.history.editNote", "メモ変更");
  }
  return i18next.t("plotThread.history.editMarker", "マーカー編集");
}
