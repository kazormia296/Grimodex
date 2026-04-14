import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { X, Pin, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CodexEntry } from "@/features/codex/api";
import type { PinnedCodexEntryWithData } from "../chatApi";
import type { ResolvedCodexColor } from "@/lib/resolveCodexColors";
import { CodexEntryPopoverContent } from "@/features/codex/components/CodexEntryPopoverContent";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { getTypeLabel } from "@/features/chat/utils/typeLabels";

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
  /** autoエントリをコンテキストから即時除去 */
  onRemoveAuto: (entryId: string) => void;
  onPin: (entryId: string) => Promise<void>;
  resolvedColor?: ResolvedCodexColor;
}

export function ContextPillGroup({
  label,
  pinnedEntries,
  autoEntries,
  onReturnToAuto,
  onRemove,
  onRemoveAuto,
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

  // Codex エントリ hover ポップオーバー
  const [hoveredEntry, setHoveredEntry] = useState<{
    entry: CodexEntry;
    rect: DOMRect;
  } | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  // ドロップダウンを閉じたらポップオーバーも閉じる
  useEffect(() => {
    if (!open) setHoveredEntry(null);
  }, [open]);

  const handleEntryMouseEnter = useCallback(
    (entry: CodexEntry, e: MouseEvent<HTMLElement>) => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setHoveredEntry({ entry, rect });
    },
    [],
  );

  const handleEntryMouseLeave = useCallback(() => {
    hideTimerRef.current = setTimeout(() => {
      setHoveredEntry(null);
    }, 200);
  }, []);

  function handleOpenInCodex(entryId: string) {
    setHoveredEntry(null);
    useLayoutStore.getState().showPanel("codex");
    useCodexStore.getState().requestSelectEntry(entryId);
  }

  // クリック外で閉じる
  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: globalThis.MouseEvent) {
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
                onMouseEnter={(e) => handleEntryMouseEnter(entry, e)}
                onMouseLeave={handleEntryMouseLeave}
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
              onMouseEnter={(e) => handleEntryMouseEnter(entry, e)}
              onMouseLeave={handleEntryMouseLeave}
            >
              <span
                className="truncate"
                style={pillStyle ? { color: pillStyle.color } : undefined}
              >
                {entry.name}
                <span className="ml-1 text-muted-foreground/70">auto</span>
              </span>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => onPin(entry.id)}
                  className="hover:text-foreground text-muted-foreground/70"
                  aria-label={t("chat.context.pinEntry", { name: entry.name })}
                >
                  <Pin className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => onRemoveAuto(entry.id)}
                  className="hover:text-destructive text-muted-foreground/70"
                  aria-label={t("chat.context.unpinEntry", {
                    name: entry.name,
                  })}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Codex エントリ hover ポップオーバー（ドロップダウン右側に表示） */}
      {hoveredEntry &&
        createPortal(
          <div
            className="fixed z-[60] w-64 rounded-lg border border-border bg-popover p-3 shadow-md"
            style={{
              left: hoveredEntry.rect.right + 4,
              top: hoveredEntry.rect.top,
            }}
            onMouseEnter={() => {
              if (hideTimerRef.current) {
                clearTimeout(hideTimerRef.current);
                hideTimerRef.current = null;
              }
            }}
            onMouseLeave={() => setHoveredEntry(null)}
          >
            <CodexEntryPopoverContent
              entry={hoveredEntry.entry}
              dotColor={resolvedColor?.fg ?? "#888888"}
              typeLabel={getTypeLabel(hoveredEntry.entry.type)}
              onOpenInCodex={() => handleOpenInCodex(hoveredEntry.entry.id)}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
