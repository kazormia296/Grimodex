import { useTranslation } from "react-i18next";
import { Trash2, PanelLeft, Tag, MoreHorizontal } from "lucide-react";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useLabelStore } from "@/features/labels/labelStore";
import { LABEL_PALETTE } from "@/lib/labelPalette";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface Props {
  nodeId: string;
  onDelete: () => void;
}

export function GridCardMenu({ nodeId, onDelete }: Props) {
  const { t } = useTranslation();
  const allLabels = useLabelStore((s) => s.labels);
  const nodeLabels = useLabelStore((s) => s.nodeLabels);
  const assignedIds = nodeLabels[nodeId] ?? [];

  function showInScenes() {
    useLayoutStore.getState().showPanel("scenes");
  }

  async function handleToggleLabel(labelId: string) {
    const current = useLabelStore.getState().nodeLabels[nodeId] ?? [];
    const next = current.includes(labelId)
      ? current.filter((id) => id !== labelId)
      : [...current, labelId];
    await useLabelStore.getState().setNodeLabels(nodeId, next);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
          data-testid="grid-card-menu-btn"
          title={t("grid.card.menuLabel", "メニュー")}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[160px]"
        onClick={(e) => e.stopPropagation()}
      >
        <DropdownMenuItem onSelect={showInScenes}>
          <PanelLeft className="h-3.5 w-3.5" />
          {t("grid.card.menu.showInScenes", "シーン一覧で表示")}
        </DropdownMenuItem>

        {allLabels.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Tag className="h-3.5 w-3.5" />
              {t("grid.card.menu.addLabel", "Label を付ける")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-[160px]">
              {allLabels.map((label) => (
                <DropdownMenuCheckboxItem
                  key={label.id}
                  checked={assignedIds.includes(label.id)}
                  onCheckedChange={() => void handleToggleLabel(label.id)}
                  onSelect={(e) => e.preventDefault()}
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full shrink-0 mr-2"
                    style={{
                      backgroundColor:
                        LABEL_PALETTE[label.color]?.light ?? "#888888",
                    }}
                  />
                  <span className="truncate">{label.name}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onSelect={onDelete}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("grid.card.menu.delete", "削除")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
