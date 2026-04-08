import { ChevronDown, ChevronRight } from "lucide-react";

interface CategoryGroupHeaderProps {
  type: string;
  label: string;
  color: string;
  count: number;
  isExpanded: boolean;
  onToggle: () => void;
}

export function CategoryGroupHeader({
  type,
  label,
  color,
  count,
  isExpanded,
  onToggle,
}: CategoryGroupHeaderProps) {
  return (
    <button
      type="button"
      data-testid={`codex-category-group-${type}`}
      onClick={onToggle}
      className="flex w-full items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-1.5 text-left hover:bg-muted/50"
    >
      {isExpanded ? (
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
      )}
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="text-xs font-medium">{label}</span>
      <span className="ml-auto text-[10px] text-muted-foreground">{count}</span>
    </button>
  );
}
