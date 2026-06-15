import { NodeToolbar, Position } from "@xyflow/react";
import { useTranslation } from "react-i18next";

/**
 * 選択中のノードの左右に「+」ボタンを表示し、押下するとその方向に
 * 隣接 Sticky を新規作成し UserEdge で接続するアフォーダンス。
 *
 * NodeToolbar は React Flow が node の選択状態を購読しているので、
 * 各ノードからは `selected` の if を書かずに常設しておけば良い。
 * `onBranchFrom` が undefined のとき (=frame など分岐元として未サポート
 * のノード) は何も描画しない。
 */
export function NodeBranchToolbar({
  onBranchFrom,
}: {
  onBranchFrom?: (dir: "left" | "right") => void;
}) {
  const { t } = useTranslation();
  if (!onBranchFrom) return null;
  return (
    <>
      <NodeToolbar position={Position.Left} offset={6}>
        <button
          type="button"
          aria-label={t("map.menu.branchStickyLeft")}
          title={t("map.menu.branchStickyLeft")}
          onClick={(e) => {
            e.stopPropagation();
            onBranchFrom("left");
          }}
          className="map-branch-affordance"
        >
          +
        </button>
      </NodeToolbar>
      <NodeToolbar position={Position.Right} offset={6}>
        <button
          type="button"
          aria-label={t("map.menu.branchStickyRight")}
          title={t("map.menu.branchStickyRight")}
          onClick={(e) => {
            e.stopPropagation();
            onBranchFrom("right");
          }}
          className="map-branch-affordance"
        >
          +
        </button>
      </NodeToolbar>
    </>
  );
}
