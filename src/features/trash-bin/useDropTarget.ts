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
 * accepts / onDrop は pickupHandlers の汎用関数を内部で呼ぶ。
 */
import { useEffect, useRef } from "react";
import {
  useDropTargetRegistry,
  type DropTargetKind,
} from "@/store/dropTargetRegistry";
import { useTrashBinStore } from "./trashBinStore";
import { acceptsMatrix, pickupAndDispatch } from "./pickupHandlers";

export function useDropTarget(
  id: string,
  kind: DropTargetKind,
): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const register = useDropTargetRegistry.getState().register;
    const unregister = register({
      id,
      kind,
      rect: () => ref.current?.getBoundingClientRect() ?? null,
      accepts: (subKind) => acceptsMatrix(kind, subKind),
      onDrop: async (item, point) => {
        await useTrashBinStore
          .getState()
          .pickup(item.id, () =>
            pickupAndDispatch(
              item,
              {
                id,
                kind,
                rect: () => null,
                accepts: () => true,
                onDrop: async () => {},
              },
              point,
            ),
          );
      },
    });
    return unregister;
  }, [id, kind]);

  return ref;
}
