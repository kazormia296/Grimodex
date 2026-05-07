import { useCallback } from "react";
import type { TrashItemData } from "../types";
import { getBodySize } from "../displayHelpers";

interface Props {
  item: TrashItemData;
  registerNode: (id: string, el: HTMLElement | null) => void;
}

interface ForeshadowMeta {
  intent?: string | null;
  loadBearing?: string | null;
  abandoned?: boolean;
}

// 設計書 §8.2: 「赤糸モチーフ、細長い赤紐、両端にミニ結び目」
export function ForeshadowTrashItem({ item, registerNode }: Props) {
  const ref = useCallback(
    (el: HTMLDivElement | null) => registerNode(item.id, el),
    [item.id, registerNode],
  );
  const size = getBodySize(item);
  const meta = (item.previewMeta ?? {}) as ForeshadowMeta;
  const isAbandoned = Boolean(meta.abandoned);

  return (
    <div
      ref={ref}
      className="absolute flex will-change-transform select-none items-center gap-1 px-1"
      style={{ width: size.width, height: size.height, top: 0, left: 0 }}
      data-subkind={item.subKind}
      data-interesting={item.isInteresting}
      title={item.previewText}
    >
      {/* 左端の結び目 */}
      <span
        aria-hidden
        className="block h-2.5 w-2.5 shrink-0 rounded-full bg-red-700 shadow-sm ring-1 ring-red-900/40"
      />
      {/* 赤い紐本体 */}
      <div
        className={`relative flex h-full min-w-0 flex-1 items-center rounded-full px-2 shadow ${
          isAbandoned
            ? "bg-red-300/70 ring-1 ring-red-400/50"
            : "bg-red-600/90 ring-1 ring-red-900/30"
        }`}
      >
        <span
          className={`block min-w-0 truncate text-[10px] font-medium ${
            isAbandoned ? "text-red-900 line-through" : "text-red-50"
          }`}
        >
          {item.previewText || "—"}
        </span>
      </div>
      {/* 右端の結び目 */}
      <span
        aria-hidden
        className="block h-2.5 w-2.5 shrink-0 rounded-full bg-red-700 shadow-sm ring-1 ring-red-900/40"
      />
    </div>
  );
}
