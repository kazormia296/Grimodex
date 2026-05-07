import { useTranslation } from "react-i18next";
import { useTabStore } from "@/features/editor/tabStore";
import {
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import type { TreeNodeData, NodeType } from "./treeStore";

export interface RootContextMenuProps {
  createNode: (opts: {
    nodeType: NodeType;
    parentId: string | null;
  }) => Promise<TreeNodeData>;
}

/**
 * Right-click menu content for the empty area of the Scenes panel.
 * Render inside <ContextMenu><ContextMenuTrigger asChild>{...root}</ContextMenuTrigger>...</ContextMenu>.
 */
export function RootContextMenu({ createNode }: RootContextMenuProps) {
  const { t } = useTranslation();

  return (
    <ContextMenuContent className="min-w-[192px]">
      <ContextMenuItem
        onSelect={() => {
          createNode({ nodeType: "scene", parentId: null })
            .then((n) => {
              useTabStore.getState().openPinned(n.id);
            })
            .catch(() => {});
        }}
      >
        {t("scenes.addScene")}
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => {
          createNode({ nodeType: "note", parentId: null })
            .then((n) => {
              useTabStore.getState().openPinned(n.id);
            })
            .catch(() => {});
        }}
      >
        {t("scenes.addNote")}
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => {
          createNode({ nodeType: "folder", parentId: null }).catch(() => {});
        }}
      >
        {t("scenes.addFolder")}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
