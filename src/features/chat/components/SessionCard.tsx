import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import type { SessionWithStats } from "../chatHistoryApi";
import { listExtractionsBySession } from "../chatHistoryApi";

interface SessionCardProps {
  session: SessionWithStats;
  isActive: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor(
    (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString("ja-JP", { month: "short", day: "numeric" });
}

interface PopoverData {
  type: "codex" | "snippets";
  entries: Array<{ id: string; label: string }>;
  top: number;
  left: number;
}

export function SessionCard({
  session,
  isActive,
  onClick,
  onDoubleClick,
}: SessionCardProps) {
  const [popover, setPopover] = useState<PopoverData | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!popover) return;
    function handleMouseDown(e: MouseEvent) {
      if (!popoverRef.current?.contains(e.target as Node)) {
        setPopover(null);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setPopover(null);
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [popover]);

  async function handleBadgeClick(
    e: React.MouseEvent,
    type: "codex" | "snippets",
  ) {
    e.stopPropagation();
    if (popover?.type === type) {
      setPopover(null);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const data = await listExtractionsBySession(session.id);
    const entries =
      type === "codex"
        ? data.codex.map((c) => ({ id: c.id, label: c.name }))
        : data.snippets.map((s) => ({ id: s.id, label: s.title }));
    setPopover({ type, entries, top: rect.bottom + 4, left: rect.left });
  }

  const totalExtractions = session.codexCount + session.snippetCount;

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onKeyDown={(e) => {
          if (e.key === "Enter") onClick();
        }}
        className={cn(
          "group cursor-pointer rounded-md border border-border p-2.5 text-left transition-colors hover:bg-accent/50",
          isActive && "border-l-2 border-l-primary bg-accent/30",
        )}
      >
        {/* Title + timestamp */}
        <div className="flex items-start justify-between gap-2">
          <span
            className={cn(
              "line-clamp-1 text-xs font-medium text-foreground",
              isActive && "text-primary",
            )}
          >
            {session.title}
          </span>
          <span className="flex-shrink-0 text-[10px] text-muted-foreground">
            {formatDate(session.updatedAt)}
          </span>
        </div>

        {/* First user message preview */}
        {session.firstUserMessage && (
          <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
            {session.firstUserMessage}
          </p>
        )}

        {/* Badges */}
        <div className="mt-1.5 flex items-center gap-1.5">
          {/* Message count */}
          <span className="rounded-full bg-purple-500/15 px-1.5 py-0.5 text-[10px] font-medium text-purple-600 dark:text-purple-400">
            {session.msgCount} msgs
          </span>

          {/* Codex extractions */}
          {session.codexCount > 0 && (
            <button
              type="button"
              onClick={(e) => handleBadgeClick(e, "codex")}
              className={cn(
                "rounded-full px-1.5 py-0.5 text-[10px] font-medium transition-colors",
                popover?.type === "codex"
                  ? "bg-teal-500/30 text-teal-700 dark:text-teal-300"
                  : "bg-teal-500/15 text-teal-600 hover:bg-teal-500/25 dark:text-teal-400",
              )}
            >
              {session.codexCount} codex
            </button>
          )}

          {/* Snippet extractions */}
          {session.snippetCount > 0 && (
            <button
              type="button"
              onClick={(e) => handleBadgeClick(e, "snippets")}
              className={cn(
                "rounded-full px-1.5 py-0.5 text-[10px] font-medium transition-colors",
                popover?.type === "snippets"
                  ? "bg-amber-500/30 text-amber-700 dark:text-amber-300"
                  : "bg-amber-500/15 text-amber-600 hover:bg-amber-500/25 dark:text-amber-400",
              )}
            >
              {session.snippetCount} snippets
            </button>
          )}

          {/* No extractions indicator */}
          {totalExtractions === 0 && (
            <span className="text-[10px] text-muted-foreground/50">
              No extractions
            </span>
          )}
        </div>
      </div>

      {/* Extraction popover (portal) */}
      {popover &&
        createPortal(
          <div
            ref={popoverRef}
            style={{ top: popover.top, left: popover.left }}
            className="fixed z-50 min-w-[180px] max-w-[260px] rounded-md border border-border bg-popover py-1 shadow-lg"
          >
            <p className="border-b border-border px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {popover.type === "codex" ? "Codex entries" : "Snippets"}
            </p>
            {popover.entries.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">None</p>
            ) : (
              popover.entries.map((entry) => (
                <p
                  key={entry.id}
                  className="truncate px-3 py-1.5 text-xs text-foreground"
                >
                  {entry.label}
                </p>
              ))
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
