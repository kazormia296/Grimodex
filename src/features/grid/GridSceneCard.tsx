import { useRef, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { useTabStore } from "@/features/editor/tabStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { StatusDot } from "@/features/tree/StatusDot";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { cn } from "@/lib/utils";
import { GridCardHeader } from "./GridCardHeader";
import { GridCardBody } from "./GridCardBody";
import { GridCardChips } from "./GridCardChips";
import { GridCardMenu } from "./GridCardMenu";
import { sceneDraggableId, sceneDroppableId } from "./gridDndUtils";
import type { GridDisplaySettings } from "./gridStore";

interface Props {
  scene: TreeNodeData;
  display: GridDisplaySettings;
}

export function GridSceneCard({ scene, display }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: sceneDraggableId(scene.id),
    data: { kind: "scene", sceneId: scene.id },
    disabled: isEditing,
  });

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: sceneDroppableId(scene.id),
    data: { kind: "scene-drop", sceneId: scene.id },
  });

  function openInEditor() {
    useTabStore.getState().openPinned(scene.id);
    useLayoutStore.getState().showPanel("editor");
  }

  return (
    <div
      ref={(node) => {
        setDragRef(node);
        setDropRef(node);
      }}
      className={cn(
        "relative rounded-md border bg-card text-card-foreground shadow-sm",
        "flex flex-col select-none",
        isDragging && "opacity-40",
        isOver && "ring-2 ring-primary",
      )}
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
      />

      <GridCardBody
        nodeId={scene.id}
        synopsis={scene.synopsis}
        unplacedBeatPreview={scene.unplacedBeatPreview}
        showSynopsis={display.showSynopsis}
        showBeats={display.showBeats}
        onEditingChange={setIsEditing}
      />

      {display.showCodex && (
        <div className="px-3 pb-2">
          <GridCardChips
            sceneId={scene.id}
            onChipClick={(entryId) => {
              useLayoutStore.getState().showPanel("codex");
              // Future: focus the entry in CodexPanel
              void entryId;
            }}
          />
        </div>
      )}

      <div className="flex items-center gap-1 px-3 pb-2">
        <StatusDot status={scene.status} />
        {display.showLabel && scene.status && (
          <span className="text-[10px] text-muted-foreground">
            {scene.status}
          </span>
        )}
      </div>

      {menuOpen && (
        <div className="relative">
          <GridCardMenu
            nodeId={scene.id}
            onClose={() => setMenuOpen(false)}
            onRename={() => {
              // handled inside GridCardHeader via double-click; close menu only
              setMenuOpen(false);
            }}
            anchorRef={menuBtnRef}
          />
        </div>
      )}
    </div>
  );
}
