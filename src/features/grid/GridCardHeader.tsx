import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useQuiescentDraftParticipant } from "@/application/lifecycle/useQuiescentDraftParticipant";
import { useLatestValueDraftController } from "@/application/lifecycle/latestValueDraftController";
import type { QuiescenceParticipantFlushOptions } from "@/application/lifecycle/quiescenceParticipants";

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
  onEditingChange?: (editing: boolean) => void;
}

export function GridCardHeader({
  nodeId,
  title,
  onOpenInEditor,
  menuSlot,
  dragHandleSlot,
  onEditingChange,
}: Props) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const editingRef = useRef(false);
  const mountedRef = useRef(true);
  const onEditingChangeRef = useRef(onEditingChange);
  onEditingChangeRef.current = onEditingChange;
  const updateNodeTitle = useTreeStore((s) => s.updateNodeTitle);
  const draftController = useLatestValueDraftController(
    `grid-card-title:${nodeId}`,
    title,
    async (next) => {
      const trimmed = next.trim();
      if (trimmed && trimmed !== title) {
        await updateNodeTitle(nodeId, trimmed);
      }
    },
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (!editingRef.current) return;
      onEditingChangeRef.current?.(false);
    };
  }, []);

  function startEdit(e: React.MouseEvent) {
    e.stopPropagation();
    if (editingRef.current) return;
    editingRef.current = true;
    draftController.reset(title);
    setDraft(title);
    setEditing(true);
    onEditingChangeRef.current?.(true);
    setTimeout(() => {
      inputRef.current?.select();
    }, 0);
  }

  async function commitEdit(
    options?: QuiescenceParticipantFlushOptions,
  ): Promise<void> {
    if (!editingRef.current) return;
    if (!draftController.latestValue.trim()) {
      draftController.reset(title);
    } else {
      await draftController.save(options);
    }
    editingRef.current = false;
    if (mountedRef.current) {
      setEditing(false);
      onEditingChangeRef.current?.(false);
    }
  }

  function cancelEdit() {
    if (!editingRef.current) return;
    editingRef.current = false;
    draftController.reset(title);
    if (mountedRef.current) {
      setDraft(title);
      setEditing(false);
      onEditingChangeRef.current?.(false);
    }
  }

  useQuiescentDraftParticipant({
    id: `grid-card-title:${nodeId}`,
    scope: { kind: "tree-node", entityId: nodeId },
    enabled: editing,
    isDirty: () => editingRef.current && draftController.dirty,
    flush: commitEdit,
    discard: cancelEdit,
    recovery: () =>
      editingRef.current
        ? {
            kind: "grid-card-title",
            nodeId,
            title: draftController.latestValue,
          }
        : null,
  });

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void commitEdit().catch(() => {});
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
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
          onChange={(e) => {
            draftController.markDirty(
              e.target.value.trim() ? e.target.value : title,
            );
            setDraft(e.target.value);
          }}
          onBlur={() => void commitEdit().catch(() => {})}
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
          className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity"
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
