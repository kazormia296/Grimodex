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
import { PanelHeader } from "@/features/layout/PanelHeader";
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
    <PanelHeader
      panelId="scenes"
      actions={
        <>
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
            <DropdownMenuContent
              align="end"
              className="min-w-[140px]"
              // Don't return focus to the "+" trigger on close — the newly
              // created node opens an inline rename input that takes focus via
              // autoFocus. Letting Radix restore focus to the trigger would
              // immediately blur the input and finishEdit() would exit rename
              // mode before the user can type.
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              {CREATE_OPTIONS.map((opt, i) =>
                opt === null ? (
                  <DropdownMenuSeparator key={`sep-${i}`} />
                ) : (
                  <DropdownMenuItem
                    key={opt.type}
                    onSelect={() => onCreate(opt.type)}
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
        </>
      }
    />
  );
}
