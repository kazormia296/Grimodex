import { createPortal } from "react-dom";
import type { CodexEntry } from "@/features/codex/api";

interface CodexQuickPopoverProps {
  entry: CodexEntry;
  rect: DOMRect;
  onClose: () => void;
  typeLabels: Record<string, string>;
}

export function CodexQuickPopover({
  entry,
  rect,
  onClose,
  typeLabels,
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
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm font-semibold">{entry.name}</span>
        <span className="rounded-full bg-accent px-2 py-0.5 text-xs text-muted-foreground">
          {typeLabels[entry.type] ?? entry.type}
        </span>
      </div>
      {entry.summary && (
        <p className="line-clamp-3 text-xs text-muted-foreground">
          {entry.summary}
        </p>
      )}
    </div>,
    document.body,
  );
}
