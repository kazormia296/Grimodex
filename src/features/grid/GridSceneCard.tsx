import { useRef, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
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
import { GridCardMenu } from "./GridCardMenu";
import { sceneDraggableId, sceneDroppableId } from "./gridDndUtils";
import type { DropIndicator } from "./gridDndUtils";
import type { GridDisplaySettings } from "./gridStore";

interface Props {
  scene: TreeNodeData;
  display: GridDisplaySettings;
  dimmed?: boolean;
  dropIndicator?: DropIndicator | null;
}

export function GridSceneCard({
  scene,
  display,
  dimmed,
  dropIndicator,
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

  return (
    <div
      ref={(node) => {
        setDragRef(node);
        setDropRef(node);
      }}
      style={{
        paddingTop: isDropBefore ? GAP : 0,
        paddingBottom: isDropAfter ? GAP : 0,
        transition: "padding 120ms ease-out",
      }}
    >
      <div
        className={cn(
          "relative rounded-md border bg-card text-card-foreground shadow-sm",
          "flex flex-col select-none",
          (isDragging || dimmed) && "opacity-40",
        )}
        style={{ transition: "opacity 120ms ease-out" }}
      >
        {/* Drag handle area */}
        <div
          {...attributes}
          {...listeners}
          className="absolute inset-x-0 top-0 h-4 cursor-grab active:cursor-grabbing rounded-t-md"
          aria-label="ドラッグして移動"
        />

        <GridCardHeader
          nodeId={scene.id}
          title={scene.title}
          onMenuOpen={() => setMenuOpen((v) => !v)}
          onTitleClick={openInEditor}
          menuBtnRef={menuBtnRef}
        />

        <GridCardBody
          nodeId={scene.id}
          synopsis={scene.synopsis}
          unplacedBeatPreview={scene.unplacedBeatPreview}
          showSynopsis={display.showSynopsis}
          showBeats={display.showBeats}
          compact={display.compactCards}
          onEditingChange={setIsEditing}
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

        {/* Footer: status badge + char count */}
        <div className="flex items-center gap-2 px-3 pb-2 pt-0.5 border-t border-border/40 mt-0.5">
          <StatusBadge status={scene.status} iconOnly={!display.showLabel} />
          <span className="text-[10px] text-muted-foreground/60 ml-auto">
            {liveCharCount.toLocaleString()} chars
          </span>
        </div>

        {menuOpen && (
          <div className="relative">
            <GridCardMenu
              nodeId={scene.id}
              onClose={() => setMenuOpen(false)}
              onRename={() => {
                setMenuOpen(false);
              }}
              onAddBeat={() => {
                setAddingBeat(true);
                setBeatDraft("");
              }}
              anchorRef={menuBtnRef}
            />
          </div>
        )}
      </div>
    </div>
  );
}
