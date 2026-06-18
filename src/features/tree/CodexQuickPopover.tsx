import { createPortal } from "react-dom";
import type { CodexEntry } from "@/features/codex/api";
import { CodexEntryPopoverContent } from "@/features/codex/components/CodexEntryPopoverContent";

interface CodexQuickPopoverProps {
  entry: CodexEntry;
  rect: DOMRect;
  dotColor: string;
  typeLabel: string;
  onClose: () => void;
  phaseLabel?: string;
  resolvedSummary?: string | null;
  spoilerNote?: string;
}

export function CodexQuickPopover({
  entry,
  rect,
  dotColor,
  typeLabel,
  onClose,
  phaseLabel,
  resolvedSummary,
  spoilerNote,
}: CodexQuickPopoverProps) {
  return createPortal(
    <div
      className="fixed z-50 w-64 rounded-lg border border-border bg-popover p-3 shadow-md"
      style={{ left: rect.left, top: rect.bottom + 4 }}
      onMouseEnter={() => {
        // keep visible while hovering popover
      }}
      onMouseLeave={onClose}
    >
      <CodexEntryPopoverContent
        entry={entry}
        dotColor={dotColor}
        typeLabel={typeLabel}
        phaseLabel={phaseLabel}
        resolvedSummary={resolvedSummary}
        spoilerNote={spoilerNote}
      />
    </div>,
    document.body,
  );
}
