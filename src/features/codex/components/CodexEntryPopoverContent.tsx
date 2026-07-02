import { ExternalLink, EyeOff } from "lucide-react";
import type { CodexEntry } from "@/features/codex/api";
import { iconToDataUrl } from "../iconUtils";

/**
 * ポップオーバーが読む最小列。M10: chat の detected/always ピルは icon を
 * 持たない projection 行を渡すため icon は任意 (無ければ色ドットで代替)。
 */
export type CodexPopoverEntry = Pick<CodexEntry, "name" | "summary"> &
  Partial<Pick<CodexEntry, "icon">>;

interface CodexEntryPopoverContentProps {
  entry: CodexPopoverEntry;
  dotColor: string;
  typeLabel: string;
  onOpenInCodex?: () => void;
  phaseLabel?: string;
  resolvedSummary?: string | null;
  spoilerNote?: string;
}

export function CodexEntryPopoverContent({
  entry,
  dotColor,
  typeLabel,
  onOpenInCodex,
  phaseLabel,
  resolvedSummary,
  spoilerNote,
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
      {spoilerNote && (
        <p
          data-testid="codex-spoiler-note"
          className="mb-2 flex items-start gap-1 text-[11px] text-amber-600 dark:text-amber-500"
        >
          <EyeOff className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span>{spoilerNote}</span>
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
