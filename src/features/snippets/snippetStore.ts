import { create } from "zustand";
import { toast } from "sonner";
import i18next from "i18next";
import { debugLog, errorDetail } from "@/lib/debugLog";
import * as snippetApi from "./api";
import type { Snippet, NewSnippet } from "./api";
import { searchSnippets } from "./search";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";

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

  loadEntries: () => Promise<void>;
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

export const useSnippetStore = create<SnippetState>()((set, get) => ({
  entries: [],
  searchQuery: "",
  isLoading: false,
  sourceFilter: "all",
  sortOrder: "recent",
  pendingEntryId: null,

  setSourceFilter: (filter) => set({ sourceFilter: filter }),
  setSortOrder: (order) => set({ sortOrder: order }),
  requestSelectEntry: (id) => set({ pendingEntryId: id }),
  clearPendingEntry: () => set({ pendingEntryId: null }),

  loadEntries: async () => {
    set({ isLoading: true });
    try {
      const entries = await snippetApi.listSnippets();
      set({ entries, isLoading: false });
    } catch (e) {
      set({ isLoading: false });
      toast.error(i18next.t("snippets.store.loadFailed"));
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
      toast.error(i18next.t("snippets.store.searchFailed"));
      debugLog.error("SnippetStore", "search", errorDetail(e));
    }
  },

  create: async (data, options) => {
    try {
      const id = crypto.randomUUID();
      const created = await snippetApi.createSnippet({
        id,
        projectId: "default-project",
        ...data,
      });
      set((state) => ({ entries: [...state.entries, created] }));

      if (!useGlobalHistoryStore.getState().isReplaying) {
        const captured = { ...created };
        useGlobalHistoryStore.getState().push({
          kind: "snippets",
          label: "Snippet作成",
          async undo() {
            await snippetApi.deleteSnippet(captured.id);
            set((state) => ({
              entries: state.entries.filter((e) => e.id !== captured.id),
            }));
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
          .listSnippets()
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
      const updated = await snippetApi.updateSnippet(id, data);
      if (!updated) return;
      set((state) => ({
        entries: state.entries.map((e) => (e.id === id ? updated : e)),
      }));
    } catch (e) {
      toast.error(i18next.t("snippets.store.updateFailed"));
      debugLog.error("SnippetStore", "update", errorDetail(e));
      return;
    }

    if (!before) return;
    if (useGlobalHistoryStore.getState().isReplaying) return;

    const undoPatch: Record<string, unknown> = {};
    for (const key of Object.keys(data)) {
      const v = (before as unknown as Record<string, unknown>)[key];
      undoPatch[key] = v ?? undefined;
    }

    useGlobalHistoryStore.getState().push({
      kind: "snippets",
      label: "Snippet更新",
      async undo() {
        const restored = await snippetApi.updateSnippet(
          id,
          undoPatch as Parameters<typeof snippetApi.updateSnippet>[1],
        );
        if (restored) {
          set((state) => ({
            entries: state.entries.map((e) => (e.id === id ? restored : e)),
          }));
        }
      },
      async redo() {
        const reapplied = await snippetApi.updateSnippet(id, data);
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
      await snippetApi.deleteSnippet(id);
      set((state) => ({
        entries: state.entries.filter((e) => e.id !== id),
      }));
    } catch (e) {
      toast.error(i18next.t("snippets.store.deleteFailed"));
      debugLog.error("SnippetStore", "remove", errorDetail(e));
      return;
    }

    if (!before) return;
    if (useGlobalHistoryStore.getState().isReplaying) return;

    const captured = { ...before };
    useGlobalHistoryStore.getState().push({
      kind: "snippets",
      label: "Snippet削除",
      async undo() {
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
        await snippetApi.deleteSnippet(captured.id);
        set((state) => ({
          entries: state.entries.filter((e) => e.id !== captured.id),
        }));
      },
    });
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
