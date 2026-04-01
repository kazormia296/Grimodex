import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCodexStore } from "@/features/codex/codexStore";
import type { CodexEntry } from "@/features/codex/api";

const typeLabels: Record<string, string> = {
  character: "キャラクター",
  location: "場所",
  item: "アイテム",
  lore: "設定",
};

function PinCodexVirtualList({
  entries,
  pinnedIds,
  onPin,
  onUnpin,
}: {
  entries: CodexEntry[];
  pinnedIds: Set<string>;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 5,
  });

  return (
    <div ref={parentRef} className="max-h-72 overflow-y-auto">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const entry = entries[virtualItem.index];
          const isPinned = pinnedIds.has(entry.id);
          return (
            <div
              key={entry.id}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualItem.size}px`,
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <label className="flex h-full cursor-pointer items-center gap-2 rounded px-2 text-sm hover:bg-accent">
                <input
                  type="checkbox"
                  checked={isPinned}
                  onChange={() =>
                    isPinned ? onUnpin(entry.id) : onPin(entry.id)
                  }
                  className="rounded"
                />
                <span>{entry.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {typeLabels[entry.type] ?? entry.type}
                </span>
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface PinCodexDialogProps {
  open: boolean;
  pinnedIds: Set<string>;
  onPin: (entryId: string) => void;
  onUnpin: (entryId: string) => void;
  onClose: () => void;
}

export function PinCodexDialog({
  open,
  pinnedIds,
  onPin,
  onUnpin,
  onClose,
}: PinCodexDialogProps) {
  const entries = useCodexStore((s) => s.entries);
  const loadEntries = useCodexStore((s) => s.loadEntries);

  useEffect(() => {
    if (open) loadEntries();
  }, [open, loadEntries]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-80 max-h-96 rounded-lg border border-border bg-background p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold mb-3">Codexエントリをピン留め</h3>
        {entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Codexエントリがありません
          </p>
        ) : (
          <PinCodexVirtualList
            entries={entries}
            pinnedIds={pinnedIds}
            onPin={onPin}
            onUnpin={onUnpin}
          />
        )}
        <button
          type="button"
          onClick={onClose}
          className="mt-3 w-full rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90"
        >
          閉じる
        </button>
      </div>
    </div>
  );
}
