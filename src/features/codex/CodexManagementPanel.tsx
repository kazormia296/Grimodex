import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  type KeyboardEvent,
} from "react";
import { Search, Plus } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useCodexStore, type CodexSortOrder } from "./codexStore";
import type { CodexEntry, CodexEntryType } from "./api";
import { EntryIcon } from "./components/EntryIcon";
import { TagPill } from "./components/TagPill";
import { CodexDetailContent } from "./components/CodexDetailContent";

const TYPE_LABELS: Record<string, string> = {
  character: "キャラクター",
  location: "場所",
  item: "アイテム",
  lore: "設定・世界観",
};

const FILTER_OPTIONS: { value: CodexEntryType | "all"; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "character", label: "キャラクター" },
  { value: "location", label: "場所" },
  { value: "item", label: "アイテム" },
  { value: "lore", label: "設定・世界観" },
];

const SORT_OPTIONS: { value: CodexSortOrder; label: string }[] = [
  { value: "name-asc", label: "名前 (A→Z)" },
  { value: "name-desc", label: "名前 (Z→A)" },
  { value: "updated", label: "更新順" },
  { value: "created", label: "作成順" },
];

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
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
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
            onChange={(e) => void handleSearch(e.target.value)}
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

// --- Virtualized Entry List ---

function VirtualizedEntryList({
  entries,
  isLoading,
  selectedEntryId,
  onSelect,
}: {
  entries: CodexEntry[];
  isLoading: boolean;
  selectedEntryId: string | null;
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
          let cachedTagNames: string[] = [];
          try {
            if (entry.tagsCache) {
              cachedTagNames = JSON.parse(entry.tagsCache) as string[];
            }
          } catch {
            cachedTagNames = [];
          }
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
                  <EntryIcon
                    icon={entry.icon as number[] | null}
                    entryType={entry.type}
                    size={28}
                  />
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
                {cachedTagNames.length > 0 && (
                  <div className="mt-0.5 flex flex-wrap gap-0.5">
                    {cachedTagNames.map((tagName) => (
                      <TagPill
                        key={tagName}
                        name={tagName}
                        color="#888888"
                        size="sm"
                      />
                    ))}
                  </div>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Sort utility ---

function sortEntries(
  entries: CodexEntry[],
  order: CodexSortOrder,
): CodexEntry[] {
  const sorted = [...entries];
  switch (order) {
    case "name-asc":
      return sorted.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    case "name-desc":
      return sorted.sort((a, b) => b.name.localeCompare(a.name, "ja"));
    case "updated":
      return sorted.sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    case "created":
      return sorted.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    default:
      return sorted;
  }
}

// --- Main Panel ---

interface CodexManagementPanelProps {
  /** For testing: force stack mode (normally detected from panel width) */
  initialStackMode?: boolean;
}

export function CodexManagementPanel({
  initialStackMode = false,
}: CodexManagementPanelProps = {}) {
  const entries = useCodexStore((s) => s.entries);
  const filterType = useCodexStore((s) => s.filterType);
  const sortOrder = useCodexStore((s) => s.sortOrder);
  const isLoading = useCodexStore((s) => s.isLoading);
  const loadEntries = useCodexStore((s) => s.loadEntries);
  const searchStore = useCodexStore((s) => s.search);
  const remove = useCodexStore((s) => s.remove);
  const create = useCodexStore((s) => s.create);
  const setFilterType = useCodexStore((s) => s.setFilterType);
  const setSort = useCodexStore((s) => s.setSort);

  const [selectedEntry, setSelectedEntry] = useState<CodexEntry | null>(null);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isStackMode, setIsStackMode] = useState(initialStackMode);
  const [showDetail, setShowDetail] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  // Responsive: observe container width for stack/split switching
  useEffect(() => {
    if (initialStackMode) return; // controlled by prop in tests
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      setIsStackMode(width < 400);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [initialStackMode]);

  // Ctrl+K handler
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setShowCommandPalette((prev) => !prev);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Debounced search (300ms)
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchQuery(value);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = setTimeout(() => {
        void searchStore(value);
      }, 300);
    },
    [searchStore],
  );

  const handleSearchKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        setSearchQuery("");
        void searchStore("");
      }
    },
    [searchStore],
  );

  const handleFilterClick = useCallback(
    (value: CodexEntryType | "all") => {
      setFilterType(value === "all" ? null : value);
    },
    [setFilterType],
  );

  const handleNewEntry = useCallback(async () => {
    const entry = await create({ type: "character", name: "Untitled" });
    setSelectedEntry(entry);
    if (isStackMode) setShowDetail(true);
  }, [create, isStackMode]);

  const handleSelectEntry = useCallback(
    (entry: CodexEntry) => {
      setSelectedEntry(entry);
      if (isStackMode) setShowDetail(true);
    },
    [isStackMode],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await remove(id);
      setSelectedEntry(null);
      if (isStackMode) setShowDetail(false);
    },
    [remove, isStackMode],
  );

  const handleBack = useCallback(() => {
    setShowDetail(false);
    setSelectedEntry(null);
  }, []);

  const handleCommandSelect = useCallback(
    (entry: CodexEntry) => {
      setSelectedEntry(entry);
      if (isStackMode) setShowDetail(true);
    },
    [isStackMode],
  );

  // Sorted entries (client-side)
  const sortedEntries = useMemo(
    () => sortEntries(entries, sortOrder),
    [entries, sortOrder],
  );

  // --- Header ---
  const header = (
    <div
      data-testid="codex-header"
      className="flex items-center justify-between border-b border-border px-3 py-2"
    >
      <span data-testid="codex-header-title" className="text-sm font-semibold">
        Codex
      </span>
      <div className="flex items-center gap-1">
        <span
          data-testid="codex-entry-count"
          className="text-xs text-muted-foreground"
        >
          {entries.length}
        </span>
        <select
          data-testid="codex-sort-selector"
          value={sortOrder}
          onChange={(e) => setSort(e.target.value as CodexSortOrder)}
          className="rounded border border-input bg-background px-1 py-0.5 text-[10px]"
          title="ソート順"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="codex-new-entry-button"
          onClick={() => void handleNewEntry()}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          title="新規エントリ"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );

  // --- Search bar ---
  const searchBar = (
    <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
      <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
      <input
        data-testid="codex-search-input"
        type="text"
        value={searchQuery}
        onChange={(e) => handleSearchChange(e.target.value)}
        onKeyDown={handleSearchKeyDown}
        placeholder="検索..."
        className="flex-1 bg-transparent text-xs outline-none"
      />
    </div>
  );

  // --- Filter tabs ---
  const filterTabs = (
    <div className="flex flex-wrap gap-1 border-b border-border px-2 py-2">
      {FILTER_OPTIONS.map((opt) => (
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
  );

  // --- List panel content ---
  const listPanelContent = (
    <div data-testid="codex-list-panel" className="flex h-full flex-col">
      {searchBar}
      {filterTabs}
      <VirtualizedEntryList
        entries={sortedEntries}
        isLoading={isLoading}
        selectedEntryId={selectedEntry?.id ?? null}
        onSelect={handleSelectEntry}
      />
    </div>
  );

  // --- Detail panel content ---
  const detailPanelContent = selectedEntry ? (
    <CodexDetailContent
      key={selectedEntry.id}
      entry={selectedEntry}
      onDelete={handleDelete}
      onBack={isStackMode ? handleBack : undefined}
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
  );

  return (
    <div
      ref={containerRef}
      data-testid="codex-management-panel"
      className="flex h-full flex-col"
    >
      {showCommandPalette && (
        <CommandPalette
          onSelect={handleCommandSelect}
          onClose={() => setShowCommandPalette(false)}
        />
      )}

      {header}

      {isStackMode ? (
        // Stack mode: list or detail, not both
        <div className="flex-1 overflow-hidden">
          {showDetail ? (
            <div data-testid="codex-detail-panel" className="h-full">
              {detailPanelContent}
            </div>
          ) : (
            listPanelContent
          )}
        </div>
      ) : (
        // Split mode
        <ResizablePanelGroup
          orientation="horizontal"
          className="flex-1 overflow-hidden"
        >
          <ResizablePanel defaultSize={40} minSize={25}>
            {listPanelContent}
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={60} minSize={30}>
            <div data-testid="codex-detail-panel" className="h-full">
              {detailPanelContent}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  );
}
