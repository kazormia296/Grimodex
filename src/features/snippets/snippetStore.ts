import { create } from "zustand";
import { toast } from "sonner";
import * as snippetApi from "./api";
import type { Snippet, NewSnippet } from "./api";
import { searchSnippets } from "./search";

interface SnippetState {
  entries: Snippet[];
  searchQuery: string;
  isLoading: boolean;

  loadEntries: () => Promise<void>;
  search: (query: string) => Promise<void>;
  create: (
    data: Pick<NewSnippet, "title" | "content" | "tags"> &
      Partial<Pick<NewSnippet, "sceneId" | "sourceChatMessageId">>,
  ) => Promise<Snippet>;
  update: (
    id: number,
    data: Partial<Pick<NewSnippet, "title" | "content" | "tags" | "sceneId">>,
  ) => Promise<void>;
  remove: (id: number) => Promise<void>;
}

export const useSnippetStore = create<SnippetState>()((set) => ({
  entries: [],
  searchQuery: "",
  isLoading: false,

  loadEntries: async () => {
    set({ isLoading: true });
    try {
      const entries = await snippetApi.listSnippets();
      set({ entries, isLoading: false });
    } catch (e) {
      set({ isLoading: false });
      toast.error("スニペットの読み込みに失敗しました");
      console.error("[SnippetStore] loadEntries:", e);
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
      console.error("[SnippetStore] search:", e);
    }
  },

  create: async (data) => {
    try {
      const created = await snippetApi.createSnippet(data);
      set((state) => ({ entries: [...state.entries, created] }));
      return created;
    } catch (e) {
      toast.error("スニペットの作成に失敗しました");
      console.error("[SnippetStore] create:", e);
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
      console.error("[SnippetStore] update:", e);
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
      console.error("[SnippetStore] remove:", e);
    }
  },
}));
