import { useTranslation } from "react-i18next";
import { FolderPlus, FolderTree, MoreVertical, Plus } from "lucide-react";
import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import {
  consolidateLooseIntoChapter,
  convertLooseToChapter,
} from "./looseBatchOps";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Variant = "loose" | "container";

interface Props {
  variant: Variant;
  /** Loose: project root id (or null). Container: the folder id whose direct
   *  scenes are listed. */
  containerId: string | null;
  scenes: TreeNodeData[];
  chapters: TreeNodeData[];
}

/**
 * Hover-revealed kebab for loose (project-root orphan scenes) and
 * dive-in container scene columns. 1:1 mirror of
 * `GridLooseColumnContextMenu` — replaces the hand-rolled menu that
 * previously lived inline in both components.
 */
export function GridLooseColumnMenu({
  variant,
  containerId,
  scenes,
  chapters,
}: Props) {
  const { t } = useTranslation();
  const createNode = useTreeStore((s) => s.createNode);

  async function addScene() {
    await createNode({ nodeType: "scene", parentId: containerId });
  }

  async function handleConsolidate(chapterId: string) {
    await consolidateLooseIntoChapter(
      scenes.map((s) => s.id),
      chapterId,
    );
  }

  async function handleConvertToChapter() {
    await convertLooseToChapter(
      containerId,
      scenes.map((s) => s.id),
    );
  }

  const canConsolidate = scenes.length > 0 && chapters.length > 0;
  const canConvert = variant === "loose" && scenes.length > 0;

  // Nothing to show beyond addScene — skip the kebab entirely.
  if (!canConsolidate && !canConvert && scenes.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="data-[state=open]:bg-accent transition-opacity"
          onClick={(e) => e.stopPropagation()}
          data-testid={`grid-${variant}-column-menu-btn`}
          title={t("grid.looseColumn.menu", "操作")}
        >
          <MoreVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[200px]"
        onClick={(e) => e.stopPropagation()}
      >
        <DropdownMenuItem onSelect={() => void addScene().catch(() => {})}>
          <Plus className="h-3.5 w-3.5" />
          {t("grid.column.contextMenu.addScene", "シーンを追加")}
        </DropdownMenuItem>

        {(canConsolidate || canConvert) && <DropdownMenuSeparator />}

        {canConsolidate && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderTree className="h-3.5 w-3.5" />
              {t("grid.looseColumn.consolidate", "既存の章にまとめる")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-[180px] max-h-[300px] overflow-y-auto">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {t("grid.looseColumn.pickChapter", "章を選択")}
              </DropdownMenuLabel>
              {chapters.map((ch) => (
                <DropdownMenuItem
                  key={ch.id}
                  onSelect={() => void handleConsolidate(ch.id)}
                >
                  <span className="truncate">{ch.title}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}

        {canConvert && (
          <DropdownMenuItem onSelect={() => void handleConvertToChapter()}>
            <FolderPlus className="h-3.5 w-3.5" />
            {t("grid.looseColumn.convertToChapter", "新規章フォルダに変換")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
