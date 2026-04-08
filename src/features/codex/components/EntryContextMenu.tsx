import { useEffect, useRef, useState } from "react";
import { Copy, MapPin, Pencil, Tag, Trash2 } from "lucide-react";
import type { CodexEntry } from "../api";
import type { CodexType } from "../typeApi";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";

interface EntryContextMenuProps {
  entry: CodexEntry;
  x: number;
  y: number;
  onClose: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string) => void;
  onDuplicate?: (id: string) => void;
  onFindInScenes?: (id: string) => void;
  onChangeType?: (id: string, newType: string) => void;
  codexTypes?: CodexType[];
}

export function EntryContextMenu({
  entry,
  x,
  y,
  onClose,
  onDelete,
  onRename,
  onDuplicate,
  onFindInScenes,
  onChangeType,
  codexTypes = [],
}: EntryContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [showTypeSubmenu, setShowTypeSubmenu] = useState(false);
  const typeColorMap = useCodexHighlightStore((s) => s.typeColorMap);

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [onClose]);

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

  const handleDuplicate = () => {
    onDuplicate?.(entry.id);
    onClose();
  };

  const handleFindInScenes = () => {
    onFindInScenes?.(entry.id);
    onClose();
  };

  const handleChangeType = (newType: string) => {
    onChangeType?.(entry.id, newType);
    onClose();
  };

  return (
    <div
      ref={menuRef}
      data-testid="entry-context-menu"
      style={{ left: `${x}px`, top: `${y}px` }}
      className="fixed z-50 min-w-[180px] rounded-lg border border-border bg-background shadow-lg"
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

        <button
          type="button"
          data-testid="entry-context-menu-duplicate"
          onClick={handleDuplicate}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
        >
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
          複製
        </button>

        {/* Change type */}
        <div className="relative">
          <button
            type="button"
            data-testid="entry-context-menu-change-type"
            onClick={() => setShowTypeSubmenu((prev) => !prev)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
          >
            <Tag className="h-3.5 w-3.5 text-muted-foreground" />
            タイプ変更
          </button>
          {showTypeSubmenu && codexTypes.length > 0 && (
            <div className="absolute left-full top-0 z-50 min-w-[140px] rounded-lg border border-border bg-background shadow-lg">
              <div className="py-1">
                {codexTypes.map((t) => (
                  <button
                    key={t.slug}
                    type="button"
                    data-testid={`entry-context-menu-type-${t.slug}`}
                    onClick={() => handleChangeType(t.slug)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent ${
                      entry.type === t.slug ? "font-medium" : ""
                    }`}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor: typeColorMap[t.slug]?.fg ?? t.color,
                      }}
                    />
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="my-1 border-t border-border" />

        <button
          type="button"
          data-testid="entry-context-menu-find-in-scenes"
          onClick={handleFindInScenes}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
        >
          <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
          シーンで検索
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
