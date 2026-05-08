/**
 * パネル側で使う薄いフック (設計書 §5-B)。
 * `data-droptarget-id="{id}"` 属性を持つ DOM 要素を登録 / 解除する。
 *
 * 使用例:
 * ```tsx
 * const targetRef = useDropTarget("scenes-panel", "scenes-panel");
 * return <div ref={targetRef} data-droptarget-id="scenes-panel">...</div>;
 * ```
 *
 * `transformPoint` を渡すと、PhysicsView から渡されたスクリーン座標を
 * パネル固有の座標系 (例: ReactFlow の flow 座標) へ変換できる。Map ペインは
 * これで screenToFlowPosition を噛ませる。
 */
import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/core";
import {
  useDropTargetRegistry,
  type DropPoint,
  type DropTargetKind,
} from "@/store/dropTargetRegistry";
import { useTrashBinStore } from "./trashBinStore";
import { acceptsMatrix, pickupAndDispatch } from "./pickupHandlers";
import type { TrashItemData, TrashSubKind } from "./types";

export interface UseDropTargetOptions {
  /**
   * 受け取った client 座標 (window 基準) をパネル固有座標系に変換する。
   * 未指定なら client 座標をそのまま渡す。
   */
  transformPoint?: (client: DropPoint, item: TrashItemData) => DropPoint;
  /**
   * 編集系 target が「自身が保持する Editor」を返す。pickupHandlers は
   * これを優先し、無ければ focusedContentEditorStore へフォールバック。
   */
  getEditor?: () => Editor | null;
}

export function useDropTarget(
  id: string,
  kind: DropTargetKind,
  options: UseDropTargetOptions = {},
): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  // options を ref で参照して、毎レンダの再 register を避ける
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const register = useDropTargetRegistry.getState().register;
    // self-reference を埋め込むので一旦 let に組み立てる
    const target = {
      id,
      kind,
      rect: () => ref.current?.getBoundingClientRect() ?? null,
      accepts: (subKind: TrashSubKind) => acceptsMatrix(kind, subKind),
      getEditor: () => optionsRef.current.getEditor?.() ?? null,
      onDrop: async (item: TrashItemData, clientPoint: DropPoint) => {
        const localPoint =
          optionsRef.current.transformPoint?.(clientPoint, item) ?? clientPoint;
        await useTrashBinStore
          .getState()
          .pickup(item.id, () => pickupAndDispatch(item, target, localPoint));
      },
    };
    const unregister = register(target);
    return unregister;
  }, [id, kind]);

  return ref;
}
