import { useState } from "react";
import { Plus, Search, MoreVertical, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import { useGridStore } from "./gridStore";
import { GridContainerSelector } from "./GridContainerSelector";

interface Props {
  containerId: string | null;
  projectId: string;
  chapterCount: number;
  onContainerChange: (id: string | null) => void;
  onTogglePanelMenu: () => void;
}

export function GridHeader({
  containerId,
  projectId,
  chapterCount,
  onContainerChange,
  onTogglePanelMenu,
}: Props) {
  const { t } = useTranslation();
  const [searchOpen, setSearchOpen] = useState(false);
  const createNode = useTreeStore((s) => s.createNode);
  const searchQuery = useGridStore((s) => s.searchQuery);
  const setSearchQuery = useGridStore((s) => s.setSearchQuery);

  async function addChapter() {
    await createNode({ nodeType: "folder", parentId: containerId });
  }

  function toggleSearch() {
    if (searchOpen) {
      setSearchQuery("");
    }
    setSearchOpen((v) => !v);
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
        <GridContainerSelector
          containerId={containerId}
          projectId={projectId}
          onSelect={onContainerChange}
        />

        <span className="ml-1 text-[11px] text-muted-foreground">
          {t("grid.header.chapterCount", "{{count}} 章", {
            count: chapterCount,
          })}
        </span>

        <div className="flex-1" />

        <button
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] hover:bg-accent transition-colors"
          onClick={() => void addChapter()}
          title={t("grid.header.newChapter", "章を追加")}
        >
          <Plus className="h-3 w-3" />
          {t("grid.header.newChapter", "章を追加")}
        </button>

        <button
          className="rounded p-1 hover:bg-accent transition-colors"
          onClick={toggleSearch}
          title={t("grid.header.search", "検索")}
          aria-pressed={searchOpen}
        >
          <Search className="h-3.5 w-3.5" />
        </button>

        <button
          className="rounded p-1 hover:bg-accent transition-colors"
          onClick={onTogglePanelMenu}
          title={t("grid.header.panelMenu", "メニュー")}
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
      </div>

      {searchOpen && (
        <div className="flex items-center gap-1 border-t px-3 py-1.5">
          <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={t(
              "grid.header.searchPlaceholder",
              "シーン名・Synopsis・Beat・Codex を検索…",
            )}
            className="flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/50"
          />
          {searchQuery && (
            <button
              className="shrink-0 rounded p-0.5 hover:bg-accent"
              onClick={() => setSearchQuery("")}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
