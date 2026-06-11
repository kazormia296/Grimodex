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
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useChatStore } from "@/features/chat/chatStore";
import { createInFlightTracker } from "@/lib/inFlightTracker";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import {
  computeBodyDiff,
  computeDocDiff,
  type BodyDiff,
} from "@/features/timelapse/bodyDiff";
import {
  blockIfUnlicensed,
  LICENSE_WRITE_RESTRICTED_ERROR,
} from "@/features/license/gate";

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
  /**
   * 現在 Codex パネルで選択中のエントリ。レイアウトプリセット切替で配置から
   * 外れたりパネルを閉じたりするとパネル subtree は unmount され、パネル内
   * local state だと選択が失われる。選択をストアに持たせて unmount を跨いで
   * 保持する。pendingEntryId（外部からの一発選択要求）とは別物。
   */
  selectedEntry: CodexEntry | null;
  setSelectedEntry: (entry: CodexEntry | null) => void;
  /**
   * Codex panel の wide mode 用 phase preview。entry id → phase id (`__base__` or実際の phase id)。
   * null（key 不在）は「auto-resolve に従う」を意味する。DetailsTab の PhaseIndicator から書き込み、
   * 同じ entry を内部 EditorPane が読む経路を媒介する。
   */
  previewPhaseByEntry: Record<string, string | null>;
  setPreviewPhase: (entryId: string, phaseId: string | null) => void;

  loadEntries: () => Promise<void>;
  /** mount 用の dedup 付きロード。同一キー (projectId|filterType) のロードが
   *  進行中ならそれに相乗りする。settle 後は毎回ロードする (remount での
   *  再フェッチ = MCP 等の外部書き込み追従は維持)。 */
  ensureEntriesLoaded: () => Promise<void>;
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

// mount eager load の in-flight dedup (詳細は ensureEntriesLoaded の docs)
const entriesLoadTracker = createInFlightTracker();
function entriesLoadKey(filterType: CodexEntryType | null): string {
  return `${getCurrentProjectId()}|${filterType ?? ""}`;
}

export const useCodexStore = create<CodexState>()((set, get) => ({
  entries: [],
  types: [],
  searchQuery: "",
  filterType: null,
  sortOrder: "category" as CodexSortOrder,
  isLoading: false,
  pendingEntryId: null,
  selectedEntry: null,
  setSelectedEntry: (entry) => set({ selectedEntry: entry }),
  previewPhaseByEntry: {},

  setPreviewPhase: (entryId, phaseId) => {
    set((s) => {
      if (phaseId == null) {
        if (!(entryId in s.previewPhaseByEntry)) return s;
        const next = { ...s.previewPhaseByEntry };
        delete next[entryId];
        return { previewPhaseByEntry: next };
      }
      if (s.previewPhaseByEntry[entryId] === phaseId) return s;
      return {
        previewPhaseByEntry: { ...s.previewPhaseByEntry, [entryId]: phaseId },
      };
    });
  },

  loadEntries: async () => {
    const run = (async () => {
      set({ isLoading: true });
      try {
        const { filterType } = get();
        const projectId = getCurrentProjectId();
        const [entries, types] = await Promise.all([
          listCodexEntries(projectId, filterType ?? undefined),
          listCodexTypes(projectId),
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
    })();
    // mutation 後の直接 loadEntries も in-flight として記録し、直後に
    // mount する ensureEntriesLoaded がこの (最新の) ロードに相乗りする
    entriesLoadTracker.track(entriesLoadKey(get().filterType), run);
    return run;
  },

  ensureEntriesLoaded: () => {
    const inFlight = entriesLoadTracker.peek(entriesLoadKey(get().filterType));
    if (inFlight) return inFlight;
    return get().loadEntries();
  },

  setSort: (order) => {
    set({ sortOrder: order });
  },

  search: async (query: string) => {
    set({ searchQuery: query, isLoading: true });
    try {
      if (query.trim() === "") {
        const { filterType } = get();
        const entries = await listCodexEntries(
          getCurrentProjectId(),
          filterType ?? undefined,
        );
        set({ entries, isLoading: false });
      } else {
        const entries = await searchCodexEntries(query, getCurrentProjectId());
        set({ entries, isLoading: false });
      }
    } catch (e) {
      set({ isLoading: false });
      toast.error(i18next.t("codex.store.searchFailed"));
      debugLog.error("CodexStore", `search: ${rootCause(e)}`, errorDetail(e));
    }
  },

  create: async (data) => {
    if (blockIfUnlicensed()) throw new Error(LICENSE_WRITE_RESTRICTED_ERROR);
    try {
      const id = crypto.randomUUID();
      const entry = await createCodexEntry({
        id,
        projectId: getCurrentProjectId(),
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
          entityId: captured.id,
          async undo() {
            await deleteCodexEntry(captured.projectId, captured.id);
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
            await updateCodexEntry(captured.projectId, captured.id, {
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
      recordChangeEvent({
        domain: "codex",
        opType: "entry.create",
        entityType: "codex_entry",
        entityId: entry.id,
        payload: {
          type: entry.type,
          name: entry.name,
          parentId: entry.parentId,
        },
      });
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
      const updated = await updateCodexEntry(getCurrentProjectId(), id, data);
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

    recordChangeEvent({
      domain: "codex",
      opType: "entry.update",
      entityType: "codex_entry",
      entityId: id,
      payload: {
        fields: Object.keys(data),
        // before/after は keys のみで巨大な content を chain に含めない。
        // body 差分は AuthorshipMark + editor onTransaction が別経路で捕捉する。
      },
    });

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
      entityId: id,
      async undo() {
        const restored = await updateCodexEntry(
          getCurrentProjectId(),
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
        const reapplied = await updateCodexEntry(
          getCurrentProjectId(),
          id,
          redoPatch,
        );
        if (reapplied) {
          set((state) => ({
            entries: state.entries.map((e) => (e.id === id ? reapplied : e)),
          }));
        }
      },
    });
  },

  updateText: async (id, data) => {
    const before = get().entries.find((e) => e.id === id);
    try {
      const updated = await updateCodexEntry(getCurrentProjectId(), id, data);
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
      return;
    }

    // 本文系 (content / summary) の変更差分を timelapse に記録する。notes は
    // 対象外。差分が無ければイベントは出さない (純 notes 編集は従来通り無記録)。
    // content は ProseMirror JSON なので抽出テキストで diff、summary はプレーン
    // テキストなのでそのまま diff する。
    const diffs: Record<string, BodyDiff> = {};
    if ("content" in data) {
      const d = computeDocDiff(before?.content ?? "", data.content ?? "");
      if (d) diffs.content = d;
    }
    if ("summary" in data) {
      const d = computeBodyDiff(before?.summary ?? "", data.summary ?? "");
      if (d) diffs.summary = d;
    }
    const fields = Object.keys(diffs);
    if (fields.length > 0) {
      recordChangeEvent({
        domain: "codex",
        opType: "entry.update",
        entityType: "codex_entry",
        entityId: id,
        payload: { fields, diffs },
      });
    }
  },

  remove: async (id) => {
    const before = get().entries.find((e) => e.id === id);
    try {
      await deleteCodexEntry(getCurrentProjectId(), id);
      await get().loadEntries();
      useChatStore.getState().onCodexAnchorDeleted(id);
    } catch (e) {
      toast.error(i18next.t("codex.store.deleteFailed"));
      debugLog.error("CodexStore", `remove: ${rootCause(e)}`, errorDetail(e));
      return;
    }

    recordChangeEvent({
      domain: "codex",
      opType: "entry.delete",
      entityType: "codex_entry",
      entityId: id,
      payload: { name: before?.name ?? null, type: before?.type ?? null },
    });

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
        entityId: captured.id,
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
          await updateCodexEntry(captured.projectId, captured.id, {
            content: captured.content ?? undefined,
            contextMode: captured.contextMode ?? undefined,
            icon: captured.icon ?? undefined,
            childrenBudget: captured.childrenBudget ?? undefined,
            notes: captured.notes ?? undefined,
          });
          await get().loadEntries();
        },
        async redo() {
          await deleteCodexEntry(captured.projectId, captured.id);
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
      const entries = await listCodexEntries(
        getCurrentProjectId(),
        type ?? undefined,
      );
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
