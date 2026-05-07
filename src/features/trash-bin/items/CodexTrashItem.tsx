import { useCallback } from "react";
import { BookOpen, MapPin, Package, User } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { TrashItemData } from "../types";
import { getBodySize } from "../displayHelpers";

interface Props {
  item: TrashItemData;
  registerNode: (id: string, el: HTMLElement | null) => void;
}

interface CodexMeta {
  category?: string | null;
  categoryLabel?: string | null;
  iconName?: string | null;
}

// CodexEntryHeader.tsx の KICKER_ICON と同等のマッピング (builtin slug)。
// カスタムタイプは fallback (BookOpen)。完全な動的 Lucide 解決は Phase 5/6 で検討。
const SLUG_ICON: Record<string, LucideIcon> = {
  character: User,
  location: MapPin,
  item: Package,
  lore: BookOpen,
};

export function CodexTrashItem({ item, registerNode }: Props) {
  const ref = useCallback(
    (el: HTMLDivElement | null) => registerNode(item.id, el),
    [item.id, registerNode],
  );
  const size = getBodySize(item);
  const meta = (item.previewMeta ?? {}) as CodexMeta;
  const label = meta.categoryLabel ?? meta.category ?? "";
  const Icon = SLUG_ICON[meta.category ?? ""] ?? BookOpen;

  return (
    <div
      ref={ref}
      className="absolute flex will-change-transform select-none items-center gap-1.5 rounded-lg border border-emerald-300/60 bg-emerald-50/90 px-2 py-1 shadow-sm dark:border-emerald-700/50 dark:bg-emerald-950/40"
      style={{ width: size.width, height: size.height, top: 0, left: 0 }}
      data-subkind={item.subKind}
      data-interesting={item.isInteresting}
      title={item.previewText}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-emerald-700 dark:text-emerald-300" />
      <div className="flex min-w-0 flex-col">
        <div className="truncate text-xs font-semibold text-foreground">
          {item.previewText || "—"}
        </div>
        {label ? (
          <div className="truncate text-[9px] leading-tight text-muted-foreground">
            {label}
          </div>
        ) : null}
      </div>
    </div>
  );
}
