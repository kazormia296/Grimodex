import { useState, useRef, useEffect } from "react";
import { X, Pin, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CodexEntry } from "@/features/codex/api";
import type { PinnedCodexEntryWithData } from "../chatApi";
import type { ResolvedCodexColor } from "@/lib/resolveCodexColors";

interface ContextPillGroupProps {
  type: string;
  label: string;
  /** ピン済みエントリ（先頭に表示） */
  pinnedEntries: PinnedCodexEntryWithData[];
  /** autoエントリ（後ろに表示、Pinボタン） */
  autoEntries: CodexEntry[];
  /** 手動ピンをautoに戻す */
  onReturnToAuto: (entryId: string) => void;
  /** コンテキストから完全除去 */
  onRemove: (entryId: string) => void;
  onPin: (entryId: string) => Promise<void>;
  resolvedColor?: ResolvedCodexColor;
}

export function ContextPillGroup({
  label,
  pinnedEntries,
  autoEntries,
  onReturnToAuto,
  onRemove,
  onPin,
  resolvedColor,
}: ContextPillGroupProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const count = pinnedEntries.length + autoEntries.length;
  const pillStyle = resolvedColor
    ? { backgroundColor: resolvedColor.hl, color: resolvedColor.fg }
    : undefined;

  // クリック外で閉じる
  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative inline-flex">
      {/* グループヘッダーピル */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("chat.context.group", { label })}
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs bg-accent"
        style={pillStyle}
      >
        <span>{label}</span>
        <span>{open ? "▴" : "▾"}</span>
        <span>({count})</span>
      </button>

      {/* ポップオーバー: グループ内エントリを縦一覧 */}
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-48 rounded-md border border-border bg-popover py-1 shadow-md">
          {pinnedEntries.map((entry) => {
            const isManual = entry.pinSource === "manual";
            return (
              <div
                key={entry.id}
                className="flex w-full items-center justify-between gap-2 px-2 py-0.5 text-xs hover:bg-accent/50"
              >
                <span
                  className="truncate font-medium"
                  style={pillStyle ? { color: pillStyle.color } : undefined}
                >
                  {entry.name}
                </span>
                <div className="flex shrink-0 items-center gap-0.5">
                  {isManual && (
                    <button
                      type="button"
                      onClick={() => onReturnToAuto(entry.id)}
                      className="hover:text-foreground text-muted-foreground/70"
                      aria-label={t("chat.context.returnToAuto", {
                        name: entry.name,
                      })}
                    >
                      <Undo2 className="h-3 w-3" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onRemove(entry.id)}
                    className="hover:text-destructive text-muted-foreground"
                    aria-label={t("chat.context.unpinEntry", {
                      name: entry.name,
                    })}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </div>
            );
          })}
          {autoEntries.map((entry) => (
            <div
              key={entry.id}
              className="flex w-full items-center justify-between gap-2 px-2 py-0.5 text-xs hover:bg-accent/50 opacity-75"
            >
              <span
                className="truncate"
                style={pillStyle ? { color: pillStyle.color } : undefined}
              >
                {entry.name}
                <span className="ml-1 text-muted-foreground/70">auto</span>
              </span>
              <button
                type="button"
                onClick={() => onPin(entry.id)}
                className="shrink-0 hover:text-foreground text-muted-foreground/70"
                aria-label={t("chat.context.pinEntry", { name: entry.name })}
              >
                <Pin className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
