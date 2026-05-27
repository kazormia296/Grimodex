import { Handle, Position } from "@xyflow/react";

/**
 * 不可視のフローティングハンドル。役割を分離した 2 枚の Handle で
 * 構成する:
 *
 * 1. drop ハンドル — ノード bounding box (+ 外周 6px) 全体を覆う。
 *    isConnectableStart=false なので click では connection が始まらず、
 *    pointerdown はノード本体の drag に流れる。エッジドラッグの
 *    "受け側" として、ノードのどこに drop してもスナップさせる。
 *
 * 2. drag ハンドル — 同じ領域を覆うが isConnectableEnd=false。
 *    外周 ~6px の縁（ノード本体に隠れない部分）から click すると
 *    connection 作成を開始する。
 *
 * 両方とも z-index: -1 でノード本体の背面に配置するため、ノード
 *  本体の編集・選択・ドラッグは通常通り動作する。
 *
 * Position はダミー (Top)。実際の anchor 位置は UserEdge の
 * floating edge ロジックがノード境界から計算する。
 *
 * `isConnectable` は React Flow が NodeProps から各カスタムノードへ
 * 注入する値を受け取る想定。左下 Controls の Toggle Interactivity
 * OFF 時に store.nodesConnectable が false → NodeProps.isConnectable
 * → ここを経由して両 Handle が無効化され、Handle 経由の UserEdge
 * 追加もブロックされる。
 */
export function FloatingHandle({
  isConnectable = true,
}: {
  isConnectable?: boolean;
}) {
  return (
    <>
      <Handle
        type="source"
        position={Position.Top}
        className="map-handle-floating-drop"
        isConnectable={isConnectable}
        isConnectableStart={false}
      />
      <Handle
        type="source"
        position={Position.Top}
        className="map-handle-floating-drag"
        isConnectable={isConnectable}
        isConnectableEnd={false}
      />
    </>
  );
}
