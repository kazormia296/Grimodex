import { useTranslation } from "react-i18next";
import { Plus, ChevronsUpDown, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { PanelMenu } from "./PanelMenu";
import type { NodeType } from "./treeStore";

const CREATE_OPTIONS: Array<{ type: NodeType; labelKey: string } | null> = [
  { type: "scene", labelKey: "scenes.newScene" },
  { type: "note", labelKey: "scenes.newNote" },
  null,
  { type: "folder", labelKey: "scenes.newFolder" },
];

interface ScenesToolbarProps {
  onCreate: (type: NodeType) => void;
  onToggleAll: () => void;
}

export function ScenesToolbar({ onCreate, onToggleAll }: ScenesToolbarProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-2 py-1.5">
      <span className="text-xs font-semibold text-foreground">Scenes</span>
      <div className="flex items-center gap-0.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              title={t("scenes.create")}
              className="text-muted-foreground hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[140px]">
            {CREATE_OPTIONS.map((opt, i) =>
              opt === null ? (
                <DropdownMenuSeparator key={`sep-${i}`} />
              ) : (
                <DropdownMenuItem
                  key={opt.type}
                  onSelect={(e) => {
                    e.preventDefault();
                    onCreate(opt.type);
                  }}
                >
                  {t(opt.labelKey)}
                </DropdownMenuItem>
              ),
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon-xs"
          title={t("scenes.expandCollapse")}
          onClick={onToggleAll}
          className="text-muted-foreground hover:text-foreground"
        >
          <ChevronsUpDown className="h-3.5 w-3.5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              title={t("scenes.panelMenu")}
              className="text-muted-foreground hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <PanelMenu />
        </DropdownMenu>
      </div>
    </div>
  );
}
