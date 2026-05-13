import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Search, ArrowLeft, Pencil, Trash2 } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCodexStore } from "./codexStore";
import { getTypeLabel } from "@/features/chat/utils/typeLabels";
import type { CodexEntry, CodexEntryType } from "./api";
import { useDropTarget } from "@/features/trash-bin/useDropTarget";

const TYPE_OPTION_KEYS: { value: CodexEntryType; key: string }[] = [
  { value: "character", key: "codex.character" },
  { value: "location", key: "codex.location" },
  { value: "item", key: "codex.item" },
  { value: "lore", key: "codex.lore" },
];

function CodexDetailView({
  entry,
  onBack,
  onEdit,
  onDelete,
}: {
  entry: CodexEntry;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div data-testid="codex-detail-view" className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          data-testid="codex-back-button"
          onClick={onBack}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h3 className="flex-1 truncate text-sm font-semibold">{entry.name}</h3>
        <button
          type="button"
          data-testid="codex-edit-button"
          onClick={onEdit}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          data-testid="codex-delete-button"
          onClick={onDelete}
          className="rounded p-1 text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <span className="mb-2 inline-block rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium">
          {getTypeLabel(entry.type)}
        </span>
        {entry.summary && (
          <p className="whitespace-pre-wrap text-sm">{entry.summary}</p>
        )}
        {entry.tagsCache && (
          <div className="mt-3 flex flex-wrap gap-1">
            {entry.tagsCache.split(",").map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary"
              >
                {tag.trim()}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CodexEditView({
  entry,
  onSave,
  onCancel,
}: {
  entry: CodexEntry;
  onSave: (data: {
    type: CodexEntryType;
    name: string;
    summary: string;
    tagsCache: string;
  }) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [type, setType] = useState<CodexEntryType>(
    entry.type as CodexEntryType,
  );
  const [name, setName] = useState(entry.name);
  const [summary, setSummary] = useState(entry.summary ?? "");
  const [tags, setTags] = useState(entry.tagsCache ?? "");

  const handleSave = () => {
    if (!name.trim()) return;
    onSave({ type, name: name.trim(), summary, tagsCache: tags });
  };

  return (
    <div data-testid="codex-edit-view" className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h3 className="flex-1 text-sm font-semibold">{t("codex.editEntry")}</h3>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        <div>
          <label className="mb-1 block text-xs font-medium">
            {t("codex.typeLabel")}
          </label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as CodexEntryType)}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          >
            {TYPE_OPTION_KEYS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {t(opt.key)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">
            {t("codex.nameLabel")}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">
            {t("codex.summaryLabel")}
          </label>
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            rows={5}
            className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">
            {t("codex.tagsLabel")}
          </label>
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-3 py-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          onClick={handleSave}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90"
        >
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}

function CodexVirtualList({
  entries,
  isLoading,
  onSelect,
}: {
  entries: CodexEntry[];
  isLoading: boolean;
  onSelect: (entry: CodexEntry) => void;
}) {
  const { t } = useTranslation();
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 5,
  });

  if (isLoading) {
    return (
      <p className="flex-1 p-3 text-center text-xs text-muted-foreground">
        {t("common.loading")}
      </p>
    );
  }

  if (entries.length === 0) {
    return (
      <div
        data-testid="codex-empty-state"
        className="flex-1 p-3 text-center text-xs text-muted-foreground"
      >
        {t("codex.empty")}
      </div>
    );
  }

  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const entry = entries[virtualItem.index];
          return (
            <div
              key={entry.id}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualItem.size}px`,
                transform: `translateY(${virtualItem.start}px)`,
              }}
              className="border-b border-border"
            >
              <button
                type="button"
                data-testid={`codex-entry-${entry.id}`}
                onClick={() => onSelect(entry)}
                className="h-full w-full px-3 py-2 text-left hover:bg-accent"
              >
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium">
                    {getTypeLabel(entry.type)}
                  </span>
                  <span className="truncate text-sm font-medium">
                    {entry.name}
                  </span>
                </div>
                {entry.summary && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {entry.summary}
                  </p>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CodexPanel() {
  const { t } = useTranslation();
  const entries = useCodexStore((s) => s.entries);
  const searchQuery = useCodexStore((s) => s.searchQuery);
  const filterType = useCodexStore((s) => s.filterType);
  const isLoading = useCodexStore((s) => s.isLoading);
  const loadEntries = useCodexStore((s) => s.loadEntries);
  const search = useCodexStore((s) => s.search);
  const update = useCodexStore((s) => s.update);
  const remove = useCodexStore((s) => s.remove);
  const setFilterType = useCodexStore((s) => s.setFilterType);

  const [selectedEntry, setSelectedEntry] = useState<CodexEntry | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [localSearch, setLocalSearch] = useState(searchQuery);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trashDropRef = useDropTarget("codex-panel", "codex-panel");

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  const handleSearchChange = useCallback(
    (value: string) => {
      setLocalSearch(value);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = setTimeout(() => {
        search(value);
      }, 300);
    },
    [search],
  );

  const handleFilterChange = useCallback(
    (value: string) => {
      setFilterType(value === "" ? null : (value as CodexEntryType));
    },
    [setFilterType],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await remove(id);
      setSelectedEntry(null);
    },
    [remove],
  );

  const handleEditSave = useCallback(
    async (data: {
      type: CodexEntryType;
      name: string;
      summary: string;
      tagsCache: string;
    }) => {
      if (!selectedEntry) return;
      await update(selectedEntry.id, data);
      setIsEditing(false);
      setSelectedEntry(null);
    },
    [selectedEntry, update],
  );

  if (selectedEntry && isEditing) {
    return (
      <CodexEditView
        entry={selectedEntry}
        onSave={handleEditSave}
        onCancel={() => setIsEditing(false)}
      />
    );
  }

  if (selectedEntry) {
    return (
      <CodexDetailView
        entry={selectedEntry}
        onBack={() => setSelectedEntry(null)}
        onEdit={() => setIsEditing(true)}
        onDelete={() => handleDelete(selectedEntry.id)}
      />
    );
  }

  return (
    <div
      ref={trashDropRef}
      data-testid="codex-panel"
      data-droptarget-id="codex-panel"
      className="flex h-full flex-col data-[trash-drop-hover=true]:ring-2 data-[trash-drop-hover=true]:ring-primary/60"
    >
      <div className="space-y-2 border-b border-border px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            data-testid="codex-search-input"
            type="text"
            value={localSearch}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder={t("codex.searchPlaceholder")}
            className="w-full rounded-md border border-input bg-background py-1.5 pl-7 pr-2 text-sm"
          />
        </div>
        <select
          data-testid="codex-filter-select"
          value={filterType ?? ""}
          onChange={(e) => handleFilterChange(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        >
          <option value="">{t("codex.filterAll")}</option>
          {TYPE_OPTION_KEYS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(opt.key)}
            </option>
          ))}
        </select>
      </div>

      <CodexVirtualList
        entries={entries}
        isLoading={isLoading}
        onSelect={setSelectedEntry}
      />
    </div>
  );
}
