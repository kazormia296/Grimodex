import { useCallback } from "react";
import { Pin } from "lucide-react";
import type { TrashItemData } from "../types";
import { getBodySize } from "../displayHelpers";

interface Props {
  item: TrashItemData;
  registerNode: (id: string, el: HTMLElement | null) => void;
}

// 設計書 §8.2: 「円形 40×40、Lucide Pin、影で立体感」
export function PinTrashItem({ item, registerNode }: Props) {
  const ref = useCallback(
    (el: HTMLDivElement | null) => registerNode(item.id, el),
    [item.id, registerNode],
  );
  const size = getBodySize(item);

  return (
    <div
      ref={ref}
      className="absolute flex will-change-transform select-none items-center justify-center rounded-full bg-rose-100 shadow-md ring-1 ring-rose-300/60 dark:bg-rose-950/60 dark:ring-rose-700/40"
      style={{ width: size.width, height: size.height, top: 0, left: 0 }}
      data-subkind={item.subKind}
      data-interesting={item.isInteresting}
      title={item.previewText}
    >
      <Pin className="h-4 w-4 text-rose-600 dark:text-rose-300" />
    </div>
  );
}
