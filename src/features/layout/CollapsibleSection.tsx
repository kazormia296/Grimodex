import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface CollapsibleSectionProps {
  /** セクション見出しのラベル。 */
  title: ReactNode;
  /** 開いているか。 */
  open: boolean;
  /** 見出しクリックで開閉をトグルする。 */
  onToggle: () => void;
  /** 見出し右端に並べる操作(sort select・loading スピナー等)。 */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * パネル内の折りたたみ可能セクション。Scene Context パネルが Codex と
 * 関連過去シーンを縦積みするために使う汎用部品。
 *
 * 注意: `data-panel-header` は **付けない**。パネル最大化/右クリックメニューの
 * ジェスチャはパネル全体の `PanelHeader` だけが持つ。セクション見出しに付けると
 * `PanelChromeMenu` のダブルクリック最大化が二重発火する。
 */
export function CollapsibleSection({
  title,
  open,
  onToggle,
  actions,
  children,
  className,
}: CollapsibleSectionProps) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex flex-1 items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          <Chevron className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{title}</span>
        </button>
        {actions != null && (
          <div className="flex shrink-0 items-center gap-1">{actions}</div>
        )}
      </div>
      {open && children}
    </div>
  );
}
