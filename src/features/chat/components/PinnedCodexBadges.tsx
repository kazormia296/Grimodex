import { X, BookOpen } from "lucide-react";
import type { CodexEntry } from "@/features/codex/api";

interface PinnedCodexBadgesProps {
  pinnedEntries: CodexEntry[];
  onUnpin: (entryId: string) => void;
  onOpenPinDialog: () => void;
}

export function PinnedCodexBadges({
  pinnedEntries,
  onUnpin,
  onOpenPinDialog,
}: PinnedCodexBadgesProps) {
  return (
    <div
      className="flex flex-wrap items-center gap-1 px-4 py-1 border-b border-border"
      data-testid="pinned-codex-badges"
    >
      <button
        type="button"
        onClick={onOpenPinDialog}
        className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
        aria-label="Codexをピン留め"
      >
        <BookOpen className="h-3 w-3" />
        ピン留め
      </button>
      {pinnedEntries.map((entry) => (
        <span
          key={entry.id}
          className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs"
        >
          {entry.name}
          <button
            type="button"
            onClick={() => onUnpin(entry.id)}
            className="hover:text-destructive"
            aria-label={`${entry.name}のピン留め解除`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
