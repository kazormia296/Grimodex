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
import type { CodexType } from "./typeApi";
import { listCodexTypes, ensureBuiltinTypes } from "./typeApi";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { EntryIcon } from "./components/EntryIcon";
import { TagPill } from "./components/TagPill";
import { CodexDetailContent } from "./components/CodexDetailContent";
import { EntryContextMenu } from "./components/EntryContextMenu";
import { CategoryGroupHeader } from "./components/CategoryGroupHeader";
import { TagFilterBar } from "./components/TagFilterBar";
import { CodexCommandPalette } from "./components/CodexCommandPalette";
import { buildCrossReferenceReport } from "./crossReference";
import * as chatApi from "@/features/chat/chatApi";
import { useChatStore } from "@/features/chat/chatStore";

// Fallback labels/colors for when types haven't loaded yet
const FALLBACK_TYPE_LABELS: Record<string, string> = {
  character: "キャラクター",
  location: "場所",
  item: "アイテム",
  lore: "設定・世界観",
};

const FALLBACK_TYPE_COLORS: Record<string, string> = {
  character: "#6B7ADB",
  location: "#5BAD8F",
  item: "#C27D3C",
  lore: "#9B6BB5",
};

const SORT_OPTIONS: { value: CodexSortOrder; label: string }[] = [
  { value: "category", label: "カテゴリ別" },
  { value: "name-asc", label: "名前 (A→Z)" },
  { value: "name-desc", label: "名前 (Z→A)" },
  { value: "updated", label: "更新順" },
  { value: "created", label: "作成順" },
  { value: "most-referenced", label: "参照数順" },
];

// --- Search highlight helper ---

function HighlightedName({
  name,
  query,
}: {
  name: string;
  query: string;
}): React.ReactElement {
  if (!query) return <>{name}</>;
  const lower = name.toLowerCase();
  const lowerQ = query.toLowerCase();
  const idx = lower.indexOf(lowerQ);
  if (idx === -1) return <>{name}</>;
  return (
    <>
      {name.slice(0, idx)}
      <mark className="bg-yellow-200/60 dark:bg-yellow-500/30 rounded px-0.5">
        {name.slice(idx, idx + query.length)}
      </mark>
      {name.slice(idx + query.length)}
    </>
  );
}

// --- Tag cache parser ---

type TagCacheItem = { name: string; color: string | null };

function parseTags(tagsCache: string | null | undefined): TagCacheItem[] {
  if (!tagsCache) return [];
  try {
    const parsed = JSON.parse(tagsCache) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return [];
    // New format: {name, color}[]
    if (typeof parsed[0] === "object" && parsed[0] !== null) {
      return parsed as TagCacheItem[];
    }
    // Old format: string[] (backward compat)
    return (parsed as string[]).map((name) => ({ name, color: null }));
  } catch {
    return [];
  }
}

// --- Virtualized Entry List (for non-category sorts) ---

function VirtualizedEntryList({
  entries,
  isLoading,
  selectedEntryId,
  onSelect,
  onDelete,
  onDuplicate,
  onFindInScenes,
  onChangeType,
  onPinToChat,
  codexTypes,
  searchQuery = "",
  renamingEntryId = null,
  onRenameCommit,
  onRenameCancel,
  onStartRename,
}: {
  entries: CodexEntry[];
  isLoading: boolean;
  selectedEntryId: string | null;
  onSelect: (entry: CodexEntry) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onFindInScenes: (id: string) => void;
  onChangeType: (id: string, newType: string) => void;
  onPinToChat?: (id: string) => void;
  codexTypes: CodexType[];
  searchQuery?: string;
  renamingEntryId?: string | null;
  onRenameCommit?: (id: string, name: string) => void;
  onRenameCancel?: () => void;
  onStartRename?: (id: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{
    entry: CodexEntry;
    x: number;
    y: number;
  } | null>(null);
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
            >
              <EntryCard
                entry={entry}
                isSelected={selectedEntryId === entry.id}
                onSelect={() => onSelect(entry)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ entry, x: e.clientX, y: e.clientY });
                }}
                searchQuery={searchQuery}
                isRenaming={renamingEntryId === entry.id}
                onRenameCommit={onRenameCommit}
                onRenameCancel={onRenameCancel}
              />
            </div>
          );
        })}
      </div>
      {contextMenu && (
        <EntryContextMenu
          entry={contextMenu.entry}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onDelete={(id) => {
            onDelete(id);
            setContextMenu(null);
          }}
          onRename={(id) => {
            onStartRename?.(id);
            setContextMenu(null);
          }}
          onDuplicate={(id) => {
            onDuplicate(id);
            setContextMenu(null);
          }}
          onFindInScenes={(id) => {
            onFindInScenes(id);
            setContextMenu(null);
          }}
          onChangeType={(id, newType) => {
            onChangeType(id, newType);
            setContextMenu(null);
          }}
          onPinToChat={
            onPinToChat
              ? (id) => {
                  onPinToChat(id);
                  setContextMenu(null);
                }
              : undefined
          }
          codexTypes={codexTypes}
        />
      )}
    </div>
  );
}

// --- Entry Card (shared between flat and grouped list) ---

function EntryCard({
  entry,
  isSelected,
  onSelect,
  onContextMenu,
  searchQuery = "",
  isRenaming = false,
  onRenameCommit,
  onRenameCancel,
}: {
  entry: CodexEntry;
  isSelected: boolean;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  searchQuery?: string;
  isRenaming?: boolean;
  onRenameCommit?: (id: string, name: string) => void;
  onRenameCancel?: () => void;
}) {
  const cachedTags = parseTags(entry.tagsCache);
  const [renameValue, setRenameValue] = useState(entry.name);

  // Reset when rename starts
  useEffect(() => {
    if (isRenaming) setRenameValue(entry.name);
  }, [isRenaming, entry.name]);

  if (isRenaming) {
    return (
      <div className="border-b border-border px-3 py-2">
        <input
          autoFocus
          type="text"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onRenameCommit?.(entry.id, renameValue.trim() || entry.name);
            } else if (e.key === "Escape") {
              onRenameCancel?.();
            }
          }}
          onBlur={() =>
            onRenameCommit?.(entry.id, renameValue.trim() || entry.name)
          }
          className="w-full rounded border border-input bg-background px-2 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
    );
  }

  return (
    <div className="border-b border-border">
      <button
        type="button"
        data-testid={`codex-entry-${entry.id}`}
        onClick={onSelect}
        onContextMenu={onContextMenu}
        className={`w-full px-3 py-2 text-left hover:bg-accent ${isSelected ? "bg-accent" : ""}`}
      >
        <div className="flex items-center gap-2 overflow-hidden">
          <EntryIcon
            icon={entry.icon as string | null}
            entryType={entry.type}
            size={28}
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            <HighlightedName name={entry.name} query={searchQuery} />
          </span>
          {cachedTags.length > 0 && (
            <div className="flex shrink-0 items-center gap-0.5">
              {cachedTags.slice(0, 2).map((tag) => (
                <TagPill
                  key={tag.name}
                  name={tag.name}
                  color={tag.color}
                  size="sm"
                />
              ))}
              {cachedTags.length > 2 && (
                <span className="rounded-full bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                  +{cachedTags.length - 2}
                </span>
              )}
            </div>
          )}
        </div>
        {entry.summary && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {entry.summary}
          </p>
        )}
      </button>
    </div>
  );
}

// --- Category Grouped List ---

function CategoryGroupedList({
  entries,
  isLoading,
  selectedEntryId,
  onSelect,
  onDelete,
  onDuplicate,
  onFindInScenes,
  onChangeType,
  onPinToChat,
  codexTypes,
  renamingEntryId = null,
  onRenameCommit,
  onRenameCancel,
  onStartRename,
}: {
  entries: CodexEntry[];
  isLoading: boolean;
  selectedEntryId: string | null;
  onSelect: (entry: CodexEntry) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onFindInScenes: (id: string) => void;
  onChangeType: (id: string, newType: string) => void;
  onPinToChat?: (id: string) => void;
  codexTypes: CodexType[];
  renamingEntryId?: string | null;
  onRenameCommit?: (id: string, name: string) => void;
  onRenameCancel?: () => void;
  onStartRename?: (id: string) => void;
}) {
  const [contextMenu, setContextMenu] = useState<{
    entry: CodexEntry;
    x: number;
    y: number;
  } | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    {},
  );
  const typeColorMap = useCodexHighlightStore((s) => s.typeColorMap);

  // Group entries by type, ordered by codexTypes sortOrder
  const groups = useMemo(() => {
    const byType = new Map<string, CodexEntry[]>();
    for (const entry of entries) {
      if (!byType.has(entry.type)) byType.set(entry.type, []);
      byType.get(entry.type)!.push(entry);
    }

    // Sort each group's entries by name
    for (const grpEntries of byType.values()) {
      grpEntries.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    }

    // Order groups by codexTypes.sortOrder; types not in codexTypes go last
    const typeOrder = new Map(
      codexTypes.map((t, i) => [t.slug, t.sortOrder ?? i]),
    );

    return [...byType.entries()]
      .sort(([aSlug], [bSlug]) => {
        const aOrd = typeOrder.get(aSlug) ?? 9999;
        const bOrd = typeOrder.get(bSlug) ?? 9999;
        return aOrd - bOrd;
      })
      .map(([typeSlug, grpEntries]) => {
        const codexType = codexTypes.find((t) => t.slug === typeSlug);
        const resolvedColor = typeColorMap[typeSlug];
        return {
          slug: typeSlug,
          label: codexType?.label ?? FALLBACK_TYPE_LABELS[typeSlug] ?? typeSlug,
          color:
            resolvedColor?.fg ??
            codexType?.color ??
            FALLBACK_TYPE_COLORS[typeSlug] ??
            "#888888",
          entries: grpEntries,
        };
      });
  }, [entries, codexTypes, typeColorMap]);

  const isExpanded = useCallback(
    (slug: string) => expandedGroups[slug] !== false, // default: expanded
    [expandedGroups],
  );

  const toggleGroup = useCallback(
    (slug: string) => {
      setExpandedGroups((prev) => ({ ...prev, [slug]: !isExpanded(slug) }));
    },
    [isExpanded],
  );

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
    <div className="flex-1 overflow-y-auto">
      {groups.map((group) => (
        <div key={group.slug}>
          <CategoryGroupHeader
            type={group.slug}
            label={group.label}
            color={group.color}
            count={group.entries.length}
            isExpanded={isExpanded(group.slug)}
            onToggle={() => toggleGroup(group.slug)}
          />
          {isExpanded(group.slug) &&
            group.entries.map((entry) => (
              <EntryCard
                key={entry.id}
                entry={entry}
                isSelected={selectedEntryId === entry.id}
                onSelect={() => onSelect(entry)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ entry, x: e.clientX, y: e.clientY });
                }}
                isRenaming={renamingEntryId === entry.id}
                onRenameCommit={onRenameCommit}
                onRenameCancel={onRenameCancel}
              />
            ))}
        </div>
      ))}
      {contextMenu && (
        <EntryContextMenu
          entry={contextMenu.entry}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onDelete={(id) => {
            onDelete(id);
            setContextMenu(null);
          }}
          onRename={(id) => {
            onStartRename?.(id);
            setContextMenu(null);
          }}
          onDuplicate={(id) => {
            onDuplicate(id);
            setContextMenu(null);
          }}
          onFindInScenes={(id) => {
            onFindInScenes(id);
            setContextMenu(null);
          }}
          onChangeType={(id, newType) => {
            onChangeType(id, newType);
            setContextMenu(null);
          }}
          onPinToChat={
            onPinToChat
              ? (id) => {
                  onPinToChat(id);
                  setContextMenu(null);
                }
              : undefined
          }
          codexTypes={codexTypes}
        />
      )}
    </div>
  );
}

// --- Sort utility (for non-category sorts) ---

function sortEntries(
  entries: CodexEntry[],
  order: CodexSortOrder,
  refCountMap?: Map<string, number>,
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
    case "most-referenced":
      return sorted.sort((a, b) => {
        const ac = refCountMap?.get(a.id) ?? 0;
        const bc = refCountMap?.get(b.id) ?? 0;
        return bc - ac;
      });
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
  const pendingEntryId = useCodexStore((s) => s.pendingEntryId);
  const clearPendingEntry = useCodexStore((s) => s.clearPendingEntry);
  const searchStore = useCodexStore((s) => s.search);
  const remove = useCodexStore((s) => s.remove);
  const create = useCodexStore((s) => s.create);
  const update = useCodexStore((s) => s.update);
  const setFilterType = useCodexStore((s) => s.setFilterType);
  const setSort = useCodexStore((s) => s.setSort);

  const [selectedEntry, setSelectedEntry] = useState<CodexEntry | null>(null);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isStackMode, setIsStackMode] = useState(initialStackMode);
  const [showDetail, setShowDetail] = useState(false);
  const [codexTypes, setCodexTypes] = useState<CodexType[]>([]);
  // When the user triggers "Find in scenes" we open the Mentions tab
  const [detailInitialTab, setDetailInitialTab] = useState("details");
  // S1: tag filter
  const [allTags, setAllTags] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  // M1: reference count cache
  const [refCountMap, setRefCountMap] = useState<Map<string, number>>(
    new Map(),
  );
  const [refCountLoading, setRefCountLoading] = useState(false);
  // M2: inline rename
  const [renamingEntryId, setRenamingEntryId] = useState<string | null>(null);
  // S3: active chat session
  const activeSessionId = useChatStore((s) => s.activeSessionId);

  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  // Handle external entry selection request (e.g. from CodexQuick panel click)
  useEffect(() => {
    if (!pendingEntryId) return;
    const entry = entries.find((e) => e.id === pendingEntryId);
    if (!entry) return; // wait for entries to load
    setSelectedEntry(entry);
    if (isStackMode) setShowDetail(true);
    clearPendingEntry();
  }, [pendingEntryId, entries, isStackMode, clearPendingEntry]);

  useEffect(() => {
    ensureBuiltinTypes("default-project")
      .then(() => listCodexTypes("default-project"))
      .then(setCodexTypes)
      .catch(() => setCodexTypes([]));
  }, []);

  // S1: collect all unique tag names from entries
  useEffect(() => {
    const tagSet = new Set<string>();
    for (const entry of entries) {
      for (const tag of parseTags(entry.tagsCache)) {
        tagSet.add(tag.name);
      }
    }
    setAllTags([...tagSet].sort());
  }, [entries]);

  // M1: load reference counts when sort changes to most-referenced
  useEffect(() => {
    if (sortOrder !== "most-referenced") return;
    setRefCountLoading(true);
    buildCrossReferenceReport()
      .then((report) => {
        const map = new Map<string, number>();
        for (const item of report) {
          map.set(
            item.entryId,
            item.scenes.reduce((sum, s) => sum + s.count, 0),
          );
        }
        setRefCountMap(map);
      })
      .catch(() => setRefCountMap(new Map()))
      .finally(() => setRefCountLoading(false));
  }, [sortOrder]);

  // Responsive: observe container width for stack/split switching
  useEffect(() => {
    if (initialStackMode) return;
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      setIsStackMode(width < 400);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [initialStackMode]);

  // Ctrl+K / Ctrl+F / ↑↓ / F2 / Delete shortcuts
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setShowCommandPalette((prev) => !prev);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      // Arrow navigation — only when focus is NOT in a text editor or input field
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const active = document.activeElement;
        if (
          active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          (active instanceof HTMLElement && active.isContentEditable)
        )
          return;
        const currentSorted =
          sortOrder === "category" ? entries : sortEntries(entries, sortOrder);
        if (currentSorted.length === 0) return;
        const idx = selectedEntry
          ? currentSorted.findIndex((e) => e.id === selectedEntry.id)
          : -1;
        const next =
          e.key === "ArrowDown"
            ? Math.min(idx + 1, currentSorted.length - 1)
            : Math.max(idx - 1, 0);
        handleSelectEntry(currentSorted[next]);
        e.preventDefault();
        return;
      }
      if (e.key === "F2" && selectedEntry) {
        setRenamingEntryId(selectedEntry.id);
        return;
      }
      if (e.key === "Delete" && selectedEntry && !renamingEntryId) {
        if (window.confirm(`"${selectedEntry.name}" を削除しますか？`)) {
          void handleDelete(selectedEntry.id);
        }
        return;
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [entries, selectedEntry, sortOrder, renamingEntryId]);

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
    setDetailInitialTab("details");
    setSelectedEntry(entry);
    if (isStackMode) setShowDetail(true);
  }, [create, isStackMode]);

  const handleSelectEntry = useCallback(
    (entry: CodexEntry, tab = "details") => {
      setDetailInitialTab(tab);
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

  const handleDuplicate = useCallback(
    async (id: string) => {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return;
      const newEntry = await create({
        type: entry.type as CodexEntryType,
        name: `${entry.name} (copy)`,
        summary: entry.summary ?? undefined,
        aliases: entry.aliases ?? undefined,
        excludedAliases: entry.excludedAliases ?? undefined,
      });
      setDetailInitialTab("details");
      setSelectedEntry(newEntry);
      if (isStackMode) setShowDetail(true);
    },
    [create, entries, isStackMode],
  );

  const handleFindInScenes = useCallback(
    (id: string) => {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return;
      // Open entry detail at the Mentions tab
      handleSelectEntry(entry, "mentions");
    },
    [entries, handleSelectEntry],
  );

  const handleChangeType = useCallback(
    async (id: string, newType: string) => {
      await update(id, { type: newType as CodexEntryType });
    },
    [update],
  );

  const handleBack = useCallback(() => {
    setShowDetail(false);
    setSelectedEntry(null);
  }, []);

  // M2: inline rename
  const handleRenameCommit = useCallback(
    async (id: string, name: string) => {
      setRenamingEntryId(null);
      if (!name) return;
      await update(id, { name });
    },
    [update],
  );

  // S3: pin to chat
  const handlePinToChat = useCallback(
    async (id: string) => {
      if (!activeSessionId) return;
      await chatApi.pinCodexEntry(activeSessionId, id);
    },
    [activeSessionId],
  );

  const handleCommandSelect = useCallback(
    (entry: CodexEntry) => {
      setDetailInitialTab("details");
      setSelectedEntry(entry);
      if (isStackMode) setShowDetail(true);
    },
    [isStackMode],
  );

  // S1: tag-filtered entries
  const tagFilteredEntries = useMemo(() => {
    if (selectedTags.size === 0) return entries;
    return entries.filter((e) => {
      const tags = parseTags(e.tagsCache).map((t) => t.name);
      return [...selectedTags].some((tag) => tags.includes(tag));
    });
  }, [entries, selectedTags]);

  // Sorted entries (client-side, only for non-category sorts)
  const sortedEntries = useMemo(
    () =>
      sortOrder === "category"
        ? tagFilteredEntries
        : sortEntries(tagFilteredEntries, sortOrder, refCountMap),
    [tagFilteredEntries, sortOrder, refCountMap],
  );

  // Build type label map from loaded types (fallback to hardcoded)
  const typeLabels: Record<string, string> = useMemo(() => {
    if (codexTypes.length === 0) return FALLBACK_TYPE_LABELS;
    return Object.fromEntries(codexTypes.map((t) => [t.slug, t.label]));
  }, [codexTypes]);

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
        ref={searchInputRef}
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
  const filterOptions: { value: CodexEntryType | "all"; label: string }[] =
    useMemo(() => {
      const opts: { value: CodexEntryType | "all"; label: string }[] = [
        { value: "all", label: "すべて" },
      ];
      if (codexTypes.length > 0) {
        codexTypes.forEach((t) => opts.push({ value: t.slug, label: t.label }));
      } else {
        opts.push(
          { value: "character", label: "キャラクター" },
          { value: "location", label: "場所" },
          { value: "item", label: "アイテム" },
          { value: "lore", label: "設定・世界観" },
        );
      }
      return opts;
    }, [codexTypes]);

  const filterTabs = (
    <div className="flex flex-wrap gap-1 border-b border-border px-2 py-2">
      {filterOptions.map((opt) => (
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

  // S1: tag filter bar
  const tagFilterBar = (
    <TagFilterBar
      allTags={allTags}
      selectedTags={selectedTags}
      onToggle={(tag) =>
        setSelectedTags((prev) => {
          const next = new Set(prev);
          if (next.has(tag)) next.delete(tag);
          else next.add(tag);
          return next;
        })
      }
      onClear={() => setSelectedTags(new Set())}
    />
  );

  // Shared props for both list components
  const listProps = {
    isLoading: isLoading || refCountLoading,
    selectedEntryId: selectedEntry?.id ?? null,
    onSelect: handleSelectEntry,
    onDelete: handleDelete,
    onDuplicate: handleDuplicate,
    onFindInScenes: handleFindInScenes,
    onChangeType: handleChangeType,
    onPinToChat: activeSessionId ? handlePinToChat : undefined,
    codexTypes,
    renamingEntryId,
    onRenameCommit: handleRenameCommit,
    onRenameCancel: () => setRenamingEntryId(null),
    onStartRename: (id: string) => setRenamingEntryId(id),
  };

  // --- List panel content ---
  const listPanelContent = (
    <div data-testid="codex-list-panel" className="flex h-full flex-col">
      {searchBar}
      {filterTabs}
      {tagFilterBar}
      {sortOrder === "category" &&
      searchQuery === "" &&
      filterType === null &&
      selectedTags.size === 0 ? (
        <CategoryGroupedList entries={entries} {...listProps} />
      ) : (
        <VirtualizedEntryList
          entries={sortedEntries}
          searchQuery={searchQuery}
          {...listProps}
        />
      )}
    </div>
  );

  // --- Detail panel content ---
  const detailPanelContent = selectedEntry ? (
    <CodexDetailContent
      key={`${selectedEntry.id}-${detailInitialTab}`}
      entry={selectedEntry}
      onDelete={handleDelete}
      onBack={isStackMode ? handleBack : undefined}
      initialTab={detailInitialTab}
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
        <CodexCommandPalette
          onSelect={handleCommandSelect}
          onClose={() => setShowCommandPalette(false)}
          typeLabels={typeLabels}
        />
      )}

      {header}

      {isStackMode ? (
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
