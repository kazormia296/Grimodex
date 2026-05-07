import { create } from "zustand";
import { toast } from "sonner";
import i18next from "i18next";
import { debugLog, errorDetail, rootCause } from "@/lib/debugLog";
import {
  listCodexEntries,
  createCodexEntry,
  updateCodexEntry,
  deleteCodexEntry,
} from "./api";
import type { CodexEntry, CodexEntryType, NewCodexEntry } from "./api";
import { listCodexTypes, type CodexType } from "./typeApi";
import { searchCodexEntries } from "./search";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { captureCodexDeletion } from "@/features/trash-bin/captureHooks";
import { useTrashBinStore } from "@/features/trash-bin/trashBinStore";

const DEFAULT_PROJECT_ID = "default-project";

export type CodexSortOrder =
  | "category"
  | "name-asc"
  | "name-desc"
  | "updated"
  | "created"
  | "most-referenced";

type StructuralPatch = Partial<
  Pick<
    NewCodexEntry,
    | "type"
    | "name"
    | "summary"
    | "content"
    | "tagsCache"
    | "aliases"
    | "excludedAliases"
    | "parentId"
    | "contextMode"
    | "icon"
    | "childrenBudget"
    | "notes"
  >
>;

type TextPatch = Partial<Pick<NewCodexEntry, "summary" | "content" | "notes">>;

const FIELD_LABELS: Record<string, string> = {
  type: "種別変更",
  name: "名称変更",
  summary: "概要変更",
  content: "内容変更",
  notes: "ノート変更",
  tagsCache: "タグ変更",
  aliases: "別名変更",
  excludedAliases: "除外別名変更",
  parentId: "親変更",
  contextMode: "コンテキストモード変更",
  icon: "アイコン変更",
  childrenBudget: "子budget変更",
};

function labelForPatch(data: StructuralPatch): string {
  const keys = Object.keys(data);
  if (keys.length === 1) {
    return FIELD_LABELS[keys[0]] ?? "Codex 更新";
  }
  return "Codex 更新";
}

interface CodexState {
  entries: CodexEntry[];
  /** type slug → CodexType の lookup 用キャッシュ。loadEntries で更新。 */
  types: CodexType[];
  searchQuery: string;
  filterType: CodexEntryType | null;
  sortOrder: CodexSortOrder;
  isLoading: boolean;
  pendingEntryId: string | null;

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
  /**
   * Structural / deliberate user edits. Pushes a history entry.
   */
  update: (id: string, data: StructuralPatch) => Promise<void>;
  /**
   * Auto-save path for TipTap-driven text fields. Does NOT push history;
   * TipTap's built-in undo handles text-level reversal.
   */
  updateText: (id: string, data: TextPatch) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setFilterType: (type: CodexEntryType | null) => Promise<void>;
  requestSelectEntry: (id: string) => void;
  clearPendingEntry: () => void;
}

export const useCodexStore = create<CodexState>()((set, get) => ({
  entries: [],
  types: [],
  searchQuery: "",
  filterType: null,
  sortOrder: "category" as CodexSortOrder,
  isLoading: false,
  pendingEntryId: null,

  loadEntries: async () => {
    set({ isLoading: true });
    try {
      const { filterType } = get();
      const [entries, types] = await Promise.all([
        listCodexEntries(filterType ?? undefined),
        listCodexTypes(DEFAULT_PROJECT_ID),
      ]);
      set({ entries, types, isLoading: false });
    } catch (e) {
      set({ isLoading: false });
      toast.error(i18next.t("codex.store.loadFailed"));
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
      toast.error(i18next.t("codex.store.searchFailed"));
      debugLog.error("CodexStore", `search: ${rootCause(e)}`, errorDetail(e));
    }
  },

  create: async (data) => {
    try {
      const id = crypto.randomUUID();
      const entry = await createCodexEntry({
        id,
        projectId: "default-project",
        ...data,
      });
      const { filterType } = get();
      if (!filterType || filterType === entry.type) {
        set((state) => ({ entries: [entry, ...state.entries] }));
      }

      if (!useGlobalHistoryStore.getState().isReplaying) {
        const captured = { ...entry };
        useGlobalHistoryStore.getState().push({
          kind: "codex",
          label: "Codex作成",
          async undo() {
            await deleteCodexEntry(captured.id);
            set((state) => ({
              entries: state.entries.filter((e) => e.id !== captured.id),
            }));
          },
          async redo() {
            await createCodexEntry({
              id: captured.id,
              projectId: captured.projectId,
              type: captured.type,
              name: captured.name,
              summary: captured.summary ?? undefined,
              tagsCache: captured.tagsCache ?? undefined,
              aliases: captured.aliases ?? undefined,
              excludedAliases: captured.excludedAliases ?? undefined,
              parentId: captured.parentId ?? undefined,
              sourceChatMessageId: captured.sourceChatMessageId ?? undefined,
            });
            // Apply remaining fields not accepted by createCodexEntry
            await updateCodexEntry(captured.id, {
              content: captured.content ?? undefined,
              contextMode: captured.contextMode ?? undefined,
              icon: captured.icon ?? undefined,
              childrenBudget: captured.childrenBudget ?? undefined,
              notes: captured.notes ?? undefined,
            });
            const { filterType } = get();
            if (!filterType || filterType === captured.type) {
              set((state) => ({ entries: [captured, ...state.entries] }));
            }
          },
        });
      }
      return entry;
    } catch (e) {
      toast.error(i18next.t("codex.store.createFailed"));
      debugLog.error("CodexStore", `create: ${rootCause(e)}`, errorDetail(e));
      throw e;
    }
  },

  update: async (id, data) => {
    const before = get().entries.find((e) => e.id === id);

    try {
      const updated = await updateCodexEntry(id, data);
      if (updated) {
        set((state) => ({
          entries: state.entries.map((e) => (e.id === id ? updated : e)),
        }));
      }
    } catch (e) {
      toast.error(i18next.t("codex.store.updateFailed"));
      debugLog.error("CodexStore", `update: ${rootCause(e)}`, errorDetail(e));
      return;
    }

    if (!before) return;
    if (useGlobalHistoryStore.getState().isReplaying) return;

    const undoPatch: Record<string, unknown> = {};
    for (const key of Object.keys(data)) {
      const v = (before as unknown as Record<string, unknown>)[key];
      undoPatch[key] = v ?? undefined;
    }
    // Defensive copy so later mutation of `data` by the caller cannot change
    // the redo behavior captured in this closure.
    const redoPatch = { ...data };

    useGlobalHistoryStore.getState().push({
      kind: "codex",
      label: labelForPatch(data),
      async undo() {
        const restored = await updateCodexEntry(
          id,
          undoPatch as StructuralPatch,
        );
        if (restored) {
          set((state) => ({
            entries: state.entries.map((e) => (e.id === id ? restored : e)),
          }));
        }
      },
      async redo() {
        const reapplied = await updateCodexEntry(id, redoPatch);
        if (reapplied) {
          set((state) => ({
            entries: state.entries.map((e) => (e.id === id ? reapplied : e)),
          }));
        }
      },
    });
  },

  updateText: async (id, data) => {
    try {
      const updated = await updateCodexEntry(id, data);
      if (updated) {
        set((state) => ({
          entries: state.entries.map((e) => (e.id === id ? updated : e)),
        }));
      }
    } catch (e) {
      toast.error(i18next.t("codex.store.updateFailed"));
      debugLog.error(
        "CodexStore",
        `updateText: ${rootCause(e)}`,
        errorDetail(e),
      );
    }
  },

  remove: async (id) => {
    const before = get().entries.find((e) => e.id === id);
    try {
      await deleteCodexEntry(id);
      await get().loadEntries();
    } catch (e) {
      toast.error(i18next.t("codex.store.deleteFailed"));
      debugLog.error("CodexStore", `remove: ${rootCause(e)}`, errorDetail(e));
      return;
    }

    if (before && !useGlobalHistoryStore.getState().isReplaying) {
      const captured = { ...before };
      const trashTempId = `trash-codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const matchedType = get().types.find((t) => t.slug === captured.type);
      captureCodexDeletion({
        projectId: captured.projectId,
        entry: captured,
        categoryLabel: matchedType?.label ?? null,
        iconName: matchedType?.icon ?? null,
        tempId: trashTempId,
      });
      useGlobalHistoryStore.getState().push({
        kind: "codex",
        label: "Codex削除",
        async undo() {
          useTrashBinStore.getState().cancelPending({ tempId: trashTempId });
          await createCodexEntry({
            id: captured.id,
            projectId: captured.projectId,
            type: captured.type,
            name: captured.name,
            summary: captured.summary ?? undefined,
            tagsCache: captured.tagsCache ?? undefined,
            aliases: captured.aliases ?? undefined,
            excludedAliases: captured.excludedAliases ?? undefined,
            parentId: captured.parentId ?? undefined,
            sourceChatMessageId: captured.sourceChatMessageId ?? undefined,
          });
          await updateCodexEntry(captured.id, {
            content: captured.content ?? undefined,
            contextMode: captured.contextMode ?? undefined,
            icon: captured.icon ?? undefined,
            childrenBudget: captured.childrenBudget ?? undefined,
            notes: captured.notes ?? undefined,
          });
          await get().loadEntries();
        },
        async redo() {
          await deleteCodexEntry(captured.id);
          await get().loadEntries();
        },
      });
    }
  },

  requestSelectEntry: (id) => set({ pendingEntryId: id }),
  clearPendingEntry: () => set({ pendingEntryId: null }),

  setFilterType: async (type) => {
    set({ filterType: type, isLoading: true });
    try {
      const entries = await listCodexEntries(type ?? undefined);
      set({ entries, isLoading: false });
    } catch (e) {
      set({ isLoading: false });
      toast.error(i18next.t("codex.store.filterFailed"));
      debugLog.error(
        "CodexStore",
        `setFilterType: ${rootCause(e)}`,
        errorDetail(e),
      );
    }
  },
}));
