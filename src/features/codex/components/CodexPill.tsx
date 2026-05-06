import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { CodexEntry } from "@/features/codex/api";
import type { ResolvedCodexColor } from "@/lib/resolveCodexColors";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { getTypeLabel } from "@/features/chat/utils/typeLabels";
import { CodexEntryPopoverContent } from "./CodexEntryPopoverContent";
import { cn } from "@/lib/utils";

interface CodexPillProps {
  entry: CodexEntry;
  /** Explicit color override; defaults to typeColorMap[entry.type]. */
  resolvedColor?: ResolvedCodexColor;
  /** Reduce opacity to indicate auto/via state. */
  dim?: boolean;
  /** Compact form for narrow contexts (e.g. grid card). */
  size?: "sm" | "md";
  /** Inline content after the entry name (e.g. "auto" / "via X"). */
  suffix?: ReactNode;
  /** Trailing action buttons (X / Pin / Undo etc). */
  actions?: ReactNode;
  /** Suppress the hover popover (e.g. when already inside one). */
  disablePopover?: boolean;
  /** Click handler. Default: navigate to Codex panel + select entry. */
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  /** Override "Open in Codex" link in the popover. */
  onOpenInCodex?: () => void;
  className?: string;
}

const POPOVER_HIDE_DELAY = 200;

export function CodexPill({
  entry,
  resolvedColor,
  dim,
  size = "md",
  suffix,
  actions,
  disablePopover,
  onClick,
  onOpenInCodex,
  className,
}: CodexPillProps) {
  const mappedColor = useCodexHighlightStore((s) => s.typeColorMap[entry.type]);
  const color = resolvedColor ?? mappedColor;

  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  const handleMouseEnter = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      if (disablePopover) return;
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      setHoverRect((e.currentTarget as HTMLElement).getBoundingClientRect());
    },
    [disablePopover],
  );

  const handleMouseLeave = useCallback(() => {
    if (disablePopover) return;
    hideTimerRef.current = setTimeout(() => {
      setHoverRect(null);
    }, POPOVER_HIDE_DELAY);
  }, [disablePopover]);

  function handleOpenInCodex() {
    setHoverRect(null);
    if (onOpenInCodex) {
      onOpenInCodex();
      return;
    }
    useLayoutStore.getState().showPanel("codex");
    useCodexStore.getState().requestSelectEntry(entry.id);
  }

  function handleDefaultClick(e: MouseEvent<HTMLElement>) {
    if (onClick) {
      onClick(e);
      return;
    }
    e.stopPropagation();
    handleOpenInCodex();
  }

  const sizeClass =
    size === "sm"
      ? "px-1.5 py-0 text-[10px] gap-1"
      : "px-2 py-0.5 text-xs gap-1";

  const fallbackClass = !color
    ? dim
      ? "border border-border text-muted-foreground"
      : "bg-accent text-accent-foreground"
    : undefined;

  const colorStyle = color
    ? dim
      ? {
          backgroundColor: "transparent",
          color: color.fg,
          boxShadow: `inset 0 0 0 1px ${color.hl}`,
        }
      : { backgroundColor: color.hl, color: color.fg }
    : undefined;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-full",
        sizeClass,
        fallbackClass,
        className,
      )}
      style={colorStyle}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 leading-none truncate max-w-[12rem]"
        onClick={handleDefaultClick}
        title={entry.name}
      >
        <span className="truncate">{entry.name}</span>
        {suffix}
      </button>
      {actions}

      {hoverRect &&
        createPortal(
          <div
            className="fixed z-[60] w-64 rounded-lg border border-border bg-popover p-3 shadow-md"
            style={{ left: hoverRect.left, top: hoverRect.bottom + 4 }}
            onMouseEnter={() => {
              if (hideTimerRef.current) {
                clearTimeout(hideTimerRef.current);
                hideTimerRef.current = null;
              }
            }}
            onMouseLeave={() => setHoverRect(null)}
          >
            <CodexEntryPopoverContent
              entry={entry}
              dotColor={color?.fg ?? "#888888"}
              typeLabel={getTypeLabel(entry.type)}
              onOpenInCodex={handleOpenInCodex}
            />
          </div>,
          document.body,
        )}
    </span>
  );
}
