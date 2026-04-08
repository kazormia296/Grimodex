import { useState, useEffect, useRef, useCallback } from "react";
import { Trash2, MessageSquare, ArrowLeft } from "lucide-react";
import { db } from "@/db/client";
import { chatMessages, chatSessions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { useAutoSave } from "@/hooks/useAutoSave";
import { useCodexStore } from "../codexStore";
import type { CodexEntry, CodexEntryType } from "../api";
import type { ChildrenBudgetPreset } from "../childrenBudget";
import { getChildrenFromArray } from "../childrenBudget";
import { listEntryTags } from "../tagApi";
import type { CodexTag } from "../tagApi";
import type { CodexContextMode } from "@/db/schema";
import { TagSelector } from "./TagSelector";
import { TagPill } from "./TagPill";
import { IconPicker } from "./IconPicker";
import { ChildrenBudgetSelector } from "./ChildrenBudgetSelector";
import { RelationSection } from "./RelationSection";
import { ReferencesSection } from "./ReferencesSection";
import { ContextModeSelector } from "./ContextModeSelector";
import { AliasesField } from "./AliasesField";
import { ExcludedAliasesField } from "./ExcludedAliasesField";
import { CodexContentEditor } from "./CodexContentEditor";
import { DetailsSection } from "./DetailsSection";

const TYPE_OPTIONS: { value: CodexEntryType; label: string }[] = [
  { value: "character", label: "キャラクター" },
  { value: "location", label: "場所" },
  { value: "item", label: "アイテム" },
  { value: "lore", label: "設定・世界観" },
];

interface CodexDetailContentProps {
  entry: CodexEntry;
  onDelete: (id: string) => void;
  onBack?: () => void;
}

export function CodexDetailContent({
  entry,
  onDelete,
  onBack,
}: CodexDetailContentProps) {
  const entries = useCodexStore((s) => s.entries);
  const update = useCodexStore((s) => s.update);

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

  // Refs for auto-save closures (always read latest value)
  const summaryRef = useRef(summary);
  const emptyContent = !entry.content || entry.content === "{}";
  const contentRef = useRef(emptyContent ? "" : entry.content);
  summaryRef.current = summary;

  // Sync form when entry.id changes (happens when key prop changes)
  useEffect(() => {
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
  ]);

  // Load tags when entry changes
  useEffect(() => {
    listEntryTags(entry.id).then(setSelectedTags);
  }, [entry.id]);

  // Load source session title from sourceChatMessageId
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

  const hasChildren = getChildrenFromArray(entry.id, entries).length > 0;

  // Immediate-save handlers
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
    await update(entry.id, { excludedAliases: JSON.stringify(newExcluded) });
  };

  return (
    <div data-testid="codex-detail-content" className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
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

      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {/* Header: Icon + Name + Type */}
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

        {/* Context Mode */}
        <ContextModeSelector
          value={contextMode}
          onChange={(mode) => void handleContextModeChange(mode)}
        />

        {/* Aliases */}
        <AliasesField
          label="Aliases"
          aliases={aliases}
          onChange={(a) => void handleAliasesChange(a)}
        />

        {/* Excluded Aliases */}
        <ExcludedAliasesField
          excludedAliases={excludedAliases}
          onChange={(e) => void handleExcludedAliasesChange(e)}
        />

        {/* Summary */}
        <div>
          <label className="mb-1 block text-xs font-medium">概要</label>
          <textarea
            data-testid="codex-detail-summary"
            value={summary}
            onChange={(e) => {
              setSummary(e.target.value);
              scheduleSummarySave();
            }}
            rows={3}
            className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            placeholder="Short description..."
          />
        </div>

        {/* Content (TipTap) */}
        <div>
          <label className="mb-1 block text-xs font-medium">Content</label>
          <CodexContentEditor
            content={emptyContent ? "" : entry.content}
            onContentChange={(content) => {
              contentRef.current = content;
              scheduleContentSave();
            }}
          />
        </div>

        {/* Tags */}
        <div data-testid="codex-detail-tags">
          <label className="mb-1 block text-xs font-medium">タグ</label>
          <TagSelector
            entryId={entry.id}
            entryType={type}
            selectedTags={selectedTags}
            onTagsChange={setSelectedTags}
          />
          {selectedTags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-0.5">
              {selectedTags.map((tag) => (
                <TagPill
                  key={tag.id}
                  name={tag.name}
                  color={tag.color ?? "#888888"}
                  size="sm"
                />
              ))}
            </div>
          )}
        </div>

        {/* Children Budget */}
        <ChildrenBudgetSelector
          value={childrenBudget}
          onChange={(preset) => {
            setChildrenBudget(preset);
            void update(entry.id, { childrenBudget: preset });
          }}
          hasChildren={hasChildren}
        />

        {/* Custom Details */}
        <DetailsSection entry={entry} />

        {/* References (Appears in) */}
        <ReferencesSection entry={entry} />

        {/* Relations */}
        <RelationSection entry={entry} />

        {/* Source */}
        {entry.sourceChatMessageId && (
          <div
            data-testid="codex-source-chat-link"
            className="flex items-center gap-1.5 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            <span>
              抽出元チャット: {sourceSessionTitle ?? entry.sourceChatMessageId}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
