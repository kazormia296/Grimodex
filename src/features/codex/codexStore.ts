import { create } from "zustand";
import { toast } from "sonner";
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
    data: Pick<NewCodexEntry, "type" | "name"> &
      Partial<
        Pick<
          NewCodexEntry,
          | "summary"
          | "tags"
          | "aliases"
          | "excludedAliases"
          | "sourceChatMessageId"
        >
      >,
  ) => Promise<CodexEntry>;
  update: (
    id: string,
    data: Partial<Pick<NewCodexEntry, "type" | "name" | "summary" | "tags">>,
  ) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setFilterType: (type: CodexEntryType | null) => Promise<void>;
}

export const useCodexStore = create<CodexState>()((set, get) => ({
  entries: [],
  searchQuery: "",
  filterType: null,
  isLoading: false,

  loadEntries: async () => {
    set({ isLoading: true });
    try {
      const { filterType } = get();
      const entries = await listCodexEntries(filterType ?? undefined);
      set({ entries, isLoading: false });
    } catch (e) {
      set({ isLoading: false });
      toast.error("Codexの読み込みに失敗しました");
      console.error("[CodexStore] loadEntries:", e);
    }
  },

  search: async (query: string) => {
    set({ searchQuery: query, isLoading: true });
    try {
      if (query.trim() === "") {
        const { filterType } = get();
        const entries = await listCodexEntries(filterType ?? undefined);
        set({ entries, isLoading: false });
      } else {
        const entries = await searchCodexEntries(query);
        set({ entries, isLoading: false });
      }
    } catch (e) {
      set({ isLoading: false });
      toast.error("検索に失敗しました");
      console.error("[CodexStore] search:", e);
    }
  },

  create: async (data) => {
    try {
      const entry = await createCodexEntry({
        id: crypto.randomUUID(),
        projectId: "default-project",
        ...data,
      });
      await get().loadEntries();
      return entry;
    } catch (e) {
      toast.error("Codexエントリの作成に失敗しました");
      console.error("[CodexStore] create:", e);
      throw e;
    }
  },

  update: async (id, data) => {
    try {
      await updateCodexEntry(id, data);
      await get().loadEntries();
    } catch (e) {
      toast.error("Codexエントリの更新に失敗しました");
      console.error("[CodexStore] update:", e);
    }
  },

  remove: async (id) => {
    try {
      await deleteCodexEntry(id);
      await get().loadEntries();
    } catch (e) {
      toast.error("Codexエントリの削除に失敗しました");
      console.error("[CodexStore] remove:", e);
    }
  },

  setFilterType: async (type) => {
    set({ filterType: type, isLoading: true });
    try {
      const entries = await listCodexEntries(type ?? undefined);
      set({ entries, isLoading: false });
    } catch (e) {
      set({ isLoading: false });
      toast.error("フィルタの適用に失敗しました");
      console.error("[CodexStore] setFilterType:", e);
    }
  },
}));
