import { useRef, useState } from "react";
import {
  Search,
  MoreVertical,
  X,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useGridStore } from "./gridStore";
import { GridContainerSelector } from "./GridContainerSelector";
import { GridActionsMenu } from "./GridActionsMenu";

interface Props {
  containerId: string | null;
  projectId: string;
  chapterCount: number;
  /** All nested folder IDs visible in the current Grid view (for collapse-all). */
  nestedFolderIds: string[];
  onContainerChange: (id: string | null) => void;
  toolbarOpen: boolean;
  onToggleToolbar: () => void;
  onManageLabels?: () => void;
}

export function GridHeader({
  containerId,
  projectId,
  chapterCount,
  nestedFolderIds,
  onContainerChange,
  toolbarOpen,
  onToggleToolbar,
  onManageLabels,
}: Props) {
  const { t } = useTranslation();
  const [searchOpen, setSearchOpen] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchQuery = useGridStore((s) => s.searchQuery);
  const setSearchQuery = useGridStore((s) => s.setSearchQuery);
  const collapsedFolderIds = useGridStore((s) => s.collapsedFolderIds);
  const expandAllFolders = useGridStore((s) => s.expandAllFolders);
  const collapseAllFolders = useGridStore((s) => s.collapseAllFolders);

  const anyCollapsed = collapsedFolderIds.size > 0;
  const hasNestedFolders = nestedFolderIds.length > 0;

  function handleToggleAll() {
    if (anyCollapsed) {
      expandAllFolders();
    } else {
      collapseAllFolders(nestedFolderIds);
    }
  }

  function toggleSearch() {
    if (searchOpen) {
      setSearchQuery("");
      setSearchOpen(false);
    } else {
      setSearchOpen(true);
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }

  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setSearchQuery("");
      setSearchOpen(false);
    }
  }

  return (
    <div className="shrink-0 border-b">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {t("grid.header.kicker", "Grid")}
        </span>
        <span className="text-muted-foreground/40">/</span>

        <GridContainerSelector
          containerId={containerId}
          projectId={projectId}
          onSelect={onContainerChange}
        />

        <span className="ml-1 font-mono text-[10px] text-muted-foreground">
          {t("grid.header.chapterCount", "{{count}} 章", {
            count: chapterCount,
          })}
        </span>

        <div className="flex-1" />

        {searchOpen ? (
          <div className="flex items-center gap-1 rounded border border-input bg-background px-2 py-1">
            <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={t(
                "grid.header.searchPlaceholder",
                "シーン名・Synopsis・Beat・Codex を検索…",
              )}
              className="w-48 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/50"
            />
            <button
              className="shrink-0 rounded p-0.5 hover:bg-accent"
              onClick={toggleSearch}
              aria-label={t("grid.header.closeSearch", "検索を閉じる")}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <button
            className="rounded p-1 hover:bg-accent transition-colors"
            onClick={toggleSearch}
            title={t("grid.header.search", "検索")}
            aria-pressed={searchOpen}
          >
            <Search className="h-3.5 w-3.5" />
          </button>
        )}

        {hasNestedFolders && (
          <button
            className="rounded p-1 hover:bg-accent transition-colors"
            onClick={handleToggleAll}
            title={
              anyCollapsed
                ? t("grid.header.expandAll", "全て展開")
                : t("grid.header.collapseAll", "全て折りたたむ")
            }
            aria-label={
              anyCollapsed
                ? t("grid.header.expandAll", "全て展開")
                : t("grid.header.collapseAll", "全て折りたたむ")
            }
          >
            {anyCollapsed ? (
              <ChevronsUpDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronsDownUp className="h-3.5 w-3.5" />
            )}
          </button>
        )}

        <button
          className={cn(
            "inline-flex items-center gap-1 rounded border px-2 py-1 font-mono text-[10.5px] tracking-wider transition-colors",
            toolbarOpen
              ? "border-border bg-accent text-foreground"
              : "border-border/60 text-muted-foreground hover:text-foreground hover:bg-accent/50",
          )}
          onClick={onToggleToolbar}
          title={
            toolbarOpen
              ? t("grid.header.hideToolbar", "表示設定を閉じる")
              : t("grid.header.showToolbar", "表示設定")
          }
          aria-pressed={toolbarOpen}
        >
          {t("grid.header.displayFilter", "表示・フィルタ")}
          {toolbarOpen ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
        </button>

        <div className="relative">
          <button
            ref={menuBtnRef}
            className="rounded border border-border/60 p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            onClick={() => setActionsMenuOpen((v) => !v)}
            title={t("grid.header.actionsMenu", "アクション")}
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
          {actionsMenuOpen && (
            <GridActionsMenu
              onClose={() => setActionsMenuOpen(false)}
              anchorRef={menuBtnRef}
              onManageLabels={onManageLabels}
            />
          )}
        </div>
      </div>
    </div>
  );
}
