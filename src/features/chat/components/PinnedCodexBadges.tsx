import { X, BookOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PinnedCodexEntryWithData } from "@/features/chat/chatApi";
import { getChildrenFromArray } from "@/features/codex/childrenBudget";
import { useCodexStore } from "@/features/codex/codexStore";

interface PinnedCodexBadgesProps {
  pinnedEntries: PinnedCodexEntryWithData[];
  onUnpin: (entryId: string) => void;
  onOpenPinDialog: () => void;
}

export function PinnedCodexBadges({
  pinnedEntries,
  onUnpin,
  onOpenPinDialog,
}: PinnedCodexBadgesProps) {
  const { t } = useTranslation();
  const allEntries = useCodexStore((s) => s.entries);

  return (
    <div
      className="flex flex-wrap items-center gap-1 border-b border-border px-4 py-1"
      data-testid="pinned-codex-badges"
    >
      <button
        type="button"
        onClick={onOpenPinDialog}
        className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
        aria-label={t("chat.context.pinCodex")}
      >
        <BookOpen className="h-3 w-3" />
        {t("chat.context.pin")}
      </button>
      {pinnedEntries.map((entry) => {
        const children = entry.withChildren
          ? getChildrenFromArray(entry.id, allEntries)
          : [];

        return (
          <span key={entry.id} className="contents">
            <span className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs">
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
            {children.map((child) => (
              <span
                key={`${entry.id}-child-${child.id}`}
                className="inline-flex items-center gap-1 rounded-full bg-accent/60 px-2 py-0.5 text-[10px] text-muted-foreground"
                title={`via ${entry.name}`}
              >
                {child.name}
                <span className="opacity-60">↑{entry.name}</span>
              </span>
            ))}
          </span>
        );
      })}
    </div>
  );
}
