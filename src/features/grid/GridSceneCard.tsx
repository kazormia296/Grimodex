import { useLayoutEffect, useRef, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/features/editor/tabStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useNodeBeatPreview, useTreeStore } from "@/features/tree/treeStore";
import { StatusBadge } from "@/features/tree/StatusBadge";
import { addUnplacedBeatFromGrid } from "@/features/editor/beat/addUnplacedBeatFromGrid";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { cn } from "@/lib/utils";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";
import { GridCardHeader } from "./GridCardHeader";
import { GridCardBody } from "./GridCardBody";
import { GridCardChips } from "./GridCardChips";
import { GridCardLabelBar } from "./GridCardLabelBar";
import { GridCardPovChips } from "./GridCardPovChips";
import { GridCardForeshadowIndicator } from "./GridCardForeshadowIndicator";
import { GridCardMenu } from "./GridCardMenu";
import { sceneDraggableId, sceneDroppableId } from "./gridDndUtils";
import type { DropIndicator, ColumnDropIndicator } from "./gridDndUtils";
import type { GridDisplaySettings } from "./gridStore";
import { useGridStore } from "./gridStore";

interface Props {
  scene: TreeNodeData;
  display: GridDisplaySettings;
  dimmed?: boolean;
  dropIndicator?: DropIndicator | null;
  /** Live column-drop indicator. When a column is dragged and this scene is
   *  the target, drives the same top/bottom before/after bar as the scene-drag
   *  indicator — visually communicating where the column will land as the
   *  scene's sibling in its parent. */
  columnDropIndicator?: ColumnDropIndicator | null;
  /** Axis-locked drag: signed translateY pixels. Negative = up, positive =
   *  down. Applies to both passing siblings (one slot) and the active card
   *  itself (multi-slot) so the card travels visually with the swap. */
  axisLockOffsetPx?: number;
  /** Called when delete is requested (single or multi-select). */
  onRequestDeleteConfirm?: (sceneIds: string[]) => void;
  /** Flat scene order for range selection (Shift+Click). */
  flatOrder?: string[];
}

export function GridSceneCard({
  scene,
  display,
  dimmed,
  dropIndicator,
  columnDropIndicator,
  axisLockOffsetPx,
  onRequestDeleteConfirm,
  flatOrder,
}: Props) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const [isEditing, setIsEditing] = useState(false);
  const [addingBeat, setAddingBeat] = useState(false);
  const [beatDraft, setBeatDraft] = useState("");
  const beatInputRef = useRef<HTMLTextAreaElement>(null);

  const liveCharCount = useTreeStore(
    (s) => s.charCounts[scene.id] ?? scene.charCount ?? 0,
  );
  const deleteNode = useTreeStore((s) => s.deleteNode);
  const preview = useNodeBeatPreview(scene.id);

  const isSelected = useGridStore((s) => s.selectedSceneIds.has(scene.id));
  const isRevealed = useGridStore((s) => s.revealedSceneId === scene.id);
  const selectOnly = useGridStore((s) => s.selectOnly);
  const toggleSelection = useGridStore((s) => s.toggleSelection);
  const rangeSelect = useGridStore((s) => s.rangeSelect);
  const clearSelection = useGridStore((s) => s.clearSelection);

  function requestDelete() {
    const { selectedSceneIds } = useGridStore.getState();
    const isMultiSelect =
      selectedSceneIds.has(scene.id) && selectedSceneIds.size > 1;
    if (isMultiSelect) {
      onRequestDeleteConfirm?.(Array.from(selectedSceneIds));
    } else {
      const needsConfirm = liveCharCount > 0 || !!scene.synopsis;
      if (needsConfirm && onRequestDeleteConfirm) {
        onRequestDeleteConfirm([scene.id]);
      } else {
        clearSelection();
        void deleteNode(scene.id);
      }
    }
  }

  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: sceneDraggableId(scene.id),
    data: { kind: "scene", sceneId: scene.id },
    disabled: isEditing || addingBeat,
  });

  const { setNodeRef: setDropRef } = useDroppable({
    id: sceneDroppableId(scene.id),
    data: { kind: "scene-drop", sceneId: scene.id },
  });

  const isDropBefore =
    (dropIndicator?.targetId === scene.id &&
      dropIndicator.position === "before") ||
    (columnDropIndicator?.targetId === scene.id &&
      columnDropIndicator.position === "before");
  const isDropAfter =
    (dropIndicator?.targetId === scene.id &&
      dropIndicator.position === "after") ||
    (columnDropIndicator?.targetId === scene.id &&
      columnDropIndicator.position === "after");

  function openInEditor() {
    useTabStore.getState().openPinned(scene.id);
    useLayoutStore.getState().showPanel("editor");
  }

  async function commitBeat() {
    const text = beatDraft.trim();
    setAddingBeat(false);
    setBeatDraft("");
    if (text) {
      await addUnplacedBeatFromGrid(scene.id, text);
    }
  }

  function handleBeatKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void commitBeat();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setAddingBeat(false);
      setBeatDraft("");
    }
  }

  // Auto-resize the add-beat textarea to fit content.
  useLayoutEffect(() => {
    if (!addingBeat) return;
    const el = beatInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [addingBeat, beatDraft]);

  function handleCardClick(e: React.MouseEvent) {
    if (isEditing || addingBeat) return;
    // Ignore clicks on interactive descendants — they handle their own clicks
    if (
      (e.target as HTMLElement).closest(
        "button, a, input, textarea, [contenteditable='true']",
      )
    ) {
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      toggleSelection(scene.id);
    } else if (e.shiftKey) {
      rangeSelect(scene.id, flatOrder ?? []);
    } else {
      selectOnly(scene.id);
    }
  }

  const axisLockOffset = axisLockOffsetPx ?? 0;
  const [e0, e1, e2, e3] = EASINGS.easeOut;
  const axisLockTransition = reducedMotion
    ? "none"
    : `transform ${DURATIONS.fast}s cubic-bezier(${e0}, ${e1}, ${e2}, ${e3})`;

  return (
    <div
      ref={(node) => {
        setDragRef(node);
        setDropRef(node);
      }}
      data-grid-scene-id={scene.id}
      className="relative"
      style={{
        transform: axisLockOffset
          ? `translateY(${axisLockOffset}px)`
          : undefined,
        transition: axisLockTransition,
        willChange: axisLockOffset ? "transform" : undefined,
      }}
    >
      {isDropBefore && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-1.5 h-1 rounded-full bg-primary"
        />
      )}
      {isDropAfter && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -bottom-1.5 h-1 rounded-full bg-primary"
        />
      )}
      <div
        tabIndex={0}
        role="option"
        aria-selected={isSelected}
        className={cn(
          "relative rounded-md border bg-card text-card-foreground shadow-sm",
          "flex flex-col select-none outline-none",
          (isDragging || dimmed) && "opacity-40",
          isSelected && "ring-2 ring-primary border-primary/60 bg-primary/5",
          isRevealed &&
            "ring-2 ring-amber-400 border-amber-400/60 bg-amber-400/10",
        )}
        style={{ transition: "opacity 120ms ease-out" }}
        onClick={handleCardClick}
      >
        {/* Drag handle area */}
        <div
          {...attributes}
          {...listeners}
          className="absolute inset-x-0 top-0 h-4 cursor-grab active:cursor-grabbing rounded-t-md"
          aria-label="ドラッグして移動"
        />

        {display.showLabelBar && <GridCardLabelBar nodeId={scene.id} />}

        <GridCardHeader
          nodeId={scene.id}
          title={scene.title}
          onOpenInEditor={openInEditor}
          menuSlot={<GridCardMenu nodeId={scene.id} onDelete={requestDelete} />}
        />

        <GridCardPovChips
          sceneId={scene.id}
          scenePovCharacterId={scene.povCharacterId}
          compact={display.compactCards}
        />

        <GridCardBody
          nodeId={scene.id}
          synopsis={scene.synopsis}
          unplacedBeatPreview={preview.unplaced}
          placedBeatPreview={preview.placed}
          showSynopsis={display.showSynopsis}
          showBeats={display.showBeats}
          compact={display.compactCards}
          onEditingChange={setIsEditing}
          onRequestAddBeat={() => {
            if (!addingBeat) {
              setAddingBeat(true);
              setBeatDraft("");
            }
          }}
        />

        {addingBeat && (
          <div className="px-3 pb-2">
            <textarea
              ref={beatInputRef}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              rows={1}
              className="w-full resize-none overflow-hidden rounded border border-input bg-background px-2 py-1 text-[11px] leading-snug focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder={t(
                "grid.card.beatPlaceholder",
                "Beat を入力… (Enter で確定 / Shift+Enter で改行)",
              )}
              value={beatDraft}
              onChange={(e) => setBeatDraft(e.target.value)}
              onKeyDown={handleBeatKeyDown}
              onBlur={() => void commitBeat()}
              title={t(
                "grid.card.beatEditHint",
                "Enter で確定、Shift+Enter で改行、Esc で取消",
              )}
            />
          </div>
        )}

        {display.showCodex && (
          <div className="px-3 pb-2">
            <GridCardChips
              sceneId={scene.id}
              editable
              compact={display.compactCards}
            />
          </div>
        )}

        {/* Footer: status badge + foreshadow + char count */}
        <div className="flex items-center gap-2 px-3 pb-2 pt-1 border-t border-border/40 mt-0.5">
          <StatusBadge
            status={scene.status}
            iconOnly={!display.showStatusLabel}
          />
          {display.showForeshadow && (
            <GridCardForeshadowIndicator
              sceneId={scene.id}
              compact={display.compactCards}
            />
          )}
          <span className="text-[10px] text-muted-foreground/60 ml-auto">
            {liveCharCount.toLocaleString()} chars
          </span>
        </div>
      </div>
    </div>
  );
}
