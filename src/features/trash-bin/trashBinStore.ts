import { create } from "zustand";
import { toast } from "sonner";
import i18next from "i18next";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { recordChangeEvent } from "@/features/timelapse/recorder";
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

interface EnqueueOptions {
  /** Backspace バッファのフラッシュ起源など、識別子に使う一時 ID */
  tempId: string;
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
  items: Map<string, TrashItemData>;
  selectedItemId: string | null;
  isCapturing: boolean;
  isLoading: boolean;
  pendingQueue: PendingTrashItem[];

  loadItems(projectId: string): Promise<void>;
  /**
   * 文字屑のキャプチャを保留キューに入れる。
   * 1500ms 以内に `cancelPending(tempId)` が呼ばれなければ DB へ書き込む。
   */
  enqueuePending(data: TrashItemInput, options: EnqueueOptions): void;
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

function clearFlushTimer(tempId: string) {
  const t = flushTimers.get(tempId);
  if (t !== undefined) {
    clearTimeout(t);
    flushTimers.delete(tempId);
  }
}

export const useTrashBinStore = create<TrashBinStore>()((set, get) => ({
  items: new Map(),
  selectedItemId: null,
  isCapturing: true,
  isLoading: false,
  pendingQueue: [],

  setSelectedItem: (id) => set({ selectedItemId: id }),
  setCapturing: (value) => set({ isCapturing: value }),

  loadItems: async (projectId) => {
    set({ isLoading: true });
    try {
      const list = await trashApi.listTrashItems(projectId);
      const items = new Map<string, TrashItemData>();
      for (const item of list) items.set(item.id, item);
      set({ items, isLoading: false });
    } catch (e) {
      set({ isLoading: false });
      toast.error(i18next.t("trashBin.loadFailed"));
      debugLog.error("TrashBinStore", "loadItems", errorDetail(e));
    }
  },

  enqueuePending: (data, options) => {
    if (!get().isCapturing) return;
    // プロジェクト設定 (`trashBin.enabled`) で無効化されているなら何もしない
    // (設計書 §3.5)。デフォルト ON。
    const enabled = useSettingsStore
      .getState()
      .getBoolean("trashBin.enabled", true);
    if (!enabled) return;

    const { tempId } = options;
    const expireAt = Date.now() + UNDO_ABSORB_WINDOW_MS;
    const pending: PendingTrashItem = {
      tempId,
      data,
      expireAt,
      originSceneId: data.originSceneId,
      originCodexId: data.originCodexId,
    };
    set((s) => ({ pendingQueue: [...s.pendingQueue, pending] }));

    clearFlushTimer(tempId);
    const timer = setTimeout(() => {
      flushTimers.delete(tempId);
      flushPending(tempId).catch((e) =>
        debugLog.error("TrashBinStore", "flushPending", errorDetail(e)),
      );
    }, UNDO_ABSORB_WINDOW_MS);
    flushTimers.set(tempId, timer);
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
        } else {
          remaining.push(p);
        }
      }
      return { pendingQueue: remaining };
    });
  },

  removeItem: async (id) => {
    try {
      await trashApi.deleteTrashItem(id);
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
    try {
      await trashApi.clearAllTrashItems(projectId);
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
    let result: PickupResult;
    try {
      result = await onRestore();
    } catch (e) {
      return {
        ok: false,
        reason: "internal-error",
        message: e instanceof Error ? e.message : String(e),
      };
    }
    if (!result.ok) return result;

    // The delete side was already recorded (grid.node.delete etc.); the restore
    // is a distinct durable event that would otherwise be invisible. Metadata
    // domain — no rebaseline (the restored body re-enters via its own path).
    recordChangeEvent({
      domain: "trash",
      opType: "restore",
      entityType: "trash_item",
      entityId: itemId,
      payload: { itemId, kind: item.kind },
    });

    // 復元成功 → trash 側から削除 (DB + store)。失敗時は trash に残す。
    try {
      await trashApi.deleteTrashItem(itemId);
    } catch (e) {
      debugLog.error("TrashBinStore", "pickup/delete", errorDetail(e));
      // 復元自体は成功しているので呼び出し側には ok を返す
    }
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
async function flushPending(tempId: string): Promise<void> {
  const store = useTrashBinStore.getState();
  const target = store.pendingQueue.find((p) => p.tempId === tempId);
  if (!target) return;

  // 先にキューから抜く（再フラッシュ防止）
  useTrashBinStore.setState((s) => ({
    pendingQueue: s.pendingQueue.filter((p) => p.tempId !== tempId),
  }));

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

  try {
    const created = await trashApi.createTrashItem(data, {
      charCount,
      isInteresting,
    });
    useTrashBinStore.setState((s) => {
      const next = new Map(s.items);
      next.set(created.id, created);
      return { items: next };
    });
  } catch (e) {
    debugLog.error("TrashBinStore", "flushPending/create", errorDetail(e));
  }
}
