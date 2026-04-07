import { X } from "lucide-react";
import type { CodexEntry } from "@/features/codex/api";

interface ContextPillGroupProps {
  type: string;
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  entries: CodexEntry[];
  onUnpin: (entryId: string) => void;
  colorClass?: string;
}

export function ContextPillGroup({
  label,
  count,
  expanded,
  onToggle,
  entries,
  onUnpin,
  colorClass = "bg-accent",
}: ContextPillGroupProps) {
  return (
    <>
      {/* グループヘッダーピル */}
      <button
        type="button"
        onClick={onToggle}
        aria-label={`${label} グループ`}
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${colorClass}`}
      >
        <span>{label}</span>
        <span>{expanded ? "▴" : "▾"}</span>
        <span>({count})</span>
      </button>

      {/* 展開時: 個別エントリピル */}
      {expanded &&
        entries.map((entry) => (
          <span
            key={entry.id}
            className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs"
          >
            {entry.name}
            <button
              type="button"
              onClick={() => onUnpin(entry.id)}
              className="hover:text-destructive"
              aria-label={`${entry.name}のピン留め解除`}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
    </>
  );
}
