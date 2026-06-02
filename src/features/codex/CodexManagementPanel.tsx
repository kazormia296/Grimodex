import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  type KeyboardEvent,
} from "react";
import { Search, Plus } from "lucide-react";
import type { SlotPanelProps } from "@/features/layout/layoutTypes";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useCodexStore, type CodexSortOrder } from "./codexStore";
import { sortEntries, CODEX_SORT_OPTIONS } from "./codexSort";
import type { CodexEntry, CodexEntryType } from "./api";
import type { CodexType } from "./typeApi";
import { listCodexTypes, ensureBuiltinTypes } from "./typeApi";
import { getTypeLabel } from "@/features/chat/utils/typeLabels";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { CodexDetailContent } from "./components/CodexDetailContent";
import { EntryCard, parseTags } from "./components/EntryCard";
import { EntryContextMenu } from "./components/EntryContextMenu";
import { CategoryGroupHeader } from "./components/CategoryGroupHeader";
import { TagFilterBar } from "./components/TagFilterBar";
import { CodexCommandPalette } from "./components/CodexCommandPalette";
import { AnimatePresence } from "motion/react";
import { ListRowSkeletonList } from "@/components/ui/skeleton-patterns";
import { buildCrossReferenceReport } from "./crossReference";
import * as chatApi from "@/features/chat/chatApi";
import { useChatStore } from "@/features/chat/chatStore";
import { useTabStore } from "@/features/editor/tabStore";
import { EditorPane } from "@/features/editor/EditorPane";
import { useMatrixStore } from "@/features/matrix/matrixStore";
import { useDropTarget } from "@/features/trash-bin/useDropTarget";
import { getCurrentProjectId } from "@/features/project/projectStore";

// Fallback colors for when types haven't loaded yet
const FALLBACK_TYPE_COLORS: Record<string, string> = {
  character: "#6B7ADB",
  location: "#5BAD8F",
  item: "#C27D3C",
  lore: "#9B6BB5",
};

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
  scrollToEntryId,
  onScrollComplete,
  customSets,
  onAddToCustomSet,
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
  scrollToEntryId?: string | null;
  onScrollComplete?: () => void;
  customSets?: Array<{ id: string; name: string }>;
  onAddToCustomSet?: (setId: string, entryId: string) => void;
}) {
  const { t } = useTranslation();
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

  useEffect(() => {
    if (!scrollToEntryId) return;
    const idx = entries.findIndex((e) => e.id === scrollToEntryId);
    if (idx !== -1) {
      virtualizer.scrollToIndex(idx, { align: "start", behavior: "smooth" });
    }
    onScrollComplete?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToEntryId]);

  if (isLoading) {
    return (
      <ListRowSkeletonList
        testId="codex-list-loading"
        className="flex-1 overflow-hidden"
      />
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
          customSets={customSets}
          onAddToCustomSet={
            onAddToCustomSet && contextMenu
              ? (setId) => {
                  onAddToCustomSet(setId, contextMenu.entry.id);
                  setContextMenu(null);
                }
              : undefined
          }
        />
      )}
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
  scrollToEntryId,
  onScrollComplete,
  customSets,
  onAddToCustomSet,
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
  scrollToEntryId?: string | null;
  onScrollComplete?: () => void;
  customSets?: Array<{ id: string; name: string }>;
  onAddToCustomSet?: (setId: string, entryId: string) => void;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
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
          label: codexType?.isBuiltin
            ? getTypeLabel(typeSlug)
            : (codexType?.label ??
              t(`codex.${typeSlug}`, { defaultValue: typeSlug })),
          color:
            resolvedColor?.fg ??
            codexType?.color ??
            FALLBACK_TYPE_COLORS[typeSlug] ??
            "#888888",
          entries: grpEntries,
        };
      });
  }, [entries, codexTypes, typeColorMap, t]);

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

  const pendingScrollRef = useRef<string | null>(null);

  useEffect(() => {
    if (!scrollToEntryId) return;
    const targetEntry = entries.find((e) => e.id === scrollToEntryId);
    if (targetEntry) {
      setExpandedGroups((prev) => {
        if (prev[targetEntry.type] === false) {
          return { ...prev, [targetEntry.type]: true };
        }
        return prev;
      });
    }
    pendingScrollRef.current = scrollToEntryId;
    onScrollComplete?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToEntryId]);

  // After every render, execute pending scroll (retries after group expansion re-render)
  useEffect(() => {
    if (!pendingScrollRef.current) return;
    const el = containerRef.current?.querySelector(
      `[data-testid="codex-entry-${pendingScrollRef.current}"]`,
    );
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      pendingScrollRef.current = null;
    }
  });

  if (isLoading) {
    return (
      <ListRowSkeletonList
        testId="codex-category-list-loading"
        className="flex-1 overflow-hidden"
      />
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
    <div ref={containerRef} className="flex-1 overflow-y-auto">
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
          customSets={customSets}
          onAddToCustomSet={
            onAddToCustomSet && contextMenu
              ? (setId) => {
                  onAddToCustomSet(setId, contextMenu.entry.id);
                  setContextMenu(null);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

// --- Sort utility (for non-category sorts) ---

// sortEntries is imported from ./codexSort

// --- Main Panel ---

// SlotPanelProps を継承する。isActive 自体はこのパネルでは未使用だが、
// PANEL_COMPONENT_MAP の FunctionComponent<SlotPanelProps> 型に対し
// weak-type ルール (全 optional な型は共通プロパティ必須) を満たすために必要。
interface CodexManagementPanelProps extends SlotPanelProps {
  /** For testing: force stack mode (normally detected from panel width) */
  initialStackMode?: boolean;
}

export function CodexManagementPanel({
  initialStackMode = false,
}: CodexManagementPanelProps = {}) {
  const { t } = useTranslation();

  const SORT_OPTIONS = CODEX_SORT_OPTIONS.map((opt) => ({
    ...opt,
    label: t(opt.key),
  }));

  const entries = useCodexStore((s) => s.entries);
  const previewPhaseByEntry = useCodexStore((s) => s.previewPhaseByEntry);
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
  const [isWideMode, setIsWideMode] = useState(false);
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
  const [, setRefCountLoading] = useState(false);
  // M2: inline rename
  const [renamingEntryId, setRenamingEntryId] = useState<string | null>(null);
  // Delete confirmation dialog
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  // S3: active chat session
  const activeSessionId = useChatStore((s) => s.activeSessionId);

  // Matrix custom sets (for "Add to Matrix Custom" context menu item)
  const matrixCustomSets = useMatrixStore((s) => s.customSets);

  const [scrollToEntryId, setScrollToEntryId] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const trashDropRef = useDropTarget("codex-panel", "codex-panel");
  const setRootRef = useCallback(
    (el: HTMLDivElement | null) => {
      containerRef.current = el;
      trashDropRef.current = el;
    },
    [trashDropRef],
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, []);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  // Handle external entry selection request (e.g. from CodexQuick panel click)
  useEffect(() => {
    if (!pendingEntryId) return;
    const entry = entries.find((e) => e.id === pendingEntryId);
    if (!entry) return; // wait for entries to load
    setSelectedEntry(entry);
    setScrollToEntryId(pendingEntryId);
    if (isStackMode) setShowDetail(true);
    clearPendingEntry();
  }, [pendingEntryId, entries, isStackMode, clearPendingEntry]);

  useEffect(() => {
    ensureBuiltinTypes(getCurrentProjectId())
      .then(() => listCodexTypes(getCurrentProjectId()))
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
      setIsWideMode(width >= 1200);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [initialStackMode]);

  const initiateDelete = useCallback((id: string) => {
    setDeleteConfirmId(id);
  }, []);

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

  // Flat entry list in visual order for keyboard navigation
  const navigableEntries = useMemo(() => {
    if (sortOrder !== "category") return sortedEntries;
    // Category mode: reproduce the same order as CategoryGroupedList
    const base =
      searchQuery === "" && filterType === null && selectedTags.size === 0
        ? entries
        : tagFilteredEntries;
    const byType = new Map<string, CodexEntry[]>();
    for (const entry of base) {
      if (!byType.has(entry.type)) byType.set(entry.type, []);
      byType.get(entry.type)!.push(entry);
    }
    for (const grpEntries of byType.values()) {
      grpEntries.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    }
    const typeOrder = new Map(
      codexTypes.map((ct, i) => [ct.slug, ct.sortOrder ?? i]),
    );
    return [...byType.entries()]
      .sort(
        ([aSlug], [bSlug]) =>
          (typeOrder.get(aSlug) ?? 9999) - (typeOrder.get(bSlug) ?? 9999),
      )
      .flatMap(([, grpEntries]) => grpEntries);
  }, [
    sortOrder,
    sortedEntries,
    entries,
    tagFilteredEntries,
    searchQuery,
    filterType,
    selectedTags,
    codexTypes,
  ]);

  const handleSelectEntry = useCallback(
    (entry: CodexEntry, tab = "details") => {
      setDetailInitialTab(tab);
      setSelectedEntry(entry);
      if (isStackMode) setShowDetail(true);
    },
    [isStackMode],
  );

  // Ctrl+K / Ctrl+F / ↑↓ / F2 / Delete shortcuts
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      // Only handle when focus is inside this panel
      if (!containerRef.current?.contains(document.activeElement)) return;

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
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        // Don't intercept while editing text in an input/textarea/contenteditable
        const ae = document.activeElement as HTMLElement | null;
        if (
          ae?.tagName === "INPUT" ||
          ae?.tagName === "TEXTAREA" ||
          ae?.contentEditable === "true"
        )
          return;
        if (navigableEntries.length === 0) return;
        const idx = selectedEntry
          ? navigableEntries.findIndex((e) => e.id === selectedEntry.id)
          : -1;
        const next =
          e.key === "ArrowDown"
            ? Math.min(idx + 1, navigableEntries.length - 1)
            : Math.max(idx - 1, 0);
        handleSelectEntry(navigableEntries[next]);
        e.preventDefault();
        return;
      }
      if (e.key === "F2" && selectedEntry) {
        setRenamingEntryId(selectedEntry.id);
        return;
      }
      if (e.key === "Delete" && selectedEntry && !renamingEntryId) {
        // Don't intercept Delete while editing text in an input/textarea/contenteditable
        const ae = document.activeElement as HTMLElement | null;
        if (
          ae?.tagName === "INPUT" ||
          ae?.tagName === "TEXTAREA" ||
          ae?.contentEditable === "true"
        )
          return;
        initiateDelete(selectedEntry.id);
        return;
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    navigableEntries,
    selectedEntry,
    renamingEntryId,
    initiateDelete,
    handleSelectEntry,
  ]);

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
    setScrollToEntryId(entry.id);
    if (isStackMode) setShowDetail(true);
  }, [create, isStackMode]);

  const confirmDelete = useCallback(async () => {
    const id = deleteConfirmId;
    if (!id) return;
    setDeleteConfirmId(null);
    await remove(id);
    setSelectedEntry(null);
    if (isStackMode) setShowDetail(false);
    // Close editor tab if open
    const tabState = useTabStore.getState();
    if (tabState.tabs.some((t) => t.nodeId === id)) tabState.closeTab(id);
    if (tabState.secondaryTabs.some((t) => t.nodeId === id))
      tabState.closeSecondaryTab(id);
  }, [deleteConfirmId, remove, isStackMode]);

  const handleDelete = initiateDelete;

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
      setScrollToEntryId(newEntry.id);
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

  // Build type label map from loaded types (fallback to i18n)
  const typeLabels: Record<string, string> = useMemo(() => {
    if (codexTypes.length === 0) {
      return {
        character: t("codex.character"),
        location: t("codex.location"),
        item: t("codex.item"),
        lore: t("codex.lore"),
      };
    }
    return Object.fromEntries(codexTypes.map((ct) => [ct.slug, ct.label]));
  }, [codexTypes, t]);

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
          title={t("codex.sortOrderTitle")}
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
          title={t("codex.newEntry")}
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
        placeholder={t("codex.searchPlaceholder")}
        className="flex-1 bg-transparent text-xs outline-none"
      />
    </div>
  );

  // --- Filter tabs ---
  const filterOptions: { value: CodexEntryType | "all"; label: string }[] =
    useMemo(() => {
      const opts: { value: CodexEntryType | "all"; label: string }[] = [
        { value: "all", label: t("codex.filterAll") },
      ];
      if (codexTypes.length > 0) {
        codexTypes.forEach((ct) =>
          opts.push({
            value: ct.slug,
            label: ct.isBuiltin ? getTypeLabel(ct.slug) : ct.label,
          }),
        );
      } else {
        opts.push(
          { value: "character", label: t("codex.character") },
          { value: "location", label: t("codex.location") },
          { value: "item", label: t("codex.item") },
          { value: "lore", label: t("codex.lore") },
        );
      }
      return opts;
    }, [codexTypes, t]);

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
    isLoading,
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
    scrollToEntryId,
    onScrollComplete: () => setScrollToEntryId(null),
    customSets: matrixCustomSets.length > 0 ? matrixCustomSets : undefined,
    onAddToCustomSet:
      matrixCustomSets.length > 0
        ? (setId: string, entryId: string) => {
            useMatrixStore.getState().addCodexToCustomSet(setId, entryId);
          }
        : undefined,
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
      <p className="text-xs text-muted-foreground">{t("codex.selectPrompt")}</p>
    </div>
  );

  return (
    <div
      ref={setRootRef}
      tabIndex={-1}
      data-testid="codex-management-panel"
      data-droptarget-id="codex-panel"
      className="flex h-full flex-col outline-none data-[trash-drop-hover=true]:ring-2 data-[trash-drop-hover=true]:ring-primary/60 data-[trash-drop-hover=true]:ring-inset"
    >
      <AnimatePresence>
        {showCommandPalette && (
          <CodexCommandPalette
            onSelect={handleCommandSelect}
            onClose={() => setShowCommandPalette(false)}
            typeLabels={typeLabels}
          />
        )}
      </AnimatePresence>

      {isStackMode ? (
        <>
          {header}
          <div className="flex-1 overflow-hidden">
            {showDetail ? (
              <div data-testid="codex-detail-panel" className="h-full">
                {detailPanelContent}
              </div>
            ) : (
              listPanelContent
            )}
          </div>
        </>
      ) : isWideMode ? (
        <ResizablePanelGroup
          orientation="horizontal"
          className="flex-1 overflow-hidden"
        >
          <ResizablePanel defaultSize={22} minSize={15}>
            <div className="flex h-full flex-col">
              {header}
              <div className="min-h-0 flex-1">{listPanelContent}</div>
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel
            defaultSize={50}
            minSize={30}
            className="flex flex-col"
          >
            {selectedEntry ? (
              <EditorPane
                nodeId={selectedEntry.id}
                contentType="codex"
                groupIndex={0}
                onFocus={() => {}}
                phaseIdOverride={previewPhaseByEntry[selectedEntry.id] ?? null}
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <p className="text-xs text-muted-foreground">
                  {t("codex.selectPrompt")}
                </p>
              </div>
            )}
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={28} minSize={20}>
            <div data-testid="codex-detail-panel" className="h-full">
              {detailPanelContent}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <ResizablePanelGroup
          orientation="horizontal"
          className="flex-1 overflow-hidden"
        >
          <ResizablePanel defaultSize={40} minSize={25}>
            <div className="flex h-full flex-col">
              {header}
              <div className="min-h-0 flex-1">{listPanelContent}</div>
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={60} minSize={30}>
            <div data-testid="codex-detail-panel" className="h-full">
              {detailPanelContent}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      )}

      {deleteConfirmId && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80">
          <div className="w-72 rounded-lg border border-border bg-popover p-4 shadow-xl">
            <p className="mb-1 text-sm font-medium">
              {t("common.deleteConfirmTitle")}
            </p>
            <p className="mb-4 text-xs text-muted-foreground">
              {t("codex.deleteConfirmDesc", {
                name: entries.find((e) => e.id === deleteConfirmId)?.name ?? "",
              })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded border border-border px-3 py-1 text-xs hover:bg-accent"
                onClick={() => setDeleteConfirmId(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="rounded bg-destructive px-3 py-1 text-xs text-destructive-foreground hover:bg-destructive/90"
                onClick={() => void confirmDelete()}
              >
                {t("common.deleteConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
