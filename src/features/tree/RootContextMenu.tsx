import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/features/editor/editorNavigationPorts";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { useScenesPanelContext } from "./ScenesPanelContext";
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
  const scenesContext = useScenesPanelContext();

  return (
    <ContextMenuContent className="min-w-[192px]">
      <ContextMenuItem
        onSelect={() => {
          createNode({ nodeType: "scene", parentId: null })
            .then((n) => {
              openEditorDocument(
                {
                  target: { kind: "scene", documentId: n.id },
                  mode: "pinned",
                  revealEditor: true,
                  focusEditor: false,
                  syncSceneContext: true,
                },
                defaultEditorNavigationPorts,
              );
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
              openEditorDocument(
                {
                  target: { kind: "scene", documentId: n.id },
                  mode: "pinned",
                  revealEditor: true,
                  focusEditor: false,
                  syncSceneContext: true,
                },
                defaultEditorNavigationPorts,
              );
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
      {scenesContext && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() =>
              scenesContext.openAiTree({ mode: "scaffold", rootRef: null })
            }
          >
            <Sparkles className="h-3 w-3 shrink-0" />
            <span>{t("aiTree.scaffoldCta", "AI でアウトライン生成")}</span>
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}
