import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 受信箱（IssuesInbox）の観点グループ見出し。折りたたみトグル + 件数バッジ +
 * 右端の補助スロット（校正の「自動検出」ラベル等）。両タブのローカル重複を統合。
 */
export function SectionHeader({
  title,
  count,
  expanded,
  onToggle,
  action,
}: {
  title: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  action?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full shrink-0 items-center gap-1.5 border-b border-border bg-muted/20 px-3 py-1.5 text-left text-xs font-medium hover:bg-muted/40"
    >
      <ChevronRight
        size={12}
        className={cn(
          "shrink-0 text-muted-foreground transition-transform",
          expanded && "rotate-90",
        )}
      />
      <span>{title}</span>
      {count > 0 && (
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs leading-none text-muted-foreground">
          {count}
        </span>
      )}
      {action && (
        <span
          className="ml-auto"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {action}
        </span>
      )}
    </button>
  );
}
