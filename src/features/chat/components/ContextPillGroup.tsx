import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CodexEntry } from "@/features/codex/api";
import type { ResolvedCodexColor } from "@/lib/resolveCodexColors";

interface ContextPillGroupProps {
  type: string;
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  entries: CodexEntry[];
  onUnpin: (entryId: string) => void;
  resolvedColor?: ResolvedCodexColor;
}

export function ContextPillGroup({
  label,
  count,
  expanded,
  onToggle,
  entries,
  onUnpin,
  resolvedColor,
}: ContextPillGroupProps) {
  const { t } = useTranslation();
  const pillStyle = resolvedColor
    ? { backgroundColor: resolvedColor.hl, color: resolvedColor.fg }
    : undefined;
  return (
    <>
      {/* グループヘッダーピル */}
      <button
        type="button"
        onClick={onToggle}
        aria-label={t("chat.context.group", { label })}
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs bg-accent"
        style={pillStyle}
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
            style={pillStyle}
          >
            {entry.name}
            <button
              type="button"
              onClick={() => onUnpin(entry.id)}
              className="hover:text-destructive"
              aria-label={t("chat.context.unpinEntry", { name: entry.name })}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
    </>
  );
}
