import { useState, useEffect, useRef, useCallback } from "react";
import i18next from "i18next";
import { Trash2, ArrowLeft, Clock } from "lucide-react";
import { useRevisionStore } from "@/features/revision/revisionStore";
import { createRevision, pruneRevisions } from "@/features/revision/api";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { TagSelector } from "./TagSelector";
import { db } from "@/db/client";
import { chatMessages, chatSessions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { useAutoSave } from "@/hooks/useAutoSave";
import { useCodexStore } from "../codexStore";
import type { CodexEntry, CodexEntryType } from "../api";
import type { ChildrenBudgetPreset } from "../childrenBudget";
import { listEntryTags } from "../tagApi";
import type { CodexTag } from "../tagApi";
import type { CodexContextMode } from "@/db/schema";
import { IconPicker } from "./IconPicker";
import { DetailTabs } from "./DetailTabs";
import { DetailsTab } from "./DetailsTab";
import { RelationsTab } from "./RelationsTab";
import { TrackingTab } from "./TrackingTab";
import { MentionsTab } from "./MentionsTab";
import { ResearchTab } from "./ResearchTab";
import { TimelineTab } from "./TimelineTab";

function getTypeOptions(): { value: CodexEntryType; label: string }[] {
  return [
    { value: "character", label: i18next.t("codex.character") },
    { value: "location", label: i18next.t("codex.location") },
    { value: "item", label: i18next.t("codex.item") },
    { value: "lore", label: i18next.t("codex.lore") },
  ];
}

function getTabs() {
  return [
    {
      id: "details",
      label: i18next.t("codex.tab.details"),
      testId: "detail-tab-details",
    },
    {
      id: "relations",
      label: i18next.t("codex.tab.relations"),
      testId: "detail-tab-relations",
    },
    {
      id: "tracking",
      label: i18next.t("codex.tab.tracking"),
      testId: "detail-tab-tracking",
    },
    {
      id: "mentions",
      label: i18next.t("codex.tab.mentions"),
      testId: "detail-tab-mentions",
    },
    {
      id: "research",
      label: i18next.t("codex.tab.research"),
      testId: "detail-tab-research",
    },
    {
      id: "timeline",
      label: i18next.t("codex.tab.timeline"),
      testId: "detail-tab-timeline",
    },
  ];
}

interface CodexDetailContentProps {
  entry: CodexEntry;
  onDelete: (id: string) => void;
  onBack?: () => void;
  initialTab?: string;
}

export function CodexDetailContent({
  entry,
  onDelete,
  onBack,
  initialTab = "details",
}: CodexDetailContentProps) {
  const update = useCodexStore((s) => s.update);
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
  const [childrenBudget, setChildrenBudget] = useState<ChildrenBudgetPreset>(
    (entry.childrenBudget as ChildrenBudgetPreset) ?? "compact",
  );
  const [selectedTags, setSelectedTags] = useState<CodexTag[]>([]);
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
    entry.childrenBudget,
    entry.icon,
    initialTab,
  ]);

  useEffect(() => {
    listEntryTags(entry.id).then(setSelectedTags);
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
      await update(entry.id, { summary: summaryRef.current });
    }, [entry.id, update]),
    1000,
  );

  // Auto-save: content (2 second debounce)
  const { schedule: scheduleContentSave } = useAutoSave(
    useCallback(async () => {
      const content = contentRef.current;
      await update(entry.id, { content });
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
    }, [entry.id, update, shouldAutoRevision, recordAutoRevision]),
    2000,
  );

  // Auto-save: notes (2 second debounce)
  const { schedule: scheduleNotesSave } = useAutoSave(
    useCallback(async () => {
      await update(entry.id, { notes: notesRef.current });
    }, [entry.id, update]),
    2000,
  );

  const handleTypeChange = async (newType: CodexEntryType) => {
    setType(newType);
    await update(entry.id, { type: newType });
  };

  const handleNameBlur = async () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== entry.name) {
      await update(entry.id, { name: trimmed });
    }
  };

  const handleContextModeChange = async (mode: CodexContextMode) => {
    setContextMode(mode);
    await update(entry.id, { contextMode: mode });
  };

  const handleAliasesChange = async (newAliases: string[]) => {
    setAliases(newAliases);
    await update(entry.id, { aliases: JSON.stringify(newAliases) });
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

  return (
    <div data-testid="codex-detail-content" className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-1">
          {onBack && (
            <button
              type="button"
              data-testid="codex-back-button"
              onClick={onBack}
              className="rounded p-1.5 text-muted-foreground hover:bg-accent"
              title={i18next.t("codex.detail.back")}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
          )}
          <h3 className="text-sm font-semibold">
            {i18next.t("codex.editEntry")}
          </h3>
        </div>
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
      </div>

      {/* Header: Icon + Name + Type (always visible, above tabs) */}
      <div className="shrink-0 border-b border-border px-3 py-2">
        <div className="flex items-start gap-2">
          <IconPicker
            currentIcon={icon}
            entryType={type}
            onIconChange={(newIcon) => {
              setIcon(newIcon);
              void update(entry.id, { icon: newIcon as never });
            }}
          />
          <div className="flex-1 space-y-2">
            <div>
              <label className="mb-1 block text-xs font-medium">
                {i18next.t("codex.nameLabel")}
              </label>
              <input
                data-testid="codex-detail-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => void handleNameBlur()}
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">
                {i18next.t("codex.typeLabel")}
              </label>
              <select
                data-testid="codex-detail-type"
                value={type}
                onChange={(e) =>
                  void handleTypeChange(e.target.value as CodexEntryType)
                }
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              >
                {getTypeOptions().map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Tags (always visible in header) */}
        <div data-testid="codex-detail-tags" className="mt-2">
          <TagSelector
            entryId={entry.id}
            entryType={type}
            selectedTags={selectedTags}
            onTagsChange={(tags) => {
              // アルファベット順に揃えてリストとの表示順を一致させる
              const sorted = [...tags].sort((a, b) =>
                a.name.localeCompare(b.name),
              );
              setSelectedTags(sorted);
              // tagsCache をストアに同期（{name,color}[] 形式）
              void update(entry.id, {
                tagsCache: JSON.stringify(
                  sorted.map((t) => ({ name: t.name, color: t.color })),
                ),
              });
            }}
            maxVisible={3}
          />
        </div>
      </div>

      {/* Tab bar */}
      <DetailTabs
        tabs={getTabs()}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {activeTab === "details" && (
          <DetailsTab
            entry={entry}
            aliases={aliases}
            summary={summary}
            onAliasesChange={(a) => void handleAliasesChange(a)}
            onSummaryChange={handleSummaryChange}
            onContentChange={handleContentChange}
            onExternalSync={(content) => {
              contentRef.current = content;
            }}
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
            onContextModeChange={(mode) => void handleContextModeChange(mode)}
            onExcludedAliasesChange={(e) => void handleExcludedAliasesChange(e)}
          />
        )}
        {activeTab === "mentions" && (
          <MentionsTab entry={entry} sourceSessionTitle={sourceSessionTitle} />
        )}
        {activeTab === "research" && (
          <ResearchTab
            notes={emptyNotes ? "" : (entry.notes ?? "")}
            onNotesChange={handleNotesChange}
          />
        )}
        {activeTab === "timeline" && <TimelineTab entry={entry} />}
      </div>
    </div>
  );
}
