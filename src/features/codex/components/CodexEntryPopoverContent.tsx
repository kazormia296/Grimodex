import type { CodexEntry } from "@/features/codex/api";
import { iconToDataUrl } from "../iconUtils";

interface CodexEntryPopoverContentProps {
  entry: CodexEntry;
  dotColor: string;
  typeLabel: string;
  onOpenInCodex?: () => void;
}

export function CodexEntryPopoverContent({
  entry,
  dotColor,
  typeLabel,
  onOpenInCodex,
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
      {entry.summary && (
        <p className="mb-2 line-clamp-3 text-xs text-muted-foreground">
          {entry.summary}
        </p>
      )}
      {onOpenInCodex && (
        <button
          type="button"
          className="text-xs text-primary hover:underline"
          onClick={onOpenInCodex}
        >
          Open in Codex →
        </button>
      )}
    </>
  );
}
