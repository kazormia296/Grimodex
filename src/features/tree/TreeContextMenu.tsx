import { useTranslation } from "react-i18next";
import i18next from "@/lib/i18n";
import { MapPin, Settings, Tag, Sparkles } from "lucide-react";
import { useTreeStore } from "./treeStore";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/features/editor/editorNavigationPorts";
import { useLabelStore } from "@/features/labels/labelStore";
import { resolveLabelColor } from "@/lib/labelPalette";
import { formatShortcut } from "@/lib/platform";
import { useScenesPanelContext } from "./ScenesPanelContext";
import { StatusDot } from "./StatusDot";
import type { TreeNodeData, SceneStatus } from "./treeStore";
import { useAddToMapBoards } from "@/features/map/hooks/useAddToMapBoards";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/components/ui/context-menu";
import { getCurrentProjectId } from "@/features/project/projectStore";

const EMPTY_LABEL_IDS: readonly string[] = Object.freeze([]);

const STATUS_OPTIONS: SceneStatus[] = [
  "outline",
  "draft",
  "complete",
  "revision",
  "final",
];
const statusLabels = (): Record<SceneStatus, string> => ({
  outline: i18next.t("editor.status.outline"),
  draft: i18next.t("editor.status.draft"),
  complete: i18next.t("editor.status.complete"),
  revision: i18next.t("editor.status.revision"),
  final: i18next.t("editor.status.final"),
});

interface TreeContextMenuProps {
  node: TreeNodeData;
  onStartRename: () => void;
}

/**
 * Right-click menu content for a tree node.
 * Render inside <ContextMenu><ContextMenuTrigger asChild>{...row}</ContextMenuTrigger>...</ContextMenu>.
 */
export function TreeContextMenu({ node, onStartRename }: TreeContextMenuProps) {
  const { t } = useTranslation();
  const { deleteNode, setStatus, createNode } = useTreeStore();
  const selectedIds = useTreeStore((s) => s.selectedIds);
  const allNodes = useTreeStore((s) => s.nodes);
  const allLabels = useLabelStore((s) => s.labels);
  const assignedLabelIds = useLabelStore(
    (s) => s.nodeLabels[node.id] ?? EMPTY_LABEL_IDS,
  );
  const { boards, addToBoard } = useAddToMapBoards(getCurrentProjectId());
  const scenesContext = useScenesPanelContext();

  function openInEditor(documentId: string, group: 0 | 1 = 0): void {
    openEditorDocument(
      {
        target: { kind: "scene", documentId },
        group,
        mode: "pinned",
        revealEditor: true,
        focusEditor: false,
        syncSceneContext: true,
      },
      defaultEditorNavigationPorts,
    );
  }

  // If the right-clicked node is part of a multi-selection, operations apply
  // to all selected nodes; otherwise only to the right-clicked node.
  const targetIds: string[] =
    selectedIds.includes(node.id) && selectedIds.length > 1
      ? selectedIds
      : [node.id];
  const isMulti = targetIds.length > 1;
  const targetSceneIds = targetIds.filter(
    (id) => allNodes.find((n) => n.id === id)?.nodeType === "scene",
  );

  async function handleToggleLabel(labelId: string) {
    const hasLabel = assignedLabelIds.includes(labelId);
    const labelStore = useLabelStore.getState();
    for (const id of targetIds) {
      const current = labelStore.nodeLabels[id] ?? [];
      const next = hasLabel
        ? current.filter((x) => x !== labelId)
        : current.includes(labelId)
          ? current
          : [...current, labelId];
      if (next !== current) {
        await labelStore.setNodeLabels(id, next);
      }
    }
  }

  async function handleSetStatus(status: SceneStatus) {
    for (const id of targetSceneIds) {
      await setStatus(id, status);
    }
  }

  async function handleDelete() {
    for (const id of targetIds) {
      await deleteNode(id).catch(() => {});
    }
  }

  const isScene = node.nodeType === "scene";
  const isFolder = node.nodeType === "folder";
  const isNote = node.nodeType === "note";
  const isContainer = isFolder;

  return (
    <ContextMenuContent className="min-w-[192px]">
      {/* Open (Scene/Note only) */}
      {(isScene || isNote) && (
        <>
          <ContextMenuItem
            onSelect={() => {
              openInEditor(node.id);
            }}
          >
            {t("tree.openInEditor")}
            <ContextMenuShortcut>Enter</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              openInEditor(node.id, 1);
            }}
          >
            {t("tree.openInSide")}
            <ContextMenuShortcut>
              {formatShortcut("Ctrl+Enter")}
            </ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}

      {/* Set Status (Scene only — submenu) */}
      {targetSceneIds.length > 0 && (
        <>
          <ContextMenuSub>
            <ContextMenuSubTrigger inset>
              {t("tree.setStatus")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup
                value={!isMulti ? (node.status ?? undefined) : undefined}
                onValueChange={(v) => void handleSetStatus(v as SceneStatus)}
              >
                {STATUS_OPTIONS.map((s) => (
                  <ContextMenuRadioItem key={s} value={s}>
                    <StatusDot status={s} />
                    <span className="ml-2">{statusLabels()[s]}</span>
                  </ContextMenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
        </>
      )}

      {/* Rename */}
      <ContextMenuItem inset onSelect={onStartRename}>
        {t("tree.rename")}
        <ContextMenuShortcut>F2</ContextMenuShortcut>
      </ContextMenuItem>

      {/* Assign labels (scene / note) */}
      {(isScene || isNote) && (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Tag className="h-3 w-3" />
            <span>{t("tree.assignLabels")}</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-[180px]">
            {allLabels.length === 0 && (
              <div className="px-3 py-1.5 text-xs text-muted-foreground">
                {t("scenes.noLabels")}
              </div>
            )}
            {allLabels.map((label) => {
              const checked = assignedLabelIds.includes(label.id);
              return (
                <ContextMenuCheckboxItem
                  key={label.id}
                  checked={checked}
                  onCheckedChange={() => void handleToggleLabel(label.id)}
                  onSelect={(e) => e.preventDefault()}
                >
                  <span
                    className="mr-2 h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: resolveLabelColor(label.color) }}
                  />
                  <span className="truncate">{label.name}</span>
                </ContextMenuCheckboxItem>
              );
            })}
            {scenesContext && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onSelect={() => scenesContext.openManageLabels()}
                >
                  <Settings className="h-3 w-3 shrink-0" />
                  <span>{t("tree.manageLabels")}</span>
                </ContextMenuItem>
              </>
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}

      {/* Add children inside folder */}
      {isFolder && (
        <>
          <ContextMenuItem
            inset
            onSelect={() => {
              createNode({ nodeType: "scene", parentId: node.id })
                .then((n) => {
                  openInEditor(n.id);
                })
                .catch(() => {});
            }}
          >
            {t("tree.addScene")}
          </ContextMenuItem>
          <ContextMenuItem
            inset
            onSelect={() => {
              createNode({ nodeType: "note", parentId: node.id })
                .then((n) => {
                  openInEditor(n.id);
                })
                .catch(() => {});
            }}
          >
            {t("tree.addNote")}
          </ContextMenuItem>
          <ContextMenuItem
            inset
            onSelect={() => {
              createNode({ nodeType: "folder", parentId: node.id }).catch(
                () => {},
              );
            }}
          >
            {t("tree.addFolder")}
          </ContextMenuItem>
          {scenesContext && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={() =>
                  scenesContext.openAiTree({
                    mode: "scaffold",
                    rootRef: node.id,
                    rootTitle: node.title,
                  })
                }
              >
                <Sparkles className="h-3 w-3 shrink-0" />
                <span>{t("aiTree.scaffoldHere", "AI で構成を生成")}</span>
              </ContextMenuItem>
              {/* 再編は子を持つ folder のみ。空 folder では create-only に縮退するため出さない (N6)。 */}
              {allNodes.some((n) => n.parentId === node.id) && (
                <ContextMenuItem
                  onSelect={() =>
                    scenesContext.openAiTree({
                      mode: "reorganize",
                      rootRef: node.id,
                      rootTitle: node.title,
                    })
                  }
                >
                  <Sparkles className="h-3 w-3 shrink-0" />
                  <span>{t("aiTree.reorganizeHere", "AI で構成を再編")}</span>
                </ContextMenuItem>
              )}
            </>
          )}
        </>
      )}

      {/* Add sibling below (scene / note) */}
      {(isScene || isNote) && (
        <>
          <ContextMenuItem
            inset
            onSelect={() => {
              createNode({
                nodeType: "scene",
                parentId: node.parentId,
                afterId: node.id,
              })
                .then((n) => {
                  openInEditor(n.id);
                })
                .catch(() => {});
            }}
          >
            {t("tree.addSceneBelow")}
          </ContextMenuItem>
          <ContextMenuItem
            inset
            onSelect={() => {
              createNode({
                nodeType: "note",
                parentId: node.parentId,
                afterId: node.id,
              })
                .then((n) => {
                  openInEditor(n.id);
                })
                .catch(() => {});
            }}
          >
            {t("tree.addNoteBelow")}
          </ContextMenuItem>
          <ContextMenuItem
            inset
            onSelect={() => {
              createNode({
                nodeType: "folder",
                parentId: node.parentId,
                afterId: node.id,
              }).catch(() => {});
            }}
          >
            {t("tree.addFolderBelow")}
          </ContextMenuItem>
        </>
      )}

      {isContainer && <ContextMenuSeparator />}

      {/* Add to Map (scene / note only) */}
      {(isScene || isNote) && boards.length > 0 && (
        <>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <MapPin className="h-3 w-3" />
              <span>{t("tree.addToMap")}</span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {boards.map((b) => (
                <ContextMenuItem
                  key={b.id}
                  onSelect={() => {
                    void addToBoard(b.id, {
                      nodeRefType: node.nodeType as "scene" | "note",
                      treeNodeId: node.id,
                    });
                  }}
                >
                  {b.title}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        </>
      )}

      {/* Delete */}
      <ContextMenuSeparator />
      <ContextMenuItem
        inset
        onSelect={() => void handleDelete()}
        className="text-destructive focus:text-destructive"
      >
        {t("tree.delete")}
        <ContextMenuShortcut>Del</ContextMenuShortcut>
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
