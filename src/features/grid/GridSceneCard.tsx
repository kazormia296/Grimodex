import { useRef, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/features/editor/tabStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { StatusBadge } from "@/features/tree/StatusBadge";
import { addUnplacedBeatFromGrid } from "@/features/editor/beat/addUnplacedBeatFromGrid";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { cn } from "@/lib/utils";
import { GridCardHeader } from "./GridCardHeader";
import { GridCardBody } from "./GridCardBody";
import { GridCardChips } from "./GridCardChips";
import { GridCardLabelBar } from "./GridCardLabelBar";
import { GridCardPovChips } from "./GridCardPovChips";
import { GridCardForeshadowIndicator } from "./GridCardForeshadowIndicator";
import { GridCardMenu } from "./GridCardMenu";
import { sceneDraggableId, sceneDroppableId } from "./gridDndUtils";
import type { DropIndicator } from "./gridDndUtils";
import type { GridDisplaySettings } from "./gridStore";
import { useGridStore } from "./gridStore";

interface Props {
  scene: TreeNodeData;
  display: GridDisplaySettings;
  dimmed?: boolean;
  dropIndicator?: DropIndicator | null;
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
  onRequestDeleteConfirm,
  flatOrder,
}: Props) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [addingBeat, setAddingBeat] = useState(false);
  const [beatDraft, setBeatDraft] = useState("");
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  const liveCharCount = useTreeStore(
    (s) => s.charCounts[scene.id] ?? scene.charCount ?? 0,
  );
  const deleteNode = useTreeStore((s) => s.deleteNode);

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
    dropIndicator?.targetId === scene.id && dropIndicator.position === "before";
  const isDropAfter =
    dropIndicator?.targetId === scene.id && dropIndicator.position === "after";
  const GAP = display.compactCards ? 56 : 72;

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

  function handleBeatKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitBeat();
    } else if (e.key === "Escape") {
      setAddingBeat(false);
      setBeatDraft("");
    }
  }

  function handleCardClick(e: React.MouseEvent) {
    if (isEditing || addingBeat) return;
    if (e.metaKey || e.ctrlKey) {
      toggleSelection(scene.id);
    } else if (e.shiftKey) {
      rangeSelect(scene.id, flatOrder ?? []);
    } else {
      selectOnly(scene.id);
    }
  }

  return (
    <div
      ref={(node) => {
        setDragRef(node);
        setDropRef(node);
      }}
      data-grid-scene-id={scene.id}
      style={{
        paddingTop: isDropBefore ? GAP : 0,
        paddingBottom: isDropAfter ? GAP : 0,
        transition: "padding 120ms ease-out",
      }}
    >
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
          onMenuOpen={() => setMenuOpen((v) => !v)}
          onTitleClick={openInEditor}
          menuBtnRef={menuBtnRef}
          menuSlot={
            menuOpen ? (
              <GridCardMenu
                nodeId={scene.id}
                onClose={() => setMenuOpen(false)}
                onDelete={requestDelete}
                anchorRef={menuBtnRef}
              />
            ) : null
          }
        />

        <GridCardPovChips
          sceneId={scene.id}
          scenePovCharacterId={scene.povCharacterId}
          compact={display.compactCards}
        />

        <GridCardBody
          nodeId={scene.id}
          synopsis={scene.synopsis}
          unplacedBeatPreview={scene.unplacedBeatPreview}
          showSynopsis={display.showSynopsis}
          showBeats={display.showBeats}
          compact={display.compactCards}
          onEditingChange={setIsEditing}
          addBeatSlot={
            display.showBeats && !addingBeat ? (
              <button
                type="button"
                className="mb-1 flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground/50 hover:bg-accent hover:text-muted-foreground transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  setAddingBeat(true);
                  setBeatDraft("");
                }}
              >
                <Plus className="h-2.5 w-2.5" />
                {t("grid.card.addBeat", "Beat を追加")}
              </button>
            ) : null
          }
        />

        {addingBeat && (
          <div className="px-3 pb-2">
            <input
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              className="w-full rounded border border-input bg-background px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder={t(
                "grid.card.beatPlaceholder",
                "Beat を入力… (Enter で確定)",
              )}
              value={beatDraft}
              onChange={(e) => setBeatDraft(e.target.value)}
              onKeyDown={handleBeatKeyDown}
              onBlur={() => void commitBeat()}
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

        {display.showForeshadow && (
          <GridCardForeshadowIndicator
            sceneId={scene.id}
            compact={display.compactCards}
          />
        )}

        {/* Footer: status badge + char count */}
        <div className="flex items-center gap-2 px-3 pb-2 pt-0.5 border-t border-border/40 mt-0.5">
          <StatusBadge
            status={scene.status}
            iconOnly={!display.showStatusLabel}
          />
          <span className="text-[10px] text-muted-foreground/60 ml-auto">
            {liveCharCount.toLocaleString()} chars
          </span>
        </div>
      </div>
    </div>
  );
}
