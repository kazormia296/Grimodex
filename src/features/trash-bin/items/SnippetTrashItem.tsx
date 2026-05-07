import { useCallback } from "react";
import type { TrashItemData } from "../types";
import { getBodySize } from "../displayHelpers";

interface Props {
  item: TrashItemData;
  registerNode: (id: string, el: HTMLElement | null) => void;
}

interface SnippetMeta {
  bodyPreview?: string | null;
  tagsCache?: string | null;
}

interface ParsedTag {
  name: string;
  color?: string | null;
}

function parseTags(json: string | null | undefined): ParsedTag[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((t) => {
      if (t && typeof t === "object" && "name" in t) {
        const name = (t as { name?: unknown }).name;
        if (typeof name !== "string") return [];
        const color = (t as { color?: unknown }).color;
        return [{ name, color: typeof color === "string" ? color : null }];
      }
      return [];
    });
  } catch {
    return [];
  }
}

export function SnippetTrashItem({ item, registerNode }: Props) {
  const ref = useCallback(
    (el: HTMLDivElement | null) => registerNode(item.id, el),
    [item.id, registerNode],
  );
  const size = getBodySize(item);
  const meta = (item.previewMeta ?? {}) as SnippetMeta;
  const tags = parseTags(meta.tagsCache).slice(0, 3);

  return (
    <div
      ref={ref}
      className="absolute will-change-transform select-none overflow-hidden rounded-sm border border-amber-200/70 bg-amber-50 px-2 py-1.5 shadow-md dark:border-amber-800/50 dark:bg-amber-950/40"
      style={{ width: size.width, height: size.height, top: 0, left: 0 }}
      data-subkind={item.subKind}
      data-interesting={item.isInteresting}
      title={item.previewText}
    >
      {/* 上端の折れ表現 */}
      <div
        className="absolute right-0 top-0 h-3 w-3"
        style={{
          background:
            "linear-gradient(225deg, transparent 50%, rgba(0,0,0,0.08) 50%)",
        }}
        aria-hidden="true"
      />
      <div className="truncate text-xs font-semibold text-foreground">
        {item.previewText || "—"}
      </div>
      {meta.bodyPreview ? (
        <div className="mt-0.5 line-clamp-2 text-[10px] leading-tight text-muted-foreground">
          {meta.bodyPreview}
        </div>
      ) : null}
      {tags.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-0.5">
          {tags.map((tag) => (
            <span
              key={tag.name}
              className="rounded px-1 text-[9px] leading-none text-foreground/80"
              style={{
                backgroundColor: tag.color ?? "rgba(0,0,0,0.08)",
              }}
            >
              {tag.name}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
