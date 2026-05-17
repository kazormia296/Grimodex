import { useTranslation } from "react-i18next";
import { ExternalLink, PanelLeft, Plus, Tag, Trash2 } from "lucide-react";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useLabelStore } from "@/features/labels/labelStore";
import { LABEL_PALETTE } from "@/lib/labelPalette";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

interface Props {
  sceneId: string;
  onOpenInEditor: () => void;
  onAddBeat: () => void;
  onDelete: () => void;
  children: React.ReactNode;
}

/**
 * Right-click menu for scene cards in the Grid panel. Mirrors the kebab
 * (`GridCardMenu`) for parity, plus exposes "Open in Editor" / "Add Beat"
 * which are otherwise only reachable via hover-only buttons inside the card.
 */
export function GridSceneCardContextMenu({
  sceneId,
  onOpenInEditor,
  onAddBeat,
  onDelete,
  children,
}: Props) {
  const { t } = useTranslation();
  const allLabels = useLabelStore((s) => s.labels);
  const nodeLabels = useLabelStore((s) => s.nodeLabels);
  const assignedIds = nodeLabels[sceneId] ?? [];

  function showInScenes() {
    useLayoutStore.getState().showPanel("scenes");
  }

  async function handleToggleLabel(labelId: string) {
    const current = useLabelStore.getState().nodeLabels[sceneId] ?? [];
    const next = current.includes(labelId)
      ? current.filter((id) => id !== labelId)
      : [...current, labelId];
    await useLabelStore.getState().setNodeLabels(sceneId, next);
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-[180px]">
        <ContextMenuItem onSelect={onOpenInEditor}>
          <ExternalLink className="h-3.5 w-3.5" />
          {t("grid.card.contextMenu.openInEditor", "エディタで開く")}
        </ContextMenuItem>

        <ContextMenuItem onSelect={showInScenes}>
          <PanelLeft className="h-3.5 w-3.5" />
          {t("grid.card.contextMenu.showInScenes", "シーン一覧で表示")}
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onSelect={onAddBeat}>
          <Plus className="h-3.5 w-3.5" />
          {t("grid.card.contextMenu.addBeat", "Beat を追加")}
        </ContextMenuItem>

        {allLabels.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Tag className="h-3.5 w-3.5" />
              {t("grid.card.contextMenu.addLabel", "Label を付ける")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="min-w-[160px]">
              {allLabels.map((label) => (
                <ContextMenuCheckboxItem
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
                </ContextMenuCheckboxItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}

        <ContextMenuSeparator />

        <ContextMenuItem
          onSelect={onDelete}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("grid.card.contextMenu.delete", "削除")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
