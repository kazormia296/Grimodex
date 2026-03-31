import { useEffect } from "react";
import { useCodexStore } from "@/features/codex/codexStore";

interface PinCodexDialogProps {
  open: boolean;
  pinnedIds: Set<number>;
  onPin: (entryId: number) => void;
  onUnpin: (entryId: number) => void;
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

  const typeLabels: Record<string, string> = {
    character: "キャラクター",
    location: "場所",
    item: "アイテム",
    lore: "設定",
  };

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
          <div className="space-y-1 max-h-72 overflow-y-auto">
            {entries.map((entry) => {
              const isPinned = pinnedIds.has(entry.id);
              return (
                <label
                  key={entry.id}
                  className="flex items-center gap-2 rounded px-2 py-1 hover:bg-accent cursor-pointer text-sm"
                >
                  <input
                    type="checkbox"
                    checked={isPinned}
                    onChange={() =>
                      isPinned ? onUnpin(entry.id) : onPin(entry.id)
                    }
                    className="rounded"
                  />
                  <span>{entry.name}</span>
                  <span className="text-xs text-muted-foreground ml-auto">
                    {typeLabels[entry.type] ?? entry.type}
                  </span>
                </label>
              );
            })}
          </div>
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
