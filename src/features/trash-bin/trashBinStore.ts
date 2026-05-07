import { create } from "zustand";
import { toast } from "sonner";
import i18next from "i18next";
import { debugLog, errorDetail } from "@/lib/debugLog";
import * as trashApi from "./api";
import { isInterestingTextFragment } from "./interestingness";
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
      : false;

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
