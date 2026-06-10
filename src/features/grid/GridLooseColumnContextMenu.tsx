import { useTranslation } from "react-i18next";
import { FolderPlus, FolderTree, Plus } from "lucide-react";
import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import {
  consolidateLooseIntoChapter,
  convertLooseToChapter,
} from "./looseBatchOps";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

/** Either a loose (project-root) column or a folder-container scene column.
 *  Both share the "scenes living without a chapter wrapper" semantics — the
 *  context menu differs only by which structural ops are meaningful. */
type Variant = "loose" | "container";

interface Props {
  variant: Variant;
  /** For `loose`: project root (null) or whichever ancestor holds these scenes.
   *  For `container`: the folder whose direct children are listed. */
  containerId: string | null;
  scenes: TreeNodeData[];
  /** Sibling chapter folders that scenes can be consolidated into. */
  chapters: TreeNodeData[];
  children: React.ReactNode;
}

export function GridLooseColumnContextMenu({
  variant,
  containerId,
  scenes,
  chapters,
  children,
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

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-[200px]">
        <ContextMenuItem onSelect={() => void addScene().catch(() => {})}>
          <Plus className="h-3.5 w-3.5" />
          {t("grid.column.contextMenu.addScene", "シーンを追加")}
        </ContextMenuItem>

        {(canConsolidate || canConvert) && <ContextMenuSeparator />}

        {canConsolidate && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <FolderTree className="h-3.5 w-3.5" />
              {t("grid.looseColumn.consolidate", "既存の章にまとめる")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="min-w-[180px] max-h-[300px] overflow-y-auto">
              {chapters.map((ch) => (
                <ContextMenuItem
                  key={ch.id}
                  onSelect={() => void handleConsolidate(ch.id)}
                >
                  <span className="truncate">{ch.title}</span>
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}

        {canConvert && (
          <ContextMenuItem onSelect={() => void handleConvertToChapter()}>
            <FolderPlus className="h-3.5 w-3.5" />
            {t("grid.looseColumn.convertToChapter", "新規章フォルダに変換")}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
