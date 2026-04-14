import { X, Pin } from "lucide-react";
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
  /** ピン済みエントリ用: ×ボタンでアンピン */
  onUnpin?: (entryId: string) => void;
  /** autoエントリ用: ピンボタンでピン留め */
  onPin?: (entryId: string) => Promise<void>;
  resolvedColor?: ResolvedCodexColor;
}

export function ContextPillGroup({
  label,
  count,
  expanded,
  onToggle,
  entries,
  onUnpin,
  onPin,
  resolvedColor,
}: ContextPillGroupProps) {
  const { t } = useTranslation();
  const isAuto = !!onPin;
  const pillStyle = resolvedColor
    ? { backgroundColor: resolvedColor.hl, color: resolvedColor.fg }
    : undefined;
  const headerStyle =
    isAuto && resolvedColor ? { ...pillStyle, opacity: 0.75 } : pillStyle;
  return (
    <>
      {/* グループヘッダーピル */}
      <button
        type="button"
        onClick={onToggle}
        aria-label={t("chat.context.group", { label })}
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs bg-accent"
        style={headerStyle}
      >
        <span>{label}</span>
        {isAuto && <span className="text-muted-foreground/70">auto</span>}
        <span>{expanded ? "▴" : "▾"}</span>
        <span>({count})</span>
      </button>

      {/* 展開時: 個別エントリピル */}
      {expanded &&
        entries.map((entry) => (
          <span
            key={entry.id}
            className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs"
            style={
              isAuto && pillStyle ? { ...pillStyle, opacity: 0.75 } : pillStyle
            }
          >
            {entry.name}
            {isAuto ? (
              <>
                <span className="text-muted-foreground/70">auto</span>
                <button
                  type="button"
                  onClick={() => onPin(entry.id)}
                  className="hover:text-foreground text-muted-foreground/70"
                  aria-label={t("chat.context.pinEntry", { name: entry.name })}
                >
                  <Pin className="h-3 w-3" />
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => onUnpin!(entry.id)}
                className="hover:text-destructive"
                aria-label={t("chat.context.unpinEntry", { name: entry.name })}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
    </>
  );
}
