import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Search, Trash2, Copy, Plus, GripVertical } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { useSnippetStore } from "./snippetStore";
import { useDropTarget } from "@/features/trash-bin/useDropTarget";
import type { SnippetSourceFilter, SnippetSortOrder } from "./snippetStore";
import { SnippetDetailContent } from "./SnippetDetailContent";
import { SnippetContextMenu } from "./SnippetContextMenu";
import { SnippetCardBody } from "./components/SnippetCardBody";
import { PanelHeader } from "@/features/layout/PanelHeader";
import { useTabStore } from "@/features/editor/tabStore";
import { useEditorStore } from "@/features/editor/editorStore";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  copyWithAttribution,
  handleCopyWithAttribution,
} from "@/lib/clipboardAttribution";
import { matchesMod } from "@/lib/platform";
import { compareInstantValues } from "@/lib/time";
import type { AuthorshipSource } from "@/features/attribution/AuthorshipMark";
import type { Snippet } from "./api";
import type { TimelapseDocumentRef } from "@/features/timelapse/documentCoverage";
import { GridCardSkeletonList } from "@/components/ui/skeleton-patterns";

export function SnippetPanel() {
  const { t } = useTranslation();

  const SOURCE_FILTER_OPTIONS: { value: SnippetSourceFilter; label: string }[] =
    [
      { value: "all", label: t("snippets.filterAll") },
      { value: "from-chat", label: t("snippets.filterFromChat") },
      { value: "from-editor", label: t("snippets.filterFromEditor") },
      { value: "manual", label: t("snippets.filterManual") },
    ];

  const SORT_OPTIONS: { value: SnippetSortOrder; label: string }[] = [
    { value: "recent", label: t("snippets.sortRecent") },
    { value: "oldest", label: t("snippets.sortOldest") },
    { value: "title-asc", label: t("snippets.sortTitleAsc") },
    { value: "most-used", label: t("snippets.sortMostUsed") },
  ];

  const entries = useSnippetStore((s) => s.entries);
  const searchQuery = useSnippetStore((s) => s.searchQuery);
  const isLoading = useSnippetStore((s) => s.isLoading);
  const ensureEntriesLoaded = useSnippetStore((s) => s.ensureEntriesLoaded);
  const search = useSnippetStore((s) => s.search);
  const create = useSnippetStore((s) => s.create);
  const update = useSnippetStore((s) => s.update);
  const remove = useSnippetStore((s) => s.remove);
  const incrementUsageCount = useSnippetStore((s) => s.incrementUsageCount);
  const sourceFilter = useSnippetStore((s) => s.sourceFilter);
  const sortOrder = useSnippetStore((s) => s.sortOrder);
  const setSourceFilter = useSnippetStore((s) => s.setSourceFilter);
  const setSortOrder = useSnippetStore((s) => s.setSortOrder);
  const pendingEntryId = useSnippetStore((s) => s.pendingEntryId);
  const clearPendingEntry = useSnippetStore((s) => s.clearPendingEntry);
  const nodes = useTreeStore((s) => s.nodes);
  const setActiveScene = useTreeStore((s) => s.setActiveScene);

  // 選択中スニペットはストアに持たせる。プリセット切替で配置から外れたり
  // パネルを閉じたりして subtree が unmount されても選択を保持するため
  // （local state だと失われる）。
  const selectedSnippet = useSnippetStore((s) => s.selectedSnippet);
  const setSelectedSnippet = useSnippetStore((s) => s.setSelectedSnippet);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [gridCols, setGridCols] = useState(1);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [contextMenu, setContextMenu] = useState<{
    snippet: Snippet;
    x: number;
    y: number;
  } | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const trashDropRef = useDropTarget("snippets-panel", "snippets-panel");
  const setRootRef = useCallback(
    (el: HTMLDivElement | null) => {
      panelRef.current = el;
      trashDropRef.current = el;
    },
    [trashDropRef],
  );

  useEffect(() => {
    // mount eager load: 同時 mount のクエリ重複は store 側で dedup される
    ensureEntriesLoaded();
  }, [ensureEntriesLoaded]);

  useEffect(() => {
    const el = listContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      setGridCols(w >= 700 ? 3 : w >= 400 ? 2 : 1);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Reset focused index when filter/sort changes
  useEffect(() => {
    setFocusedIndex(-1);
  }, [sourceFilter, sortOrder]);

  // 矢印移動でフォーカス中のカードへ実 DOM フォーカスを移す。カードは
  // role="group" + aria-label=タイトル なので、スクリーンリーダーが
  // 「<タイトル>, グループ」と読み上げる (DOM フォーカスがパネル root に
  // 留まる従来モデルでは SR が各カードに到達できなかった)。カードは
  // tabIndex=-1 で Tab 連打の tab-stop 爆発を避けつつ矢印で roving 到達する。
  useEffect(() => {
    if (focusedIndex < 0) return;
    const el = listContainerRef.current?.querySelector<HTMLElement>(
      `[data-snippet-index="${focusedIndex}"]`,
    );
    el?.focus();
  }, [focusedIndex]);

  // 外部からの requestSelectEntry(id) によるエントリ選択
  useEffect(() => {
    if (!pendingEntryId) return;
    const snippet = entries.find((s) => s.id === pendingEntryId);
    if (!snippet) return;
    setSelectedSnippet(snippet);
    clearPendingEntry();
  }, [pendingEntryId, entries, clearPendingEntry, setSelectedSnippet]);

  const filteredEntries = useMemo(() => {
    let filtered = entries;
    if (sourceFilter === "from-chat") {
      filtered = filtered.filter((s) => s.sourceChatMessageId != null);
    } else if (sourceFilter === "from-editor") {
      filtered = filtered.filter(
        (s) => s.sourceChatMessageId == null && s.sceneId != null,
      );
    } else if (sourceFilter === "manual") {
      filtered = filtered.filter(
        (s) => s.sourceChatMessageId == null && s.sceneId == null,
      );
    }

    switch (sortOrder) {
      case "recent":
        return [...filtered].sort((a, b) =>
          compareInstantValues(a.createdAt, b.createdAt, "descending"),
        );
      case "oldest":
        return [...filtered].sort((a, b) =>
          compareInstantValues(a.createdAt, b.createdAt),
        );
      case "title-asc":
        return [...filtered].sort((a, b) => a.title.localeCompare(b.title));
      case "most-used":
        return [...filtered].sort(
          (a, b) => (b.usageCount ?? 0) - (a.usageCount ?? 0),
        );
      default:
        return filtered;
    }
  }, [entries, sourceFilter, sortOrder]);

  const handleNew = useCallback(async () => {
    try {
      const created = await create({
        title: t("snippets.newSnippet"),
        content: "",
      });
      setSelectedSnippet(created);
    } catch {
      // error toast shown by store
    }
  }, [create, t, setSelectedSnippet]);

  const copySnippet = useCallback(
    async (snippet: Snippet) => {
      try {
        await copyWithAttribution(
          snippet.content,
          (snippet.contentSource as AuthorshipSource) ?? "human",
        );
        toast.success(t("snippets.copied"));
      } catch {
        toast.error(t("snippets.copyFailed"));
      }
    },
    [t],
  );

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent) => {
      // Don't intercept keys while typing in an input/textarea or contenteditable
      // (e.g. detail title input or the Tiptap content editor).
      const target = e.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA"
      ) {
        return;
      }

      // Ctrl+V: paste from clipboard
      if (matchesMod(e) && e.key === "v") {
        e.preventDefault();
        try {
          const text = await navigator.clipboard.readText();
          if (!text.trim()) return;
          const created = await create({
            title: text.slice(0, 40).trim() || t("snippets.clipboard"),
            content: text,
          });
          setSelectedSnippet(created);
        } catch {
          // clipboard permission denied - silently ignore
        }
        return;
      }

      // Ctrl+F: focus search
      if (matchesMod(e) && e.key === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      const total = filteredEntries.length;

      if (e.key === "ArrowDown" && total > 0) {
        e.preventDefault();
        setFocusedIndex((prev) => (prev + 1) % total);
        return;
      }

      if (e.key === "ArrowUp" && total > 0) {
        e.preventDefault();
        setFocusedIndex((prev) => (prev - 1 + total) % total);
        return;
      }

      if (matchesMod(e) && e.key === "Enter" && focusedIndex >= 0) {
        e.preventDefault();
        const snippet = filteredEntries[focusedIndex];
        if (snippet) {
          const { insertFromSnippet } = useEditorStore.getState();
          const source = (snippet.contentSource as "ai" | "human") ?? "human";
          const success = insertFromSnippet(
            snippet.id,
            snippet.content,
            source,
            null,
            undefined,
            snippet.sourceChatMessageId,
          );
          if (success) {
            void incrementUsageCount(snippet.id);
            toast.success(t("snippets.inserted"));
          }
        }
        return;
      }

      if (e.key === "Enter" && focusedIndex >= 0) {
        e.preventDefault();
        const snippet = filteredEntries[focusedIndex];
        if (snippet) {
          setSelectedSnippet((prev) =>
            prev?.id === snippet.id ? null : snippet,
          );
        }
        return;
      }

      if (e.key === "Delete" && focusedIndex >= 0) {
        e.preventDefault();
        const snippet = filteredEntries[focusedIndex];
        if (snippet) setDeleteConfirmId(snippet.id);
        return;
      }

      // Ctrl/Cmd+C: フォーカス中スニペットをコピー。インラインのコピーボタンは
      // tabIndex=-1 にしたため、明示的なキーボード経路をここで保証する
      // (カードの native copy イベントは webview 依存で不確実なため頼らない)。
      // ただしテキスト選択中はネイティブのコピーを尊重する。
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "c" &&
        focusedIndex >= 0
      ) {
        const selection = window.getSelection?.();
        if (selection && selection.toString().length > 0) return;
        const snippet = filteredEntries[focusedIndex];
        if (!snippet) return;
        e.preventDefault();
        await copySnippet(snippet);
        return;
      }

      if (e.key === "Escape") {
        if (searchQuery) {
          search("");
          if (searchInputRef.current) searchInputRef.current.value = "";
        } else {
          setSelectedSnippet(null);
          setFocusedIndex(-1);
        }
      }
    },
    [
      filteredEntries,
      focusedIndex,
      searchQuery,
      create,
      search,
      incrementUsageCount,
      copySnippet,
      t,
      setSelectedSnippet,
    ],
  );

  const handleSearchChange = useCallback(
    (value: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        search(value);
      }, 300);
    },
    [search],
  );

  const handleDragStart = useCallback(
    (
      e: React.DragEvent,
      snippet: {
        id: string;
        content: string;
        contentSource?: string | null;
        sourceChatMessageId?: string | null;
      },
    ) => {
      e.dataTransfer.setData("text/plain", snippet.content);
      e.dataTransfer.setData(
        "application/x-grimodex-snippet",
        JSON.stringify({
          id: snippet.id,
          content: snippet.content,
          source: (snippet.contentSource as "ai" | "human") ?? "human",
          originalContent: null,
          sourceChatMessageId: snippet.sourceChatMessageId ?? null,
        }),
      );
    },
    [],
  );

  const handleSave = useCallback(
    (
      id: string,
      data: Partial<{ title: string; content: string }>,
      options: {
        baseVersion: number;
        timelapseDocument?: TimelapseDocumentRef;
      },
    ) => update(id, data, options),
    [update],
  );

  const initiateDelete = useCallback((id: string) => {
    setDeleteConfirmId(id);
  }, []);

  const confirmDelete = useCallback(async () => {
    const id = deleteConfirmId;
    if (!id) return;
    setDeleteConfirmId(null);
    await remove(id);
    setSelectedSnippet((prev) => (prev?.id === id ? null : prev));
    const tabState = useTabStore.getState();
    if (tabState.tabs.some((t) => t.nodeId === id)) tabState.closeTab(id);
    if (tabState.secondaryTabs.some((t) => t.nodeId === id))
      tabState.closeSecondaryTab(id);
  }, [deleteConfirmId, remove, setSelectedSnippet]);

  return (
    <div
      ref={setRootRef}
      data-droptarget-id="snippets-panel"
      className="relative flex h-full flex-col data-[trash-drop-hover=true]:ring-2 data-[trash-drop-hover=true]:ring-primary/60 data-[trash-drop-hover=true]:ring-inset"
      data-testid="snippet-panel"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <ResizablePanelGroup orientation="horizontal">
        {/* Left Panel: List */}
        <ResizablePanel defaultSize={40} minSize={25}>
          <div
            data-testid="snippet-list-panel"
            className="flex h-full flex-col"
          >
            {/* Header */}
            <PanelHeader
              panelId="snippets"
              count={
                <span data-testid="snippet-count">
                  {filteredEntries.length}
                </span>
              }
              actions={
                <button
                  type="button"
                  data-testid="snippet-new-button"
                  onClick={() => void handleNew()}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground active:scale-[0.97] transition-transform duration-75"
                  title={t("snippets.newSnippet")}
                  aria-label={t("snippets.newSnippet")}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              }
            />

            {/* Search */}
            <div className="border-b border-border p-2">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={searchInputRef}
                  data-testid="snippet-search-input"
                  type="text"
                  defaultValue={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      search("");
                      e.currentTarget.value = "";
                      e.currentTarget.blur();
                    }
                  }}
                  placeholder={t("snippets.searchPlaceholder")}
                  className="w-full rounded-md border border-input bg-background pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>

            {/* Filter bar */}
            <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
              {SOURCE_FILTER_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  data-testid={`snippet-filter-${opt.value}`}
                  onClick={() => setSourceFilter(opt.value)}
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors active:scale-[0.97] transition-transform duration-75 ${
                    sourceFilter === opt.value
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
              <select
                data-testid="snippet-sort-selector"
                value={sortOrder}
                onChange={(e) =>
                  setSortOrder(e.target.value as SnippetSortOrder)
                }
                className="ml-auto rounded border border-input bg-background px-1 py-0.5 text-[10px]"
                title={t("snippets.sortOrder")}
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex-1 overflow-y-auto">
              {isLoading && (
                <GridCardSkeletonList
                  testId="snippet-loading"
                  columns={gridCols}
                  count={gridCols * 2}
                />
              )}

              {!isLoading && filteredEntries.length === 0 && (
                <div
                  data-testid="snippet-empty-state"
                  className="flex h-full items-center justify-center"
                >
                  <p className="text-xs text-muted-foreground">
                    {t("snippets.empty")}
                  </p>
                </div>
              )}

              {!isLoading && filteredEntries.length > 0 && (
                <div
                  ref={listContainerRef}
                  className="p-2"
                  style={{
                    display: "grid",
                    gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
                    gap: "4px",
                  }}
                >
                  {filteredEntries.map((snippet, idx) => {
                    const sceneName = snippet.sceneId
                      ? nodes.find((n) => n.id === snippet.sceneId)?.title
                      : null;
                    return (
                      <div
                        key={snippet.id}
                        data-testid={`snippet-item-${snippet.id}`}
                        data-snippet-index={idx}
                        // role="group"(構造ロール)にすることで nested アクション
                        // ボタンを含んでも nested-interactive 違反にならず、aria-label で
                        // カード名を与えられる。矢印移動でこのカードへ DOM フォーカスが
                        // 移り(上の effect)、SR が「<タイトル>, グループ」と読む。
                        // aria-current で選択状態(role 非依存の global 属性)。
                        // tabIndex=-1: Tab 連打の tab-stop 爆発を避け、矢印で roving 到達。
                        role="group"
                        aria-label={snippet.title}
                        aria-current={
                          selectedSnippet?.id === snippet.id
                            ? "true"
                            : undefined
                        }
                        tabIndex={-1}
                        draggable="true"
                        onClick={() => {
                          setSelectedSnippet(snippet);
                          setFocusedIndex(idx);
                        }}
                        onDoubleClick={() => {
                          void copySnippet(snippet);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setContextMenu({
                            snippet,
                            x: e.clientX,
                            y: e.clientY,
                          });
                        }}
                        onDragStart={(e) =>
                          handleDragStart(e, {
                            id: snippet.id,
                            content: snippet.content,
                            contentSource: snippet.contentSource,
                          })
                        }
                        onCopy={(e) =>
                          handleCopyWithAttribution(
                            e,
                            (snippet.contentSource as AuthorshipSource) ??
                              "human",
                          )
                        }
                        className={`group flex cursor-grab items-start gap-1 rounded-md border border-border p-2 hover:bg-accent/50 active:cursor-grabbing ${
                          selectedSnippet?.id === snippet.id ? "bg-accent" : ""
                        } ${focusedIndex === idx ? "ring-1 ring-ring" : ""}`}
                      >
                        <GripVertical className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground opacity-50" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-1">
                            <h4 className="truncate text-xs font-medium text-foreground">
                              {snippet.title}
                            </h4>
                            <div className="flex shrink-0 gap-0.5">
                              <button
                                type="button"
                                data-testid={`snippet-copy-${snippet.id}`}
                                aria-label={t("common.copy")}
                                // タブ順から外す (カード自体が roving の到達点)。
                                // キーボードでは Ctrl+C(カードの onCopy) で代替。
                                tabIndex={-1}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void copySnippet(snippet);
                                }}
                                className="rounded p-0.5 text-muted-foreground opacity-0 transition-transform duration-75 hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100 group-focus-within:opacity-100 active:scale-[0.97]"
                              >
                                <Copy className="h-3 w-3" />
                              </button>
                              <button
                                type="button"
                                data-testid={`snippet-delete-${snippet.id}`}
                                aria-label={t("common.delete")}
                                // タブ順から外す。キーボードでは Delete キーで代替。
                                tabIndex={-1}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  initiateDelete(snippet.id);
                                }}
                                className="rounded p-0.5 text-muted-foreground opacity-0 transition-transform duration-75 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100 group-focus-within:opacity-100 active:scale-[0.97]"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                          <SnippetCardBody snippet={snippet} />
                          {sceneName && (
                            <button
                              type="button"
                              tabIndex={-1}
                              onClick={(e) => {
                                e.stopPropagation();
                                setActiveScene(snippet.sceneId!);
                              }}
                              className="mt-1 block text-[10px] text-muted-foreground underline hover:text-foreground"
                            >
                              {sceneName}
                            </button>
                          )}
                          {snippet.tagsCache && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {(
                                JSON.parse(snippet.tagsCache) as {
                                  name: string;
                                  color: string | null;
                                }[]
                              ).map((tag) => (
                                <span
                                  key={tag.name}
                                  className="inline-block rounded-full px-1.5 py-0.5 text-[10px] text-white"
                                  style={{
                                    backgroundColor: tag.color ?? "#888888",
                                  }}
                                >
                                  {tag.name}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Right Panel: Detail */}
        <ResizablePanel defaultSize={60} minSize={30}>
          <div data-testid="snippet-detail-panel" className="h-full">
            {selectedSnippet ? (
              <SnippetDetailContent
                key={selectedSnippet.id}
                snippet={selectedSnippet}
                onSave={handleSave}
                onDelete={initiateDelete}
              />
            ) : (
              <div
                data-testid="snippet-detail-placeholder"
                className="flex h-full items-center justify-center"
              >
                <p className="text-xs text-muted-foreground">
                  {t("snippets.selectPrompt")}
                </p>
              </div>
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      {deleteConfirmId && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80">
          <div className="w-72 rounded-lg border border-border bg-popover p-4 shadow-xl">
            <p className="mb-1 text-sm font-medium">
              {t("common.deleteConfirmTitle")}
            </p>
            <p className="mb-4 text-xs text-muted-foreground">
              {t("snippets.deleteConfirmDesc", {
                name:
                  entries.find((e) => e.id === deleteConfirmId)?.title ?? "",
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

      {contextMenu && (
        <SnippetContextMenu
          snippet={contextMenu.snippet}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onEdit={(snippet) => setSelectedSnippet(snippet)}
          onDelete={initiateDelete}
        />
      )}
    </div>
  );
}
