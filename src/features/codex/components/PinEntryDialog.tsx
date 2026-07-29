import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search } from "lucide-react";
import { AnimatedPopover } from "@/components/ui/animated-popover";
import { useTranslation } from "react-i18next";
import { useCodexStore } from "@/features/codex/codexStore";
import type { CodexSortOrder } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import type {
  SnippetSourceFilter,
  SnippetSortOrder,
} from "@/features/snippets/snippetStore";
import { getChildrenFromArray } from "@/features/codex/childrenBudget";
import type { CodexEntry } from "@/features/codex/api";
import type { Snippet } from "@/features/snippets/api";
import {
  EntryCardBody,
  parseTags,
} from "@/features/codex/components/EntryCard";
import { SnippetCardBody } from "@/features/snippets/components/SnippetCardBody";
import { getTypeLabel } from "@/features/chat/utils/typeLabels";
import { sortEntries, CODEX_SORT_OPTIONS } from "@/features/codex/codexSort";
import { TagFilterBar } from "@/features/codex/components/TagFilterBar";
import type { CodexType } from "@/features/codex/typeApi";
import { listCodexTypes, ensureBuiltinTypes } from "@/features/codex/typeApi";
import {
  getCurrentProjectId,
  getCurrentProjectLanguage,
} from "@/features/project/projectStore";
import { compareInstantValues } from "@/lib/time";

const DIALOG_CODEX_SORT_OPTIONS = CODEX_SORT_OPTIONS.filter(
  (o) => o.value !== "most-referenced",
);

const SNIPPET_SOURCE_OPTIONS: { value: SnippetSourceFilter; key: string }[] = [
  { value: "all", key: "snippets.filterAll" },
  { value: "from-chat", key: "snippets.filterFromChat" },
  { value: "from-editor", key: "snippets.filterFromEditor" },
  { value: "manual", key: "snippets.filterManual" },
];

const SNIPPET_SORT_OPTIONS: { value: SnippetSortOrder; key: string }[] = [
  { value: "recent", key: "snippets.sortRecent" },
  { value: "oldest", key: "snippets.sortOldest" },
  { value: "title-asc", key: "snippets.sortTitleAsc" },
  { value: "most-used", key: "snippets.sortMostUsed" },
];

function PinCodexList({
  entries,
  allEntries,
  pinnedIds,
  lockedIds,
  withChildrenIds,
  onPin,
  onUnpin,
  onToggleChildren,
  selectionMode = "multi",
  selectedId,
  onSelect,
}: {
  entries: CodexEntry[];
  allEntries: CodexEntry[];
  pinnedIds: Set<string>;
  lockedIds: ReadonlySet<string>;
  withChildrenIds?: Set<string>;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  onToggleChildren?: (id: string, withChildren: boolean) => void;
  selectionMode?: "multi" | "single";
  selectedId?: string | null;
  onSelect?: (entry: CodexEntry) => void;
}) {
  const { t } = useTranslation();

  if (entries.length === 0) {
    return (
      <p className="py-4 text-center text-xs text-muted-foreground">
        {t("codex.noResults")}
      </p>
    );
  }

  if (selectionMode === "single") {
    return (
      <div className="max-h-52 overflow-y-auto">
        {entries.map((entry) => {
          const isSelected = selectedId === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              data-testid={`pin-entry-pick-${entry.id}`}
              data-selected={isSelected || undefined}
              onClick={() => onSelect?.(entry)}
              className={`block w-full border-b border-border px-2 py-1.5 text-left last:border-0 hover:bg-accent ${
                isSelected ? "bg-accent" : ""
              }`}
            >
              <EntryCardBody entry={entry} />
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="max-h-52 overflow-y-auto">
      {entries.map((entry) => {
        const isLocked = lockedIds.has(entry.id);
        const isPinned = pinnedIds.has(entry.id) || isLocked;
        const hasChildren =
          getChildrenFromArray(entry.id, allEntries).length > 0;
        const isWithChildren = withChildrenIds?.has(entry.id) ?? false;

        return (
          <div key={entry.id} className="border-b border-border last:border-0">
            <label
              className={`flex items-start gap-2 rounded px-2 py-1.5 ${
                isLocked
                  ? "cursor-not-allowed opacity-60"
                  : "cursor-pointer hover:bg-accent"
              }`}
            >
              <input
                type="checkbox"
                data-testid={`pin-entry-toggle-${entry.id}`}
                checked={isPinned}
                disabled={isLocked}
                onChange={() => {
                  if (isLocked) return;
                  if (isPinned) onUnpin(entry.id);
                  else onPin(entry.id);
                }}
                className="mt-1 shrink-0 rounded"
              />
              <div className="min-w-0 flex-1">
                <EntryCardBody entry={entry} />
              </div>
            </label>
            {isPinned &&
              !isLocked &&
              hasChildren &&
              withChildrenIds &&
              onToggleChildren && (
                <label className="ml-8 flex cursor-pointer items-center gap-1.5 px-2 pb-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={isWithChildren}
                    onChange={(e) =>
                      onToggleChildren(entry.id, e.target.checked)
                    }
                    className="rounded"
                  />
                  {t("chat.context.includeChildren")}
                </label>
              )}
          </div>
        );
      })}
    </div>
  );
}

function PinSnippetList({
  snippets,
  pinnedSnippetIds,
  lockedIds,
  onPin,
  onUnpin,
}: {
  snippets: Snippet[];
  pinnedSnippetIds: Set<string>;
  lockedIds: ReadonlySet<string>;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
}) {
  const { t } = useTranslation();

  if (snippets.length === 0) {
    return (
      <p className="py-4 text-center text-xs text-muted-foreground">
        {t("codex.noResults")}
      </p>
    );
  }

  return (
    <div className="max-h-52 overflow-y-auto">
      {snippets.map((snippet) => {
        const isLocked = lockedIds.has(snippet.id);
        const isPinned = pinnedSnippetIds.has(snippet.id) || isLocked;

        return (
          <label
            key={snippet.id}
            className={`flex items-start gap-2 rounded border-b border-border px-2 py-1.5 last:border-0 ${
              isLocked
                ? "cursor-not-allowed opacity-60"
                : "cursor-pointer hover:bg-accent"
            }`}
          >
            <input
              type="checkbox"
              checked={isPinned}
              disabled={isLocked}
              onChange={() => {
                if (isLocked) return;
                if (isPinned) onUnpin(snippet.id);
                else onPin(snippet.id);
              }}
              className="mt-0.5 shrink-0 rounded"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-foreground">
                {snippet.title}
              </p>
              <SnippetCardBody snippet={snippet} />
            </div>
          </label>
        );
      })}
    </div>
  );
}

const EMPTY_PIN_SET: Set<string> = new Set();

export interface PinEntryDialogProps {
  open: boolean;
  /** multi モードのチェック状態。single モードでは不要 */
  pinnedIds?: Set<string>;
  /** focus subject など、checked のまま変更不可にする Codex/Snippet ID。 */
  lockedIds?: ReadonlySet<string>;
  onPin?: (entryId: string, type?: "codex" | "snippet") => void;
  onUnpin?: (entryId: string) => void;
  onClose: () => void;
  containerRef?: React.RefObject<HTMLElement | null>;
  /**
   * When set, the dialog renders in a portal (document.body) with `fixed`
   * positioning anchored below this element. Use this to escape overflow
   * clipping from ancestor scroll containers (e.g. Grid panel).
   */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** Override the dialog title. Defaults to chat.context.pinEntries i18n key. */
  title?: string;
  /** Which tabs to show. Defaults to ["codex", "snippet"]. Single-tab hides the tab bar. */
  tabs?: ("codex" | "snippet")[];
  withChildrenIds?: Set<string>;
  pinnedSnippetIds?: Set<string>;
  onToggleChildren?: (entryId: string, withChildren: boolean) => void;
  /** single: checkbox の代わりに行クリックで onSelect(entry) を呼ぶ（codex タブのみ対応） */
  selectionMode?: "multi" | "single";
  onSelect?: (entry: CodexEntry) => void;
  /** single モードで現在の選択をハイライト */
  selectedId?: string | null;
}

export function PinEntryDialog({
  open,
  pinnedIds = EMPTY_PIN_SET,
  lockedIds = EMPTY_PIN_SET,
  onPin,
  onUnpin,
  onClose,
  containerRef,
  anchorRef,
  title,
  tabs = ["codex", "snippet"],
  withChildrenIds,
  pinnedSnippetIds,
  onToggleChildren,
  selectionMode = "multi",
  onSelect,
  selectedId,
}: PinEntryDialogProps) {
  const { t } = useTranslation();
  const showSnippetTab = tabs.includes("snippet");
  const showCodexTab = tabs.includes("codex");
  const showTabBar = showCodexTab && showSnippetTab;

  const [activeTab, setActiveTab] = useState<"codex" | "snippet">(
    showCodexTab ? "codex" : "snippet",
  );

  // Codex filter state
  const [codexSearch, setCodexSearch] = useState("");
  const [codexFilterType, setCodexFilterType] = useState<string | null>(null);
  const [codexSelectedTags, setCodexSelectedTags] = useState<Set<string>>(
    new Set(),
  );

  // Snippet filter state
  const [snippetSearch, setSnippetSearch] = useState("");
  const [snippetSourceFilter, setSnippetSourceFilter] =
    useState<SnippetSourceFilter>("all");
  const [snippetSortOrder, setSnippetSortOrder] =
    useState<SnippetSortOrder>("recent");

  const entries = useCodexStore((s) => s.entries);
  const loadEntries = useCodexStore((s) => s.loadEntries);
  const codexSortOrder = useCodexStore((s) => s.sortOrder);
  const setCodexSortOrder = useCodexStore((s) => s.setSort);
  const snippetEntries = useSnippetStore((s) => s.entries);
  const loadSnippets = useSnippetStore((s) => s.loadEntries);
  const [codexTypes, setCodexTypes] = useState<CodexType[]>([]);

  useEffect(() => {
    if (!open) return;
    if (useCodexStore.getState().entries.length === 0) loadEntries();
    if (showSnippetTab && useSnippetStore.getState().entries.length === 0)
      loadSnippets();
    ensureBuiltinTypes(getCurrentProjectId(), getCurrentProjectLanguage())
      .then(() => listCodexTypes(getCurrentProjectId()))
      .then(setCodexTypes)
      .catch(() => setCodexTypes([]));
  }, [open, loadEntries, loadSnippets, showSnippetTab]);

  // Portal mode: compute fixed position from anchorRef when opening
  const portalDivRef = useRef<HTMLDivElement>(null);
  const [portalPos, setPortalPos] = useState<{
    left: number;
    top: number;
  } | null>(null);

  useEffect(() => {
    if (!open || !anchorRef?.current) {
      setPortalPos(null);
      return;
    }
    const rect = anchorRef.current.getBoundingClientRect();
    const popoverWidth = 384; // w-96
    const left = Math.max(
      8,
      Math.min(rect.right - popoverWidth, window.innerWidth - popoverWidth - 8),
    );
    setPortalPos({ left, top: rect.bottom + 4 });
  }, [open, anchorRef]);

  // Click-outside for portal mode (containerRef handler in AnimatedPopover is bypassed)
  useEffect(() => {
    if (!open || !anchorRef || !portalPos) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const insidePortal = portalDivRef.current?.contains(target) ?? false;
      const insideAnchor = anchorRef.current?.contains(target) ?? false;
      if (!insidePortal && !insideAnchor) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, anchorRef, portalPos, onClose]);

  const allCodexTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const entry of entries) {
      for (const tag of parseTags(entry.tagsCache)) {
        tagSet.add(tag.name);
      }
    }
    return [...tagSet].sort();
  }, [entries]);

  const uniqueCodexTypes = useMemo(
    () => [...new Set(entries.map((e) => e.type))],
    [entries],
  );

  const filteredCodexEntries = useMemo(() => {
    let filtered = entries;
    if (codexSearch) {
      const q = codexSearch.toLowerCase();
      filtered = filtered.filter((e) => e.name.toLowerCase().includes(q));
    }
    if (codexFilterType) {
      filtered = filtered.filter((e) => e.type === codexFilterType);
    }
    if (codexSelectedTags.size > 0) {
      filtered = filtered.filter((e) => {
        const tags = parseTags(e.tagsCache).map((tag) => tag.name);
        return [...codexSelectedTags].some((tag) => tags.includes(tag));
      });
    }
    if (codexSortOrder === "category") {
      const byType = new Map<string, CodexEntry[]>();
      for (const entry of filtered) {
        if (!byType.has(entry.type)) byType.set(entry.type, []);
        byType.get(entry.type)!.push(entry);
      }
      for (const grp of byType.values()) {
        grp.sort((a, b) => a.name.localeCompare(b.name, "ja"));
      }
      const typeOrder = new Map(
        codexTypes.map((ct, i) => [ct.slug, ct.sortOrder ?? i]),
      );
      return [...byType.entries()]
        .sort(
          ([aSlug], [bSlug]) =>
            (typeOrder.get(aSlug) ?? 9999) - (typeOrder.get(bSlug) ?? 9999),
        )
        .flatMap(([, grp]) => grp);
    }
    return sortEntries(filtered, codexSortOrder);
  }, [
    entries,
    codexSearch,
    codexFilterType,
    codexSelectedTags,
    codexSortOrder,
    codexTypes,
  ]);

  const filteredSnippetEntries = useMemo(() => {
    if (!showSnippetTab) return [];
    let filtered = snippetEntries;
    if (snippetSearch) {
      const q = snippetSearch.toLowerCase();
      filtered = filtered.filter((s) => s.title.toLowerCase().includes(q));
    }
    if (snippetSourceFilter === "from-chat") {
      filtered = filtered.filter((s) => s.sourceChatMessageId != null);
    } else if (snippetSourceFilter === "from-editor") {
      filtered = filtered.filter(
        (s) => s.sourceChatMessageId == null && s.sceneId != null,
      );
    } else if (snippetSourceFilter === "manual") {
      filtered = filtered.filter(
        (s) => s.sourceChatMessageId == null && s.sceneId == null,
      );
    }
    switch (snippetSortOrder) {
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
  }, [
    snippetEntries,
    snippetSearch,
    snippetSourceFilter,
    snippetSortOrder,
    showSnippetTab,
  ]);

  const popover = (
    <AnimatedPopover
      open={open}
      onClose={anchorRef ? undefined : onClose}
      containerRef={anchorRef ? undefined : containerRef}
      className={
        anchorRef
          ? "fixed z-[9999] w-96 rounded-lg border border-border bg-popover p-4 shadow-lg"
          : "absolute right-0 top-full z-50 mt-1 w-96 rounded-lg border border-border bg-popover p-4 shadow-lg"
      }
      style={portalPos ?? undefined}
    >
      <div ref={portalDivRef}>
        <h3 className="mb-3 text-sm font-semibold">
          {title ?? t("chat.context.pinEntries")}
        </h3>

        {showTabBar && (
          <div className="mb-3 flex overflow-hidden rounded-md border border-border">
            <button
              type="button"
              onClick={() => setActiveTab("codex")}
              className={`flex-1 px-3 py-1 text-xs font-medium transition-colors ${
                activeTab === "codex"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:bg-accent"
              }`}
            >
              Codex
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("snippet")}
              className={`flex-1 px-3 py-1 text-xs font-medium transition-colors ${
                activeTab === "snippet"
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:bg-accent"
              }`}
            >
              Snippet
            </button>
          </div>
        )}

        {(!showTabBar || activeTab === "codex") && showCodexTab ? (
          entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("chat.context.noCodexEntries")}
            </p>
          ) : (
            <>
              <div className="relative mb-2">
                <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={codexSearch}
                  onChange={(e) => setCodexSearch(e.target.value)}
                  placeholder={t("codex.searchPlaceholder")}
                  aria-label={t("codex.searchPlaceholder")}
                  className="w-full rounded border border-input bg-background py-1 pl-6 pr-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>

              <div className="mb-2 flex items-center gap-1.5">
                <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={() => setCodexFilterType(null)}
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                      codexFilterType === null
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    {t("codex.filterAll")}
                  </button>
                  {uniqueCodexTypes.map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() =>
                        setCodexFilterType(
                          codexFilterType === type ? null : type,
                        )
                      }
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        codexFilterType === type
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:bg-accent"
                      }`}
                    >
                      {getTypeLabel(type)}
                    </button>
                  ))}
                </div>
                <select
                  value={codexSortOrder}
                  onChange={(e) =>
                    setCodexSortOrder(e.target.value as CodexSortOrder)
                  }
                  title={t("codex.sortOrderTitle")}
                  className="shrink-0 rounded border border-input bg-background px-1 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {DIALOG_CODEX_SORT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {t(opt.key)}
                    </option>
                  ))}
                </select>
              </div>

              {allCodexTags.length > 0 && (
                <div className="mb-2">
                  <TagFilterBar
                    allTags={allCodexTags}
                    selectedTags={codexSelectedTags}
                    onToggle={(tag) =>
                      setCodexSelectedTags((prev) => {
                        const next = new Set(prev);
                        if (next.has(tag)) next.delete(tag);
                        else next.add(tag);
                        return next;
                      })
                    }
                    onClear={() => setCodexSelectedTags(new Set())}
                  />
                </div>
              )}

              <PinCodexList
                entries={filteredCodexEntries}
                allEntries={entries}
                pinnedIds={pinnedIds}
                lockedIds={lockedIds}
                withChildrenIds={withChildrenIds}
                onPin={(id) => onPin?.(id, "codex")}
                onUnpin={(id) => onUnpin?.(id)}
                onToggleChildren={onToggleChildren}
                selectionMode={selectionMode}
                selectedId={selectedId}
                onSelect={onSelect}
              />
            </>
          )
        ) : showTabBar && activeTab === "snippet" && showSnippetTab ? (
          snippetEntries.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("chat.context.noSnippets")}
            </p>
          ) : (
            <>
              <div className="relative mb-2">
                <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={snippetSearch}
                  onChange={(e) => setSnippetSearch(e.target.value)}
                  placeholder={t("snippets.searchPlaceholder")}
                  aria-label={t("snippets.searchPlaceholder")}
                  className="w-full rounded border border-input bg-background py-1 pl-6 pr-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>

              <div className="mb-2 flex items-center gap-1.5">
                <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                  {SNIPPET_SOURCE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setSnippetSourceFilter(opt.value)}
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        snippetSourceFilter === opt.value
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground hover:bg-accent"
                      }`}
                    >
                      {t(opt.key)}
                    </button>
                  ))}
                </div>
                <select
                  value={snippetSortOrder}
                  onChange={(e) =>
                    setSnippetSortOrder(e.target.value as SnippetSortOrder)
                  }
                  title={t("snippets.sortOrder")}
                  className="shrink-0 rounded border border-input bg-background px-1 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {SNIPPET_SORT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {t(opt.key)}
                    </option>
                  ))}
                </select>
              </div>

              <PinSnippetList
                snippets={filteredSnippetEntries}
                pinnedSnippetIds={pinnedSnippetIds ?? new Set()}
                lockedIds={lockedIds}
                onPin={(id) => onPin?.(id, "snippet")}
                onUnpin={(id) => onUnpin?.(id)}
              />
            </>
          )
        ) : null}
      </div>
    </AnimatedPopover>
  );

  if (anchorRef && portalPos) {
    return createPortal(popover, document.body);
  }
  return popover;
}
