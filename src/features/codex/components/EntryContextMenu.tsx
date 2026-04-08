import { useEffect, useRef } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { CodexEntry } from "../api";

interface EntryContextMenuProps {
  entry: CodexEntry;
  x: number;
  y: number;
  onClose: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string) => void;
}

export function EntryContextMenu({
  entry,
  x,
  y,
  onClose,
  onDelete,
  onRename,
}: EntryContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleDelete = () => {
    onDelete(entry.id);
    onClose();
  };

  const handleRename = () => {
    onRename(entry.id);
    onClose();
  };

  return (
    <div
      ref={menuRef}
      data-testid="entry-context-menu"
      style={{ left: `${x}px`, top: `${y}px` }}
      className="fixed z-50 min-w-[160px] rounded-lg border border-border bg-background shadow-lg"
    >
      {/* Header */}
      <div className="border-b border-border px-3 py-2">
        <p className="truncate text-xs font-semibold">{entry.name}</p>
        <p className="text-[10px] text-muted-foreground">{entry.type}</p>
      </div>

      {/* Actions */}
      <div className="py-1">
        <button
          type="button"
          data-testid="entry-context-menu-rename"
          onClick={handleRename}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
        >
          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
          名前を変更
        </button>

        <div className="my-1 border-t border-border" />

        <button
          type="button"
          data-testid="entry-context-menu-delete"
          onClick={handleDelete}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="h-3.5 w-3.5" />
          削除
        </button>
      </div>
    </div>
  );
}
