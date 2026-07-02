import { create } from "zustand";
import { toast } from "sonner";
import i18next from "i18next";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { announce } from "@/lib/a11y/announcer";
import * as snippetApi from "./api";
import type { Snippet, NewSnippet } from "./api";
import { SnippetVersionConflictError } from "./occ";
import { searchSnippets } from "./search";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { captureSnippetDeletion } from "@/features/trash-bin/captureHooks";
import { useTrashBinStore } from "@/features/trash-bin/trashBinStore";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { notifySnippetDeleted } from "./anchorNotify";
import { createInFlightTracker } from "@/lib/inFlightTracker";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import { computeDocDiff, type BodyDiff } from "@/features/timelapse/bodyDiff";
import {
  blockIfUnlicensed,
  LICENSE_WRITE_RESTRICTED_ERROR,
} from "@/features/license/gate";

/**
 * 別窓 / 別プロセスが同じ snippet を先に更新していて OCC 衝突した時のハンドラ。
 * 既定はトースト通知のみ。編集面が setSnippetEditConflictHandler で
 * 「最新を読み込む」導線に差し替える (codexStore の同名フックと対称)。
 * 本文を黙って上書きしないための非破壊フックなので、ここでは store も
 * timelapse も触らない。
 */
let snippetEditConflictHandler: (snippetId: string) => void = () => {
  toast.error(i18next.t("snippets.store.editConflict"));
};

export function setSnippetEditConflictHandler(
  handler: (snippetId: string) => void,
): void {
  snippetEditConflictHandler = handler;
}

export type SnippetSourceFilter =
  | "all"
  | "from-chat"
  | "from-editor"
  | "manual";
export type SnippetSortOrder = "recent" | "oldest" | "title-asc" | "most-used";

interface SnippetState {
  entries: Snippet[];
  searchQuery: string;
  isLoading: boolean;
  sourceFilter: SnippetSourceFilter;
  sortOrder: SnippetSortOrder;
  pendingEntryId: string | null;
  /**
   * 現在 Snippet パネルで選択中のスニペット。レイアウトプリセット切替で配置
   * から外れたりパネルを閉じたりするとパネル subtree は unmount され、パネル
   * 内 local state だと選択が失われる。選択をストアに持たせて unmount を跨い
   * で保持する。pendingEntryId（外部からの一発選択要求）とは別物。
   * React の setState 同様、値だけでなく updater 関数も受け付ける。
   */
  selectedSnippet: Snippet | null;
  setSelectedSnippet: (
    next: Snippet | null | ((prev: Snippet | null) => Snippet | null),
  ) => void;

  loadEntries: () => Promise<void>;
  /** mount 用の dedup 付きロード。同一 projectId のロードが進行中なら
   *  それに相乗りする。settle 後は毎回ロードする (remount での再フェッチ =
   *  外部書き込み追従は維持)。 */
  ensureEntriesLoaded: () => Promise<void>;
  search: (query: string) => Promise<void>;
  setSourceFilter: (filter: SnippetSourceFilter) => void;
  setSortOrder: (order: SnippetSortOrder) => void;
  requestSelectEntry: (id: string) => void;
  clearPendingEntry: () => void;
  create: (
    data: Pick<NewSnippet, "title" | "content"> &
      Partial<
        Pick<
          NewSnippet,
          "tagsCache" | "sceneId" | "sourceChatMessageId" | "contentSource"
        >
      >,
    options?: { silent?: boolean },
  ) => Promise<Snippet>;
  update: (
    id: string,
    data: Partial<
      Pick<NewSnippet, "title" | "content" | "tagsCache" | "sceneId">
    >,
  ) => Promise<void>;
  remove: (id: string) => Promise<void>;
  incrementUsageCount: (id: string) => Promise<void>;
}

// mount eager load の in-flight dedup (詳細は ensureEntriesLoaded の docs)
const entriesLoadTracker = createInFlightTracker();

export const useSnippetStore = create<SnippetState>()((set, get) => ({
  entries: [],
  searchQuery: "",
  isLoading: false,
  sourceFilter: "all",
  sortOrder: "recent",
  pendingEntryId: null,
  selectedSnippet: null,
  setSelectedSnippet: (next) =>
    set((state) => ({
      selectedSnippet:
        typeof next === "function" ? next(state.selectedSnippet) : next,
    })),

  setSourceFilter: (filter) => set({ sourceFilter: filter }),
  setSortOrder: (order) => set({ sortOrder: order }),
  requestSelectEntry: (id) => set({ pendingEntryId: id }),
  clearPendingEntry: () => set({ pendingEntryId: null }),

  loadEntries: async () => {
    const run = (async () => {
      set({ isLoading: true });
      try {
        const entries = await snippetApi.listSnippets(getCurrentProjectId());
        set({ entries, isLoading: false });
      } catch (e) {
        set({ isLoading: false });
        toast.error(i18next.t("snippets.store.loadFailed"));
        debugLog.error("SnippetStore", "loadEntries", errorDetail(e));
      }
    })();
    // mutation 後の直接 loadEntries も in-flight として記録し、直後に
    // mount する ensureEntriesLoaded がこの (最新の) ロードに相乗りする
    entriesLoadTracker.track(getCurrentProjectId(), run);
    return run;
  },

  ensureEntriesLoaded: () => {
    const inFlight = entriesLoadTracker.peek(getCurrentProjectId());
    if (inFlight) return inFlight;
    return get().loadEntries();
  },

  search: async (query: string) => {
    set({ searchQuery: query, isLoading: true });
    try {
      if (query.trim() === "") {
        const entries = await snippetApi.listSnippets(getCurrentProjectId());
        set({ entries, isLoading: false });
      } else {
        const entries = await searchSnippets(query);
        set({ entries, isLoading: false });
        // 成功パスは toast を出さないため、SR には結果件数が無音になる。
        // 呼び出し側 (パネル) が debounce 済みなので確定検索ごとに 1 回だけ、
        // かつ後発の検索が始まっていれば stale な件数は読み上げない。
        if (get().searchQuery === query) {
          announce(
            i18next.t("snippets.searchResultCount", { count: entries.length }),
          );
        }
      }
    } catch (e) {
      set({ isLoading: false });
      toast.error(i18next.t("snippets.store.searchFailed"));
      debugLog.error("SnippetStore", "search", errorDetail(e));
    }
  },

  create: async (data, options) => {
    if (blockIfUnlicensed()) throw new Error(LICENSE_WRITE_RESTRICTED_ERROR);
    try {
      const id = crypto.randomUUID();
      const created = await snippetApi.createSnippet({
        id,
        projectId: getCurrentProjectId(),
        ...data,
      });
      set((state) => ({ entries: [...state.entries, created] }));
      recordChangeEvent({
        domain: "snippet",
        opType: "snippet.create",
        entityType: "snippet",
        entityId: created.id,
        sceneId: created.sceneId ?? null,
        payload: { title: created.title, sceneId: created.sceneId },
      });

      if (!useGlobalHistoryStore.getState().isReplaying) {
        const captured = { ...created };
        useGlobalHistoryStore.getState().push({
          kind: "snippets",
          label: i18next.t("history.snippets.created"),
          entityId: captured.id,
          async undo() {
            await snippetApi.deleteSnippet(captured.projectId, captured.id);
            set((state) => ({
              entries: state.entries.filter((e) => e.id !== captured.id),
            }));
            notifySnippetDeleted(captured.id);
          },
          async redo() {
            await snippetApi.createSnippet({
              id: captured.id,
              projectId: captured.projectId,
              title: captured.title,
              content: captured.content,
              tagsCache: captured.tagsCache ?? undefined,
              sceneId: captured.sceneId ?? undefined,
              sourceChatMessageId: captured.sourceChatMessageId ?? undefined,
              contentSource: captured.contentSource ?? undefined,
            });
            set((state) => ({ entries: [...state.entries, captured] }));
          },
        });
      }
      // Background re-sync to fix race condition: if useEffect's loadEntries() was
      // in-flight (e.g., after a layout preset change or during Tauri startup),
      // it may resolve after this optimistic update and overwrite it with stale data.
      // Re-fetch after the INSERT so our SELECT is guaranteed to include the new entry.
      if (get().isLoading) {
        snippetApi
          .listSnippets(getCurrentProjectId())
          .then((entries) =>
            set((state) => (state.searchQuery ? state : { entries })),
          )
          .catch(() => {});
      }
      if (!options?.silent) {
        toast.success(i18next.t("snippets.store.saved"));
      }
      return created;
    } catch (e) {
      toast.error(i18next.t("snippets.store.createFailed"));
      debugLog.error("SnippetStore", "create", errorDetail(e));
      throw e;
    }
  },

  update: async (id, data) => {
    const before = get().entries.find((e) => e.id === id);

    try {
      // OCC: 読み込み時点の version を baseVersion として渡す。別窓 / 別プロセスが
      // 先に書いていれば衝突として弾かれ、本文を黙って上書きしない。
      // 成功時は .returning() の行 (version = base + 1) で entries を置き換える
      // ので、in-memory の version が DB に追従し、連続保存でも自己衝突しない。
      const updated = await snippetApi.updateSnippet(
        getCurrentProjectId(),
        id,
        data,
        { baseVersion: before?.version ?? 0 },
      );
      if (!updated) return;
      set((state) => ({
        entries: state.entries.map((e) => (e.id === id ? updated : e)),
      }));
    } catch (e) {
      if (e instanceof SnippetVersionConflictError) {
        // 非破壊: store も timelapse も触らず、呼び出し側に再読み込みを促す。
        snippetEditConflictHandler(id);
        return;
      }
      toast.error(i18next.t("snippets.store.updateFailed"));
      debugLog.error("SnippetStore", "update", errorDetail(e));
      return;
    }

    // 本文 (content, ProseMirror JSON) の変更差分を timelapse に記録する。
    const diffs: Record<string, BodyDiff> = {};
    const nextContent = (data as { content?: unknown }).content;
    if (typeof nextContent === "string") {
      const d = computeDocDiff(before?.content ?? "", nextContent);
      if (d) diffs.content = d;
    }
    recordChangeEvent({
      domain: "snippet",
      opType: "snippet.update",
      entityType: "snippet",
      entityId: id,
      payload:
        Object.keys(diffs).length > 0
          ? { fields: Object.keys(data), diffs }
          : { fields: Object.keys(data) },
    });

    if (!before) return;
    if (useGlobalHistoryStore.getState().isReplaying) return;

    const undoPatch: Record<string, unknown> = {};
    for (const key of Object.keys(data)) {
      const v = (before as unknown as Record<string, unknown>)[key];
      undoPatch[key] = v ?? undefined;
    }

    // undo/redo クロージャは blind (baseVersion 無し) で固定する。replay 中に
    // version が動くと、その後の OCC 保存 (update) が in-memory の version と
    // 食い違って自己衝突するため。
    useGlobalHistoryStore.getState().push({
      kind: "snippets",
      label: i18next.t("history.snippets.updated"),
      entityId: id,
      async undo() {
        const restored = await snippetApi.updateSnippet(
          getCurrentProjectId(),
          id,
          undoPatch as Parameters<typeof snippetApi.updateSnippet>[2],
        );
        if (restored) {
          set((state) => ({
            entries: state.entries.map((e) => (e.id === id ? restored : e)),
          }));
        }
      },
      async redo() {
        const reapplied = await snippetApi.updateSnippet(
          getCurrentProjectId(),
          id,
          data,
        );
        if (reapplied) {
          set((state) => ({
            entries: state.entries.map((e) => (e.id === id ? reapplied : e)),
          }));
        }
      },
    });
  },

  remove: async (id) => {
    const before = get().entries.find((e) => e.id === id);
    try {
      await snippetApi.deleteSnippet(getCurrentProjectId(), id);
      set((state) => ({
        entries: state.entries.filter((e) => e.id !== id),
      }));
      notifySnippetDeleted(id);
    } catch (e) {
      toast.error(i18next.t("snippets.store.deleteFailed"));
      debugLog.error("SnippetStore", "remove", errorDetail(e));
      return;
    }

    recordChangeEvent({
      domain: "snippet",
      opType: "snippet.delete",
      entityType: "snippet",
      entityId: id,
      payload: { title: before?.title ?? null },
    });

    if (!before) return;
    if (useGlobalHistoryStore.getState().isReplaying) return;

    const captured = { ...before };
    const trashTempId = `trash-snippet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    captureSnippetDeletion({
      projectId: captured.projectId,
      snippet: captured,
      tempId: trashTempId,
    });
    useGlobalHistoryStore.getState().push({
      kind: "snippets",
      label: i18next.t("history.snippets.deleted"),
      entityId: captured.id,
      async undo() {
        useTrashBinStore.getState().cancelPending({ tempId: trashTempId });
        await snippetApi.createSnippet({
          id: captured.id,
          projectId: captured.projectId,
          title: captured.title,
          content: captured.content,
          tagsCache: captured.tagsCache ?? undefined,
          sceneId: captured.sceneId ?? undefined,
          sourceChatMessageId: captured.sourceChatMessageId ?? undefined,
          contentSource: captured.contentSource ?? undefined,
        });
        set((state) => ({ entries: [...state.entries, captured] }));
      },
      async redo() {
        await snippetApi.deleteSnippet(captured.projectId, captured.id);
        set((state) => ({
          entries: state.entries.filter((e) => e.id !== captured.id),
        }));
        notifySnippetDeleted(captured.id);
      },
    });
  },

  incrementUsageCount: async (id: string) => {
    try {
      await snippetApi.incrementSnippetUsageCount(getCurrentProjectId(), id);
      set((state) => ({
        entries: state.entries.map((e) =>
          e.id === id ? { ...e, usageCount: (e.usageCount ?? 0) + 1 } : e,
        ),
      }));
    } catch (e) {
      debugLog.error("SnippetStore", "incrementUsageCount", errorDetail(e));
    }
  },
}));
