import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Plus, ChevronsUpDown, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

interface ScenesToolbarProps {
  showPanelMenu: boolean;
  createBtnRef: RefObject<HTMLButtonElement | null>;
  panelMenuBtnRef: RefObject<HTMLButtonElement | null>;
  onOpenCreateMenu: () => void;
  onOpenPanelMenu: () => void;
  onToggleAll: () => void;
}

export function ScenesToolbar({
  showPanelMenu,
  createBtnRef,
  panelMenuBtnRef,
  onOpenCreateMenu,
  onOpenPanelMenu,
  onToggleAll,
}: ScenesToolbarProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-2 py-1.5">
      <span className="text-xs font-semibold text-foreground">Scenes</span>
      <div className="flex items-center gap-0.5">
        <button
          ref={createBtnRef}
          type="button"
          title={t("scenes.create")}
          onClick={onOpenCreateMenu}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.97] transition-transform duration-75"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title={t("scenes.expandCollapse")}
          onClick={onToggleAll}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.97] transition-transform duration-75"
        >
          <ChevronsUpDown className="h-3.5 w-3.5" />
        </button>
        <button
          ref={panelMenuBtnRef}
          type="button"
          title={t("scenes.panelMenu")}
          onClick={onOpenPanelMenu}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.97] transition-transform duration-75",
            showPanelMenu && "bg-accent text-foreground",
          )}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
