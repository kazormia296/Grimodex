import { create } from "zustand";
import { toast } from "sonner";
import { debugLog, errorDetail } from "@/lib/debugLog";
import * as snippetApi from "./api";
import type { Snippet, NewSnippet } from "./api";
import { searchSnippets } from "./search";

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

  loadEntries: () => Promise<void>;
  search: (query: string) => Promise<void>;
  setSourceFilter: (filter: SnippetSourceFilter) => void;
  setSortOrder: (order: SnippetSortOrder) => void;
  create: (
    data: Pick<NewSnippet, "title" | "content"> &
      Partial<
        Pick<
          NewSnippet,
          "tagsCache" | "sceneId" | "sourceChatMessageId" | "contentSource"
        >
      >,
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

export const useSnippetStore = create<SnippetState>()((set, get) => ({
  entries: [],
  searchQuery: "",
  isLoading: false,
  sourceFilter: "all",
  sortOrder: "recent",

  setSourceFilter: (filter) => set({ sourceFilter: filter }),
  setSortOrder: (order) => set({ sortOrder: order }),

  loadEntries: async () => {
    set({ isLoading: true });
    try {
      const entries = await snippetApi.listSnippets();
      set({ entries, isLoading: false });
    } catch (e) {
      set({ isLoading: false });
      toast.error("スニペットの読み込みに失敗しました");
      debugLog.error("SnippetStore", "loadEntries", errorDetail(e));
    }
  },

  search: async (query: string) => {
    set({ searchQuery: query, isLoading: true });
    try {
      if (query.trim() === "") {
        const entries = await snippetApi.listSnippets();
        set({ entries, isLoading: false });
      } else {
        const entries = await searchSnippets(query);
        set({ entries, isLoading: false });
      }
    } catch (e) {
      set({ isLoading: false });
      toast.error("スニペット検索に失敗しました");
      debugLog.error("SnippetStore", "search", errorDetail(e));
    }
  },

  create: async (data) => {
    try {
      const created = await snippetApi.createSnippet({
        id: crypto.randomUUID(),
        projectId: "default-project",
        ...data,
      });
      set((state) => ({ entries: [...state.entries, created] }));
      // Background re-sync to fix race condition: if useEffect's loadEntries() was
      // in-flight (e.g., after a layout preset change or during Tauri startup),
      // it may resolve after this optimistic update and overwrite it with stale data.
      // Re-fetch after the INSERT so our SELECT is guaranteed to include the new entry.
      if (get().isLoading) {
        snippetApi
          .listSnippets()
          .then((entries) =>
            set((state) => (state.searchQuery ? state : { entries })),
          )
          .catch(() => {});
      }
      toast.success("Saved as Snippet");
      return created;
    } catch (e) {
      toast.error("スニペットの作成に失敗しました");
      debugLog.error("SnippetStore", "create", errorDetail(e));
      throw e;
    }
  },

  update: async (id, data) => {
    try {
      const updated = await snippetApi.updateSnippet(id, data);
      if (!updated) return;
      set((state) => ({
        entries: state.entries.map((e) => (e.id === id ? updated : e)),
      }));
    } catch (e) {
      toast.error("スニペットの更新に失敗しました");
      debugLog.error("SnippetStore", "update", errorDetail(e));
    }
  },

  remove: async (id) => {
    try {
      await snippetApi.deleteSnippet(id);
      set((state) => ({
        entries: state.entries.filter((e) => e.id !== id),
      }));
    } catch (e) {
      toast.error("スニペットの削除に失敗しました");
      debugLog.error("SnippetStore", "remove", errorDetail(e));
    }
  },

  incrementUsageCount: async (id: string) => {
    try {
      await snippetApi.incrementSnippetUsageCount(id);
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
