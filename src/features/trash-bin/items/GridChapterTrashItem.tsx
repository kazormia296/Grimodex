import { useCallback } from "react";
import { FolderOpen } from "lucide-react";
import type { TrashItemData } from "../types";
import { getBodySize } from "../displayHelpers";

interface Props {
  item: TrashItemData;
  registerNode: (id: string, el: HTMLElement | null) => void;
}

// 設計書 §8.2: 「帯 200×40、Grid カラー (オレンジ系)、左に階層インデント風記号」
export function GridChapterTrashItem({ item, registerNode }: Props) {
  const ref = useCallback(
    (el: HTMLDivElement | null) => registerNode(item.id, el),
    [item.id, registerNode],
  );
  const size = getBodySize(item);

  return (
    <div
      ref={ref}
      className="absolute flex will-change-transform select-none items-center gap-1.5 rounded-sm border-l-4 border-orange-500 bg-orange-100/95 px-2 py-1 shadow-sm dark:bg-orange-950/40"
      style={{ width: size.width, height: size.height, top: 0, left: 0 }}
      data-subkind={item.subKind}
      data-interesting={item.isInteresting}
      title={item.previewText}
    >
      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-orange-700 dark:text-orange-300" />
      <span className="truncate text-xs font-semibold text-foreground">
        {item.previewText || "(無題)"}
      </span>
    </div>
  );
}
