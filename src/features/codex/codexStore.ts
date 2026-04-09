import { create } from "zustand";
import { toast } from "sonner";
import { debugLog, errorDetail, rootCause } from "@/lib/debugLog";
import {
  listCodexEntries,
  createCodexEntry,
  updateCodexEntry,
  deleteCodexEntry,
} from "./api";
import type { CodexEntry, CodexEntryType, NewCodexEntry } from "./api";
import { searchCodexEntries } from "./search";

export type CodexSortOrder =
  | "category"
  | "name-asc"
  | "name-desc"
  | "updated"
  | "created"
  | "most-referenced";

interface CodexState {
  entries: CodexEntry[];
  searchQuery: string;
  filterType: CodexEntryType | null;
  sortOrder: CodexSortOrder;
  isLoading: boolean;

  loadEntries: () => Promise<void>;
  search: (query: string) => Promise<void>;
  setSort: (order: CodexSortOrder) => void;
  create: (
    data: Pick<NewCodexEntry, "type" | "name"> &
      Partial<
        Pick<
          NewCodexEntry,
          | "summary"
          | "tagsCache"
          | "aliases"
          | "excludedAliases"
          | "sourceChatMessageId"
        >
      >,
  ) => Promise<CodexEntry>;
  update: (
    id: string,
    data: Partial<
      Pick<
        NewCodexEntry,
        | "type"
        | "name"
        | "summary"
        | "content"
        | "tagsCache"
        | "aliases"
        | "excludedAliases"
        | "contextMode"
        | "icon"
        | "childrenBudget"
        | "notes"
      >
    >,
  ) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setFilterType: (type: CodexEntryType | null) => Promise<void>;
}

export const useCodexStore = create<CodexState>()((set, get) => ({
  entries: [],
  searchQuery: "",
  filterType: null,
  sortOrder: "category" as CodexSortOrder,
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
      debugLog.error(
        "CodexStore",
        `loadEntries: ${rootCause(e)}`,
        errorDetail(e),
      );
    }
  },

  setSort: (order) => {
    set({ sortOrder: order });
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
      debugLog.error("CodexStore", `search: ${rootCause(e)}`, errorDetail(e));
    }
  },

  create: async (data) => {
    try {
      const entry = await createCodexEntry({
        id: crypto.randomUUID(),
        projectId: "default-project",
        ...data,
      });
      // Optimistic update: add to store immediately without triggering isLoading cycle.
      // isLoading=true unmounts the virtualizer's scroll container, causing a one-frame
      // gap where getVirtualItems() returns [] before ResizeObserver fires.
      const { filterType } = get();
      if (!filterType || filterType === entry.type) {
        set((state) => ({ entries: [entry, ...state.entries] }));
      }
      return entry;
    } catch (e) {
      toast.error("Codexエントリの作成に失敗しました");
      debugLog.error("CodexStore", `create: ${rootCause(e)}`, errorDetail(e));
      throw e;
    }
  },

  update: async (id, data) => {
    try {
      const updated = await updateCodexEntry(id, data);
      if (updated) {
        set((state) => ({
          entries: state.entries.map((e) => (e.id === id ? updated : e)),
        }));
      }
    } catch (e) {
      toast.error("Codexエントリの更新に失敗しました");
      debugLog.error("CodexStore", `update: ${rootCause(e)}`, errorDetail(e));
    }
  },

  remove: async (id) => {
    try {
      await deleteCodexEntry(id);
      await get().loadEntries();
    } catch (e) {
      toast.error("Codexエントリの削除に失敗しました");
      debugLog.error("CodexStore", `remove: ${rootCause(e)}`, errorDetail(e));
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
      debugLog.error(
        "CodexStore",
        `setFilterType: ${rootCause(e)}`,
        errorDetail(e),
      );
    }
  },
}));
