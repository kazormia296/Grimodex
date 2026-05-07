import { useCallback } from "react";
import type { TrashItemData } from "./types";
import { dominantSource, getBodySize } from "./displayHelpers";

interface Props {
  item: TrashItemData;
  registerNode: (id: string, el: HTMLElement | null) => void;
}

export function TrashBinItem({ item, registerNode }: Props) {
  const ref = useCallback(
    (el: HTMLDivElement | null) => registerNode(item.id, el),
    [item.id, registerNode],
  );

  const size = getBodySize(item);

  if (item.subKind === "text-fragment") {
    const source = dominantSource(item);
    const borderColor =
      source === "ai"
        ? "border-l-purple-500"
        : source === "unknown"
          ? "border-l-muted-foreground"
          : "border-l-foreground/70";
    return (
      <div
        ref={ref}
        className={`absolute will-change-transform select-none rounded-sm border border-border/40 border-l-2 bg-background/95 px-2 py-1 font-mono text-xs whitespace-nowrap text-foreground shadow-sm ${borderColor}`}
        style={{ width: size.width, height: size.height, top: 0, left: 0 }}
        data-subkind={item.subKind}
        data-interesting={item.isInteresting}
        title={item.previewText}
      >
        <span className="block overflow-hidden text-ellipsis">
          {item.previewText}
        </span>
      </div>
    );
  }

  // Phase 4-5 で各 subKind の見た目を本格化する。Phase 3 は暫定 box。
  return (
    <div
      ref={ref}
      className="absolute will-change-transform select-none rounded-md border border-border/40 bg-muted/80 px-2 py-1 text-xs text-foreground shadow"
      style={{ width: size.width, height: size.height, top: 0, left: 0 }}
      data-subkind={item.subKind}
      data-interesting={item.isInteresting}
      title={item.previewText}
    >
      <span className="block overflow-hidden text-ellipsis whitespace-nowrap">
        {item.previewText}
      </span>
    </div>
  );
}
