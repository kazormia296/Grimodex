import { useState, useEffect, useRef, useCallback } from "react";
import i18next from "i18next";
import { toast } from "sonner";
import {
  Trash2,
  ArrowLeft,
  Clock,
  FileText,
  Network,
  Crosshair,
  AtSign,
  Microscope,
  CalendarClock,
  LineSquiggle,
  AlertTriangle,
} from "lucide-react";
import { useRevisionStore } from "@/features/revision/revisionStore";
import { createRevision, pruneRevisions } from "@/features/revision/api";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { db } from "@/db/client";
import { chatMessages, chatSessions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { useAutoSave } from "@/hooks/useAutoSave";
import { useCodexStore } from "../codexStore";
import { parseAliases } from "../codexMatcher";
import {
  parseReadings,
  serializeReadings,
  reconcileReadingKeys,
  surfacesForEntry,
  needsAiReading,
  type ReadingMap,
} from "../reading";
import { inferReadings } from "../codexYomi";
import { prepareRenamePropagation } from "../rename/renameEngine";
import { useRenamePropagationStore } from "../rename/renamePropagationStore";
import { getCurrentProjectId } from "@/features/project/projectStore";
import type { CodexEntry, CodexEntryType } from "../api";
import type { ChildrenBudgetPreset } from "../childrenBudget";
import { listEntryTags } from "../tagApi";
import type { CodexTag } from "../tagApi";
import type { CodexContextMode } from "@/db/schema";
import { CodexEntryHeader } from "./CodexEntryHeader";
import { DetailTabs } from "./DetailTabs";
import { DetailsTab } from "./DetailsTab";
import { CodexEditLockBanner } from "../multiwindow/CodexEditLockBanner";
import { RelationsTab } from "./RelationsTab";
import { TrackingTab } from "./TrackingTab";
import { MentionsTab } from "./MentionsTab";
import { ResearchTab } from "./ResearchTab";
import { TimelineTab } from "./TimelineTab";
import { ForeshadowTab } from "./ForeshadowTab";
import { ConsistencyTab } from "./ConsistencyTab";

function getTabs() {
  return [
    {
      id: "details",
      label: i18next.t("codex.tab.details"),
      testId: "detail-tab-details",
      icon: FileText,
    },
    {
      id: "relations",
      label: i18next.t("codex.tab.relations"),
      testId: "detail-tab-relations",
      icon: Network,
    },
    {
      id: "tracking",
      label: i18next.t("codex.tab.tracking"),
      testId: "detail-tab-tracking",
      icon: Crosshair,
    },
    {
      id: "mentions",
      label: i18next.t("codex.tab.mentions"),
      testId: "detail-tab-mentions",
      icon: AtSign,
    },
    {
      id: "research",
      label: i18next.t("codex.tab.research"),
      testId: "detail-tab-research",
      icon: Microscope,
    },
    {
      id: "timeline",
      label: i18next.t("codex.tab.timeline"),
      testId: "detail-tab-timeline",
      icon: CalendarClock,
    },
    {
      id: "foreshadow",
      label: i18next.t("codex.tab.foreshadow"),
      testId: "detail-tab-foreshadow",
      icon: LineSquiggle,
    },
    {
      id: "consistency",
      label: i18next.t("codex.tab.consistency"),
      testId: "detail-tab-consistency",
      icon: AlertTriangle,
    },
  ];
}

interface CodexDetailContentProps {
  entry: CodexEntry;
  onDelete: (id: string) => void;
  onBack?: () => void;
  initialTab?: string;
  /** 別窓が同一 entry を編集中 → 本文を read-only にしバナーを出す（advisory lock）。 */
  readOnly?: boolean;
}

export function CodexDetailContent({
  entry,
  onDelete,
  onBack,
  initialTab = "details",
  readOnly = false,
}: CodexDetailContentProps) {
  const update = useCodexStore((s) => s.update);
  const updateText = useCodexStore((s) => s.updateText);
  const { shouldAutoRevision, recordAutoRevision } = useRevisionStore();

  const [activeTab, setActiveTab] = useState(initialTab);
  const [type, setType] = useState<CodexEntryType>(
    entry.type as CodexEntryType,
  );
  const [name, setName] = useState(entry.name);
  const [summary, setSummary] = useState(entry.summary ?? "");
  const [contextMode, setContextMode] = useState<CodexContextMode>(
    (entry.contextMode as CodexContextMode) ?? "mentioned",
  );
  const [aliases, setAliases] = useState<string[]>(() => {
    try {
      return JSON.parse(entry.aliases ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const [excludedAliases, setExcludedAliases] = useState<string[]>(() => {
    try {
      return JSON.parse(entry.excludedAliases ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const [readings, setReadings] = useState<ReadingMap>(() =>
    parseReadings(entry.readings),
  );
  const [estimatingReadings, setEstimatingReadings] = useState(false);
  const [childrenBudget, setChildrenBudget] = useState<ChildrenBudgetPreset>(
    (entry.childrenBudget as ChildrenBudgetPreset) ?? "compact",
  );
  const [selectedTags, setSelectedTags] = useState<CodexTag[]>([]);
  const [tagsLoading, setTagsLoading] = useState(true);
  const [icon, setIcon] = useState<string | null>(
    (entry.icon as string | null) ?? null,
  );
  const [sourceSessionTitle, setSourceSessionTitle] = useState<string | null>(
    null,
  );

  const summaryRef = useRef(summary);
  const emptyContent = !entry.content || entry.content === "{}";
  const contentRef = useRef(emptyContent ? "" : entry.content);
  const emptyNotes = !entry.notes || entry.notes === "{}";
  const notesRef = useRef(emptyNotes ? "" : (entry.notes ?? ""));
  summaryRef.current = summary;

  // Sync form when entry.id changes
  useEffect(() => {
    setActiveTab(initialTab);
    setType(entry.type as CodexEntryType);
    setName(entry.name);
    setSummary(entry.summary ?? "");
    setContextMode((entry.contextMode as CodexContextMode) ?? "mentioned");
    try {
      setAliases(JSON.parse(entry.aliases ?? "[]") as string[]);
    } catch {
      setAliases([]);
    }
    try {
      setExcludedAliases(JSON.parse(entry.excludedAliases ?? "[]") as string[]);
    } catch {
      setExcludedAliases([]);
    }
    setReadings(parseReadings(entry.readings));
    setChildrenBudget(
      (entry.childrenBudget as ChildrenBudgetPreset) ?? "compact",
    );
    setIcon((entry.icon as string | null) ?? null);
  }, [
    entry.id,
    entry.type,
    entry.name,
    entry.summary,
    entry.contextMode,
    entry.aliases,
    entry.excludedAliases,
    entry.readings,
    entry.childrenBudget,
    entry.icon,
    initialTab,
  ]);

  useEffect(() => {
    setTagsLoading(true);
    listEntryTags(entry.id)
      .then(setSelectedTags)
      .finally(() => setTagsLoading(false));
  }, [entry.id]);

  useEffect(() => {
    if (!entry.sourceChatMessageId) {
      setSourceSessionTitle(null);
      return;
    }
    db.select({ title: chatSessions.title })
      .from(chatMessages)
      .innerJoin(chatSessions, eq(chatMessages.sessionId, chatSessions.id))
      .where(eq(chatMessages.id, entry.sourceChatMessageId))
      .then((rows) => {
        setSourceSessionTitle(rows[0]?.title ?? null);
      })
      .catch(() => setSourceSessionTitle(null));
  }, [entry.sourceChatMessageId]);

  // Auto-save: summary (1 second debounce)
  const { schedule: scheduleSummarySave } = useAutoSave(
    useCallback(async () => {
      await updateText(entry.id, { summary: summaryRef.current });
    }, [entry.id, updateText]),
    1000,
  );

  // Auto-save: content (2 second debounce)
  const { schedule: scheduleContentSave } = useAutoSave(
    useCallback(async () => {
      const content = contentRef.current;
      await updateText(entry.id, { content });
      try {
        const intervalMs =
          useSettingsStore.getState().getNumber("revision.autoInterval", 5) *
          60 *
          1000;
        if (shouldAutoRevision(entry.id, intervalMs)) {
          const rev = await createRevision({
            entityType: "codex_entry",
            entityId: entry.id,
            content,
            snapshotType: "auto",
          });
          if (rev) {
            recordAutoRevision(entry.id);
            const keepCount = useSettingsStore
              .getState()
              .getNumber("revision.keepCount", 50);
            pruneRevisions("codex_entry", entry.id, keepCount).catch(
              console.error,
            );
          }
        }
      } catch (e) {
        debugLog.warn(
          "AutoSave",
          "revision failed (content saved)",
          errorDetail(e),
        );
      }
    }, [entry.id, updateText, shouldAutoRevision, recordAutoRevision]),
    2000,
  );

  // Auto-save: notes (2 second debounce)
  const { schedule: scheduleNotesSave } = useAutoSave(
    useCallback(async () => {
      await updateText(entry.id, { notes: notesRef.current });
    }, [entry.id, updateText]),
    2000,
  );

  const handleTypeChange = async (newType: CodexEntryType) => {
    setType(newType);
    await update(entry.id, { type: newType });
  };

  const handleNameBlur = async () => {
    const trimmed = name.trim();
    // Read the live current name from the store, not the `entry` prop: the prop
    // can lag a prior rename, which would make oldName the name from two edits
    // ago. `update` keeps the store entry current, so this is always the value
    // the user is editing away from.
    const currentName =
      useCodexStore.getState().entries.find((e) => e.id === entry.id)?.name ??
      entry.name;
    if (trimmed && trimmed !== currentName) {
      const oldName = currentName;
      // Warn if another entry already uses the new name (as name or alias):
      // both entries then match the same string, so future codex matching — and
      // any prose rewritten to this name — becomes ambiguous.
      const collision = useCodexStore
        .getState()
        .entries.find(
          (e) =>
            e.id !== entry.id &&
            (e.name === trimmed || parseAliases(e.aliases).includes(trimmed)),
        );
      if (collision) {
        toast.warning(
          i18next.t("codex.detail.duplicateName", { name: trimmed }),
        );
      }
      // 読みは表記をキーにするマップなので、改名で name キーを追随させる
      // (docs/Grimodex_IME連携設計書.md §3.1)。name 更新と同一パッチにして
      // undo が name/readings を lockstep で巻き戻すようにする。
      const oldSurfaces = surfacesForEntry(oldName, aliases);
      const newSurfaces = surfacesForEntry(trimmed, aliases);
      const reconciled = reconcileReadingKeys(
        readings,
        oldSurfaces,
        newSurfaces,
      );
      const readingsChanged =
        serializeReadings(reconciled) !== serializeReadings(readings);
      await update(entry.id, {
        name: trimmed,
        ...(readingsChanged ? { readings: serializeReadings(reconciled) } : {}),
      });
      if (readingsChanged) setReadings(reconciled);
      // 新しい表記が漢字を含み読み未設定なら AI 推定 (承認フロー無し, §3.3)。
      void estimateReadingsFor([trimmed], reconciled);
      // Offer to propagate the rename to plain-text occurrences (Item C).
      // id-keyed references (@mentions, relations, pins, AI context) already
      // follow automatically; this covers prose / free-text the matcher finds.
      try {
        const result = await prepareRenamePropagation({
          projectId: getCurrentProjectId(),
          entryId: entry.id,
          oldName,
          newName: trimmed,
        });
        if (result.occurrences.length > 0) {
          useRenamePropagationStore.getState().open({
            entryId: entry.id,
            oldName,
            newName: trimmed,
            result,
          });
        }
      } catch (e) {
        console.error("[codexRename] prepare failed", e);
      }
    }
  };

  const handleContextModeChange = async (mode: CodexContextMode) => {
    setContextMode(mode);
    await update(entry.id, { contextMode: mode });
  };

  const handleAliasesChange = async (newAliases: string[]) => {
    // 別名の追加/削除/変更に readings のキーを追随させる (孤児剪定・単一リネーム移送)。
    // name 成分は readings のキーである **確定済み** name を使う (ローカルの未コミット
    // rename を混ぜると旧 name の読みが孤児剪定で消える。改名は handleNameBlur が担当)。
    const committedName =
      useCodexStore.getState().entries.find((e) => e.id === entry.id)?.name ??
      entry.name;
    const oldSurfaces = surfacesForEntry(committedName, aliases);
    const newSurfaces = surfacesForEntry(committedName, newAliases);
    const reconciled = reconcileReadingKeys(readings, oldSurfaces, newSurfaces);
    const readingsChanged =
      serializeReadings(reconciled) !== serializeReadings(readings);
    setAliases(newAliases);
    if (readingsChanged) setReadings(reconciled);
    await update(entry.id, {
      aliases: JSON.stringify(newAliases),
      ...(readingsChanged ? { readings: serializeReadings(reconciled) } : {}),
    });
    // 追加された表記が漢字を含み読み未設定なら AI 推定 (§3.3)。
    const added = newSurfaces.filter((s) => !oldSurfaces.includes(s));
    if (added.length > 0) void estimateReadingsFor(added, reconciled);
  };

  const handleReadingsChange = async (next: ReadingMap) => {
    setReadings(next);
    await update(entry.id, { readings: serializeReadings(next) });
  };

  // entry.type (slug) を表示用カテゴリラベルへ。AI 読み推定の曖昧性解消ヒント。
  const resolveCategoryLabel = useCallback((): string => {
    const ct = useCodexStore
      .getState()
      .types.find((t) => t.slug === entry.type);
    return ct?.label ?? entry.type;
  }, [entry.type]);

  // 指定表記のうち漢字を含み読み未設定のものを AI 推定し、readings へ即マージ保存する。
  // 既存の読みは上書きしない (ユーザー編集を尊重)。fire-and-forget で UI を止めない。
  const estimateReadingsFor = useCallback(
    async (targetSurfaces: string[], base: ReadingMap) => {
      const need = targetSurfaces.filter(
        (s) => needsAiReading(s) && !(base[s]?.length ?? 0),
      );
      if (need.length === 0) return;
      // inferReadings は内部で例外を握り潰し空 Map を返す (reject しない)。
      // estimating フラグは promise の finally で確実に戻す。
      setEstimatingReadings(true);
      const m = await inferReadings([
        { id: entry.id, category: resolveCategoryLabel(), surfaces: need },
      ]).finally(() => setEstimatingReadings(false));
      const results = m.get(entry.id);
      if (!results?.length) return;
      // 最新の永続 readings (store が真実源) へ非破壊マージする。AI 応答待ちの間に
      // 入った編集を保つため base ではなく store の現値を起点にする。
      const storeEntry = useCodexStore
        .getState()
        .entries.find((e) => e.id === entry.id);
      const latest = parseReadings(storeEntry?.readings);
      // AI 応答が遅れて到達する間に改名/別名削除/undo で表記が消えている場合、
      // もはやエントリの表記でない読みを書くと孤児キー＋不要な履歴 push になる。
      // 現行表記の集合に含まれる surface だけ採用する。
      const currentSurfaces = new Set(
        surfacesForEntry(storeEntry?.name, parseAliases(storeEntry?.aliases)),
      );
      const next = { ...latest };
      let changed = false;
      for (const { surface, yomi } of results) {
        if (!currentSurfaces.has(surface)) continue;
        if (!(next[surface]?.length ?? 0)) {
          next[surface] = [yomi];
          changed = true;
        }
      }
      if (!changed) return;
      setReadings(next);
      await update(entry.id, { readings: serializeReadings(next) });
    },
    [entry.id, resolveCategoryLabel, update],
  );

  const handleEstimateReadings = () => {
    void estimateReadingsFor(surfacesForEntry(name, aliases), readings);
  };

  const handleExcludedAliasesChange = async (newExcluded: string[]) => {
    setExcludedAliases(newExcluded);
    await update(entry.id, {
      excludedAliases: JSON.stringify(newExcluded),
    });
  };

  const handleSummaryChange = (value: string) => {
    setSummary(value);
    summaryRef.current = value;
    scheduleSummarySave();
  };

  const handleContentChange = (content: string) => {
    contentRef.current = content;
    scheduleContentSave();
  };

  const handleNotesChange = (notes: string) => {
    notesRef.current = notes;
    scheduleNotesSave();
  };

  const handleChildrenBudgetChange = (preset: ChildrenBudgetPreset) => {
    setChildrenBudget(preset);
    void update(entry.id, { childrenBudget: preset });
  };

  const leadingAction = onBack ? (
    <button
      type="button"
      data-testid="codex-back-button"
      onClick={onBack}
      className="rounded p-1.5 text-muted-foreground hover:bg-accent"
      title={i18next.t("codex.detail.back")}
    >
      <ArrowLeft className="h-3.5 w-3.5" />
    </button>
  ) : null;

  const topActions = (
    <>
      <button
        type="button"
        data-testid="codex-detail-history"
        onClick={() =>
          useRevisionStore
            .getState()
            .openHistory("codex_entry", entry.id, contentRef.current)
        }
        className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        title={i18next.t("editor.status.revisionHistory", "Revision History")}
      >
        <Clock className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        data-testid="codex-detail-delete"
        onClick={() => onDelete(entry.id)}
        className="rounded p-1.5 text-destructive hover:bg-destructive/10"
        title={i18next.t("common.delete")}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </>
  );

  return (
    <div data-testid="codex-detail-content" className="flex h-full flex-col">
      {readOnly && <CodexEditLockBanner />}
      <CodexEntryHeader
        entry={entry}
        name={name}
        type={type}
        icon={icon}
        aliases={aliases}
        selectedTags={selectedTags}
        tagsLoading={tagsLoading}
        onNameChange={setName}
        onNameCommit={() => void handleNameBlur()}
        onTypeChange={(newType) => void handleTypeChange(newType)}
        onIconChange={(newIcon) => {
          setIcon(newIcon);
          void update(entry.id, { icon: newIcon as never });
        }}
        onAliasesChange={(a) => void handleAliasesChange(a)}
        onTagsChange={(tags) => {
          // アルファベット順に揃えてリストとの表示順を一致させる
          const sorted = [...tags].sort((a, b) => a.name.localeCompare(b.name));
          setSelectedTags(sorted);
          // tagsCache をストアに同期（{name,color}[] 形式）
          void update(entry.id, {
            tagsCache: JSON.stringify(
              sorted.map((t) => ({ name: t.name, color: t.color })),
            ),
          });
        }}
        leadingAction={leadingAction}
        topActions={topActions}
      />

      {/* Tab bar */}
      <div className="mt-[22px] px-7">
        <DetailTabs
          tabs={getTabs()}
          activeTab={activeTab}
          onTabChange={setActiveTab}
        />
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {activeTab === "details" && (
          <DetailsTab
            entry={entry}
            summary={summary}
            onSummaryChange={handleSummaryChange}
            onContentChange={handleContentChange}
            onExternalSync={(content) => {
              contentRef.current = content;
            }}
            readOnly={readOnly}
          />
        )}
        {activeTab === "relations" && (
          <RelationsTab
            entry={entry}
            childrenBudget={childrenBudget}
            onChildrenBudgetChange={handleChildrenBudgetChange}
          />
        )}
        {activeTab === "tracking" && (
          <TrackingTab
            contextMode={contextMode}
            excludedAliases={excludedAliases}
            surfaces={surfacesForEntry(name, aliases)}
            readings={readings}
            onContextModeChange={(mode) => void handleContextModeChange(mode)}
            onExcludedAliasesChange={(e) => void handleExcludedAliasesChange(e)}
            onReadingsChange={(next) => void handleReadingsChange(next)}
            onEstimateReadings={handleEstimateReadings}
            estimatingReadings={estimatingReadings}
          />
        )}
        {activeTab === "mentions" && (
          <MentionsTab entry={entry} sourceSessionTitle={sourceSessionTitle} />
        )}
        {activeTab === "research" && (
          <ResearchTab
            notes={emptyNotes ? "" : (entry.notes ?? "")}
            onNotesChange={handleNotesChange}
            readOnly={readOnly}
          />
        )}
        {activeTab === "timeline" && <TimelineTab entry={entry} />}
        {activeTab === "foreshadow" && (
          <ForeshadowTab codexEntryId={entry.id} />
        )}
        {activeTab === "consistency" && (
          <ConsistencyTab codexEntryId={entry.id} />
        )}
      </div>
    </div>
  );
}
