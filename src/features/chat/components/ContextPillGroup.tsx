import { X, Pin } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CodexEntry } from "@/features/codex/api";
import type { ResolvedCodexColor } from "@/lib/resolveCodexColors";

interface ContextPillGroupProps {
  type: string;
  label: string;
  expanded: boolean;
  onToggle: () => void;
  /** ピン済みエントリ（先頭に表示、×ボタン） */
  pinnedEntries: CodexEntry[];
  /** autoエントリ（後ろに表示、Pinボタン） */
  autoEntries: CodexEntry[];
  onUnpin: (entryId: string) => void;
  onPin: (entryId: string) => Promise<void>;
  resolvedColor?: ResolvedCodexColor;
}

export function ContextPillGroup({
  label,
  expanded,
  onToggle,
  pinnedEntries,
  autoEntries,
  onUnpin,
  onPin,
  resolvedColor,
}: ContextPillGroupProps) {
  const { t } = useTranslation();
  const count = pinnedEntries.length + autoEntries.length;
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

      {/* 展開時: ピン済み → auto の順で個別ピルを表示 */}
      {expanded && (
        <>
          {pinnedEntries.map((entry) => (
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
          {autoEntries.map((entry) => (
            <span
              key={entry.id}
              className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs"
              style={pillStyle ? { ...pillStyle, opacity: 0.75 } : undefined}
            >
              {entry.name}
              <span className="text-muted-foreground/70">auto</span>
              <button
                type="button"
                onClick={() => onPin(entry.id)}
                className="hover:text-foreground text-muted-foreground/70"
                aria-label={t("chat.context.pinEntry", { name: entry.name })}
              >
                <Pin className="h-3 w-3" />
              </button>
            </span>
          ))}
        </>
      )}
    </>
  );
}
