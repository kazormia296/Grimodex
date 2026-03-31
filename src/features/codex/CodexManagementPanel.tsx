import { useState, useEffect, useCallback, useRef } from "react";
import { Search, Trash2, Save, MessageSquare } from "lucide-react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useCodexStore } from "./codexStore";
import type { CodexEntry, CodexEntryType } from "./api";

const TYPE_OPTIONS: { value: CodexEntryType | "all"; label: string }[] = [
  { value: "all", label: "すべて" },
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

// --- Command Palette ---

function CommandPalette({
  onSelect,
  onClose,
}: {
  onSelect: (entry: CodexEntry) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CodexEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleSearch = useCallback(async (value: string) => {
    setQuery(value);
    if (value.trim() === "") {
      setResults([]);
      return;
    }
    const { searchCodexEntries } = await import("./search");
    const entries = await searchCodexEntries(value);
    setResults(entries);
  }, []);

  return (
    <div
      data-testid="codex-command-palette"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center border-b border-border px-3">
          <Search className="mr-2 h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
            data-testid="codex-command-input"
            type="text"
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Codexを検索..."
            className="flex-1 bg-transparent py-3 text-sm outline-none"
          />
        </div>
        {results.length > 0 && (
          <ul className="max-h-64 overflow-y-auto p-1">
            {results.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  data-testid={`codex-command-result-${entry.id}`}
                  onClick={() => {
                    onSelect(entry);
                    onClose();
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent"
                >
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium">
                    {TYPE_LABELS[entry.type] ?? entry.type}
                  </span>
                  <span className="truncate font-medium">{entry.name}</span>
                  {entry.summary && (
                    <span className="truncate text-xs text-muted-foreground">
                      {entry.summary}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {query.trim() !== "" && results.length === 0 && (
          <p className="p-3 text-center text-xs text-muted-foreground">
            結果なし
          </p>
        )}
      </div>
    </div>
  );
}

// --- Detail Panel ---

function CodexDetailContent({
  entry,
  onSave,
  onDelete,
}: {
  entry: CodexEntry;
  onSave: (
    id: number,
    data: {
      type: CodexEntryType;
      name: string;
      summary: string;
      content: string;
      tags: string;
    },
  ) => void;
  onDelete: (id: number) => void;
}) {
  const [type, setType] = useState<CodexEntryType>(
    entry.type as CodexEntryType,
  );
  const [name, setName] = useState(entry.name);
  const [summary, setSummary] = useState(entry.summary);
  const [tags, setTags] = useState(entry.tags);

  const editor = useEditor({
    extensions: [StarterKit.configure()],
    content: entry.content,
  });

  // Sync form when entry changes
  useEffect(() => {
    setType(entry.type as CodexEntryType);
    setName(entry.name);
    setSummary(entry.summary);
    setTags(entry.tags);
    editor?.commands.setContent(entry.content);
  }, [
    entry.id,
    entry.type,
    entry.name,
    entry.summary,
    entry.tags,
    entry.content,
    editor,
  ]);

  const handleSave = () => {
    if (!name.trim()) return;
    const content = editor?.getHTML() ?? entry.content;
    onSave(entry.id, { type, name: name.trim(), summary, content, tags });
  };

  return (
    <div data-testid="codex-detail-content" className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="text-sm font-semibold">エントリ詳細</h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="codex-save-button"
            onClick={handleSave}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title="保存"
          >
            <Save className="h-3.5 w-3.5" />
          </button>
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
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        <div>
          <label className="mb-1 block text-xs font-medium">タイプ</label>
          <select
            data-testid="codex-detail-type"
            value={type}
            onChange={(e) => setType(e.target.value as CodexEntryType)}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          >
            {TYPE_OPTIONS.filter((o) => o.value !== "all").map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium">名前</label>
          <input
            data-testid="codex-detail-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium">概要</label>
          <input
            data-testid="codex-detail-summary"
            type="text"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium">内容</label>
          <div className="rounded-md border border-input bg-background p-2">
            <EditorContent editor={editor} />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium">タグ</label>
          <input
            data-testid="codex-detail-tags"
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>

        {entry.sourceChatMessageId && (
          <div
            data-testid="codex-source-chat-link"
            className="flex items-center gap-1.5 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            <span>抽出元チャット: {entry.sourceChatMessageId}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Virtualized Entry List ---

function VirtualizedEntryList({
  entries,
  isLoading,
  selectedEntryId,
  onSelect,
}: {
  entries: CodexEntry[];
  isLoading: boolean;
  selectedEntryId: number | null;
  onSelect: (entry: CodexEntry) => void;
}) {
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
        読み込み中...
      </p>
    );
  }

  if (entries.length === 0) {
    return (
      <div
        data-testid="codex-empty-state"
        className="flex-1 p-3 text-center text-xs text-muted-foreground"
      >
        エントリがありません
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
                className={`h-full w-full px-3 py-2 text-left hover:bg-accent ${
                  selectedEntryId === entry.id ? "bg-accent" : ""
                }`}
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
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Main Panel ---

export function CodexManagementPanel() {
  const entries = useCodexStore((s) => s.entries);
  const filterType = useCodexStore((s) => s.filterType);
  const isLoading = useCodexStore((s) => s.isLoading);
  const loadEntries = useCodexStore((s) => s.loadEntries);
  const update = useCodexStore((s) => s.update);
  const remove = useCodexStore((s) => s.remove);
  const setFilterType = useCodexStore((s) => s.setFilterType);

  const [selectedEntry, setSelectedEntry] = useState<CodexEntry | null>(null);
  const [showCommandPalette, setShowCommandPalette] = useState(false);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  // Ctrl+K handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setShowCommandPalette((prev) => !prev);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleFilterClick = useCallback(
    (value: CodexEntryType | "all") => {
      setFilterType(value === "all" ? null : value);
    },
    [setFilterType],
  );

  const handleSave = useCallback(
    async (
      id: number,
      data: {
        type: CodexEntryType;
        name: string;
        summary: string;
        content: string;
        tags: string;
      },
    ) => {
      await update(id, data);
    },
    [update],
  );

  const handleDelete = useCallback(
    async (id: number) => {
      await remove(id);
      setSelectedEntry(null);
    },
    [remove],
  );

  const handleCommandSelect = useCallback((entry: CodexEntry) => {
    setSelectedEntry(entry);
  }, []);

  return (
    <div data-testid="codex-management-panel" className="flex h-full flex-col">
      {showCommandPalette && (
        <CommandPalette
          onSelect={handleCommandSelect}
          onClose={() => setShowCommandPalette(false)}
        />
      )}

      <ResizablePanelGroup orientation="horizontal">
        {/* Left Panel: List */}
        <ResizablePanel defaultSize={40} minSize={25}>
          <div data-testid="codex-list-panel" className="flex h-full flex-col">
            {/* Category filter buttons */}
            <div className="flex flex-wrap gap-1 border-b border-border px-2 py-2">
              {TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  data-testid={`codex-filter-${opt.value}`}
                  onClick={() => handleFilterClick(opt.value)}
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    (opt.value === "all" && filterType === null) ||
                    opt.value === filterType
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Entry list (virtualized) */}
            <VirtualizedEntryList
              entries={entries}
              isLoading={isLoading}
              selectedEntryId={selectedEntry?.id ?? null}
              onSelect={setSelectedEntry}
            />
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Right Panel: Detail */}
        <ResizablePanel defaultSize={60} minSize={30}>
          <div data-testid="codex-detail-panel" className="h-full">
            {selectedEntry ? (
              <CodexDetailContent
                entry={selectedEntry}
                onSave={handleSave}
                onDelete={handleDelete}
              />
            ) : (
              <div
                data-testid="codex-detail-placeholder"
                className="flex h-full items-center justify-center"
              >
                <p className="text-xs text-muted-foreground">
                  エントリを選択してください
                </p>
              </div>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
