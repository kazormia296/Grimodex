import { create } from "zustand";
import { toast } from "sonner";
import i18next from "i18next";
import { announce } from "@/lib/a11y/announcer";
import { debugLog, errorDetail, rootCause } from "@/lib/debugLog";
import {
  listCodexEntries,
  listCodexMatchTargets,
  getCodexEntry,
  createCodexEntry,
  updateCodexEntry,
  deleteCodexEntry,
} from "./api";
import type {
  CodexEntry,
  CodexEntryType,
  CodexMatchRow,
  NewCodexEntry,
} from "./api";
import { CodexVersionConflictError } from "./occ";
import { listCodexTypes, type CodexType } from "./typeApi";
import { searchCodexEntries } from "./search";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { captureCodexDeletion } from "@/features/trash-bin/captureHooks";
import { useTrashBinStore } from "@/features/trash-bin/trashBinStore";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useChatStore } from "@/features/chat/chatStore";
import { createInFlightTracker } from "@/lib/inFlightTracker";
import { _clearCodexCrossMentionCaches } from "./codexCrossMentions";
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
import {
  parseReadings,
  resolveUnsetReadingTargetForSurface,
  serializeReadings,
} from "./reading";
import { getCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import {
  SAVE_NOT_PERSISTED,
  persistedVersion,
  type VersionedSaveOutcome,
} from "@/lib/saveOutcome";
import { hasExternalEditConflictForId } from "@/lib/externalEditConflictRegistry";

export type CodexSortOrder =
  | "category"
  | "name-asc"
  | "name-desc"
  | "updated"
  | "created"
  | "most-referenced";

/**
 * 別窓 / 別プロセスが同じ entry を先に更新していて OCC 衝突した時のハンドラ。
 * 既定はトースト通知のみ。マルチウインドウ層 (Codex 編集面) が
 * setCodexEditConflictHandler で「最新を読み込む」導線に差し替える。
 * 本文を黙って上書きしないための非破壊フックなので、ここでは store も
 * timelapse も触らない。
 */
let codexEditConflictHandler: (entryId: string) => void = () => {
  toast.error(i18next.t("codex.store.editConflict"));
};

export function setCodexEditConflictHandler(
  handler: (entryId: string) => void,
): void {
  codexEditConflictHandler = handler;
}

interface RendererAuthority {
  projectId: string;
  workspacePath: string | null;
  workspaceOpenRevision: number | null;
}

function captureRendererAuthority(): RendererAuthority {
  const workspaceIdentity = getCurrentWorkspaceIdentity();
  return {
    projectId: getCurrentProjectId(),
    workspacePath: workspaceIdentity?.path ?? null,
    workspaceOpenRevision: workspaceIdentity?.openRevision ?? null,
  };
}

function isCurrentRendererAuthority(authority: RendererAuthority): boolean {
  const workspaceIdentity = getCurrentWorkspaceIdentity();
  return (
    getCurrentProjectId() === authority.projectId &&
    (workspaceIdentity?.path ?? null) === authority.workspacePath &&
    (workspaceIdentity?.openRevision ?? null) ===
      authority.workspaceOpenRevision
  );
}

class CodexCreateAuthorityChangedError extends Error {
  constructor() {
    super("codex create authority changed");
    this.name = "CodexCreateAuthorityChangedError";
  }
}

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
    | "readings"
    | "parentId"
    | "contextMode"
    | "icon"
    | "childrenBudget"
    | "notes"
  >
>;

type TextPatch = Partial<Pick<NewCodexEntry, "summary" | "content" | "notes">>;

const FIELD_LABEL_KEYS: Record<string, string> = {
  type: "codex.history.typeChanged",
  name: "codex.history.nameChanged",
  summary: "codex.history.summaryChanged",
  content: "codex.history.contentChanged",
  notes: "codex.history.notesChanged",
  tagsCache: "codex.history.tagsChanged",
  aliases: "codex.history.aliasesChanged",
  excludedAliases: "codex.history.excludedAliasesChanged",
  readings: "codex.history.readingsChanged",
  parentId: "codex.history.parentChanged",
  contextMode: "codex.history.contextModeChanged",
  icon: "codex.history.iconChanged",
  childrenBudget: "codex.history.childrenBudgetChanged",
};

function labelForPatch(data: StructuralPatch): string {
  const keys = Object.keys(data);
  if (keys.length === 1) {
    const key = FIELD_LABEL_KEYS[keys[0]];
    if (key) return i18next.t(key);
  }
  return i18next.t("codex.history.updated");
}

interface CodexState {
  entries: CodexEntry[];
  /**
   * Search/filter independent lightweight rows used by local matching features.
   * Unlike `entries`, this collection always represents the whole project.
   */
  completionTargets: CodexMatchRow[];
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
          | "readings"
          | "sourceChatMessageId"
        >
      >,
  ) => Promise<CodexEntry>;
  /**
   * Structural / deliberate user edits. Pushes a history entry.
   */
  update: (
    id: string,
    data: StructuralPatch,
    options?: { baseVersion?: number },
  ) => Promise<VersionedSaveOutcome>;
  /**
   * Type + summary detail form save. Persists both fields in one OCC-protected
   * write and reports whether the complete save was committed.
   */
  saveTypeAndSummary: (
    id: string,
    data: { type: CodexEntryType; summary: string },
  ) => Promise<boolean>;
  /**
   * 手動ルビを未設定の Codex 読みへ登録する。DB の最新行へ非破壊マージし、
   * version OCC で別窓/MCPとの競合を弾く。
   */
  registerRubyReading: (
    expectedEntryId: string,
    surface: string,
    reading: string,
  ) => Promise<boolean>;
  /**
   * Auto-save path for TipTap-driven text fields. Does NOT push history;
   * TipTap's built-in undo handles text-level reversal.
   */
  updateText: (
    id: string,
    data: TextPatch,
    options?: { baseVersion?: number },
  ) => Promise<VersionedSaveOutcome>;
  remove: (id: string) => Promise<void>;
  setFilterType: (type: CodexEntryType | null) => Promise<void>;
  requestSelectEntry: (id: string) => void;
  clearPendingEntry: () => void;
  /** Drop project-owned entries, filters, selections, and derived caches. */
  resetForProject: () => void;
}

// mount eager load の in-flight dedup (詳細は ensureEntriesLoaded の docs)
const entriesLoadTracker = createInFlightTracker();
function entriesLoadKey(filterType: CodexEntryType | null): string {
  return `${getCurrentProjectId()}|${filterType ?? ""}`;
}

function toCompletionTarget(entry: CodexEntry): CodexMatchRow {
  return {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    aliases: entry.aliases,
    excludedAliases: entry.excludedAliases,
    readings: entry.readings,
  };
}

function sameCompletionTarget(a: CodexMatchRow, b: CodexMatchRow): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.type === b.type &&
    a.aliases === b.aliases &&
    a.excludedAliases === b.excludedAliases &&
    a.readings === b.readings
  );
}

function upsertCompletionTarget(
  targets: CodexMatchRow[],
  entry: CodexEntry,
): CodexMatchRow[] {
  const target = toCompletionTarget(entry);
  const index = targets.findIndex((candidate) => candidate.id === target.id);
  if (index < 0) return [target, ...targets];
  if (sameCompletionTarget(targets[index], target)) return targets;
  const next = [...targets];
  next[index] = target;
  return next;
}

function removeCompletionTarget(
  targets: CodexMatchRow[],
  entryId: string,
): CodexMatchRow[] {
  const next = targets.filter((target) => target.id !== entryId);
  return next.length === targets.length ? targets : next;
}

export const useCodexStore = create<CodexState>()((set, get) => ({
  entries: [],
  completionTargets: [],
  types: [],
  searchQuery: "",
  filterType: null,
  sortOrder: "category" as CodexSortOrder,
  isLoading: false,
  pendingEntryId: null,
  selectedEntry: null,
  setSelectedEntry: (entry) => {
    const current = get().selectedEntry;
    if (
      current &&
      current.id !== entry?.id &&
      hasExternalEditConflictForId(current.id)
    ) {
      return;
    }
    set({ selectedEntry: entry });
  },
  previewPhaseByEntry: {},

  setPreviewPhase: (entryId, phaseId) => {
    set((s) => {
      if (
        s.previewPhaseByEntry[entryId] !== phaseId &&
        hasExternalEditConflictForId(entryId)
      ) {
        return s;
      }
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
        const [entries, types, completionTargets] = await Promise.all([
          listCodexEntries(projectId, filterType ?? undefined),
          listCodexTypes(projectId),
          listCodexMatchTargets(projectId),
        ]);
        set({ entries, types, completionTargets, isLoading: false });
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
        // 成功パスは toast を出さないため、SR には結果件数が無音になる。
        // 呼び出し側 (パネル) が debounce 済みなので確定検索ごとに 1 回だけ、
        // かつ後発の検索が始まっていれば stale な件数は読み上げない。
        if (get().searchQuery === query) {
          announce(
            i18next.t("codex.searchResultCount", { count: entries.length }),
          );
        }
      }
    } catch (e) {
      set({ isLoading: false });
      toast.error(i18next.t("codex.store.searchFailed"));
      debugLog.error("CodexStore", `search: ${rootCause(e)}`, errorDetail(e));
    }
  },

  create: async (data) => {
    if (blockIfUnlicensed()) throw new Error(LICENSE_WRITE_RESTRICTED_ERROR);
    const authority = captureRendererAuthority();
    const { projectId } = authority;
    try {
      const id = crypto.randomUUID();
      const entry = await createCodexEntry({
        id,
        projectId,
        ...data,
      });
      if (!isCurrentRendererAuthority(authority)) {
        throw new CodexCreateAuthorityChangedError();
      }
      const { filterType } = get();
      set((state) => ({
        entries:
          !filterType || filterType === entry.type
            ? [entry, ...state.entries]
            : state.entries,
        completionTargets: upsertCompletionTarget(
          state.completionTargets,
          entry,
        ),
      }));

      if (!useGlobalHistoryStore.getState().isReplaying) {
        const captured = { ...entry };
        useGlobalHistoryStore.getState().push({
          kind: "codex",
          label: i18next.t("codex.history.created"),
          entityId: captured.id,
          async undo() {
            await deleteCodexEntry(captured.projectId, captured.id);
            if (!isCurrentRendererAuthority(authority)) return;
            set((state) => ({
              entries: state.entries.filter((e) => e.id !== captured.id),
              completionTargets: removeCompletionTarget(
                state.completionTargets,
                captured.id,
              ),
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
              readings: captured.readings ?? undefined,
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
            if (!isCurrentRendererAuthority(authority)) return;
            const { filterType } = get();
            set((state) => ({
              entries:
                !filterType || filterType === captured.type
                  ? [captured, ...state.entries]
                  : state.entries,
              completionTargets: upsertCompletionTarget(
                state.completionTargets,
                captured,
              ),
            }));
          },
        });
      }
      recordChangeEvent({
        domain: "codex",
        opType: "entry.create",
        projectId,
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
      if (
        e instanceof CodexCreateAuthorityChangedError ||
        !isCurrentRendererAuthority(authority)
      ) {
        throw e instanceof CodexCreateAuthorityChangedError
          ? e
          : new CodexCreateAuthorityChangedError();
      }
      toast.error(i18next.t("codex.store.createFailed"));
      debugLog.error("CodexStore", `create: ${rootCause(e)}`, errorDetail(e));
      throw e;
    }
  },

  update: async (id, data, options) => {
    const snapshot = get();
    const before =
      snapshot.entries.find((e) => e.id === id) ??
      (snapshot.selectedEntry?.id === id ? snapshot.selectedEntry : undefined);
    let updated: CodexEntry | undefined;

    try {
      updated =
        options?.baseVersion === undefined
          ? await updateCodexEntry(getCurrentProjectId(), id, data)
          : await updateCodexEntry(getCurrentProjectId(), id, data, {
              baseVersion: options.baseVersion,
            });
      if (!updated) {
        toast.error(i18next.t("codex.store.updateFailed"));
        debugLog.warn("CodexStore", `update target missing: ${id}`);
        return SAVE_NOT_PERSISTED;
      }
      const saved = updated;
      set((state) => ({
        entries: state.entries.map((e) => (e.id === id ? saved : e)),
        completionTargets: upsertCompletionTarget(
          state.completionTargets,
          saved,
        ),
        selectedEntry:
          state.selectedEntry?.id === id ? saved : state.selectedEntry,
      }));
    } catch (e) {
      if (e instanceof CodexVersionConflictError) {
        codexEditConflictHandler(id);
        return SAVE_NOT_PERSISTED;
      }
      toast.error(i18next.t("codex.store.updateFailed"));
      debugLog.error("CodexStore", `update: ${rootCause(e)}`, errorDetail(e));
      return SAVE_NOT_PERSISTED;
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

    if (!before) return persistedVersion(updated.version);
    if (useGlobalHistoryStore.getState().isReplaying) {
      return persistedVersion(updated.version);
    }

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
            completionTargets: upsertCompletionTarget(
              state.completionTargets,
              restored,
            ),
            selectedEntry:
              state.selectedEntry?.id === id ? restored : state.selectedEntry,
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
            completionTargets: upsertCompletionTarget(
              state.completionTargets,
              reapplied,
            ),
            selectedEntry:
              state.selectedEntry?.id === id ? reapplied : state.selectedEntry,
          }));
        }
      },
    });
    return persistedVersion(updated.version);
  },

  saveTypeAndSummary: async (id, data) => {
    if (blockIfUnlicensed()) return false;
    const snapshot = get();
    const before =
      snapshot.entries.find((entry) => entry.id === id) ??
      (snapshot.selectedEntry?.id === id ? snapshot.selectedEntry : undefined);
    if (!before) return false;

    const changedFields: Array<"type" | "summary"> = [];
    if (data.type !== before.type) changedFields.push("type");
    if (data.summary !== (before.summary ?? "")) changedFields.push("summary");
    if (changedFields.length === 0) return true;

    const authority = captureRendererAuthority();
    const { projectId } = authority;
    let updated: CodexEntry | undefined;
    try {
      updated = await updateCodexEntry(
        projectId,
        id,
        { type: data.type, summary: data.summary },
        { baseVersion: before.version },
      );
      if (!updated) return false;
    } catch (error) {
      if (error instanceof CodexVersionConflictError) {
        codexEditConflictHandler(id);
        return false;
      }
      toast.error(i18next.t("codex.store.updateFailed"));
      debugLog.error(
        "CodexStore",
        `saveTypeAndSummary: ${rootCause(error)}`,
        errorDetail(error),
      );
      return false;
    }

    const syncUpdatedEntry = (entry: CodexEntry): void => {
      if (!isCurrentRendererAuthority(authority)) return;
      set((state) => ({
        entries: state.entries.map((candidate) =>
          candidate.id === id ? entry : candidate,
        ),
        completionTargets: upsertCompletionTarget(
          state.completionTargets,
          entry,
        ),
        selectedEntry:
          state.selectedEntry?.id === id ? entry : state.selectedEntry,
      }));
    };
    // Persistence is scoped to the project/workspace captured before the
    // await. If renderer authority changed while that write was in flight, the
    // write is still successful but none of its renderer/history/timelapse
    // side effects belong to the newly active scope.
    if (!isCurrentRendererAuthority(authority)) return true;
    syncUpdatedEntry(updated);

    const changedPatch: StructuralPatch = {};
    const undoPatch: StructuralPatch = {};
    if (changedFields.includes("type")) {
      changedPatch.type = data.type;
      undoPatch.type = before.type;
    }
    if (changedFields.includes("summary")) {
      changedPatch.summary = data.summary;
      undoPatch.summary = before.summary;
    }

    if (!useGlobalHistoryStore.getState().isReplaying) {
      const redoPatch = { ...changedPatch };
      let undoBaseVersion = updated.version;
      let redoBaseVersion: number | undefined;
      useGlobalHistoryStore.getState().push({
        kind: "codex",
        label: labelForPatch(changedPatch),
        entityId: id,
        async undo() {
          const restored = await updateCodexEntry(projectId, id, undoPatch, {
            baseVersion: undoBaseVersion,
          });
          if (!restored) return;
          redoBaseVersion = restored.version;
          syncUpdatedEntry(restored);
        },
        async redo() {
          const reapplied = await updateCodexEntry(
            projectId,
            id,
            redoPatch,
            redoBaseVersion === undefined
              ? undefined
              : { baseVersion: redoBaseVersion },
          );
          if (!reapplied) return;
          undoBaseVersion = reapplied.version;
          syncUpdatedEntry(reapplied);
        },
      });
    }

    const diffs: Record<string, BodyDiff> = {};
    if (changedFields.includes("summary")) {
      const summaryDiff = computeBodyDiff(
        before.summary ?? "",
        updated.summary ?? "",
      );
      if (summaryDiff) diffs.summary = summaryDiff;
    }
    recordChangeEvent({
      domain: "codex",
      opType: "entry.update",
      entityType: "codex_entry",
      entityId: id,
      payload: {
        fields: changedFields,
        ...(Object.keys(diffs).length > 0 ? { diffs } : {}),
      },
    });
    return true;
  },

  registerRubyReading: async (expectedEntryId, surface, rawReading) => {
    if (blockIfUnlicensed()) return false;
    const reading = rawReading.trim();
    if (!expectedEntryId || !surface || !reading) return false;

    const projectId = getCurrentProjectId();
    try {
      // renderer cache は別窓/MCP更新を即時反映しないため、クリック時に DB を再読込する。
      const [freshTargets, before] = await Promise.all([
        listCodexMatchTargets(projectId),
        getCodexEntry(projectId, expectedEntryId),
      ]);
      if (!before) return false;

      // 2本の SELECT 間に対象行が変わっても、対象自身は version を持つ full row を正とする。
      const targets = freshTargets.map((target) =>
        target.id === before.id ? toCompletionTarget(before) : target,
      );
      const target = resolveUnsetReadingTargetForSurface(surface, targets);
      if (!target || target.id !== expectedEntryId) return false;

      const readings = serializeReadings({
        ...parseReadings(before.readings),
        [surface]: [reading],
      });
      const patch: StructuralPatch = { readings };
      const updated = await updateCodexEntry(
        projectId,
        expectedEntryId,
        patch,
        {
          baseVersion: before.version,
          baseSurface: {
            name: before.name,
            aliases: before.aliases,
            excludedAliases: before.excludedAliases,
            readings: before.readings,
          },
        },
      );
      if (!updated) return false;

      set((state) => ({
        entries: state.entries.map((entry) =>
          entry.id === expectedEntryId ? updated : entry,
        ),
        completionTargets: upsertCompletionTarget(
          state.completionTargets,
          updated,
        ),
      }));

      recordChangeEvent({
        domain: "codex",
        opType: "entry.update",
        entityType: "codex_entry",
        entityId: expectedEntryId,
        payload: { fields: ["readings"] },
      });

      if (!useGlobalHistoryStore.getState().isReplaying) {
        const beforeReadings = before.readings;
        useGlobalHistoryStore.getState().push({
          kind: "codex",
          label: labelForPatch(patch),
          entityId: expectedEntryId,
          async undo() {
            const restored = await updateCodexEntry(
              projectId,
              expectedEntryId,
              {
                readings: beforeReadings,
              },
            );
            if (restored) {
              set((state) => ({
                entries: state.entries.map((entry) =>
                  entry.id === expectedEntryId ? restored : entry,
                ),
                completionTargets: upsertCompletionTarget(
                  state.completionTargets,
                  restored,
                ),
              }));
            }
          },
          async redo() {
            const reapplied = await updateCodexEntry(
              projectId,
              expectedEntryId,
              patch,
            );
            if (reapplied) {
              set((state) => ({
                entries: state.entries.map((entry) =>
                  entry.id === expectedEntryId ? reapplied : entry,
                ),
                completionTargets: upsertCompletionTarget(
                  state.completionTargets,
                  reapplied,
                ),
              }));
            }
          },
        });
      }

      return true;
    } catch (error) {
      if (error instanceof CodexVersionConflictError) {
        codexEditConflictHandler(expectedEntryId);
        return false;
      }
      toast.error(i18next.t("codex.store.updateFailed"));
      debugLog.error(
        "CodexStore",
        `registerRubyReading: ${rootCause(error)}`,
        errorDetail(error),
      );
      return false;
    }
  },

  updateText: async (id, data, options) => {
    const snapshot = get();
    const before =
      snapshot.entries.find((e) => e.id === id) ??
      (snapshot.selectedEntry?.id === id ? snapshot.selectedEntry : undefined);
    let updated: CodexEntry | undefined;
    try {
      // OCC: 読み込み時点の version を base_version として渡す。別窓 / 別プロセスが
      // 先に書いていれば衝突として弾かれ、本文を黙って上書きしない。
      updated = await updateCodexEntry(getCurrentProjectId(), id, data, {
        baseVersion: options?.baseVersion ?? before?.version ?? 0,
      });
      if (!updated) {
        toast.error(i18next.t("codex.store.updateFailed"));
        debugLog.warn("CodexStore", `updateText target missing: ${id}`);
        return SAVE_NOT_PERSISTED;
      }
      set((state) => ({
        entries: state.entries.map((e) => (e.id === id ? updated! : e)),
        selectedEntry:
          state.selectedEntry?.id === id ? updated! : state.selectedEntry,
      }));
    } catch (e) {
      if (e instanceof CodexVersionConflictError) {
        // 非破壊: store も timelapse も触らず、呼び出し側に再読み込みを促す。
        codexEditConflictHandler(id);
        return SAVE_NOT_PERSISTED;
      }
      toast.error(i18next.t("codex.store.updateFailed"));
      debugLog.error(
        "CodexStore",
        `updateText: ${rootCause(e)}`,
        errorDetail(e),
      );
      return SAVE_NOT_PERSISTED;
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
    return persistedVersion(updated.version);
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
        label: i18next.t("codex.history.deleted"),
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
            readings: captured.readings ?? undefined,
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
  resetForProject: () => {
    _clearCodexCrossMentionCaches();
    set({
      entries: [],
      completionTargets: [],
      types: [],
      searchQuery: "",
      filterType: null,
      pendingEntryId: null,
      selectedEntry: null,
      previewPhaseByEntry: {},
    });
  },

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
