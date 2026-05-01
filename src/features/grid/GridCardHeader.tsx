import { useState, useRef } from "react";
import { Pencil, MoreHorizontal } from "lucide-react";
import { useTreeStore } from "@/features/tree/treeStore";
import { cn } from "@/lib/utils";

interface Props {
  nodeId: string;
  title: string;
  onMenuOpen: () => void;
  onTitleClick?: () => void;
}

export function GridCardHeader({
  nodeId,
  title,
  onMenuOpen,
  onTitleClick,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const updateNodeTitle = useTreeStore((s) => s.updateNodeTitle);

  function startEdit(e: React.MouseEvent) {
    e.stopPropagation();
    setDraft(title);
    setEditing(true);
    setTimeout(() => {
      inputRef.current?.select();
    }, 0);
  }

  function commitEdit() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== title) {
      void updateNodeTitle(nodeId, trimmed);
    }
    setEditing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      setEditing(false);
    }
  }

  return (
    <div className="flex items-center gap-1 px-3 pt-2 pb-1 group">
      {editing ? (
        <input
          ref={inputRef}
          className="flex-1 min-w-0 rounded bg-accent px-1 py-0.5 text-[12px] font-medium outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={handleKeyDown}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <button
          className={cn(
            "flex-1 min-w-0 text-left text-[12px] font-medium leading-snug truncate",
            "hover:text-accent-foreground",
          )}
          onClick={onTitleClick}
          onDoubleClick={startEdit}
          title={title}
        >
          {title}
        </button>
      )}

      <button
        className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-accent transition-opacity"
        onClick={startEdit}
        tabIndex={-1}
        title="名前を変更"
      >
        <Pencil className="h-2.5 w-2.5" />
      </button>

      <button
        className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-accent transition-opacity"
        onClick={(e) => {
          e.stopPropagation();
          onMenuOpen();
        }}
        data-testid="grid-card-menu-btn"
        title="メニュー"
      >
        <MoreHorizontal className="h-3 w-3" />
      </button>
    </div>
  );
}
