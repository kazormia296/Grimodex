import { create } from "zustand";
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
    const entries = await snippetApi.listSnippets();
    set({ entries, isLoading: false });
  },

  search: async (query: string) => {
    set({ searchQuery: query, isLoading: true });
    if (query.trim() === "") {
      const entries = await snippetApi.listSnippets();
      set({ entries, isLoading: false });
    } else {
      const entries = await searchSnippets(query);
      set({ entries, isLoading: false });
    }
  },

  create: async (data) => {
    const created = await snippetApi.createSnippet(data);
    set((state) => ({ entries: [...state.entries, created] }));
    return created;
  },

  update: async (id, data) => {
    const updated = await snippetApi.updateSnippet(id, data);
    if (!updated) return;
    set((state) => ({
      entries: state.entries.map((e) => (e.id === id ? updated : e)),
    }));
  },

  remove: async (id) => {
    await snippetApi.deleteSnippet(id);
    set((state) => ({
      entries: state.entries.filter((e) => e.id !== id),
    }));
  },
}));
