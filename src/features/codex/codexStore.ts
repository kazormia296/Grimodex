import { create } from "zustand";
import {
  listCodexEntries,
  createCodexEntry,
  updateCodexEntry,
  deleteCodexEntry,
} from "./api";
import type { CodexEntry, CodexEntryType, NewCodexEntry } from "./api";
import { searchCodexEntries } from "./search";

interface CodexState {
  entries: CodexEntry[];
  searchQuery: string;
  filterType: CodexEntryType | null;
  isLoading: boolean;

  loadEntries: () => Promise<void>;
  search: (query: string) => Promise<void>;
  create: (
    data: Pick<NewCodexEntry, "type" | "name" | "content" | "tags"> &
      Partial<Pick<NewCodexEntry, "summary" | "sourceChatMessageId">>,
  ) => Promise<CodexEntry>;
  update: (
    id: number,
    data: Partial<
      Pick<NewCodexEntry, "type" | "name" | "summary" | "content" | "tags">
    >,
  ) => Promise<void>;
  remove: (id: number) => Promise<void>;
  setFilterType: (type: CodexEntryType | null) => Promise<void>;
}

export const useCodexStore = create<CodexState>()((set, get) => ({
  entries: [],
  searchQuery: "",
  filterType: null,
  isLoading: false,

  loadEntries: async () => {
    set({ isLoading: true });
    const { filterType } = get();
    const entries = await listCodexEntries(filterType ?? undefined);
    set({ entries, isLoading: false });
  },

  search: async (query: string) => {
    set({ searchQuery: query, isLoading: true });
    if (query.trim() === "") {
      const { filterType } = get();
      const entries = await listCodexEntries(filterType ?? undefined);
      set({ entries, isLoading: false });
    } else {
      const entries = await searchCodexEntries(query);
      set({ entries, isLoading: false });
    }
  },

  create: async (data) => {
    const entry = await createCodexEntry(data);
    await get().loadEntries();
    return entry;
  },

  update: async (id, data) => {
    await updateCodexEntry(id, data);
    await get().loadEntries();
  },

  remove: async (id) => {
    await deleteCodexEntry(id);
    await get().loadEntries();
  },

  setFilterType: async (type) => {
    set({ filterType: type, isLoading: true });
    const entries = await listCodexEntries(type ?? undefined);
    set({ entries, isLoading: false });
  },
}));
