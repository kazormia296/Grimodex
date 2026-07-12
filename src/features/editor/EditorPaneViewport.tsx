import { DndContext, DragOverlay } from "@dnd-kit/core";
import type { Editor } from "@tiptap/react";
import type { CodexMentionPopupState } from "@/features/codex/CodexMentionExtension";
import { SceneMetaPanel } from "@/features/editor/SceneMetaPanel";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { EditorContentAreaProps } from "@/features/editor/EditorContentArea";
import { EditorContentArea } from "@/features/editor/EditorContentArea";
import type { useBeatDragDrop } from "@/features/editor/useBeatDragDrop";

type BeatDragDropState = ReturnType<typeof useBeatDragDrop>;

interface EditorPaneViewportProps {
  isPanelVisible: boolean;
  sceneMetaPanelWidth: number;
  onPanelLayoutChanged: (layout: Record<string, number>) => void;
  contentAreaProps: EditorContentAreaProps;
  sceneId: string;
  editor: Editor | null;
  setMentionPopup: (state: CodexMentionPopupState | null) => void;
  beatDragDrop: BeatDragDropState;
}

/** Owns the editor body layout and beat drag context. */
export function EditorPaneViewport({
  isPanelVisible,
  sceneMetaPanelWidth,
  onPanelLayoutChanged,
  contentAreaProps,
  sceneId,
  editor,
  setMentionPopup,
  beatDragDrop,
}: EditorPaneViewportProps) {
  const content = <EditorContentArea {...contentAreaProps} />;

  return (
    <DndContext
      sensors={beatDragDrop.sensors}
      collisionDetection={beatDragDrop.collisionDetection}
      onDragStart={beatDragDrop.onDragStart}
      onDragEnd={beatDragDrop.onDragEnd}
    >
      {isPanelVisible ? (
        <ResizablePanelGroup
          orientation="horizontal"
          className="min-h-0 flex-1"
          onLayoutChanged={onPanelLayoutChanged}
        >
          <ResizablePanel
            id="editor-main"
            minSize="40%"
            className="flex flex-col overflow-hidden"
          >
            {content}
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel
            id="scene-meta"
            minSize="15%"
            maxSize="50%"
            defaultSize={`${sceneMetaPanelWidth}%`}
            className="flex flex-col overflow-hidden"
          >
            <SceneMetaPanel
              sceneId={sceneId}
              editor={editor}
              setMentionPopup={setMentionPopup}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {content}
          </div>
        </div>
      )}
      <DragOverlay dropAnimation={null}>
        {beatDragDrop.draggingBeat && (
          <div
            className="rounded border border-border bg-popover px-2 py-1 text-xs shadow-md opacity-90 whitespace-nowrap"
            style={{ width: "max-content", maxWidth: "320px" }}
          >
            {beatDragDrop.draggingBeat.content
              .map((c) => ("text" in c ? String(c.text ?? "") : ""))
              .join("")
              .slice(0, 40) || "Beat"}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
