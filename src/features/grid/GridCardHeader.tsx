import { useState, useRef } from "react";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  nodeId: string;
  title: string;
  onOpenInEditor?: () => void;
  /** Self-contained menu component (e.g. GridCardMenu). */
  menuSlot?: React.ReactNode;
  /** Drag handle rendered at the left of the row (e.g. GripVertical with
   *  dnd-kit attributes/listeners). Placed before the title so the drag
   *  affordance is explicit and never overlaps the action buttons. */
  dragHandleSlot?: React.ReactNode;
}

export function GridCardHeader({
  nodeId,
  title,
  onOpenInEditor,
  menuSlot,
  dragHandleSlot,
}: Props) {
  const { t } = useTranslation();
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
      {dragHandleSlot}
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
        <span
          className={cn(
            "flex-1 min-w-0 text-left text-[12px] font-medium leading-snug truncate",
          )}
          onDoubleClick={startEdit}
          title={title}
        >
          {title}
        </span>
      )}

      {onOpenInEditor && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation();
            onOpenInEditor();
          }}
          data-testid="grid-card-open-editor-btn"
          title={t("grid.card.openInEditor", "エディタで開く")}
          aria-label={t("grid.card.openInEditor", "エディタで開く")}
        >
          <ExternalLink />
        </Button>
      )}

      {menuSlot}
    </div>
  );
}
