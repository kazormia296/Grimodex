import { useCallback } from "react";
import type { TrashItemData } from "../types";
import { getBodySize } from "../displayHelpers";

interface Props {
  item: TrashItemData;
  registerNode: (id: string, el: HTMLElement | null) => void;
}

interface SceneMeta {
  folderName?: string | null;
  bodyPreview?: string | null;
  nodeType?: string | null;
}

export function SceneTrashItem({ item, registerNode }: Props) {
  const ref = useCallback(
    (el: HTMLDivElement | null) => registerNode(item.id, el),
    [item.id, registerNode],
  );
  const size = getBodySize(item);
  const meta = (item.previewMeta ?? {}) as SceneMeta;

  return (
    <div
      ref={ref}
      className="absolute will-change-transform select-none rounded-md border border-border bg-background px-2 py-1.5 shadow-sm"
      style={{ width: size.width, height: size.height, top: 0, left: 0 }}
      data-subkind={item.subKind}
      data-interesting={item.isInteresting}
      title={item.previewText}
    >
      <div className="truncate text-xs font-semibold text-foreground">
        {item.previewText || "—"}
      </div>
      {meta.bodyPreview ? (
        <div className="mt-0.5 line-clamp-2 text-[10px] leading-tight text-muted-foreground">
          {meta.bodyPreview}
        </div>
      ) : null}
      {meta.folderName ? (
        <div className="absolute right-1 top-1 rounded bg-muted/80 px-1 text-[9px] leading-none text-muted-foreground">
          {meta.folderName}
        </div>
      ) : null}
    </div>
  );
}
