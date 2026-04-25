import { ExternalLink } from "lucide-react";
import type { CodexEntry } from "@/features/codex/api";
import { iconToDataUrl } from "../iconUtils";

interface CodexEntryPopoverContentProps {
  entry: CodexEntry;
  dotColor: string;
  typeLabel: string;
  onOpenInCodex?: () => void;
  phaseLabel?: string;
  resolvedSummary?: string | null;
}

export function CodexEntryPopoverContent({
  entry,
  dotColor,
  typeLabel,
  onOpenInCodex,
  phaseLabel,
  resolvedSummary,
}: CodexEntryPopoverContentProps) {
  const safeIcon = iconToDataUrl(entry.icon);
  return (
    <>
      <div className="mb-1.5 flex items-center gap-2">
        {safeIcon ? (
          <img
            src={safeIcon}
            alt=""
            className="h-6 w-6 flex-shrink-0 rounded-sm object-cover"
          />
        ) : (
          <span
            data-testid="entry-dot"
            className="h-6 w-6 flex-shrink-0 rounded-full"
            style={{ backgroundColor: dotColor }}
          />
        )}
        <span className="flex-1 truncate text-sm font-semibold">
          {entry.name}
        </span>
        <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-xs text-muted-foreground">
          {typeLabel}
        </span>
      </div>
      {phaseLabel && (
        <span className="mb-1.5 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
          {phaseLabel}
        </span>
      )}
      {(resolvedSummary ?? entry.summary) && (
        <p className="mb-2 line-clamp-3 text-xs text-muted-foreground">
          {resolvedSummary ?? entry.summary}
        </p>
      )}
      {onOpenInCodex && (
        <button
          type="button"
          className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20 active:bg-primary/30"
          onClick={onOpenInCodex}
        >
          <ExternalLink className="h-3 w-3 shrink-0" />
          Open in Codex
        </button>
      )}
    </>
  );
}
