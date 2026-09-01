import { create } from "zustand";
import { toast } from "sonner";
import i18next from "i18next";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { readRuntimeSettingBoolean } from "@/features/settings/runtimeSettings";
import * as trashApi from "./api";
import {
  isInterestingStructureItem,
  isInterestingTextFragment,
} from "./interestingness";
import type {
  PendingTrashItem,
  TextFragmentPayload,
  TrashItemData,
  TrashItemInput,
} from "./types";
import { UNDO_ABSORB_WINDOW_MS } from "./types";
import { isCreateResultEntityPresent } from "@/lib/createResultMetadata";
import {
  captureMutationAuthority,
  isCurrentMutationAuthority,
  runAuthoritativeMutation,
  type MutationAuthority,
  type MutationOutcome,
} from "@/features/concurrency/mutationAuthority";
import { canScheduleQuiescenceMutation } from "@/application/lifecycle/quiescenceLease";
import {
  createQuiescenceProviderId,
  registerQuiescenceProvider,
  type QuiescenceProviderFlushOptions,
} from "@/lib/quiescenceProviders";

interface EnqueueOptions {
  /** Backspace バッファのフラッシュ起源など、識別子に使う一時 ID */
  tempId: string;
  /**
   * The deletion happened before a destructive lifecycle lease. Its
   * component-local capture buffer is being drained by a registered
   * quiescence participant, so moving it into this provider-owned queue is
   * persistence of existing work rather than admission of a new mutation.
   */
  preexistingDraft?: boolean;
}

/**
 * `pickup` の戻り値 (設計書 §11)。restorer の `RestoreOutcome` をそのまま返す。
 * 設計書 §9.4: pickup 自体は Global Undo に乗せない。
 */
export type PickupResult =
  | { ok: true; newId: string; brokenLinks: string[] }
  | {
      ok: false;
      reason: "rejected" | "no-target" | "internal-error" | "duplicate";
      message?: string;
    };

interface TrashBinStore {
  /** Project whose rows and delayed captures are currently authoritative. */
  activeProjectId: string | null;
  items: Map<string, TrashItemData>;
  selectedItemId: string | null;
  isCapturing: boolean;
  isLoading: boolean;
  pendingQueue: PendingTrashItem[];

  /**
   * Synchronous Project-commit boundary. Old rows and timers must disappear
   * before optional hydration of the replacement Project starts.
   */
  resetForProject(projectId: string): void;
  loadItems(projectId: string): Promise<void>;
  /**
   * 文字屑のキャプチャを保留キューに入れる。
   * 1500ms 以内に `cancelPending(tempId)` が呼ばれなければ DB へ書き込む。
   */
  /**
   * Returns false only when authority/admission rejected the pending capture;
   * callers retaining a pre-store draft must keep it retryable in that case.
   */
  enqueuePending(data: TrashItemInput, options: EnqueueOptions): boolean;
  /** Undo 1500ms 内吸収。エディタ単位で全保留を破棄するときも使う。 */
  cancelPending(filter: {
    tempId?: string;
    originSceneId?: string | null;
    originCodexId?: string | null;
  }): void;
  removeItem(id: string): Promise<void>;
  clearAll(projectId: string): Promise<void>;
  setSelectedItem(id: string | null): void;
  setCapturing(value: boolean): void;
  /**
   * 拾い上げ (D&D / キーボード経由共通)。
   * target.onDrop() を呼び (内部で restorer を呼ぶ)、成功したら DB から item を
   * 消し store からも削除。失敗時は item は trash に残す。
   */
  pickup(
    itemId: string,
    onRestore: () => Promise<PickupResult>,
  ): Promise<PickupResult>;
}

// store 外で保持するタイマー (再描画を起こさないため state には含めない)
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlightFlushes = new Map<string, Promise<void>>();
const pendingAuthorities = new Map<string, MutationAuthority>();
const MAX_PENDING_DRAIN_ROUNDS = 50;
let trashLoadGeneration = 0;

function getActiveTrashProjectId(): string {
  return useTrashBinStore.getState().activeProjectId ?? "";
}

function clearFlushTimer(tempId: string) {
  const t = flushTimers.get(tempId);
  if (t !== undefined) {
    clearTimeout(t);
    flushTimers.delete(tempId);
  }
}

function captureBoundTrashAuthority(
  state: TrashBinStore,
  projectId = state.activeProjectId ?? "",
): MutationAuthority | null {
  if (state.activeProjectId !== projectId) {
    return null;
  }
  return captureMutationAuthority(projectId, getActiveTrashProjectId);
}

function removePendingCapture(tempId: string): void {
  clearFlushTimer(tempId);
  pendingAuthorities.delete(tempId);
  useTrashBinStore.setState((state) => ({
    pendingQueue: state.pendingQueue.filter(
      (pending) => pending.tempId !== tempId,
    ),
  }));
}

function discardPendingTrashCaptures(): void {
  for (const tempId of flushTimers.keys()) clearFlushTimer(tempId);
  pendingAuthorities.clear();
  useTrashBinStore.setState({ pendingQueue: [] });
}

export const useTrashBinStore = create<TrashBinStore>()((set, get) => ({
  activeProjectId: null,
  items: new Map(),
  selectedItemId: null,
  isCapturing: true,
  isLoading: false,
  pendingQueue: [],

  setSelectedItem: (id) => set({ selectedItemId: id }),
  setCapturing: (value) => set({ isCapturing: value }),

  resetForProject: (projectId) => {
    trashLoadGeneration++;
    for (const tempId of flushTimers.keys()) clearFlushTimer(tempId);
    pendingAuthorities.clear();
    set({
      activeProjectId: projectId,
      items: new Map(),
      selectedItemId: null,
      isLoading: false,
      pendingQueue: [],
    });
  },

  loadItems: async (projectId) => {
    const authority = captureBoundTrashAuthority(get(), projectId);
    if (!authority) return;
    const generation = ++trashLoadGeneration;
    set({ isLoading: true });
    try {
      const list = await trashApi.listTrashItems(projectId);
      if (
        generation !== trashLoadGeneration ||
        get().activeProjectId !== projectId ||
        !isCurrentMutationAuthority(authority)
      ) {
        return;
      }
      const items = new Map<string, TrashItemData>();
      for (const item of list) items.set(item.id, item);
      set({ items, isLoading: false });
    } catch (e) {
      if (
        generation === trashLoadGeneration &&
        get().activeProjectId === projectId &&
        isCurrentMutationAuthority(authority)
      ) {
        set({ isLoading: false });
        toast.error(i18next.t("trashBin.loadFailed"));
        debugLog.error("TrashBinStore", "loadItems", errorDetail(e));
      }
      throw e;
    }
  },

  enqueuePending: (data, options) => {
    if (!get().isCapturing) return true;
    if (!options.preexistingDraft && !canScheduleQuiescenceMutation()) {
      return false;
    }
    // プロジェクト設定 (`trashBin.enabled`) で無効化されているなら何もしない
    // (設計書 §3.5)。デフォルト ON。
    const enabled = readRuntimeSettingBoolean("trashBin.enabled", true);
    if (!enabled) return true;

    const { tempId } = options;
    const authority = captureBoundTrashAuthority(get(), data.projectId);
    if (!authority) return false;
    const expireAt = Date.now() + UNDO_ABSORB_WINDOW_MS;
    const pending: PendingTrashItem = {
      tempId,
      data,
      expireAt,
      originSceneId: data.originSceneId,
      originCodexId: data.originCodexId,
    };
    pendingAuthorities.set(tempId, authority);
    set((state) => ({
      pendingQueue: [
        ...state.pendingQueue.filter(
          (candidate) => candidate.tempId !== tempId,
        ),
        pending,
      ],
    }));

    clearFlushTimer(tempId);
    const timer = setTimeout(() => {
      flushTimers.delete(tempId);
      flushPending(tempId).catch((e) =>
        debugLog.error("TrashBinStore", "flushPending", errorDetail(e)),
      );
    }, UNDO_ABSORB_WINDOW_MS);
    flushTimers.set(tempId, timer);
    return true;
  },

  cancelPending: ({ tempId, originSceneId, originCodexId }) => {
    set((s) => {
      const remaining: PendingTrashItem[] = [];
      for (const p of s.pendingQueue) {
        const matchTemp = tempId !== undefined && p.tempId === tempId;
        const matchScene =
          originSceneId !== undefined && p.originSceneId === originSceneId;
        const matchCodex =
          originCodexId !== undefined && p.originCodexId === originCodexId;
        const shouldCancel = matchTemp || matchScene || matchCodex;
        if (shouldCancel) {
          clearFlushTimer(p.tempId);
          pendingAuthorities.delete(p.tempId);
        } else {
          remaining.push(p);
        }
      }
      return { pendingQueue: remaining };
    });
  },

  removeItem: async (id) => {
    const item = get().items.get(id);
    if (!item) return;
    const authority = captureBoundTrashAuthority(get(), item.projectId);
    if (!authority) return;
    try {
      const outcome = await runAuthoritativeMutation(authority, () =>
        trashApi.deleteTrashItem(id),
      );
      if (outcome.status !== "current") return;
    } catch (e) {
      toast.error(i18next.t("trashBin.deleteFailed"));
      debugLog.error("TrashBinStore", "removeItem", errorDetail(e));
      return;
    }
    set((s) => {
      if (!s.items.has(id)) return s;
      const next = new Map(s.items);
      next.delete(id);
      return { items: next };
    });
  },

  clearAll: async (projectId) => {
    const authority = captureBoundTrashAuthority(get(), projectId);
    if (!authority) return;
    try {
      const outcome = await runAuthoritativeMutation(authority, () =>
        trashApi.clearAllTrashItems(projectId),
      );
      if (outcome.status !== "current") return;
    } catch (e) {
      toast.error(i18next.t("trashBin.clearFailed"));
      debugLog.error("TrashBinStore", "clearAll", errorDetail(e));
      return;
    }
    set({ items: new Map() });
  },

  pickup: async (itemId, onRestore) => {
    const item = get().items.get(itemId);
    if (!item) {
      return { ok: false, reason: "no-target", message: "item not found" };
    }
    const authority = captureBoundTrashAuthority(get(), item.projectId);
    if (!authority) {
      return {
        ok: false,
        reason: "rejected",
        message: "project changed",
      };
    }
    let outcome: MutationOutcome<PickupResult>;
    try {
      outcome = await runAuthoritativeMutation(authority, async () => {
        let result: PickupResult;
        try {
          result = await onRestore();
        } catch (e) {
          return {
            ok: false,
            reason: "internal-error",
            message: e instanceof Error ? e.message : String(e),
          } satisfies PickupResult;
        }
        if (!result.ok) return result;

        // Structural restore consumes the Trash row inside its Native
        // aggregate transaction. Text fragments are editor-local, so only
        // that path needs the separate Trash delete; a failed delete must keep
        // the store row and report failure instead of pretending atomicity.
        if (item.kind === "text-fragment") {
          try {
            await trashApi.deleteTrashItem(itemId);
          } catch (e) {
            debugLog.error("TrashBinStore", "pickup/delete", errorDetail(e));
            return {
              ok: false,
              reason: "internal-error",
              message: e instanceof Error ? e.message : String(e),
            } satisfies PickupResult;
          }
        }
        return result;
      });
    } catch (e) {
      return {
        ok: false,
        reason: "internal-error",
        message: e instanceof Error ? e.message : String(e),
      };
    }
    if (outcome.status !== "current") {
      return {
        ok: false,
        reason: "rejected",
        message: "project changed",
      };
    }
    const result = outcome.value;
    if (!result.ok) return result;

    set((s) => {
      if (!s.items.has(itemId)) return s;
      const next = new Map(s.items);
      next.delete(itemId);
      return { items: next };
    });
    return result;
  },
}));

/**
 * 保留キューから tempId を取り出し、DB に書き込む。
 */
async function performFlushPending(
  tempId: string,
  options: QuiescenceProviderFlushOptions = {},
): Promise<void> {
  const store = useTrashBinStore.getState();
  const target = store.pendingQueue.find((p) => p.tempId === tempId);
  if (!target) return;
  const authority = pendingAuthorities.get(tempId);
  if (
    !authority ||
    store.activeProjectId !== target.data.projectId ||
    !isCurrentMutationAuthority(authority)
  ) {
    // A stale delayed callback must never target an id-only native API after
    // Project/Workspace authority has moved on.
    removePendingCapture(tempId);
    return;
  }

  const { data } = target;
  const isInteresting =
    data.kind === "text-fragment"
      ? isInterestingTextFragment(
          (data.payload as TextFragmentPayload).text ?? "",
          (data.payload as TextFragmentPayload).spans ?? [],
        )
      : isInterestingStructureItem(data.subKind, data.previewText);

  // 文字数は payload.text を Unicode コードポイントで数える
  const charCount =
    data.kind === "text-fragment"
      ? [...((data.payload as TextFragmentPayload).text ?? "")].length
      : [...data.previewText].length;

  const created = await trashApi.createTrashItem(data, {
    charCount,
    isInteresting,
    id: target.tempId,
    ...(options.preexistingDraft ? { preexistingDraft: true } : {}),
  });

  // Remove only after the durable create resolves. A rejection remains queued
  // so the lifecycle can veto the scope change and retry without data loss.
  removePendingCapture(tempId);
  if (
    !isCreateResultEntityPresent(created) ||
    useTrashBinStore.getState().activeProjectId !== data.projectId ||
    !isCurrentMutationAuthority(authority)
  ) {
    return;
  }
  useTrashBinStore.setState((state) => {
    const next = new Map(state.items);
    next.set(created.id, created);
    return { items: next };
  });
}

function flushPending(
  tempId: string,
  options: QuiescenceProviderFlushOptions = {},
): Promise<void> {
  const existing = inFlightFlushes.get(tempId);
  if (existing) return existing;
  const pending = performFlushPending(tempId, options).finally(() => {
    if (inFlightFlushes.get(tempId) === pending) {
      inFlightFlushes.delete(tempId);
    }
  });
  inFlightFlushes.set(tempId, pending);
  return pending;
}

/**
 * Forces every delayed capture to durable storage before a destructive
 * Project/Workspace/window boundary. A failed create stays queued and rejects
 * the boundary; it is retried only by a later strict-quiescence attempt.
 */
export async function flushPendingTrashItemsStrict(
  options: QuiescenceProviderFlushOptions = {},
): Promise<void> {
  const failures: unknown[] = [];
  const failedIds = new Set<string>();

  for (let round = 0; round < MAX_PENDING_DRAIN_ROUNDS; round++) {
    const ids = new Set([
      ...useTrashBinStore
        .getState()
        .pendingQueue.map((pending) => pending.tempId),
      ...inFlightFlushes.keys(),
    ]);
    for (const id of failedIds) ids.delete(id);

    if (ids.size === 0) {
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "One or more pending Trash Bin captures failed",
        );
      }
      return;
    }

    for (const id of ids) clearFlushTimer(id);
    const attempts = [...ids].map(async (id) => {
      try {
        await flushPending(id, options);
      } catch (error) {
        failures.push(error);
        failedIds.add(id);
      }
    });
    await Promise.all(attempts);
  }

  throw new Error("Pending Trash Bin captures did not reach quiescence");
}

registerQuiescenceProvider({
  id: createQuiescenceProviderId("trash-bin-pending-captures"),
  stage: "scoped-mutations",
  flush: flushPendingTrashItemsStrict,
  discard: discardPendingTrashCaptures,
  recovery: () =>
    useTrashBinStore.getState().pendingQueue.map((pending) => ({
      kind: "trash-bin-pending",
      id: pending.tempId,
      data: pending.data,
    })),
});

/** Test helper for module-owned timers and authorities. */
export function _resetTrashBinLifecycleForTests(): void {
  discardPendingTrashCaptures();
  inFlightFlushes.clear();
  trashLoadGeneration++;
}
