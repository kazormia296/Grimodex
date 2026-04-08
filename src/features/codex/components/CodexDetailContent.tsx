import { useState, useEffect, useRef, useCallback } from "react";
import { Trash2, ArrowLeft } from "lucide-react";
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

const TYPE_OPTIONS: { value: CodexEntryType; label: string }[] = [
  { value: "character", label: "キャラクター" },
  { value: "location", label: "場所" },
  { value: "item", label: "アイテム" },
  { value: "lore", label: "設定・世界観" },
];

const TABS = [
  { id: "details", label: "Details", testId: "detail-tab-details" },
  { id: "relations", label: "Relations", testId: "detail-tab-relations" },
  { id: "tracking", label: "Tracking", testId: "detail-tab-tracking" },
  { id: "mentions", label: "Mentions", testId: "detail-tab-mentions" },
  { id: "research", label: "Research", testId: "detail-tab-research" },
];

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
  const [icon, setIcon] = useState<number[] | null>(
    (entry.icon as number[] | null) ?? null,
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
    setIcon((entry.icon as number[] | null) ?? null);
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
      await update(entry.id, { content: contentRef.current });
    }, [entry.id, update]),
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
              title="戻る"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
          )}
          <h3 className="text-sm font-semibold">エントリ詳細</h3>
        </div>
        <button
          type="button"
          data-testid="codex-detail-delete"
          onClick={() => onDelete(entry.id)}
          className="rounded p-1.5 text-destructive hover:bg-destructive/10"
          title="削除"
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
              <label className="mb-1 block text-xs font-medium">名前</label>
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
              <label className="mb-1 block text-xs font-medium">タイプ</label>
              <select
                data-testid="codex-detail-type"
                value={type}
                onChange={(e) =>
                  void handleTypeChange(e.target.value as CodexEntryType)
                }
                className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              >
                {TYPE_OPTIONS.map((opt) => (
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
            onTagsChange={setSelectedTags}
          />
        </div>
      </div>

      {/* Tab bar */}
      <DetailTabs
        tabs={TABS}
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
      </div>
    </div>
  );
}
