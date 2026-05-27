import { NodeToolbar, Position } from "@xyflow/react";

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
  if (!onBranchFrom) return null;
  return (
    <>
      <NodeToolbar position={Position.Left} offset={6}>
        <button
          type="button"
          aria-label="左に分岐 Sticky を追加"
          title="左に分岐 Sticky を追加"
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
          aria-label="右に分岐 Sticky を追加"
          title="右に分岐 Sticky を追加"
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
