import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Check, Circle, FileText, FolderTree, Globe } from "lucide-react";
import { useTreeStore } from "./treeStore";
import type { TreeNodeData } from "./treeStore";
import { cmpKeys } from "./fractionalIndex";

export interface TreeRow {
  node: TreeNodeData;
  depth: number;
}

/** Flatten nodes into a depth-tagged DFS order using parentId chains. */
export function flattenTree(nodes: TreeNodeData[]): TreeRow[] {
  const childrenByParent = new Map<string | null, TreeNodeData[]>();
  for (const n of nodes) {
    const key = n.parentId;
    const arr = childrenByParent.get(key) ?? [];
    arr.push(n);
    childrenByParent.set(key, arr);
  }
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));
  }
  const out: TreeRow[] = [];
  function walk(parentId: string | null, depth: number) {
    const kids = childrenByParent.get(parentId) ?? [];
    for (const n of kids) {
      out.push({ node: n, depth });
      if (n.nodeType === "folder") walk(n.id, depth + 1);
    }
  }
  walk(null, 0);
  return out;
}

export type TreeScopeSelection =
  | { type: "scene"; sceneId: string }
  | { type: "folder"; anchorId: string }
  | { type: "project" }
  | null;

interface ScopeTreePickerListProps {
  selection: TreeScopeSelection;
  /** エディタが実際に開いているシーン（●インジケータ）。省略時は非表示 */
  editorActiveSceneId?: string;
  onPickScene: (sceneId: string) => void;
  onPickFolder: (folderId: string) => void;
  onPickProject: () => void;
}

/**
 * プロジェクト/フォルダ/シーンを選ぶツリーピッカーの中身（popover の body）。
 * Chat スコープピッカーから抽出した共通部品。ラベルは chat.scope.* を共有する
 * （表示文字列を Chat と byte-identical に保つため。名前空間の付け替えはしない）。
 */
export function ScopeTreePickerList({
  selection,
  editorActiveSceneId,
  onPickScene,
  onPickFolder,
  onPickProject,
}: ScopeTreePickerListProps) {
  const { t } = useTranslation();
  const nodes = useTreeStore((s) => s.nodes);
  const rows = useMemo(() => flattenTree(nodes), [nodes]);

  return (
    <>
      <button
        type="button"
        data-testid="chat-scope-project"
        onClick={onPickProject}
        className={[
          "flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-xs",
          selection?.type === "project"
            ? "bg-accent font-medium text-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        ].join(" ")}
      >
        <Globe className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">{t("chat.scope.project")}</span>
        {selection?.type === "project" && (
          <Check className="h-3 w-3 shrink-0" />
        )}
      </button>

      <div className="max-h-72 overflow-y-auto py-1">
        {rows.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {t("chat.noScenes")}
          </p>
        )}
        {rows.map(({ node, depth }) => {
          const isFolder = node.nodeType === "folder";
          if (!isFolder && node.nodeType !== "scene") return null;
          const isSelected = isFolder
            ? selection?.type === "folder" && selection.anchorId === node.id
            : selection?.type === "scene" && selection.sceneId === node.id;
          const isEditorActive = !isFolder && editorActiveSceneId === node.id;
          return (
            <button
              key={node.id}
              type="button"
              onClick={() =>
                isFolder ? onPickFolder(node.id) : onPickScene(node.id)
              }
              style={{ paddingLeft: 12 + depth * 12 }}
              className={[
                "flex w-full items-center gap-1.5 py-1 pr-3 text-left text-xs",
                isSelected
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              ].join(" ")}
            >
              {isFolder ? (
                <FolderTree className="h-3 w-3 shrink-0 opacity-70" />
              ) : (
                <FileText className="h-3 w-3 shrink-0 opacity-70" />
              )}
              <span className="flex-1 truncate">{node.title}</span>
              {isEditorActive && (
                <Circle
                  className="h-2 w-2 shrink-0 fill-primary text-primary"
                  aria-label={t("chat.scope.editorHere")}
                />
              )}
              {isSelected && <Check className="h-3 w-3 shrink-0" />}
            </button>
          );
        })}
      </div>
    </>
  );
}
