import { useState, useEffect, useCallback } from "react";
import { Search, ArrowLeft, Pencil, Trash2 } from "lucide-react";
import { useCodexStore } from "./codexStore";
import type { CodexEntry, CodexEntryType } from "./api";

const TYPE_OPTIONS: { value: CodexEntryType; label: string }[] = [
  { value: "character", label: "キャラクター" },
  { value: "location", label: "場所" },
  { value: "item", label: "アイテム" },
  { value: "lore", label: "設定・世界観" },
];

const TYPE_LABELS: Record<string, string> = {
  character: "キャラクター",
  location: "場所",
  item: "アイテム",
  lore: "設定・世界観",
};

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
          {TYPE_LABELS[entry.type] ?? entry.type}
        </span>
        {entry.summary && (
          <p className="mb-2 text-sm text-muted-foreground">{entry.summary}</p>
        )}
        <p className="whitespace-pre-wrap text-sm">{entry.content}</p>
        {entry.tags && (
          <div className="mt-3 flex flex-wrap gap-1">
            {entry.tags.split(",").map((tag) => (
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
    content: string;
    tags: string;
  }) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<CodexEntryType>(
    entry.type as CodexEntryType,
  );
  const [name, setName] = useState(entry.name);
  const [summary, setSummary] = useState(entry.summary);
  const [content, setContent] = useState(entry.content);
  const [tags, setTags] = useState(entry.tags);

  const handleSave = () => {
    if (!name.trim()) return;
    onSave({ type, name: name.trim(), summary, content, tags });
  };

  return (
    <div data-testid="codex-edit-view" className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <h3 className="flex-1 text-sm font-semibold">エントリ編集</h3>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        <div>
          <label className="mb-1 block text-xs font-medium">タイプ</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as CodexEntryType)}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          >
            {TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">名前</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">概要</label>
          <input
            type="text"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">内容</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={5}
            className="w-full resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">タグ</label>
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
          キャンセル
        </button>
        <button
          type="button"
          onClick={handleSave}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90"
        >
          保存
        </button>
      </div>
    </div>
  );
}

export function CodexPanel() {
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

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  const handleSearchChange = useCallback(
    (value: string) => {
      setLocalSearch(value);
      search(value);
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
    async (id: number) => {
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
      content: string;
      tags: string;
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
    <div data-testid="codex-panel" className="flex h-full flex-col">
      <div className="space-y-2 border-b border-border px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            data-testid="codex-search-input"
            type="text"
            value={localSearch}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Codexを検索..."
            className="w-full rounded-md border border-input bg-background py-1.5 pl-7 pr-2 text-sm"
          />
        </div>
        <select
          data-testid="codex-filter-select"
          value={filterType ?? ""}
          onChange={(e) => handleFilterChange(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        >
          <option value="">すべて</option>
          {TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <p className="p-3 text-center text-xs text-muted-foreground">
            読み込み中...
          </p>
        ) : entries.length === 0 ? (
          <div
            data-testid="codex-empty-state"
            className="p-3 text-center text-xs text-muted-foreground"
          >
            エントリがありません
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {entries.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  data-testid={`codex-entry-${entry.id}`}
                  onClick={() => setSelectedEntry(entry)}
                  className="w-full px-3 py-2 text-left hover:bg-accent"
                >
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium">
                      {TYPE_LABELS[entry.type] ?? entry.type}
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
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
