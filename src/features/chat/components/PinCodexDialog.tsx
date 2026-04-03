import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCodexStore } from "@/features/codex/codexStore";
import { getChildrenFromArray } from "@/features/codex/childrenBudget";
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
  withChildrenIds,
  onPin,
  onUnpin,
  onToggleChildren,
}: {
  entries: CodexEntry[];
  pinnedIds: Set<string>;
  withChildrenIds: Set<string>;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  onToggleChildren: (id: string, withChildren: boolean) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
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
          const hasChildren =
            getChildrenFromArray(entry.id, entries).length > 0;
          const isWithChildren = withChildrenIds.has(entry.id);

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
              className="flex flex-col justify-center rounded px-2 hover:bg-accent"
            >
              <label className="flex cursor-pointer items-center gap-2 text-sm">
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
              {isPinned && hasChildren && (
                <label className="ml-5 flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={isWithChildren}
                    onChange={(e) =>
                      onToggleChildren(entry.id, e.target.checked)
                    }
                    className="rounded"
                  />
                  子エントリを含める
                </label>
              )}
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
  withChildrenIds: Set<string>;
  onPin: (entryId: string) => void;
  onUnpin: (entryId: string) => void;
  onToggleChildren: (entryId: string, withChildren: boolean) => void;
  onClose: () => void;
}

export function PinCodexDialog({
  open,
  pinnedIds,
  withChildrenIds,
  onPin,
  onUnpin,
  onToggleChildren,
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
        className="max-h-96 w-80 rounded-lg border border-border bg-background p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-sm font-semibold">Codexエントリをピン留め</h3>
        {entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Codexエントリがありません
          </p>
        ) : (
          <PinCodexVirtualList
            entries={entries}
            pinnedIds={pinnedIds}
            withChildrenIds={withChildrenIds}
            onPin={onPin}
            onUnpin={onUnpin}
            onToggleChildren={onToggleChildren}
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
