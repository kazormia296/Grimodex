import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, ChevronDown, Folder } from "lucide-react";
import type { TreeNodeData } from "@/features/tree/treeStore";

// ────────────────────────────────────────────────────────────────────
// 型
// ────────────────────────────────────────────────────────────────────

export interface ExportTreeState {
  checkedIds: Set<string>;
  expandedIds: Set<string>;
}

interface Props {
  nodes: TreeNodeData[];
  state: ExportTreeState;
  onChange: (next: ExportTreeState) => void;
}

// ────────────────────────────────────────────────────────────────────
// ヘルパー
// ────────────────────────────────────────────────────────────────────

/** parentId 配下の直接子ノードを sortOrder 順に返す（note 除外） */
function getChildren(
  nodes: TreeNodeData[],
  parentId: string | null,
): TreeNodeData[] {
  return nodes
    .filter((n) => n.parentId === parentId && n.nodeType !== "note")
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** フォルダー配下の全チェック可能シーンIDを収集 */
function collectSceneIds(nodes: TreeNodeData[], folderId: string): string[] {
  const result: string[] = [];
  const children = nodes.filter((n) => n.parentId === folderId);
  for (const child of children) {
    if (child.nodeType === "scene") {
      result.push(child.id);
    } else if (child.nodeType === "folder") {
      result.push(...collectSceneIds(nodes, child.id));
    }
  }
  return result;
}

/** フォルダーの三状態チェック: "all" | "some" | "none" */
function folderCheckState(
  nodes: TreeNodeData[],
  folderId: string,
  checkedIds: Set<string>,
): "all" | "some" | "none" {
  const sceneIds = collectSceneIds(nodes, folderId);
  if (sceneIds.length === 0) return "none";
  const checked = sceneIds.filter((id) => checkedIds.has(id)).length;
  if (checked === 0) return "none";
  if (checked === sceneIds.length) return "all";
  return "some";
}

/** フォルダーに表示すべきシーンがあるか（空フォルダーは非表示） */
function hasPresentableScenes(nodes: TreeNodeData[], nodeId: string): boolean {
  return collectSceneIds(nodes, nodeId).length > 0;
}

// ────────────────────────────────────────────────────────────────────
// コンポーネント
// ────────────────────────────────────────────────────────────────────

/** 三状態チェックボックス */
function TriStateCheckbox({
  state,
  onChange,
}: {
  state: "all" | "some" | "none";
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "some" ? "mixed" : state === "all"}
      onClick={onChange}
      className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border border-border bg-background text-xs transition-colors hover:bg-accent"
    >
      {state === "all" && <span className="text-primary leading-none">✓</span>}
      {state === "some" && <span className="text-primary leading-none">−</span>}
    </button>
  );
}

/** 通常チェックボックス（シーン用） */
function SceneCheckbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onChange}
      className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border border-border bg-background text-xs transition-colors hover:bg-accent"
    >
      {checked && <span className="text-primary leading-none">✓</span>}
    </button>
  );
}

/** ツリーノードの再帰レンダリング */
function TreeNode({
  node,
  nodes,
  state,
  onChange,
  depth,
}: {
  node: TreeNodeData;
  nodes: TreeNodeData[];
  state: ExportTreeState;
  onChange: (next: ExportTreeState) => void;
  depth: number;
}) {
  const { checkedIds, expandedIds } = state;

  const toggleExpand = useCallback(
    (id: string) => {
      const next = new Set(expandedIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      onChange({ ...state, expandedIds: next });
    },
    [expandedIds, state, onChange],
  );

  if (node.nodeType === "folder") {
    if (!hasPresentableScenes(nodes, node.id)) return null;

    const checkState = folderCheckState(nodes, node.id, checkedIds);
    const isExpanded = expandedIds.has(node.id);
    const children = getChildren(nodes, node.id);

    const handleFolderCheck = () => {
      const sceneIds = collectSceneIds(nodes, node.id);
      const next = new Set(checkedIds);
      if (checkState === "all") {
        // all → none
        sceneIds.forEach((id) => next.delete(id));
      } else {
        // none or some → all
        sceneIds.forEach((id) => next.add(id));
      }
      onChange({ ...state, checkedIds: next });
    };

    return (
      <div>
        <div
          className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent/50"
          style={{ paddingLeft: `${depth * 16 + 4}px` }}
        >
          <TriStateCheckbox state={checkState} onChange={handleFolderCheck} />
          <button
            type="button"
            onClick={() => toggleExpand(node.id)}
            className="flex items-center gap-1 text-left text-sm text-foreground"
          >
            {isExpanded ? (
              <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
            )}
            <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            <span className="truncate">{node.title}</span>
          </button>
        </div>
        {isExpanded && (
          <div>
            {children.map((child) => (
              <TreeNode
                key={child.id}
                node={child}
                nodes={nodes}
                state={state}
                onChange={onChange}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (node.nodeType === "scene") {
    const checked = checkedIds.has(node.id);

    const handleSceneCheck = () => {
      const next = new Set(checkedIds);
      if (checked) {
        next.delete(node.id);
      } else {
        next.add(node.id);
      }
      onChange({ ...state, checkedIds: next });
    };

    return (
      <div
        className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent/50"
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
      >
        <SceneCheckbox checked={checked} onChange={handleSceneCheck} />
        <span className="truncate text-sm text-foreground">{node.title}</span>
      </div>
    );
  }

  return null;
}

// ────────────────────────────────────────────────────────────────────
// ExportTree 本体
// ────────────────────────────────────────────────────────────────────

export function ExportTree({ nodes, state, onChange }: Props) {
  const { t } = useTranslation();
  const { checkedIds, expandedIds } = state;

  const allSceneIds = nodes
    .filter((n) => n.nodeType === "scene")
    .map((n) => n.id);
  const allChecked =
    allSceneIds.length > 0 && allSceneIds.every((id) => checkedIds.has(id));
  const someChecked = allSceneIds.some((id) => checkedIds.has(id));
  const headerCheckState: "all" | "some" | "none" = allChecked
    ? "all"
    : someChecked
      ? "some"
      : "none";

  const handleSelectAll = () => {
    if (allChecked) {
      onChange({ ...state, checkedIds: new Set() });
    } else {
      onChange({ ...state, checkedIds: new Set(allSceneIds) });
    }
  };

  const allFolderIds = nodes
    .filter((n) => n.nodeType === "folder")
    .map((n) => n.id);
  const allExpanded = allFolderIds.every((id) => expandedIds.has(id));

  const handleToggleExpandAll = () => {
    if (allExpanded) {
      onChange({ ...state, expandedIds: new Set() });
    } else {
      onChange({ ...state, expandedIds: new Set(allFolderIds) });
    }
  };

  const rootChildren = nodes
    .filter((n) => n.parentId === null && n.nodeType !== "note")
    .sort((a, b) => a.sortOrder - b.sortOrder);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ヘッダー */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <TriStateCheckbox state={headerCheckState} onChange={handleSelectAll} />
        <span className="text-xs text-muted-foreground">
          {t("export.selectAll")}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={handleToggleExpandAll}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {allExpanded ? t("export.collapse") : t("export.expand")}
        </button>
      </div>

      {/* ツリー本体 */}
      <div className="flex-1 overflow-y-auto p-1">
        {rootChildren.map((node) => (
          <TreeNode
            key={node.id}
            node={node}
            nodes={nodes}
            state={state}
            onChange={onChange}
            depth={0}
          />
        ))}
        {rootChildren.length === 0 && (
          <p className="p-3 text-xs text-muted-foreground">
            {t("export.noScenes")}
          </p>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// ユーティリティ: 初期状態の構築
// ────────────────────────────────────────────────────────────────────

/** 全シーンをチェック済み・展開状態を引き継いだ初期状態 */
export function buildInitialTreeState(
  nodes: TreeNodeData[],
  inheritExpandedIds?: string[],
): ExportTreeState {
  const checkedIds = new Set(
    nodes.filter((n) => n.nodeType === "scene").map((n) => n.id),
  );
  const expandedIds = new Set(
    inheritExpandedIds ??
      nodes.filter((n) => n.nodeType === "folder").map((n) => n.id),
  );
  return { checkedIds, expandedIds };
}

/** チェック済みシーンの合計文字数と件数を計算 */
export function calcExportStats(
  nodes: TreeNodeData[],
  contentMap: Record<string, string>,
  checkedIds: Set<string>,
): { sceneCount: number; charCount: number; totalScenes: number } {
  const allScenes = nodes.filter((n) => n.nodeType === "scene");
  const totalScenes = allScenes.length;
  const checked = allScenes.filter((n) => checkedIds.has(n.id));
  const sceneCount = checked.length;

  let charCount = 0;
  for (const scene of checked) {
    const raw = contentMap[scene.id];
    if (!raw || raw === "{}") continue;
    try {
      const doc = JSON.parse(raw);
      charCount += countChars(doc);
    } catch {
      // ignore
    }
  }

  return { sceneCount, charCount, totalScenes };
}

function countChars(node: { text?: string; content?: unknown[] }): number {
  if (node.text) return node.text.length;
  if (!node.content) return 0;
  return node.content.reduce(
    (s: number, c) => s + countChars(c as typeof node),
    0,
  );
}
