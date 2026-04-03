import { cn } from "@/lib/utils";
import type { SessionWithStats } from "../chatHistoryApi";

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

export function SessionCard({
  session,
  isActive,
  onClick,
  onDoubleClick,
}: SessionCardProps) {
  const totalExtractions = session.codexCount + session.snippetCount;

  return (
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
          <span className="rounded-full bg-teal-500/15 px-1.5 py-0.5 text-[10px] font-medium text-teal-600 dark:text-teal-400">
            {session.codexCount} codex
          </span>
        )}

        {/* Snippet extractions */}
        {session.snippetCount > 0 && (
          <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
            {session.snippetCount} snippets
          </span>
        )}

        {/* Extraction indicator (shown when has extractions but no detail badges) */}
        {totalExtractions === 0 && (
          <span className="text-[10px] text-muted-foreground/50">
            No extractions
          </span>
        )}
      </div>
    </div>
  );
}
